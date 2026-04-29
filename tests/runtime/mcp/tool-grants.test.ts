/**
 * Tests for expandToolGrants (Epic 9 Phase A PR C).
 *
 * Pure function; no IO. Covers exact-name passthrough, wildcard
 * expansion against a registry, mixed grants, and the silently-drop
 * behavior when a wildcard matches no registered tools.
 */
import { describe, expect, it } from 'vitest'
import { expandToolGrants } from '../../../src/runtime/mcp/tool-grants.js'

const REGISTRY = [
  'shell.run',
  'fs.read',
  'fs.write',
  'github.list_issues',
  'github.create_issue',
  'github.list_pull_requests',
  'slack.send',
  'slack.read',
]

describe('expandToolGrants', () => {
  it('passes exact tool names through unchanged', () => {
    const out = expandToolGrants(['shell.run', 'slack.send'], REGISTRY)
    expect([...out].sort()).toEqual(['shell.run', 'slack.send'])
  })

  it('expands a namespace wildcard to all tools in the namespace', () => {
    const out = expandToolGrants(['github.*'], REGISTRY)
    expect([...out].sort()).toEqual([
      'github.create_issue',
      'github.list_issues',
      'github.list_pull_requests',
    ])
  })

  it('mixes exact names and wildcards', () => {
    const out = expandToolGrants(['github.*', 'slack.send'], REGISTRY)
    expect([...out].sort()).toEqual([
      'github.create_issue',
      'github.list_issues',
      'github.list_pull_requests',
      'slack.send',
    ])
  })

  it('silently drops a wildcard that matches nothing', () => {
    const out = expandToolGrants(['stripe.*'], REGISTRY)
    expect(out.size).toBe(0)
  })

  it('does not match across namespaces (`github.*` does not catch `githubx.foo`)', () => {
    const out = expandToolGrants(['github.*'], [...REGISTRY, 'githubx.foo'])
    expect(out.has('githubx.foo')).toBe(false)
  })

  it('deduplicates when an exact grant overlaps a wildcard', () => {
    const out = expandToolGrants(['github.*', 'github.list_issues'], REGISTRY)
    expect([...out].sort()).toEqual([
      'github.create_issue',
      'github.list_issues',
      'github.list_pull_requests',
    ])
  })

  it('preserves an exact grant that names a tool not in the registry (caller-side error surfaces later)', () => {
    const out = expandToolGrants(['nonexistent.tool'], REGISTRY)
    expect(out.has('nonexistent.tool')).toBe(true)
  })

  it('handles an empty grant list', () => {
    const out = expandToolGrants([], REGISTRY)
    expect(out.size).toBe(0)
  })
})
