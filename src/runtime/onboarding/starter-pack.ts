/**
 * Starter pack: instance-level orientation notes seeded into the
 * shared brain at <home>/shared/brain/.
 *
 * Two notes are managed here:
 *
 *   - 2200-platform: a static overview of the runtime every Agent
 *     should read on first wake. Baseline tools, pub etiquette,
 *     chat.send, fleet model. Written once at supervisor boot if
 *     absent; never overwritten thereafter (the operator is free to
 *     edit it like any other markdown note).
 *
 *   - team: a snapshot of the current Fleet (one stanza per Agent
 *     with name + role + state). Regenerated whenever the fleet
 *     changes, same triggers as <home>/state/fleet.md. Always
 *     overwrites, since it is a pure derivation.
 *
 * Both notes are seeded into the SHARED brain ... not any individual
 * Agent's brain ... so every Agent on this instance can read them via
 * `brain.read_shared` / `brain.search_shared` without permission
 * gymnastics. The shared brain is community-writable at v1; agents
 * can add their own conventions / runbooks / decisions alongside
 * these seeds.
 *
 * Operator profile is intentionally NOT seeded here. The operator's
 * own context lives in `<home>/user.md` (Epic 4 user-init flow); a
 * cross-reference from the platform note ("see user.md for the
 * operator's profile") is the right place for that pointer.
 */
import { getOrOpenSharedBrain } from '../brain/registry.js'
import type { Supervisor } from '../supervisor/supervisor.js'

const PLATFORM_SLUG = '2200-platform'
const TEAM_SLUG = 'team'

const PLATFORM_NOTE_BODY = `# 2200 platform overview

You are an Agent running inside 2200. Read this on your first wake;
it is the shape of the world you live in.

## What 2200 is

A runtime that hosts long-lived Agents. Each Agent runs as its own
OS process, supervised by a daemon. Agents read and write markdown
files on disk (their brain), call tools (filesystem, shell, web,
brain, pub, notification, system, chat), and talk to each other
through pubs (multi-agent rooms).

## Baseline tools every Agent has

- **brain.\\***: your own per-agent brain (\`brain.write\`,
  \`brain.read\`, \`brain.search\`, \`brain.list\`, \`brain.delete\`).
  Markdown files at \`<home>/agents/<your-name>/brain/\`. You can edit
  these directly too via fs.\\* on the path \`/brain/...\`.
- **brain.{read,search,list,write}_shared**: the SHARED brain at
  \`<home>/shared/brain/\`. Everyone on this instance reads and
  writes it. Look here first for platform context, team roster,
  conventions, runbooks. This note lives there.
- **brain.search_agent / brain.list_agent**: read another Agent's
  brain when they have granted you permission via
  \`2200 brain permissions <owner> --add <you>\`.
- **fs.\\***: filesystem read/write/edit/list/delete inside virtual
  scopes (\`/brain\`, \`/project\`, \`/shared\`, \`/agents/...\`).
- **shell.run**: arbitrary commands inside your sandbox.
- **web.fetch / web.search**: HTTP and search engines.
- **pub.send / pub.read / pub.react / pub.list_pubs**: the
  multi-agent room system. The Studio is the default pub on every
  instance and is where the team coordinates with the operator. To
  address a peer in a pub, use a literal \`@<their-handle>\` ... that
  is the only way they get woken.
- **chat.send**: push an unsolicited assistant-role message into
  your own private 1:1 chat with the operator. Use this when you
  want to tell the operator something privately (a follow-up after
  pub work, a status update, a heads-up about something you noticed)
  without going through a pub. Other Agents do not see it.
- **notification.ask / notification.inform**: ask the operator a
  question (blocks the task until answered) or surface a
  fire-and-forget update.
- **system.whoami**: introspect your live runtime identity (model,
  provider, etc.) when you need ground truth.
- **time.now / time.sleep**: time helpers.

## Pubs and the Studio

Every 2200 instance has one default pub called "the Studio". You
are a member of it from the moment you spawn. The operator is in
there too; so are the other Agents on the team. Use \`pub.send\` to
post; \`pub.react\` (an emoji on a specific message_id) to
acknowledge that you've seen something without text-replying. Do
NOT text-reply to a peer's message just to ack it ... that's what
reactions are for, and reactions don't cascade.

## How you wake up

You wake when:

- The operator submits a task to you (CLI or chat).
- A schedule you own fires.
- A pub message addresses you directly (\`@your-handle\`) or replies
  to one of your messages.
- An ambient router decides you should know about a pub message you
  weren't tagged in.

When you wake, the task body tells you what triggered the wake and
what's expected of you. Read it carefully. End your turn by either
producing a real response (text or reaction) or, if you genuinely
have nothing to add, terminating silently.

## Where the operator is

The operator's profile lives at \`<home>/user.md\` (open it via
\`fs.read\` on \`/user.md\` ... wait, actually that path is rooted
at the home, not your scope. Use \`brain.read_shared\` for the team
note's pointer to operator details, or read \`user.md\` directly via
\`fs.read\` with the absolute path the supervisor exposes).

You also have a private 1:1 chat with the operator at
\`<home>/agents/<your-name>/chat.jsonl\` ... visible to them in the
web UI at \`/agent/<your-name>/chat\`. They post there to talk to
you privately; you can push to it with \`chat.send\`.

## Conventions

- Address peers in pubs with a literal \`@<handle>\`.
- Use \`pub.react\` to acknowledge; never text-reply to ack.
- Capitalize "Agent" as a proper noun when referring to other
  Agents or to yourself.
- No em-dashes; use ellipses (...) where you'd use one.
- Direct, factual language. No "exciting / amazing /
  game-changing." Match the operator's register.

## More

The team note (\`brain.read_shared('team')\`) is the live snapshot
of who's on this instance and what their lane is. Read that next.
`

