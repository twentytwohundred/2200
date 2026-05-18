/**
 * Capability catalog loader tests (Phase F §12 step 4).
 */
import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCapabilities } from '../../../src/runtime/onboarding/capability-loader.js'

const MIN_ENTRY = `---
id: sample
label: Sample
category: email
description: Read and label mail in a sample inbox.
---

# Setup walkthrough

Steps go here.
`

const ANOTHER_ENTRY = `---
id: another
label: Another
category: chat
description: Another sample capability for testing.
---

Body for another.
`

const BAD_ID_ENTRY = `---
id: 2bad
label: Bad
category: chat
description: This has a leading-digit id.
---

Body.
`

const NO_FM_ENTRY = `# No frontmatter

Just markdown.
`

const BAD_YAML_ENTRY = `---
id: badyaml
label: Bad YAML
category: chat
description: this: has: triple colons that break YAML parsing
---

Body.
`

const SHADOWED_ENV_VAR_ENTRY = `---
id: shadower
label: Shadower
category: ai-llm
description: Tries to shadow a substrate-reserved env var.
auth:
  - name: leak
    kind: api_key
    env_var: ANTHROPIC_API_KEY
---

Body.
`

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), '2200-cap-loader-test-'))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('loadCapabilities: happy path', () => {
  it('loads all valid entries from the first-party dir, sorted by id', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'sample.md'), MIN_ENTRY)
      await writeFile(join(dir, 'another.md'), ANOTHER_ENTRY)
      const records = await loadCapabilities({ firstPartyDir: dir })
      expect(records).toHaveLength(2)
      // alphabetical: another < sample
      expect(records[0]?.frontmatter.id).toBe('another')
      expect(records[1]?.frontmatter.id).toBe('sample')
      expect(records[0]?.source_kind).toBe('first-party')
      expect(records[1]?.source_kind).toBe('first-party')
    })
  })

  it('parses body separately from frontmatter', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'sample.md'), MIN_ENTRY)
      const records = await loadCapabilities({ firstPartyDir: dir })
      expect(records[0]?.body).toContain('# Setup walkthrough')
      expect(records[0]?.body).toContain('Steps go here.')
    })
  })

  it('exposes source_path for audit / debugging', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'sample.md'), MIN_ENTRY)
      const records = await loadCapabilities({ firstPartyDir: dir })
      expect(records[0]?.source_path).toBe(join(dir, 'sample.md'))
    })
  })
})

describe('loadCapabilities: empty / missing dir', () => {
  it('returns empty array on missing first-party dir', async () => {
    const records = await loadCapabilities({
      firstPartyDir: '/nonexistent/path/cap-loader-test',
    })
    expect(records).toEqual([])
  })

  it('returns empty array on missing local dir', async () => {
    await withTempDir(async (firstDir) => {
      await writeFile(join(firstDir, 'sample.md'), MIN_ENTRY)
      const records = await loadCapabilities({
        firstPartyDir: firstDir,
        localDir: '/nonexistent/path/local-cap-loader-test',
      })
      expect(records).toHaveLength(1)
      expect(records[0]?.frontmatter.id).toBe('sample')
    })
  })

  it('returns empty array on empty dir (no .md files)', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'README.txt'), 'not markdown')
      const records = await loadCapabilities({ firstPartyDir: dir })
      expect(records).toEqual([])
    })
  })
})

describe('loadCapabilities: malformed entries', () => {
  it('skips entries with no frontmatter, keeps valid ones', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'good.md'), MIN_ENTRY)
      await writeFile(join(dir, 'no-fm.md'), NO_FM_ENTRY)
      const records = await loadCapabilities({ firstPartyDir: dir })
      expect(records).toHaveLength(1)
      expect(records[0]?.frontmatter.id).toBe('sample')
    })
  })

  it('skips entries with bad YAML, keeps valid ones', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'good.md'), MIN_ENTRY)
      await writeFile(join(dir, 'bad-yaml.md'), BAD_YAML_ENTRY)
      const records = await loadCapabilities({ firstPartyDir: dir })
      expect(records).toHaveLength(1)
      expect(records[0]?.frontmatter.id).toBe('sample')
    })
  })

  it('skips entries with schema-invalid id, keeps valid ones', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'good.md'), MIN_ENTRY)
      await writeFile(join(dir, 'bad-id.md'), BAD_ID_ENTRY)
      const records = await loadCapabilities({ firstPartyDir: dir })
      expect(records).toHaveLength(1)
      expect(records[0]?.frontmatter.id).toBe('sample')
    })
  })

  it('skips entries that shadow PROVIDER_ENV_BLOCKLIST, keeps valid ones', async () => {
    await withTempDir(async (dir) => {
      await writeFile(join(dir, 'good.md'), MIN_ENTRY)
      await writeFile(join(dir, 'shadower.md'), SHADOWED_ENV_VAR_ENTRY)
      const records = await loadCapabilities({ firstPartyDir: dir })
      expect(records).toHaveLength(1)
      expect(records[0]?.frontmatter.id).toBe('sample')
    })
  })
})

describe('loadCapabilities: local override semantics', () => {
  it('local entry overrides first-party entry with same id', async () => {
    await withTempDir(async (firstDir) => {
      await withTempDir(async (localDir) => {
        await writeFile(join(firstDir, 'sample.md'), MIN_ENTRY)
        const localOverride = MIN_ENTRY.replace('Sample', 'Sample (Local Override)')
        await writeFile(join(localDir, 'sample.md'), localOverride)
        const records = await loadCapabilities({ firstPartyDir: firstDir, localDir })
        expect(records).toHaveLength(1)
        expect(records[0]?.frontmatter.label).toBe('Sample (Local Override)')
        expect(records[0]?.source_kind).toBe('local')
      })
    })
  })

  it('local entry with no first-party counterpart is added as a new entry', async () => {
    await withTempDir(async (firstDir) => {
      await withTempDir(async (localDir) => {
        await writeFile(join(firstDir, 'sample.md'), MIN_ENTRY)
        await writeFile(join(localDir, 'another.md'), ANOTHER_ENTRY)
        const records = await loadCapabilities({ firstPartyDir: firstDir, localDir })
        expect(records).toHaveLength(2)
        const sample = records.find((r) => r.frontmatter.id === 'sample')
        const another = records.find((r) => r.frontmatter.id === 'another')
        expect(sample?.source_kind).toBe('first-party')
        expect(another?.source_kind).toBe('local')
      })
    })
  })
})
