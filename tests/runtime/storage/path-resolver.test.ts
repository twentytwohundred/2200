/**
 * Tests for the virtual-prefix path resolver.
 */
import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  resolveVirtualPath,
  PathResolutionError,
} from '../../../src/runtime/storage/path-resolver.js'

const HOME = '/var/lib/2200'

describe('/commons/* prefix', () => {
  it('resolves /commons/notes.md to <home>/commons/notes.md and reports kind: commons', () => {
    const r = resolveVirtualPath('/commons/notes.md', { home: HOME, callingAgent: 'hobby' })
    expect(r.kind).toBe('commons')
    expect(r.absolute).toBe(join(HOME, 'commons', 'notes.md'))
  })

  it('reports kind: commons_reference for /commons/reference/...', () => {
    const r = resolveVirtualPath('/commons/reference/brand.md', {
      home: HOME,
      callingAgent: 'hobby',
    })
    expect(r.kind).toBe('commons_reference')
    expect(r.absolute).toBe(join(HOME, 'commons', 'reference', 'brand.md'))
  })

  it('reports kind: commons_scratch for /commons/scratch/...', () => {
    const r = resolveVirtualPath('/commons/scratch/draft.md', {
      home: HOME,
      callingAgent: 'hobby',
    })
    expect(r.kind).toBe('commons_scratch')
    expect(r.absolute).toBe(join(HOME, 'commons', 'scratch', 'draft.md'))
  })

  it('rejects /commons/../etc/passwd traversal', () => {
    expect(() =>
      resolveVirtualPath('/commons/../etc/passwd', { home: HOME, callingAgent: 'hobby' }),
    ).toThrow(PathResolutionError)
  })
})

describe('/shared/* prefix (per-Agent shared dir)', () => {
  it('resolves /shared/x.md to <home>/agents/<calling-agent>/shared/x.md', () => {
    const r = resolveVirtualPath('/shared/x.md', { home: HOME, callingAgent: 'hobby' })
    expect(r.kind).toBe('shared')
    expect(r.absolute).toBe(join(HOME, 'agents', 'hobby', 'shared', 'x.md'))
    if (r.kind === 'shared') expect(r.agent).toBe('hobby')
  })

  it('uses the calling agent identity, not a path', () => {
    const r = resolveVirtualPath('/shared/x.md', { home: HOME, callingAgent: 'simon' })
    expect(r.absolute).toBe(join(HOME, 'agents', 'simon', 'shared', 'x.md'))
  })
})

describe('/project/* prefix (per-Agent project dir)', () => {
  it('resolves /project/code.ts to <home>/agents/<name>/project/code.ts', () => {
    const r = resolveVirtualPath('/project/code.ts', { home: HOME, callingAgent: 'hobby' })
    expect(r.kind).toBe('project')
    expect(r.absolute).toBe(join(HOME, 'agents', 'hobby', 'project', 'code.ts'))
  })
})

describe('/brain/* prefix (per-Agent brain dir)', () => {
  it('resolves /brain/note.md to <home>/agents/<name>/brain/note.md', () => {
    const r = resolveVirtualPath('/brain/note.md', { home: HOME, callingAgent: 'hobby' })
    expect(r.kind).toBe('brain')
    expect(r.absolute).toBe(join(HOME, 'agents', 'hobby', 'brain', 'note.md'))
  })
})

describe('/agents/<other>/{shared,brain}/* (cross-Agent paths)', () => {
  it('resolves /agents/simon/shared/x.md', () => {
    const r = resolveVirtualPath('/agents/simon/shared/x.md', {
      home: HOME,
      callingAgent: 'hobby',
    })
    expect(r.kind).toBe('cross_agent_shared')
    expect(r.absolute).toBe(join(HOME, 'agents', 'simon', 'shared', 'x.md'))
    if (r.kind === 'cross_agent_shared') expect(r.agent).toBe('simon')
  })

  it('resolves /agents/simon/brain/note.md', () => {
    const r = resolveVirtualPath('/agents/simon/brain/note.md', {
      home: HOME,
      callingAgent: 'hobby',
    })
    expect(r.kind).toBe('cross_agent_brain')
    expect(r.absolute).toBe(join(HOME, 'agents', 'simon', 'brain', 'note.md'))
  })

  it('rejects /agents/<other>/project/...', () => {
    expect(() =>
      resolveVirtualPath('/agents/simon/project/x.ts', { home: HOME, callingAgent: 'hobby' }),
    ).toThrow(/cross-agent paths support/)
  })

  it('rejects /agents/<no-section>', () => {
    expect(() =>
      resolveVirtualPath('/agents/simon', { home: HOME, callingAgent: 'hobby' }),
    ).toThrow(/cross-agent path must include a section/)
  })
})

describe('rejection of unrecognized and dangerous paths', () => {
  it('rejects empty path', () => {
    expect(() => resolveVirtualPath('', { home: HOME, callingAgent: 'hobby' })).toThrow(
      PathResolutionError,
    )
  })

  it('rejects absolute paths outside the virtual prefixes', () => {
    expect(() => resolveVirtualPath('/etc/passwd', { home: HOME, callingAgent: 'hobby' })).toThrow(
      /not permitted by default/,
    )
  })

  it('rejects relative paths', () => {
    expect(() => resolveVirtualPath('notes.md', { home: HOME, callingAgent: 'hobby' })).toThrow(
      /must start with one of/,
    )
  })

  it('rejects /unknown-prefix/... (treated as absolute outside 2200_HOME)', () => {
    expect(() =>
      resolveVirtualPath('/unknown/x.md', { home: HOME, callingAgent: 'hobby' }),
    ).toThrow(/not permitted by default/)
  })
})

describe('bare prefix without subpath', () => {
  it('/commons resolves to the commons root', () => {
    const r = resolveVirtualPath('/commons', { home: HOME, callingAgent: 'hobby' })
    expect(r.kind).toBe('commons')
    expect(r.absolute).toBe(join(HOME, 'commons'))
  })

  it('/shared resolves to the calling agent shared dir', () => {
    const r = resolveVirtualPath('/shared', { home: HOME, callingAgent: 'hobby' })
    expect(r.kind).toBe('shared')
    expect(r.absolute).toBe(join(HOME, 'agents', 'hobby', 'shared'))
  })
})
