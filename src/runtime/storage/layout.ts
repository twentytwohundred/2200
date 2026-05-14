/**
 * 2200_HOME directory layout.
 *
 * Per [[2026-04-26-commons-and-storage-root]]:
 *
 *   $2200_HOME/
 *   ├── commons/
 *   │   ├── reference/    (human-writable, agents read-only by default)
 *   │   ├── scratch/      (agent read-write, ephemeral working space)
 *   │   └── ...           (user-organized subdirectories)
 *   ├── agents/
 *   │   └── <name>/
 *   │       ├── identity.md
 *   │       ├── project/
 *   │       ├── brain/
 *   │       └── shared/
 *   ├── state/
 *   │   ├── supervisor.json
 *   │   ├── supervisor.sock
 *   │   ├── supervisor.pid
 *   │   ├── supervisor.log
 *   │   ├── notifications/
 *   │   └── openpub/
 *   │       └── <pub_name>/
 *   │           ├── PUB.md          (openpub-server config; user/Agent edits)
 *   │           ├── pub.log         (stdio capture from the pub-server child)
 *   │           ├── pub.pid         (PID of the supervised pub-server)
 *   │           └── data/           (openpub-server's own state subtree)
 *   └── config/
 *
 * The `commons/` and `agents/<name>/` directories are user/Agent
 * working space; the runtime creates the seed structure on init/create
 * but never policies what users put inside (beyond the perm checks).
 *
 * The `state/` and `config/` directories are runtime-internal; users
 * should not edit files in them directly.
 */
import { join } from 'node:path'

export interface HomePaths {
  readonly home: string
  readonly commons: string
  readonly commonsReference: string
  readonly commonsScratch: string
  readonly agents: string
  /** Shared brain markdown root (Epic 8 Phase B). One file per note at <sharedBrain>/<slug>.md. */
  readonly sharedBrain: string
  /** Shared brain FTS5 index (Epic 8 Phase B). Rebuildable from sharedBrain/. */
  readonly sharedBrainIndex: string
  readonly state: string
  readonly stateSupervisorJson: string
  readonly stateSupervisorSock: string
  readonly stateSupervisorPid: string
  readonly stateSupervisorLog: string
  readonly stateNotifications: string
  readonly stateOpenpub: string
  /** Per-Agent JSONL telemetry root (Epic 4.5). One subdir per Agent name. */
  readonly stateTelemetry: string
  /** Web-app bearer tokens (Epic 15 Phase A). One JSON file per token. */
  readonly stateWebTokens: string
  readonly config: string
  /** User identity markdown (Epic 3 PR B). */
  readonly configUserMd: string
  /** User pub credential file (Epic 3 PR B). Mode 0600. */
  readonly configUserPubSecret: string
  /** Custom OpenAI-compatible LLM endpoints registered by the user. Mode 0600. */
  readonly configEndpoints: string
}

export function homePaths(home: string): HomePaths {
  const state = join(home, 'state')
  const config = join(home, 'config')
  return {
    home,
    commons: join(home, 'commons'),
    commonsReference: join(home, 'commons', 'reference'),
    commonsScratch: join(home, 'commons', 'scratch'),
    agents: join(home, 'agents'),
    sharedBrain: join(home, 'shared', 'brain'),
    sharedBrainIndex: join(state, 'brain', '__shared__', 'brain.db'),
    state,
    stateSupervisorJson: join(state, 'supervisor.json'),
    stateSupervisorSock: join(state, 'supervisor.sock'),
    stateSupervisorPid: join(state, 'supervisor.pid'),
    stateSupervisorLog: join(state, 'supervisor.log'),
    stateNotifications: join(state, 'notifications'),
    stateOpenpub: join(state, 'openpub'),
    stateTelemetry: join(state, 'telemetry'),
    stateWebTokens: join(state, 'web-tokens'),
    config,
    configUserMd: join(config, 'user.md'),
    configUserPubSecret: join(config, 'user.pub.secret'),
    configEndpoints: join(config, 'endpoints.json'),
  }
}

