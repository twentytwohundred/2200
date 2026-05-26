/**
 * Work-package read/write helpers (PR 4 / Phase 1 propose-to-execute path).
 *
 * Grok hands a proposed work package into the fleet via the new MCP
 * tool `propose_work_package`. The package lands as a normal Brain
 * note in the shared brain so the operator and any Agent can see it
 * via existing surfaces. The package's lifecycle states are tracked
 * in frontmatter:
 *
 *   proposed           ... just arrived; coordination task in flight
 *   reviewable         ... primary Agent has written the `## Plan`
 *   approved           ... operator approved; follow-on tasks submitted
 *   rejected           ... operator rejected (optional reason)
 *
 * The whole-product safety story (the operator approves anything with
 * real-world effects) hinges on the dispatcher-level hard guard set
 * up in PR 4. The coordination task that produces the plan runs under
 * `tool_policy: strict_allowlist` with WORK_PACKAGE_COORDINATION_ALLOWED_TOOLS
 * (shared-brain read/write + pub-coordination only). The package note
 * itself never executes anything ... it is read material until and
 * unless the operator routes it into the execution substrate via the
 * `2200 connector work-package approve` CLI.
 */
import { randomBytes } from 'node:crypto'
import { BrainStore } from '../../brain/store.js'
import { listConduits } from './embassy/conduits.js'

/**
 * Locate the BrainStore holding a given work package. Searches the
 * shared brain first, then each registered embassy's brain. Returns
 * null if not found anywhere. Used by read / patch / list paths so
 * operator workflows (CLI approve, web Settings tile) work without
 * the operator needing to know which embassy owns the package.
 */
async function locatePackageStore(
  home: string,
  _packageId: string,
  slug: string,
): Promise<{ store: BrainStore; owner: string } | null> {
  // 1. Shared brain (legacy + pre-migration).
  const shared = BrainStore.forShared(home)
  if ((await shared.tryRead(slug)) !== null) return { store: shared, owner: 'shared' }
  // 2. Every registered embassy.
  const conduits = await listConduits(home).catch(() => [])
  for (const c of conduits) {
    const embassyStore = BrainStore.forAgent(home, c.embassy_agent)
    if ((await embassyStore.tryRead(slug)) !== null) {
      return { store: embassyStore, owner: c.embassy_agent }
    }
  }
  return null
}

export const WORK_PACKAGE_SCHEMA_VERSION = 1
export const WORK_PACKAGE_TAGS = ['work-package']

export type WorkPackageStatus = 'proposed' | 'reviewable' | 'approved' | 'rejected'

export interface ProposedWorkPackage {
  title: string
  summary: string
  proposed_steps: string[]
  target: { kind: 'thread'; thread_slug: string } | { kind: 'agent'; agent_name: string }
  success_criteria?: string[]
  risk_notes?: string[]
  estimated_cost_usd?: number
  estimated_duration_minutes?: number
}

export interface WorkPackageRecord {
  packageId: string
  slug: string
  path: string
  status: WorkPackageStatus
  proposal: ProposedWorkPackage
  primaryAgent: string
  createdAt: string
  coordinationTaskId: string | null
  approvedAt: string | null
  approvedFollowOnTaskIds: string[]
  rejectedAt: string | null
  rejectionReason: string | null
}

/** Mint a fresh work-package id: `pkg_<24 hex>`. */
export function newWorkPackageId(): string {
  return `pkg_${randomBytes(12).toString('hex')}`
}

export function workPackageSlug(packageId: string): string {
  return `work-package-${packageId}`
}

export interface WriteProposedPackageArgs {
  home: string
  packageId: string
  proposal: ProposedWorkPackage
  primaryAgent: string
  /**
   * Embassy routing (PR-B3b): when set, the package note lands in
   * this embassy's brain (tagged `relationship-history`) instead of
   * the shared brain. Absent: legacy shared-brain write (static-
   * bearer / unregistered conduits).
   */
  embassyAgent?: string
  /** Optional clock injection for tests. */
  now?: () => Date
}

