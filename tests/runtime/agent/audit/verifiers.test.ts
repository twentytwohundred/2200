/**
 * Tests for the per-category audit verifiers. Mechanical pass; no
 * LLM calls. Each test constructs a synthetic LoopEvent transcript
 * + a synthetic ExtractedClaim and asserts the verifier's outcome
 * (verified / unverified / contradicted).
 *
 * Cover:
 *  - file_create: no write call → unverified
 *  - file_create: write attempted but failed → contradicted
 *  - file_create: write ok, no path claimed → verified
 *  - file_create: write ok + virtual path exists + non-empty → verified
 *  - file_create: write ok + virtual path missing on disk → contradicted
 *  - file_create: write ok + virtual path empty → contradicted
 *  - file_create: write ok + host-fs path (not virtual) → unverified
 *  - file_read: read ok → verified; no read call → unverified; read failed → contradicted
 *  - external_send: send ok → verified; no send call → unverified
 *  - tool_invoke: matching tool ok → verified; tool absent → contradicted
 *  - tool_invoke: claim missing tool name → unverified
 *  - process_count: counts match (±1 tolerance) → verified
 *  - process_count: counts diverge by >1 → contradicted
 *  - process_count: missing count → unverified
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyClaim } from '../../../../src/runtime/agent/audit/verifiers.js'
import type { LoopEvent } from '../../../../src/runtime/agent/detectors/types.js'
import type { ExtractedClaim } from '../../../../src/runtime/agent/audit/types.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-audit-verifiers-'))
  await mkdir(join(home, 'agents', 'hobby', 'project'), { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function makeToolEnd(tool: string, ok: boolean, at = 1): LoopEvent {
  return {
    kind: 'tool_call_end',
    at,
    call_id: `call_${tool}_${String(at)}`,
    tool,
    args_hash: 'h',
    iteration: 1,
    ok,
    duration_ms: 10,
  }
}

const ctx = (events: LoopEvent[]) => ({ home, agentName: 'hobby', events })

describe('verifyClaim · file_create', () => {
  it('unverified when no write-class tool call appears', async () => {
    const claim: ExtractedClaim = {
      category: 'file_create',
      verb: 'wrote',
      object: '/project/x',
      path: '/project/x',
    }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_read', true)]))
    expect(out.status).toBe('unverified')
  })

  it('contradicted when writes attempted but all failed', async () => {
    const claim: ExtractedClaim = {
      category: 'file_create',
      verb: 'wrote',
      object: '/project/x',
    }
    const out = await verifyClaim(
      claim,
      ctx([makeToolEnd('fs_write', false), makeToolEnd('fs_write', false)]),
    )
    expect(out.status).toBe('contradicted')
  })

  it('verified on write ok with no path claimed', async () => {
    const claim: ExtractedClaim = { category: 'file_create', verb: 'wrote', object: 'a file' }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_write', true)]))
    expect(out.status).toBe('verified')
  })

  it('verified when virtual path exists on disk with content', async () => {
    await writeFile(join(home, 'agents', 'hobby', 'project', 'x.md'), 'hello', 'utf8')
    const claim: ExtractedClaim = {
      category: 'file_create',
      verb: 'wrote',
      object: '/project/x.md',
      path: '/project/x.md',
    }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_write', true)]))
    expect(out.status).toBe('verified')
  })

  it('contradicted when virtual path is missing post-write', async () => {
    const claim: ExtractedClaim = {
      category: 'file_create',
      verb: 'wrote',
      object: '/project/missing.md',
      path: '/project/missing.md',
    }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_write', true)]))
    expect(out.status).toBe('contradicted')
  })

  it('contradicted when virtual path exists but is empty', async () => {
    await writeFile(join(home, 'agents', 'hobby', 'project', 'empty.md'), '', 'utf8')
    const claim: ExtractedClaim = {
      category: 'file_create',
      verb: 'saved',
      object: '/project/empty.md',
      path: '/project/empty.md',
    }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_write', true)]))
    expect(out.status).toBe('contradicted')
  })

  it('unverified when claimed path is not under a 2200 fs prefix', async () => {
    const claim: ExtractedClaim = {
      category: 'file_create',
      verb: 'wrote',
      object: '/Users/doug/notes.txt',
      path: '/Users/doug/notes.txt',
    }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_write', true)]))
    expect(out.status).toBe('unverified')
  })
})

describe('verifyClaim · file_read', () => {
  it('verified on read ok', async () => {
    const claim: ExtractedClaim = { category: 'file_read', verb: 'read', object: 'the handoff' }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_read', true)]))
    expect(out.status).toBe('verified')
  })
  it('unverified when no read call appears', async () => {
    const claim: ExtractedClaim = { category: 'file_read', verb: 'read', object: 'the handoff' }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_write', true)]))
    expect(out.status).toBe('unverified')
  })
  it('contradicted when reads attempted but all failed', async () => {
    const claim: ExtractedClaim = { category: 'file_read', verb: 'read', object: 'a file' }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_read', false)]))
    expect(out.status).toBe('contradicted')
  })
})

describe('verifyClaim · external_send', () => {
  it('verified on send ok', async () => {
    const claim: ExtractedClaim = {
      category: 'external_send',
      verb: 'sent',
      object: '@simon',
      target: 'simon',
    }
    const out = await verifyClaim(claim, ctx([makeToolEnd('pub_send', true)]))
    expect(out.status).toBe('verified')
  })
  it('unverified when no send call appears', async () => {
    const claim: ExtractedClaim = { category: 'external_send', verb: 'sent', object: 'a message' }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_read', true)]))
    expect(out.status).toBe('unverified')
  })
})

describe('verifyClaim · tool_invoke', () => {
  it('verified when the named tool returned ok', async () => {
    const claim: ExtractedClaim = {
      category: 'tool_invoke',
      verb: 'called',
      object: 'spotify_api',
      tool: 'spotify_api',
    }
    const out = await verifyClaim(claim, ctx([makeToolEnd('spotify_api', true)]))
    expect(out.status).toBe('verified')
  })
  it('contradicted when the named tool was not called', async () => {
    const claim: ExtractedClaim = {
      category: 'tool_invoke',
      verb: 'called',
      object: 'git_push',
      tool: 'git_push',
    }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_read', true)]))
    expect(out.status).toBe('contradicted')
  })
  it('unverified when the claim does not name a tool', async () => {
    const claim: ExtractedClaim = { category: 'tool_invoke', verb: 'ran', object: 'a tool' }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_write', true)]))
    expect(out.status).toBe('unverified')
  })
})

describe('verifyClaim · refusal', () => {
  it('verified when refusal carries a non-trivial reason', async () => {
    const claim: ExtractedClaim = {
      category: 'refusal',
      verb: 'refuse',
      object: 'share the API key',
      reason: 'sharing credentials in a public pub violates my policy',
    }
    const out = await verifyClaim(claim, ctx([]))
    expect(out.status).toBe('verified')
  })
  it('verified when reason lives in the object field (no separate reason)', async () => {
    const claim: ExtractedClaim = {
      category: 'refusal',
      verb: 'cannot',
      object: 'expose the credential because it would breach security policy',
    }
    const out = await verifyClaim(claim, ctx([]))
    expect(out.status).toBe('verified')
  })
  it('unverified when refusal has no reason at all', async () => {
    const claim: ExtractedClaim = {
      category: 'refusal',
      verb: 'refuse',
      object: 'no',
    }
    const out = await verifyClaim(claim, ctx([]))
    expect(out.status).toBe('unverified')
  })
})

describe('verifyClaim · process_count', () => {
  it('verified when counts match exactly', async () => {
    const claim: ExtractedClaim = {
      category: 'process_count',
      verb: 'processed',
      object: '3 files',
      count: 3,
    }
    const out = await verifyClaim(
      claim,
      ctx([
        makeToolEnd('fs_read', true, 1),
        makeToolEnd('fs_read', true, 2),
        makeToolEnd('fs_read', true, 3),
      ]),
    )
    expect(out.status).toBe('verified')
  })
  it('verified within ±1 tolerance', async () => {
    const claim: ExtractedClaim = {
      category: 'process_count',
      verb: 'processed',
      object: '3',
      count: 3,
    }
    // Two successes; claim said 3. Within tolerance (claim ±1).
    const out = await verifyClaim(
      claim,
      ctx([makeToolEnd('fs_read', true, 1), makeToolEnd('fs_read', true, 2)]),
    )
    expect(out.status).toBe('verified')
  })
  it('contradicted when counts diverge by more than 1', async () => {
    const claim: ExtractedClaim = {
      category: 'process_count',
      verb: 'processed',
      object: '5',
      count: 5,
    }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_read', true)]))
    expect(out.status).toBe('contradicted')
  })
  it('unverified when count is missing', async () => {
    const claim: ExtractedClaim = { category: 'process_count', verb: 'processed', object: 'all' }
    const out = await verifyClaim(claim, ctx([makeToolEnd('fs_read', true)]))
    expect(out.status).toBe('unverified')
  })
})

describe('verifyClaim · toolClassOverlay extends class predicates', () => {
  const ctxWith = (events: LoopEvent[], overlay: Record<string, string>) => ({
    home,
    agentName: 'hobby',
    events,
    toolClassOverlay: overlay,
  })

  it('treats an overlay-classified tool as external_send for verification', async () => {
    const claim: ExtractedClaim = {
      category: 'external_send',
      verb: 'checked into',
      object: 'The Open Bar',
    }
    const out = await verifyClaim(
      claim,
      ctxWith([makeToolEnd('openpub.check_in', true)], {
        'openpub.check_in': 'external_send',
      }),
    )
    expect(out.status).toBe('verified')
  })

  it('treats an overlay-classified tool as file_read for verification', async () => {
    const claim: ExtractedClaim = {
      category: 'file_read',
      verb: 'looked at',
      object: 'the pub directory',
    }
    const out = await verifyClaim(
      claim,
      ctxWith([makeToolEnd('openpub.search_pubs', true)], {
        'openpub.search_pubs': 'file_read',
      }),
    )
    expect(out.status).toBe('verified')
  })

  it('leaves an external_send claim unverified when the matching tool is not in any class', async () => {
    const claim: ExtractedClaim = {
      category: 'external_send',
      verb: 'sent',
      object: 'a thing',
    }
    const out = await verifyClaim(
      claim,
      ctxWith([makeToolEnd('openpub.check_in', true)], {
        // wrong class in the overlay
        'openpub.check_in': 'file_read',
      }),
    )
    expect(out.status).toBe('unverified')
  })

  it('does not classify a tool that is not in the overlay even if the verb suggests it', async () => {
    const claim: ExtractedClaim = {
      category: 'external_send',
      verb: 'sent',
      object: 'something',
    }
    const out = await verifyClaim(claim, ctxWith([makeToolEnd('unknown.tool', true)], {}))
    expect(out.status).toBe('unverified')
  })
})
