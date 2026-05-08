import { mkdtemp, rm, writeFile, mkdir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  SAVED_TRANSCRIPT_SCHEMA_VERSION,
  TranscriptStoreError,
  listTranscripts,
  loadTranscript,
  saveTranscript,
} from '../../../src/runtime/onboarding/transcript-store.js'
import type { InterviewTranscript } from '../../../src/runtime/onboarding/types.js'
import { onboardingTranscriptsDir } from '../../../src/runtime/storage/layout.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-tx-store-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function fakeTranscript(): InterviewTranscript {
  return {
    interview_schema_version: 2,
    script_name: 'default-v1',
    chosen_branch: 'freeform',
    entries: [
      {
        question_id: 'opening',
        question_text: 'What kind of Agent do you want?',
        answer: 'A helpful one.',
        asked_at: '2026-05-06T12:00:30.000Z',
      },
    ],
    summary: 'I am a helpful Agent.',
    started_at: '2026-05-06T12:00:00.000Z',
    finished_at: '2026-05-06T12:05:00.000Z',
  }
}

describe('saveTranscript', () => {
  it('persists with the documented filename shape', async () => {
    const fixed = new Date('2026-05-06T12:30:45.500Z')
    const path = await saveTranscript({
      home,
      agentName: 'emma',
      transcript: fakeTranscript(),
      now: () => fixed,
    })
    // Filename uses the file-safe ISO (colons → dashes).
    expect(path).toContain('emma-2026-05-06T12-30-45.500Z.json')
    const dir = onboardingTranscriptsDir(home)
    const names = await readdir(dir)
    expect(names).toEqual(['emma-2026-05-06T12-30-45.500Z.json'])
  })

  it('round-trips through loadTranscript', async () => {
    const transcript = fakeTranscript()
    const path = await saveTranscript({ home, agentName: 'rt', transcript })
    const r = await loadTranscript(path)
    expect(r.agent_name).toBe('rt')
    expect(r.schema_version).toBe(SAVED_TRANSCRIPT_SCHEMA_VERSION)
    expect(r.transcript.summary).toBe(transcript.summary)
  })
})

describe('loadTranscript', () => {
  it('throws TranscriptStoreError on missing file', async () => {
    await expect(loadTranscript(join(home, 'nope.json'))).rejects.toBeInstanceOf(
      TranscriptStoreError,
    )
  })

  it('throws on malformed JSON', async () => {
    const path = join(home, 'broken.json')
    await writeFile(path, 'not json', 'utf8')
    await expect(loadTranscript(path)).rejects.toThrow(/invalid JSON/)
  })

  it('throws on schema mismatch', async () => {
    const path = join(home, 'wrong-shape.json')
    await writeFile(path, JSON.stringify({ schema_version: 1, foo: 'bar' }), 'utf8')
    await expect(loadTranscript(path)).rejects.toThrow(/Onboarding transcript at/)
  })
})

describe('listTranscripts', () => {
  it('returns [] when the dir is missing', async () => {
    expect(await listTranscripts(home)).toEqual([])
  })

  it('lists transcripts sorted oldest-first', async () => {
    const t1 = new Date('2026-05-06T10:00:00.000Z')
    const t2 = new Date('2026-05-06T11:00:00.000Z')
    await saveTranscript({
      home,
      agentName: 'first',
      transcript: fakeTranscript(),
      now: () => t1,
    })
    await saveTranscript({
      home,
      agentName: 'second',
      transcript: fakeTranscript(),
      now: () => t2,
    })
    const list = await listTranscripts(home)
    expect(list.map((e) => e.agent_name)).toEqual(['first', 'second'])
    expect(list.map((e) => e.saved_at)).toEqual([t1.toISOString(), t2.toISOString()])
  })

  it('filters by agent name when provided', async () => {
    await saveTranscript({ home, agentName: 'a', transcript: fakeTranscript() })
    await saveTranscript({ home, agentName: 'b', transcript: fakeTranscript() })
    const onlyA = await listTranscripts(home, 'a')
    expect(onlyA.map((e) => e.agent_name)).toEqual(['a'])
  })

  it('skips malformed entries silently', async () => {
    await saveTranscript({ home, agentName: 'good', transcript: fakeTranscript() })
    const dir = onboardingTranscriptsDir(home)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.json'), 'not json', 'utf8')
    const list = await listTranscripts(home)
    expect(list.map((e) => e.agent_name)).toEqual(['good'])
  })
})