export interface AgentPaths {
  readonly root: string
  readonly identity: string
  readonly project: string
  readonly brain: string
  readonly shared: string
  /** Agent's pub credential file (Epic 3 PR B). Mode 0600. */
  readonly pubSecret: string
  /** Legacy single-thread JSONL (Epic 15 Phase C). Migrated to chatsDir/default.jsonl by MultiChatStore on first read. */
  readonly chatLog: string
  /** Optional per-Agent avatar image (webp). Sits alongside identity.md; absent when the operator hasn't uploaded one. */
  readonly avatarImage: string
  /**
   * Per-Agent pub-membership file. Markdown with frontmatter listing
   * which pubs the Agent attaches a wake source to on boot. When the
   * file is absent, AgentProcess falls back to identity.md's
   * `pub.member_of`. Created/updated by the supervisor's "create
   * studio" flow; safe for operators to edit by hand.
   */
  readonly pubsFile: string
  /** Per-Agent multi-thread chat root (design-system v1.1 port). Each thread is `<chatsDir>/<chat-id>.jsonl`; metadata in `<chatsDir>/index.json`; attachments under `<chatsDir>/<chat-id>/attachments/`. */
  readonly chatsDir: string
  /** Per-Agent chat index.json (chat metadata: id, title, created_at, updated_at, unread, archived). */
  readonly chatsIndex: string
}

export function agentPaths(home: string, agentName: string): AgentPaths {
  const root = join(home, 'agents', agentName)
  const chatsDir = join(root, 'chats')
  return {
    root,
    identity: join(root, 'identity.md'),
    project: join(root, 'project'),
    brain: join(root, 'brain'),
    shared: join(root, 'shared'),
    pubSecret: join(root, 'pub.secret'),
    chatLog: join(root, 'chat.jsonl'),
    chatsDir,
    chatsIndex: join(chatsDir, 'index.json'),
    avatarImage: join(root, 'avatar.webp'),
    pubsFile: join(root, 'pubs.md'),
  }
}

/** Path to a single chat thread's JSONL file. */
export function agentChatThreadPath(home: string, agentName: string, chatId: string): string {
  return join(home, 'agents', agentName, 'chats', `${chatId}.jsonl`)
}

/** Per-chat attachments directory. Created lazily by the multi-chat store on first attach. */
export function agentChatAttachmentsDir(home: string, agentName: string, chatId: string): string {
  return join(home, 'agents', agentName, 'chats', chatId, 'attachments')
}

export function agentChatAttachmentPath(
  home: string,
  agentName: string,
  chatId: string,
  attachmentId: string,
  filename: string,
): string {
  return join(agentChatAttachmentsDir(home, agentName, chatId), `${attachmentId}-${filename}`)
}

/**
 * Per-Agent telemetry directory. One file per UTC day at the leaf:
 *   <home>/state/telemetry/<agent_name>/YYYY-MM-DD.jsonl
 * Created lazily by the TelemetryWriter on first record.
 */
export function agentTelemetryDir(home: string, agentName: string): string {
  return join(home, 'state', 'telemetry', agentName)
}

/**
 * Per-Agent credential vault directory (Epic 9 Phase B). One JSON file
 * per credential at the leaf:
 *   <home>/state/credentials/<agent_name>/<credential_name>.json
 *
 * Each file is a sealed envelope (AES-256-GCM) over the credential
 * value plus its metadata (provider, scopes, expires_at, etc).
 * Per-Agent salt under `salt`. Wrapping key derived via HKDF from
 * the per-instance master key + this salt + a credential-namespace
 * info string, mirroring the SCUT keystore pattern from Epic 4 Phase A.
 *
 * Files are mode 0600. Directory is mode 0700.
 */
export function agentCredentialsDir(home: string, agentName: string): string {
  return join(home, 'state', 'credentials', agentName)
}

