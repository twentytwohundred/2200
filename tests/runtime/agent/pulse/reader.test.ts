import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readPulse } from '../../../../src/runtime/agent/pulse/reader.js'
import { agentPaths } from '../../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-pulse-rd-'))
  await mkdir(agentPaths(home, 'hobby').root, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function writePulseFile(content: string): Promise<void> {
  const path = join(agentPaths(home, 'hobby').root, 'pulse.json')
  await writeFile(path, content, 'utf8')
}

describe('readPulse', () => {
  it('returns null when the file is missing', async () => {
    expect(await readPulse(home, 'hobby')).toBeNull()
  })

  it('parses a v2 record', async () => {
    await writePulseFile(
      JSON.stringify({
        schema_version: 2,
        agent: 'hobby',
        state: 'working_medium',
        intensity: 0.4,
        detector_kind: null,
        trip_id: null,
        updated_at: '2026-04-29T20:00:00.000Z',
      }),
    )
    const r = await readPulse(home, 'hobby')
    expect(r?.state).toBe('working_medium')
    expect(r?.intensity).toBe(0.4)
  })

  it('migrates a v1 record (yellow ⇒ working_medium)', async () => {
    await writePulseFile(
      JSON.stringify({
        schema_version: 1,
        agent: 'hobby',
        state: 'yellow',
        detector_kind: null,
        trip_id: null,
        updated_at: '2026-04-29T20:00:00.000Z',
      }),
    )
    const r = await readPulse(home, 'hobby')
    expect(r?.schema_version).toBe(2)
    expect(r?.state).toBe('working_medium')
    expect(typeof r?.intensity).toBe('number')
  })

  it('migrates a v1 record (redlined ⇒ redlined with trip metadata)', async () => {
    await writePulseFile(
      JSON.stringify({
        schema_version: 1,
        agent: 'hobby',
        state: 'redlined',
        detector_kind: 'tool_repetition',
        trip_id: 'trip-1',
        updated_at: '2026-04-29T20:00:00.000Z',
      }),
    )
    const r = await readPulse(home, 'hobby')
    expect(r?.state).toBe('redlined')
    expect(r?.detector_kind).toBe('tool_repetition')
    expect(r?.trip_id).toBe('trip-1')
  })

  it('throws on malformed JSON', async () => {
    await writePulseFile('not json')
    await expect(readPulse(home, 'hobby')).rejects.toThrow(/not valid JSON/)
  })

  it('throws on unknown schema version', async () => {
    await writePulseFile(JSON.stringify({ schema_version: 99 }))
    await expect(readPulse(home, 'hobby')).rejects.toThrow(/unrecognized shape/)
  })
})
