/**
 * Unit tests for the pub_scope perm check.
 */
import { describe, expect, it } from 'vitest'
import { pubScope } from '../../../../src/runtime/tools/perm/checks/pub-scope.js'
import type { PermContext } from '../../../../src/runtime/tools/perm/types.js'
import type { ToolDefinition } from '../../../../src/runtime/mcp/tool.js'
import { z } from 'zod'

function ctx(toolName: string): PermContext {
  const tool: ToolDefinition = {
    name: toolName,
    description: '',
    idempotency: 'pure',
    argsSchema: z.object({}),
    execute: () => Promise.resolve({}),
  }
  return {
    callingAgent: 'hobby',
    tool,
    allowedToolNames: new Set([toolName]),
    taskIdempotency: null,
    resolvedPaths: new Map(),
    shellCommand: null,
  }
}

describe('pubScope', () => {
  it('returns not_applicable for non-pub tools', () => {
    expect(pubScope(ctx('fs.read')).result).toBe('not_applicable')
    expect(pubScope(ctx('shell.run')).result).toBe('not_applicable')
    expect(pubScope(ctx('brain.write')).result).toBe('not_applicable')
    expect(pubScope(ctx('time.now')).result).toBe('not_applicable')
  })

  it('returns pass with sub-check breakdown for pub tools', () => {
    const out = pubScope(ctx('pub.send'))
    expect(out.type).toBe('pub_scope')
    expect(out.result).toBe('pass')
    expect(out.detail).toContain('pub_membership=')
    expect(out.detail).toContain('mention_scope=')
    expect(out.detail).toContain('dm_initiation=')
    expect(out.detail).toContain('tier_policy=')
  })

  it('passes for each of the four pub tools', () => {
    for (const name of ['pub.send', 'pub.read', 'pub.list_pubs', 'pub.react']) {
      expect(pubScope(ctx(name)).result).toBe('pass')
    }
  })
})
