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
 *   │   └── notifications/
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
