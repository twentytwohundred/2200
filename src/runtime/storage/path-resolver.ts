/**
 * Virtual path resolution for fs tools.
 *
 * Per [[2026-04-26-commons-and-storage-root]], fs tool calls take paths
 * with one of four virtual prefixes; the runtime resolves them to
 * absolute filesystem paths under 2200_HOME.
 *
 *   /commons/...   -> $2200_HOME/commons/...
 *   /shared/...    -> $2200_HOME/agents/<calling-agent>/shared/...
 *   /project/...   -> $2200_HOME/agents/<calling-agent>/project/...
 *   /brain/...     -> $2200_HOME/agents/<calling-agent>/brain/...
 *
 * Cross-agent shared access is explicit:
 *   /agents/<other>/shared/...
 *   /agents/<other>/brain/... (when permitted)
 *
 * Anything else (no recognized prefix, absolute path outside 2200_HOME,
 * traversal that escapes the resolved root) is rejected at the perm
 * layer with a `commons_scope` denial. The resolver returns a typed
 * result describing the resolution; the perm check uses that to decide.
 */
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { homePaths, agentPaths } from './layout.js'

export type ResolvedScope =
  | { kind: 'commons'; absolute: string; subpath: string }
  | { kind: 'commons_reference'; absolute: string; subpath: string }
  | { kind: 'commons_scratch'; absolute: string; subpath: string }
  | { kind: 'shared'; absolute: string; agent: string; subpath: string }
  | { kind: 'project'; absolute: string; agent: string; subpath: string }
  | { kind: 'brain'; absolute: string; agent: string; subpath: string }
  | { kind: 'cross_agent_shared'; absolute: string; agent: string; subpath: string }
  | { kind: 'cross_agent_brain'; absolute: string; agent: string; subpath: string }

export class PathResolutionError extends Error {
  constructor(
    public readonly code: 'UNRECOGNIZED_PREFIX' | 'ESCAPES_ROOT' | 'INVALID_PATH',
    message: string,
  ) {
    super(message)
    this.name = 'PathResolutionError'
  }
}

export interface ResolveContext {
  /** 2200_HOME root. */
  home: string
  /** Name of the Agent making the call. Used for /shared, /project, /brain prefixes. */
  callingAgent: string
}

/**
 * Resolve a virtual path against the calling Agent's identity. Throws
 * PathResolutionError on any failure. Callers should treat the resolved
 * path as the value to pass to fs operations; the perm layer separately
 * decides whether the call is allowed.
 */
export function resolveVirtualPath(virtualPath: string, ctx: ResolveContext): ResolvedScope {
  if (typeof virtualPath !== 'string' || virtualPath.length === 0) {
    throw new PathResolutionError('INVALID_PATH', 'path must be a non-empty string')
  }

  // Normalize but reject anything that would traverse with `..` segments.
  const normalized = normalize(virtualPath)
  if (normalized.split(sep).some((seg) => seg === '..')) {
    throw new PathResolutionError(
      'INVALID_PATH',
      `path may not contain '..' segments: ${virtualPath}`,
    )
  }

  // Recognize the four base prefixes plus the cross-agent form.
  const paths = homePaths(ctx.home)

  if (normalized.startsWith('/commons/') || normalized === '/commons') {
    const subpath = normalized === '/commons' ? '' : normalized.slice('/commons/'.length)
    const absolute = subpath ? join(paths.commons, subpath) : paths.commons
    enforceContainment(absolute, paths.commons)
    if (subpath.startsWith('reference/') || subpath === 'reference') {
      return { kind: 'commons_reference', absolute, subpath }
    }
    if (subpath.startsWith('scratch/') || subpath === 'scratch') {
      return { kind: 'commons_scratch', absolute, subpath }
    }
    return { kind: 'commons', absolute, subpath }
  }

  if (normalized.startsWith('/shared/') || normalized === '/shared') {
    const subpath = normalized === '/shared' ? '' : normalized.slice('/shared/'.length)
    const myShared = agentPaths(ctx.home, ctx.callingAgent).shared
    const absolute = subpath ? join(myShared, subpath) : myShared
    enforceContainment(absolute, myShared)
    return { kind: 'shared', absolute, agent: ctx.callingAgent, subpath }
  }

  if (normalized.startsWith('/project/') || normalized === '/project') {
    const subpath = normalized === '/project' ? '' : normalized.slice('/project/'.length)
    const myProject = agentPaths(ctx.home, ctx.callingAgent).project
    const absolute = subpath ? join(myProject, subpath) : myProject
    enforceContainment(absolute, myProject)
    return { kind: 'project', absolute, agent: ctx.callingAgent, subpath }
  }

  if (normalized.startsWith('/brain/') || normalized === '/brain') {
    const subpath = normalized === '/brain' ? '' : normalized.slice('/brain/'.length)
    const myBrain = agentPaths(ctx.home, ctx.callingAgent).brain
    const absolute = subpath ? join(myBrain, subpath) : myBrain
    enforceContainment(absolute, myBrain)
    return { kind: 'brain', absolute, agent: ctx.callingAgent, subpath }
  }

  // Cross-agent form: /agents/<other>/shared/... or /agents/<other>/brain/...
  if (normalized.startsWith('/agents/')) {
    const after = normalized.slice('/agents/'.length)
    const slashIdx = after.indexOf('/')
    if (slashIdx === -1) {
      throw new PathResolutionError(
        'UNRECOGNIZED_PREFIX',
        `cross-agent path must include a section: /agents/<name>/shared/... or /agents/<name>/brain/...`,
      )
    }
    const otherAgent = after.slice(0, slashIdx)
    const rest = after.slice(slashIdx + 1)
    if (rest.startsWith('shared/') || rest === 'shared') {
      const subpath = rest === 'shared' ? '' : rest.slice('shared/'.length)
      const otherShared = agentPaths(ctx.home, otherAgent).shared
      const absolute = subpath ? join(otherShared, subpath) : otherShared
      enforceContainment(absolute, otherShared)
      return { kind: 'cross_agent_shared', absolute, agent: otherAgent, subpath }
    }
    if (rest.startsWith('brain/') || rest === 'brain') {
      const subpath = rest === 'brain' ? '' : rest.slice('brain/'.length)
      const otherBrain = agentPaths(ctx.home, otherAgent).brain
      const absolute = subpath ? join(otherBrain, subpath) : otherBrain
      enforceContainment(absolute, otherBrain)
      return { kind: 'cross_agent_brain', absolute, agent: otherAgent, subpath }
    }
    throw new PathResolutionError(
      'UNRECOGNIZED_PREFIX',
      `cross-agent paths support /agents/<name>/shared/... and /agents/<name>/brain/...; got ${virtualPath}`,
    )
  }

  // Anything else: reject. v1 is sandboxed by default; future per-Agent
  // permissions can opt in to absolute paths outside 2200_HOME.
  if (isAbsolute(normalized)) {
    throw new PathResolutionError(
      'UNRECOGNIZED_PREFIX',
      `absolute paths outside 2200_HOME are not permitted by default at v1: ${virtualPath}`,
    )
  }

  throw new PathResolutionError(
    'UNRECOGNIZED_PREFIX',
    `path must start with one of /commons, /shared, /project, /brain, or /agents/<name>/...; got ${virtualPath}`,
  )
}

/** Throw if `absolute` is outside `root` after path normalization. */
function enforceContainment(absolute: string, root: string): void {
  const resolved = resolve(absolute)
  const rel = relative(resolve(root), resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new PathResolutionError(
      'ESCAPES_ROOT',
      `resolved path escapes the expected root: ${absolute}`,
    )
  }
}