export interface WriteProposedPackageResult {
  slug: string
  path: string
  createdAt: string
}

/**
 * Persist a freshly-proposed work package to the shared brain.
 *
 * The body is a structured markdown surface the operator (and the
 * coordinating Agent) can read at a glance. The body's `## Plan` /
 * `## Risks` / `## Success Criteria` / etc. sections are reserved
 * for the coordination task to fill in via `brain_write_shared`;
 * we render placeholders here so the structure is visible from the
 * first write.
 */
export async function writeProposedPackage(
  args: WriteProposedPackageArgs,
): Promise<WriteProposedPackageResult> {
  const now = args.now?.() ?? new Date()
  const createdAt = now.toISOString()
  // Embassy routing (PR-B3b): land work-package anchors in the
  // embassy's brain when one is registered for the calling client.
  // Shared-brain writes are reserved for static-bearer / unregistered
  // callers; the one-time migration absorbs those when an embassy
  // is first registered.
  const store =
    args.embassyAgent !== undefined
      ? BrainStore.forAgent(args.home, args.embassyAgent)
      : BrainStore.forShared(args.home)
  const slug = workPackageSlug(args.packageId)
  const body = renderProposedPackageBody(args.proposal, createdAt)
  const extras: Record<string, unknown> = {
    package_schema_version: WORK_PACKAGE_SCHEMA_VERSION,
    package_id: args.packageId,
    package_status: 'proposed' satisfies WorkPackageStatus,
    primary_agent: args.primaryAgent,
    target_kind: args.proposal.target.kind,
    target_name:
      args.proposal.target.kind === 'thread'
        ? args.proposal.target.thread_slug
        : args.proposal.target.agent_name,
    created_at: createdAt,
    coordination_task_id: null,
    approved_at: null,
    approved_follow_on_task_ids: [],
    rejected_at: null,
    rejection_reason: null,
  }
  if (args.proposal.estimated_cost_usd !== undefined) {
    extras['estimated_cost_usd'] = args.proposal.estimated_cost_usd
  }
  if (args.proposal.estimated_duration_minutes !== undefined) {
    extras['estimated_duration_minutes'] = args.proposal.estimated_duration_minutes
  }
  const tags = [...WORK_PACKAGE_TAGS, `target:${extras['target_kind'] as string}`]
  if (args.embassyAgent !== undefined) tags.push('relationship-history')
  const result = await store.write({
    slug,
    title: `Work package: ${args.proposal.title}`,
    body,
    type: 'work-package',
    tags,
    extras,
    now: () => now,
  })
  return { slug: result.slug, path: result.path, createdAt }
}

export interface PatchPackageFrontmatterArgs {
  home: string
  packageId: string
  updates: Partial<{
    package_status: WorkPackageStatus
    coordination_task_id: string | null
    approved_at: string | null
    approved_follow_on_task_ids: string[]
    rejected_at: string | null
    rejection_reason: string | null
  }>
}

export async function patchPackageFrontmatter(args: PatchPackageFrontmatterArgs): Promise<void> {
  // The package may live in any embassy's brain (post-B3 routing) OR
  // in the shared brain (legacy / pre-migration). Search until we
  // find it; the slug is globally unique.
  const slug = workPackageSlug(args.packageId)
  const found = await locatePackageStore(args.home, args.packageId, slug)
  if (found === null) {
    throw new Error(
      `unknown work package ${args.packageId}; not found in shared brain or any embassy`,
    )
  }
  const { store } = found
  const existing = await store.read(slug)
  const newExtras: Record<string, unknown> = { ...existing.extras }
  const updates = args.updates as Record<string, unknown>
  for (const k of Object.keys(updates)) {
    const v = updates[k]
    if (v === null) {
      Reflect.deleteProperty(newExtras, k)
    } else {
      newExtras[k] = v
    }
  }
  await store.write({
    slug,
    title: existing.frontmatter.title,
    body: existing.body,
    type: existing.frontmatter.type,
    tags: existing.frontmatter.tags,
    extras: newExtras,
  })
}

