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
  readonly state: string
  readonly stateSupervisorJson: string
  readonly stateSupervisorSock: string
  readonly stateSupervisorPid: string
  readonly stateSupervisorLog: string
  readonly stateNotifications: string
  readonly stateOpenpub: string
  readonly config: string
}

export function homePaths(home: string): HomePaths {
  const state = join(home, 'state')
  return {
    home,
    commons: join(home, 'commons'),
    commonsReference: join(home, 'commons', 'reference'),
    commonsScratch: join(home, 'commons', 'scratch'),
    agents: join(home, 'agents'),
    state,
    stateSupervisorJson: join(state, 'supervisor.json'),
    stateSupervisorSock: join(state, 'supervisor.sock'),
    stateSupervisorPid: join(state, 'supervisor.pid'),
    stateSupervisorLog: join(state, 'supervisor.log'),
    stateNotifications: join(state, 'notifications'),
    stateOpenpub: join(state, 'openpub'),
    config: join(home, 'config'),
  }
}

export interface AgentPaths {
  readonly root: string
  readonly identity: string
  readonly project: string
  readonly brain: string
  readonly shared: string
}

export function agentPaths(home: string, agentName: string): AgentPaths {
  const root = join(home, 'agents', agentName)
  return {
    root,
    identity: join(root, 'identity.md'),
    project: join(root, 'project'),
    brain: join(root, 'brain'),
    shared: join(root, 'shared'),
  }
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
}

export function pubPaths(home: string, pubName: string): PubPaths {
  const root = join(home, 'state', 'openpub', pubName)
  return {
    root,
    pubMd: join(root, 'PUB.md'),
    log: join(root, 'pub.log'),
    pid: join(root, 'pub.pid'),
    data: join(root, 'data'),
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