/**
 * Seed the platform note into the shared brain if it does not
 * already exist. Idempotent: re-running on a populated instance
 * is a no-op.
 */
export async function seedPlatformNote(home: string): Promise<void> {
  const { store, index } = await getOrOpenSharedBrain(home)
  const existing = await store.list({ limit: 1000 })
  if (existing.some((n) => n.slug === PLATFORM_SLUG)) {
    return
  }
  const result = await store.write({
    title: '2200 platform overview',
    body: PLATFORM_NOTE_BODY,
    slug: PLATFORM_SLUG,
    type: 'platform',
    tags: ['platform', 'orientation'],
  })
  const note = await store.read(result.slug)
  index.upsert(note)
}

/**
 * Regenerate the team note in the shared brain from the supervisor's
 * current snapshot. Always overwrites; the team note is a pure
 * derivation of state.
 */
export async function regenerateTeamNote(home: string, supervisor: Supervisor): Promise<void> {
  const snap = supervisor.snapshot()
  const agents = Object.values(snap.agents).sort((a, b) =>
    a.identity_path.localeCompare(b.identity_path),
  )

  const lines: string[] = [
    `# Team`,
    ``,
    `Snapshot of the Agents on this 2200 instance, regenerated whenever the`,
    `fleet changes. Each stanza names one Agent and its current state. The`,
    `Identity file (\`<home>/agents/<name>/identity.md\`) is the source of`,
    `truth for what each Agent does day-to-day; this note is the index.`,
    ``,
    `Total Agents: ${String(agents.length)}`,
    ``,
  ]

  for (const a of agents) {
    lines.push(`## ${a.name}`)
    lines.push(``)
    lines.push(`- State: \`${a.state}\``)
    lines.push(`- Identity: \`${a.identity_path}\``)
    if (a.pid !== null) lines.push(`- PID: \`${String(a.pid)}\``)
    lines.push(``)
    lines.push(
      `Read their Identity for the full role description: \`fs.read /agents/${a.name}/identity.md\` ... or, if they have granted permission, \`brain.search_agent('${a.name}', '<query>')\` to look at what they've been writing about.`,
    )
    lines.push(``)
  }

  if (agents.length === 0) {
    lines.push(`*(No Agents yet. The first one to spawn will appear here.)*`)
    lines.push(``)
  }

  const { store, index } = await getOrOpenSharedBrain(home)
  const result = await store.write({
    title: 'Team',
    body: lines.join('\n'),
    slug: TEAM_SLUG,
    type: 'team-roster',
    tags: ['team', 'orientation'],
  })
  const note = await store.read(result.slug)
  index.upsert(note)
}

/**
 * Build the body for a freshly-spawned Agent's first task. The task
 * tells them to orient via the shared brain, then chat.send a brief
 * back to the operator covering what they learned and what their
 * first move is on the lane they were just spawned for.
 */
export function buildOrientationTaskBody(args: {
  agentName: string
  agentRole: string
  operatorAddressing: string
}): string {
  return `Welcome. You were just spawned. Before doing anything else, take a
moment to orient yourself.

Steps:

1. Call \`brain.search_shared('platform')\` and read the
   "2200 platform overview" note. It tells you what 2200 is, what
   tools you have, how pubs work, and the conventions you are
   expected to follow.

2. Call \`brain.search_shared('team')\` and read the "Team" note.
   It is a live snapshot of who is on this instance. Note who you
   might collaborate with on your lane.

3. Read your own Identity (\`fs.read /brain/identity.md\`) and your
   continuity-from-onboarding brain note
   (\`brain.read('continuity-from-onboarding')\`) so you know the
   conversation that brought you into existence. This is your spec.

4. When you have read those, call \`chat.send\` to deliver a short
   brief to ${args.operatorAddressing}. Cover three things:
   - What 2200 is (in your own words, one sentence).
   - Who is on the team and who you might work with.
   - What your first move is on the lane you were hired for
     (${args.agentRole}). Be concrete, not aspirational.

End the task after \`chat.send\` returns. Do not continue working on
the lane until ${args.operatorAddressing} replies.`
}