export interface AgentCredentialPaths {
  readonly root: string
  readonly salt: string
}

export function agentCredentialPaths(home: string, agentName: string): AgentCredentialPaths {
  const root = agentCredentialsDir(home, agentName)
  return {
    root,
    salt: join(root, 'salt'),
  }
}

export function agentCredentialFilePath(
  home: string,
  agentName: string,
  credentialName: string,
): string {
  return join(agentCredentialsDir(home, agentName), `${credentialName}.json`)
}

/**
 * Per-Agent budget state directory. One file per UTC day:
 *   <home>/state/budget/<agent_name>/YYYY-MM-DD.json
 * Plus a sticky `override.json` (PR E) that, when present, suppresses
 * the budget block until its `until` timestamp passes.
 */
export function agentBudgetDir(home: string, agentName: string): string {
  return join(home, 'state', 'budget', agentName)
}

/**
 * Per-Agent brain index database (Epic 8 PR B). SQLite FTS5
 * over the markdown files at `<home>/agents/<name>/brain/`.
 * Rebuildable; the file substrate at agentPaths(name).brain
 * is the source of truth.
 *   <home>/state/brain/<agent_name>/brain.db
 */
export function agentBrainIndexPath(home: string, agentName: string): string {
  return join(home, 'state', 'brain', agentName, 'brain.db')
}

/**
 * Per-Agent schedules directory (Epic 6). One JSON file per
 * schedule entry:
 *   <home>/state/agents/<agent_name>/schedules/<schedule_id>.json
 * Created lazily on first `2200 schedule add`.
 */
export function agentSchedulesDir(home: string, agentName: string): string {
  return join(home, 'state', 'agents', agentName, 'schedules')
}

/**
 * Per-Extension state directory (Epic 12 Phase B). Layout:
 *   <home>/state/extensions/<name>/
 *   ├── grants.json     permissions the user approved at install time
 *   ├── state.json      key-value bag the Extension can read/write across hooks
 *   ├── scratch/        sandboxed read/write area when fs.scratch is granted
 *   └── *.log           per-hook stdout/stderr capture (install.log etc)
 *
 * The Extension's *static* files (manifest.json, hook scripts, bundled assets)
 * live at `<home>/extensions/<name>/`. State here is the runtime mutable
 * counterpart, separated so an upgrade can replace static files cleanly while
 * preserving Extension state.
 */
export interface ExtensionStatePaths {
  readonly root: string
  readonly grants: string
  readonly state: string
  readonly scratch: string
}

export function extensionStateDir(home: string, name: string): string {
  return join(home, 'state', 'extensions', name)
}

export function extensionStatePaths(home: string, name: string): ExtensionStatePaths {
  const root = extensionStateDir(home, name)
  return {
    root,
    grants: join(root, 'grants.json'),
    state: join(root, 'state.json'),
    scratch: join(root, 'scratch'),
  }
}

export function extensionHookLogPath(
  home: string,
  name: string,
  hook: 'install' | 'uninstall' | 'update' | 'tick',
): string {
  return join(extensionStateDir(home, name), `${hook}.log`)
}

/**
 * Per-Extension schedules directory (Epic 12 Phase B-2). One JSON
 * file per schedule entry: `<home>/state/extensions/<name>/schedules/
 * <schedule_id>.json`. Created lazily by the install orchestrator on
 * first install with a non-empty `schedules[]` manifest field.
 */
export function extensionSchedulesDir(home: string, name: string): string {
  return join(extensionStateDir(home, name), 'schedules')
}

/**
 * Saved onboarding transcripts (Epic 14 Phase A: persistence).
 *
 *   <home>/state/onboarding/transcripts/<agent_name>-<iso>.json
 *
 * Each successful `2200 spawn` invocation persists the full interview
 * transcript here so the operator can audit the conversation that
 * produced an Agent. The same file is the input format for the
 * `2200 spawn --replay <path>` flag, which skips the interview and
 * replays the captured transcript through the Identity / tool /
 * schedule generators.
 */
