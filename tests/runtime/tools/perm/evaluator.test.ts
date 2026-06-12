/**
 * Tests for the perm-check evaluator and its five active checks.
 *
 * Why this matters: `evaluatePerm` is the authorization gate in front
 * of every tool call an Agent makes. Until 2026-06-12 this layer had
 * ZERO tests ... a regression here silently widens (or breaks) what
 * every Agent on every install is allowed to do. These tests pin the
 * v1 contract from [[2026-04-25-tool-baseline]] +
 * [[2026-04-26-commons-and-storage-root]]:
 *
 *   - authorization is the AND of every check (one fail denies)
 *   - denial reports the FIRST failing check
 *   - cross-Agent paths are denied by default
 *   - /commons/reference/ is human-only for writes
 *   - the perm record carries all nine check types (active + retired
 *     + future placeholders) so historical records stay parseable
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { evaluatePerm } from '../../../../src/runtime/tools/perm/evaluator.js'
import type { PermContext } from '../../../../src/runtime/tools/perm/types.js'
import type { ResolvedScope } from '../../../../src/runtime/storage/path-resolver.js'
import type { ToolDefinition } from '../../../../src/runtime/mcp/tool.js'

function makeTool(
  name: string,
  pathArgs?: { argName: string; operation: 'read' | 'write' | 'delete' }[],
): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    idempotency: 'pure',
    argsSchema: z.object({}),
    ...(pathArgs ? { pathArgs: pathArgs as ToolDefinition['pathArgs'] } : {}),
    execute: () => Promise.resolve(undefined),
  } as ToolDefinition
}

function makeCtx(overrides: Partial<PermContext> = {}): PermContext {
  return {
    callingAgent: 'tester',
    tool: makeTool('fs_read'),
    allowedToolNames: new Set(['fs_read', 'shell_run', 'pub_send']),
    taskIdempotency: null,
    resolvedPaths: new Map<string, ResolvedScope>(),
    shellCommand: null,
    ...overrides,
  }
}

function scope(kind: ResolvedScope['kind'], agent = 'other'): ResolvedScope {
  switch (kind) {
    case 'commons':
    case 'commons_reference':
    case 'commons_scratch':
      return { kind, absolute: `/abs/${kind}`, subpath: 'x.md' }
    default:
      return { kind, absolute: `/abs/${kind}`, agent, subpath: 'x.md' }
  }
}

describe('evaluatePerm', () => {
  it('authorizes when every active check passes or is not applicable', () => {
    const result = evaluatePerm(makeCtx())
    expect(result.authorized).toBe(true)
    expect(result.denial).toBeNull()
  })

  it('one failing check denies, and denial reports the first failure', () => {
    // Tool not in set AND a cross-agent path: tool_in_set runs first,
    // so it must be the reported denial.
    const result = evaluatePerm(
      makeCtx({
        tool: makeTool('not_granted', [{ argName: 'path', operation: 'read' }]),
        resolvedPaths: new Map([['path', scope('cross_agent_brain')]]),
      }),
    )
    expect(result.authorized).toBe(false)
    expect(result.denial?.type).toBe('tool_in_set')
  })

  it('the perm record carries all nine check types, retired + future included', () => {
    const result = evaluatePerm(makeCtx())
    const types = result.checks.map((c) => c.type).sort()
    expect(types).toEqual(
      [
        'tool_in_set',
        'command_pattern',
        'commons_scope',
        'shared_scope',
        'pub_scope',
        'idempotency_compatible',
        'extension_scope',
        'cost_behavior_gate',
        'user_pref',
      ].sort(),
    )
    // Retired + future checks must be not_applicable, never pass/fail.
    for (const t of [
      'idempotency_compatible',
      'extension_scope',
      'cost_behavior_gate',
      'user_pref',
    ]) {
      expect(result.checks.find((c) => c.type === t)?.result).toBe('not_applicable')
    }
  })
})

describe('tool_in_set', () => {
  it('fails with the tool name in the detail when not granted', () => {
    const result = evaluatePerm(makeCtx({ tool: makeTool('vault_read_all') }))
    expect(result.authorized).toBe(false)
    expect(result.denial?.type).toBe('tool_in_set')
    expect(result.denial?.detail).toContain('vault_read_all')
  })

  it('an empty allowed set denies everything', () => {
    const result = evaluatePerm(makeCtx({ allowedToolNames: new Set() }))
    expect(result.authorized).toBe(false)
  })
})

describe('command_pattern', () => {
  it('is not applicable to non-shell tools', () => {
    const result = evaluatePerm(makeCtx())
    expect(result.checks.find((c) => c.type === 'command_pattern')?.result).toBe('not_applicable')
  })

  it('records the inspected command for shell_run (v1 trusts but logs)', () => {
    const result = evaluatePerm(
      makeCtx({ tool: makeTool('shell_run'), shellCommand: 'ls -la /tmp' }),
    )
    const check = result.checks.find((c) => c.type === 'command_pattern')
    expect(check?.result).toBe('pass')
    expect(check?.detail).toContain('ls -la /tmp')
  })

  it('truncates long commands in the perm record', () => {
    const long = 'x'.repeat(500)
    const result = evaluatePerm(makeCtx({ tool: makeTool('shell_run'), shellCommand: long }))
    const check = result.checks.find((c) => c.type === 'command_pattern')
    expect(check?.detail?.length).toBeLessThan(300)
    expect(check?.detail).toContain('...')
  })
})

describe('commons_scope', () => {
  const pathTool = (op: 'read' | 'write' | 'delete') =>
    makeTool('fs_read', [{ argName: 'path', operation: op }])

  it('denies writes to /commons/reference/ (human-only)', () => {
    const result = evaluatePerm(
      makeCtx({
        tool: pathTool('write'),
        resolvedPaths: new Map([['path', scope('commons_reference')]]),
      }),
    )
    expect(result.authorized).toBe(false)
    expect(result.denial?.type).toBe('commons_scope')
    expect(result.denial?.detail).toContain('human-only')
  })

  it('denies deletes to /commons/reference/ too', () => {
    const result = evaluatePerm(
      makeCtx({
        tool: pathTool('delete'),
        resolvedPaths: new Map([['path', scope('commons_reference')]]),
      }),
    )
    expect(result.authorized).toBe(false)
  })

  it('allows reads of /commons/reference/', () => {
    const result = evaluatePerm(
      makeCtx({
        tool: pathTool('read'),
        resolvedPaths: new Map([['path', scope('commons_reference')]]),
      }),
    )
    expect(result.authorized).toBe(true)
  })

  it('allows writes to /commons/scratch/', () => {
    const result = evaluatePerm(
      makeCtx({
        tool: pathTool('write'),
        resolvedPaths: new Map([['path', scope('commons_scratch')]]),
      }),
    )
    expect(result.authorized).toBe(true)
  })

  it("denies any access to another Agent's brain", () => {
    const result = evaluatePerm(
      makeCtx({
        tool: pathTool('read'),
        resolvedPaths: new Map([['path', scope('cross_agent_brain', 'simon')]]),
      }),
    )
    expect(result.authorized).toBe(false)
    expect(result.denial?.type).toBe('commons_scope')
    expect(result.denial?.detail).toContain('brain')
  })

  it('is not applicable when the tool has no path args', () => {
    const result = evaluatePerm(makeCtx())
    expect(result.checks.find((c) => c.type === 'commons_scope')?.result).toBe('not_applicable')
  })

  it('treats a path arg with no descriptor as a read (default-safe)', () => {
    // Tool declares no pathArgs metadata but the dispatcher resolved a
    // path anyway: the operation lookup falls back to 'read', so a
    // reference-dir target passes instead of false-failing.
    const result = evaluatePerm(
      makeCtx({
        tool: makeTool('fs_read'),
        resolvedPaths: new Map([['path', scope('commons_reference')]]),
      }),
    )
    expect(result.authorized).toBe(true)
  })
})

describe('shared_scope', () => {
  it("denies another Agent's shared dir by default", () => {
    const result = evaluatePerm(
      makeCtx({
        tool: makeTool('fs_read', [{ argName: 'path', operation: 'read' }]),
        resolvedPaths: new Map([['path', scope('cross_agent_shared', 'simon')]]),
      }),
    )
    expect(result.authorized).toBe(false)
    // Both commons_scope and shared_scope catch this; commons_scope
    // runs first in the active list, so it owns the denial. The
    // defense-in-depth point is that shared_scope ALSO failed.
    const shared = result.checks.find((c) => c.type === 'shared_scope')
    expect(shared?.result).toBe('fail')
    expect(shared?.detail).toContain('simon')
  })

  it("passes the Agent's own shared dir", () => {
    const result = evaluatePerm(
      makeCtx({
        tool: makeTool('fs_read', [{ argName: 'path', operation: 'write' }]),
        resolvedPaths: new Map([['path', scope('shared', 'tester')]]),
      }),
    )
    expect(result.authorized).toBe(true)
    expect(result.checks.find((c) => c.type === 'shared_scope')?.result).toBe('pass')
  })

  it('is not applicable when no shared paths are touched', () => {
    const result = evaluatePerm(
      makeCtx({
        tool: makeTool('fs_read', [{ argName: 'path', operation: 'read' }]),
        resolvedPaths: new Map([['path', scope('project', 'tester')]]),
      }),
    )
    expect(result.checks.find((c) => c.type === 'shared_scope')?.result).toBe('not_applicable')
  })
})

describe('pub_scope', () => {
  it('is not applicable to non-pub tools', () => {
    const result = evaluatePerm(makeCtx())
    expect(result.checks.find((c) => c.type === 'pub_scope')?.result).toBe('not_applicable')
  })

  it('passes pub tools at v1 with the sub-check breakdown in detail', () => {
    const result = evaluatePerm(makeCtx({ tool: makeTool('pub_send') }))
    const check = result.checks.find((c) => c.type === 'pub_scope')
    expect(check?.result).toBe('pass')
    // The four sub-checks must all be visible in the perm record so
    // a future reader can see what was (not yet) enforced.
    for (const sub of ['pub_membership', 'mention_scope', 'dm_initiation', 'tier_policy']) {
      expect(check?.detail).toContain(sub)
    }
  })
})
