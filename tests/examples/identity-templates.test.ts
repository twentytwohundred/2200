/**
 * Sanity tests for the example Identity templates that ship with the
 * repo (Epic 3.5).
 *
 * These templates are intended for the two-agent-demo runbook. They
 * must:
 *   - Pass the Identity loader's Zod validation.
 *   - Declare a `pub:` block (otherwise the demo's wake source would
 *     never attach).
 *   - Use a real model binding (`<provider>/<model_id>` shape).
 *
 * If a future PR drifts the Identity schema, this test catches the
 * mismatch before the runbook breaks for an operator.
 */
import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { loadIdentity } from '../../src/runtime/identity/loader.js'

const REPO_ROOT = resolve(__dirname, '..', '..')

describe('example/identities/hobby.identity.md', () => {
  it('loads cleanly and declares a pub block', async () => {
    const ident = await loadIdentity(resolve(REPO_ROOT, 'examples/identities/hobby.identity.md'))
    expect(ident.frontmatter.agent_name).toBe('hobby')
    expect(ident.frontmatter.pub).toBeDefined()
    expect(ident.frontmatter.pub?.handle).toBe('@hobby')
    expect(ident.frontmatter.model.provider).toBe('anthropic')
    expect(ident.frontmatter.model.model_id).toBe('claude-haiku-4-5')
  })
})

describe('example/identities/simon.identity.md', () => {
  it('loads cleanly and declares a pub block', async () => {
    const ident = await loadIdentity(resolve(REPO_ROOT, 'examples/identities/simon.identity.md'))
    expect(ident.frontmatter.agent_name).toBe('simon')
    expect(ident.frontmatter.pub).toBeDefined()
    expect(ident.frontmatter.pub?.handle).toBe('@simon')
    expect(ident.frontmatter.model.provider).toBe('anthropic')
  })
})