export function onboardingTranscriptsDir(home: string): string {
  return join(home, 'state', 'onboarding', 'transcripts')
}

/**
 * Per-Agent SCUT identity directory (Epic 4 Phase A). Layout:
 *   <home>/state/identities/<agent_name>/
 *   ├── keys/
 *   │   ├── signing.ed25519       wrapped private key (JSON: iv/ct/tag)
 *   │   ├── encryption.x25519     wrapped private key (JSON: iv/ct/tag)
 *   │   └── salt                  per-Agent HKDF salt (32 raw bytes)
 *   └── provision-state.json      pipeline state (PR E in this stack)
 *
 * Per-Agent wrapping key is derived from the per-instance master key
 * (`<home>/state/master.key`) via HKDF-SHA256 with the per-Agent salt
 * and an info string. Compromise of one Agent's keys does not reveal
 * the master.
 */
export function agentIdentityDir(home: string, agentName: string): string {
  return join(home, 'state', 'identities', agentName)
}

export interface AgentIdentityPaths {
  readonly root: string
  readonly keysDir: string
  readonly signingKey: string
  readonly encryptionKey: string
  readonly salt: string
  readonly provisionState: string
}

export function agentIdentityPaths(home: string, agentName: string): AgentIdentityPaths {
  const root = agentIdentityDir(home, agentName)
  const keysDir = join(root, 'keys')
  return {
    root,
    keysDir,
    signingKey: join(keysDir, 'signing.ed25519'),
    encryptionKey: join(keysDir, 'encryption.x25519'),
    salt: join(keysDir, 'salt'),
    provisionState: join(root, 'provision-state.json'),
  }
}

/**
 * Per-instance master key path. 32 random bytes, mode 0600. Generated
 * on supervisor first boot. Used to derive per-Agent wrapping keys
 * via HKDF-SHA256.
 */
export function masterKeyPath(home: string): string {
  return join(home, 'state', 'master.key')
}

/**
 * Per-pub directory layout.
 *
 * Each pub on a 2200 instance is its own `openpub-server` process
 * (per Epic 3's "channel = pub" model from Poe's contract). The
 * supervisor allocates a free local port on `cli.pub.create`,
 * writes PUB.md with the pub config, and execs `openpub-server`
 * with `PUB_MD_PATH` pointing at it.
 *
 * Pub names are user-chosen strings constrained to a slug shape
 * (lowercase alphanumeric and dashes) so they can serve as both
 * directory names and CLI arguments without quoting.
 */
export interface PubPaths {
  readonly root: string
  readonly pubMd: string
  readonly log: string
  readonly pid: string
  readonly data: string
  /** Per-pub admin secret (mode 0600). Required by pub-server v0.3.3 in LOCAL mode. */
  readonly adminSecret: string
  /** Per-pub Ed25519 signing keypair (mode 0600). Required by pub-server v0.3.3. */
  readonly signingKey: string
}

export function pubPaths(home: string, pubName: string): PubPaths {
  const root = join(home, 'state', 'openpub', pubName)
  return {
    root,
    pubMd: join(root, 'PUB.md'),
    log: join(root, 'pub.log'),
    pid: join(root, 'pub.pid'),
    data: join(root, 'data'),
    adminSecret: join(root, 'admin.secret'),
    signingKey: join(root, 'signing.key.json'),
  }
}

/**
 * Validate a pub name against the slug rule. Throws if the name is
 * not a non-empty lowercase alphanumeric-and-dashes slug.
 *
 * Pub names participate in directory paths and shell-style CLI args
 * so the rule is restrictive on purpose. Users who want a more
 * expressive display name can edit the `name` field inside PUB.md
 * after `pub create`; the slug is the on-disk identifier.
 */
export function assertPubName(pubName: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(pubName)) {
    throw new Error(
      `invalid pub name "${pubName}": must be lowercase alphanumeric with dashes, starting with a letter or digit`,
    )
  }
}
