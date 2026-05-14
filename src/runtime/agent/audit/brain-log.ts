/**
 * Append-only audit log at `<home>/agents/<name>/brain/audit-log.md`.
 *
 * One entry per audited turn. The brain log is the always-on surface;
 * inbox notifications and chat-inline cards fire only when something
 * unverified or contradicted is found. The full record lives here for
 * post-hoc review.
 *
 * Format: one Markdown H2 per turn, then a bullet per claim. Plain
 * text, greppable, no JSON ... a human (or another Agent doing a
 * trust audit) should be able to `cat` this and read it.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { agentPaths } from '../../storage/layout.js'
import type { ClaimEvidenceAuditResult } from './types.js'

export function auditLogPath(home: string, agentName: string): string {
  return `${agentPaths(home, agentName).brain}/audit-log.md`
}

export interface AppendAuditEntryArgs {
  home: string
  agentName: string
  taskId: string
  /** ISO timestamp of the audit. */
  at: string
  /** Was this a destructive task? Annotates the H2. */
  destructive: boolean
  result: ClaimEvidenceAuditResult
}

/**
 * Append one entry to the agent's audit log. Creates the brain dir
 * and the file as needed. Safe to call from a single supervisor
 * process (sole writer); concurrent multi-writer would race on
 * append since we don't lock.
 */
export async function appendAuditEntry(args: AppendAuditEntryArgs): Promise<void> {
  const path = auditLogPath(args.home, args.agentName)
  await mkdir(dirname(path), { recursive: true })
  const lines: string[] = [
    ``,
    `## ${args.at} · ${args.taskId} · ${args.destructive ? 'destructive' : 'non-destructive'}`,
    args.result.summary,
    ``,
  ]
  if (args.result.records.length === 0) {
    lines.push('  (no claims extracted)')
  } else {
    for (const rec of args.result.records) {
      const marker =
        rec.outcome.status === 'verified'
          ? 'verified'
          : rec.outcome.status === 'contradicted'
            ? 'contradicted'
            : 'unverified'
      const note = rec.outcome.status === 'verified' ? rec.outcome.evidence : rec.outcome.reason
      lines.push(
        `- **${marker}**: ${rec.claim.verb} ${rec.claim.object}${rec.claim.path ? ` (${rec.claim.path})` : ''}`,
      )
      lines.push(`    ↳ ${note}`)
    }
  }
  lines.push(``)
  await appendFile(path, lines.join('\n'), 'utf8')
}