export interface WorkPackageListEntry {
  packageId: string
  slug: string
  title: string
  status: WorkPackageStatus
  primaryAgent: string
  targetKind: 'thread' | 'agent'
  targetName: string
  createdAt: string
  /** Full body (markdown). Includes the `## Plan` section once written. */
  body: string
  approvedAt: string | null
  approvedFollowOnTaskIds: string[]
  rejectedAt: string | null
  rejectionReason: string | null
}

export interface ListWorkPackagesArgs {
  home: string
  /** Filter to a specific status. Omit for "all statuses". */
  status?: WorkPackageStatus
  /** Max entries. Default 100. */
  limit?: number
}

/**
 * Enumerate work-package notes in the shared brain. Sorted by
 * `createdAt` descending (most-recent first). The body is included
 * so the operator's approval UI can render the `## Plan` section
 * without a second round-trip.
 */
export async function listWorkPackages(
  args: ListWorkPackagesArgs,
): Promise<WorkPackageListEntry[]> {
  // Aggregate across the shared brain (legacy + pre-migration
  // packages) and every registered embassy's brain. Dedup by
  // package_id; embassy ownership wins on conflict (shouldn't
  // happen post-migration, but guard against double-listing).
  const stores: BrainStore[] = [BrainStore.forShared(args.home)]
  const conduits = await listConduits(args.home).catch(() => [])
  for (const c of conduits) stores.push(BrainStore.forAgent(args.home, c.embassy_agent))
  const seen = new Set<string>()
  const notes: Awaited<ReturnType<BrainStore['list']>> = []
  for (const s of stores) {
    const local = await s.list({ tag: 'work-package', limit: args.limit ?? 100 }).catch(() => [])
    for (const n of local) {
      const pid = typeof n.extras['package_id'] === 'string' ? n.extras['package_id'] : null
      if (pid === null || seen.has(pid)) continue
      seen.add(pid)
      notes.push(n)
    }
  }
  const out: WorkPackageListEntry[] = []
  for (const note of notes) {
    const e = note.extras
    const pid = typeof e['package_id'] === 'string' ? e['package_id'] : null
    if (pid === null) continue
    const status = (
      typeof e['package_status'] === 'string' ? e['package_status'] : 'proposed'
    ) as WorkPackageStatus
    if (args.status !== undefined && status !== args.status) continue
    const targetKind = (typeof e['target_kind'] === 'string' ? e['target_kind'] : 'thread') as
      | 'thread'
      | 'agent'
    out.push({
      packageId: pid,
      slug: note.slug,
      title: note.frontmatter.title.replace(/^Work package:\s*/, ''),
      status,
      primaryAgent: typeof e['primary_agent'] === 'string' ? e['primary_agent'] : '',
      targetKind,
      targetName: typeof e['target_name'] === 'string' ? e['target_name'] : '',
      createdAt: typeof e['created_at'] === 'string' ? e['created_at'] : note.frontmatter.created,
      body: note.body,
      approvedAt: typeof e['approved_at'] === 'string' ? e['approved_at'] : null,
      approvedFollowOnTaskIds: Array.isArray(e['approved_follow_on_task_ids'])
        ? (e['approved_follow_on_task_ids'] as string[])
        : [],
      rejectedAt: typeof e['rejected_at'] === 'string' ? e['rejected_at'] : null,
      rejectionReason: typeof e['rejection_reason'] === 'string' ? e['rejection_reason'] : null,
    })
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function readWorkPackage(
  home: string,
  packageId: string,
): Promise<WorkPackageRecord | null> {
  // Search shared + every embassy. Post-B3b the embassy is the
  // expected location; shared remains for pre-migration / static-
  // bearer-written packages.
  const slug = workPackageSlug(packageId)
  const found = await locatePackageStore(home, packageId, slug)
  if (found === null) return null
  const note = await found.store.tryRead(slug)
  if (note === null) return null
  const e = note.extras
  const status = (
    typeof e['package_status'] === 'string' ? e['package_status'] : 'proposed'
  ) as WorkPackageStatus
  const targetKind = (typeof e['target_kind'] === 'string' ? e['target_kind'] : 'thread') as
    | 'thread'
    | 'agent'
  const targetName = typeof e['target_name'] === 'string' ? e['target_name'] : ''
  const proposal: ProposedWorkPackage = {
    title: note.frontmatter.title.replace(/^Work package:\s*/, ''),
    summary: '(see body)',
    proposed_steps: [],
    target:
      targetKind === 'thread'
        ? { kind: 'thread', thread_slug: targetName }
        : { kind: 'agent', agent_name: targetName },
  }
  return {
    packageId,
    slug: note.slug,
    path: note.path,
    status,
    proposal,
    primaryAgent: typeof e['primary_agent'] === 'string' ? e['primary_agent'] : '',
    createdAt: typeof e['created_at'] === 'string' ? e['created_at'] : note.frontmatter.created,
    coordinationTaskId:
      typeof e['coordination_task_id'] === 'string' ? e['coordination_task_id'] : null,
    approvedAt: typeof e['approved_at'] === 'string' ? e['approved_at'] : null,
    approvedFollowOnTaskIds: Array.isArray(e['approved_follow_on_task_ids'])
      ? (e['approved_follow_on_task_ids'] as string[])
      : [],
    rejectedAt: typeof e['rejected_at'] === 'string' ? e['rejected_at'] : null,
    rejectionReason: typeof e['rejection_reason'] === 'string' ? e['rejection_reason'] : null,
  }
}

function renderProposedPackageBody(proposal: ProposedWorkPackage, createdAt: string): string {
  const parts: string[] = []
  parts.push(`_Proposed via MCP connector at ${createdAt}._`)
  parts.push('')
  parts.push(
    `Target: ${proposal.target.kind === 'thread' ? `thread \`${proposal.target.thread_slug}\`` : `agent \`${proposal.target.agent_name}\``}`,
  )
  parts.push('')
  parts.push('## Summary')
  parts.push('')
  parts.push(proposal.summary.trim())
  parts.push('')
  parts.push('## Proposed steps')
  parts.push('')
  for (const step of proposal.proposed_steps) parts.push(`- ${step.trim()}`)
  if (proposal.success_criteria && proposal.success_criteria.length > 0) {
    parts.push('')
    parts.push('## Success criteria (proposed)')
    parts.push('')
    for (const c of proposal.success_criteria) parts.push(`- ${c.trim()}`)
  }
  if (proposal.risk_notes && proposal.risk_notes.length > 0) {
    parts.push('')
    parts.push('## Risks noted by proposer')
    parts.push('')
    for (const r of proposal.risk_notes) parts.push(`- ${r.trim()}`)
  }
  if (proposal.estimated_cost_usd !== undefined) {
    parts.push('')
    parts.push(
      `**Proposer's estimate:** $${proposal.estimated_cost_usd.toFixed(2)}${
        proposal.estimated_duration_minutes !== undefined
          ? ` / ~${String(proposal.estimated_duration_minutes)} min`
          : ''
      }`,
    )
  }
  parts.push('')
  parts.push('---')
  parts.push('')
  parts.push('_The primary Agent will append a reviewable plan below._')
  parts.push('')
  parts.push('## Plan')
  parts.push('')
  parts.push('_(pending; the coordination task has not yet completed)_')
  parts.push('')
  parts.push('## Risks')
  parts.push('')
  parts.push('_(pending)_')
  parts.push('')
  parts.push('## Success criteria')
  parts.push('')
  parts.push('_(pending)_')
  parts.push('')
  parts.push('## Estimated cost / budget impact')
  parts.push('')
  parts.push('_(pending)_')
  parts.push('')
  parts.push('## Internal coordination log')
  parts.push('')
  parts.push('_(pending)_')
  return parts.join('\n')
}
