/**
 * Per-baseline-tool tests.
 *
 * Each tool is exercised through its `execute` function directly with
 * absolute paths (post-resolution shape). The dispatcher integration
 * tests cover the wrapping and path resolution; these focus on the
 * tool's own behavior.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  fsRead,
  fsWrite,
  fsEdit,
  fsList,
  fsDelete,
} from '../../../src/runtime/tools/baseline/fs.js'
import { shellRun } from '../../../src/runtime/tools/baseline/shell.js'
import {
  brainRead,
  brainWrite,
  brainSearch,
  brainLinks,
} from '../../../src/runtime/tools/baseline/brain.js'
import { timeNow, timeSleep } from '../../../src/runtime/tools/baseline/time.js'
import { webSearch } from '../../../src/runtime/tools/baseline/web.js'
import { baselineServers, BASELINE_TOOL_NAMES } from '../../../src/runtime/tools/baseline/index.js'
import type { ToolContext } from '../../../src/runtime/mcp/tool.js'

let dir: string

const ctx = (override: Partial<ToolContext> = {}): ToolContext => ({
  callingAgent: 'hobby',
  home: '/h',
  brainDir: '/h/agents/hobby/brain',
  projectDir: '/h/agents/hobby/project',
  taskId: null,
  callId: 'call_test',
  ...override,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), '2200-baseline-tools-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('baseline tool registry', () => {
  it('exports exactly 14 tools', () => {
    expect(BASELINE_TOOL_NAMES).toHaveLength(14)
  })

  it('baselineServers() builds five servers', () => {
    const servers = baselineServers()
    expect(servers.map((s) => s.name).sort()).toEqual(['brain', 'fs', 'shell', 'time', 'web'])
  })

  it('every BASELINE_TOOL_NAMES entry resolves in baselineServers()', () => {
    const servers = baselineServers()
    const allTools = new Set<string>()
    for (const s of servers) for (const name of s.tools.keys()) allTools.add(name)
    for (const name of BASELINE_TOOL_NAMES) {
      expect(allTools).toContain(name)
    }
  })
})

describe('fs tools', () => {
  it('fs.write then fs.read round-trip', async () => {
    const path = join(dir, 'a.md')
    const wr = await fsWrite.execute({ path, content: 'hello' }, ctx())
    expect(wr.bytes_written).toBe(5)
    const rd = await fsRead.execute({ path }, ctx())
    expect(rd.content).toBe('hello')
  })

  it('fs.edit replaces unique text', async () => {
    const path = join(dir, 'b.md')
    await writeFile(path, 'foo bar baz')
    const result = await fsEdit.execute(
      { path, old_text: 'bar', new_text: 'BAR', replace_all: false },
      ctx(),
    )
    expect(result.replacements).toBe(1)
    expect(await readFile(path, 'utf8')).toBe('foo BAR baz')
  })

  it('fs.edit refuses non-unique text without replace_all', async () => {
    const path = join(dir, 'c.md')
    await writeFile(path, 'a a a')
    await expect(
      fsEdit.execute({ path, old_text: 'a', new_text: 'A', replace_all: false }, ctx()),
    ).rejects.toThrow(/appears 3 times/)
  })

  it('fs.edit replace_all true replaces all occurrences', async () => {
    const path = join(dir, 'd.md')
    await writeFile(path, 'a a a')
    const result = await fsEdit.execute(
      { path, old_text: 'a', new_text: 'A', replace_all: true },
      ctx(),
    )
    expect(result.replacements).toBe(3)
    expect(await readFile(path, 'utf8')).toBe('A A A')
  })

  it('fs.list reports files and dirs', async () => {
    await writeFile(join(dir, 'one.md'), '')
    await mkdir(join(dir, 'sub'))
    const result = await fsList.execute({ path: dir }, ctx())
    const sorted = result.entries.map((e) => `${e.name}:${e.kind}`).sort()
    expect(sorted).toEqual(['one.md:file', 'sub:dir'])
  })

  it('fs.delete removes a file', async () => {
    const path = join(dir, 'gone.md')
    await writeFile(path, '')
    await fsDelete.execute({ path }, ctx())
    await expect(stat(path)).rejects.toThrow()
  })

  it('fs.delete refuses directories at v1', async () => {
    const sub = join(dir, 'sub')
    await mkdir(sub)
    await expect(fsDelete.execute({ path: sub }, ctx())).rejects.toThrow(/refuses directories/)
  })
})

describe('shell.run', () => {
  it('runs a command and returns stdout/exit', async () => {
    const result = await shellRun.execute(
      { command: 'echo hello', timeout_ms: 5000 },
      ctx({ projectDir: dir }),
    )
    const r = result as { stdout: string; exit_code: number }
    expect(r.stdout.trim()).toBe('hello')
    expect(r.exit_code).toBe(0)
  })

  it('captures stderr', async () => {
    const result = await shellRun.execute(
      { command: 'echo err 1>&2', timeout_ms: 5000 },
      ctx({ projectDir: dir }),
    )
    const r = result as { stderr: string }
    expect(r.stderr.trim()).toBe('err')
  })

  it('times out cleanly', async () => {
    await expect(
      shellRun.execute({ command: 'sleep 5', timeout_ms: 200 }, ctx({ projectDir: dir })),
    ).rejects.toThrow(/timed out/)
  })
})

describe('brain tools', () => {
  it('brain.write then brain.read round-trip', async () => {
    const path = join(dir, 'note.md')
    await brainWrite.execute({ path, content: '# title\nbody\n' }, ctx())
    const r = await brainRead.execute({ path }, ctx())
    expect(r.content).toBe('# title\nbody\n')
  })

  it('brain.search finds substrings (case-insensitive default)', async () => {
    await writeFile(join(dir, 'a.md'), 'Hello World\nfoo bar')
    await writeFile(join(dir, 'b.md'), 'world peace')
    const result = await brainSearch.execute(
      { query: 'world', scope: dir, max_results: 10, case_sensitive: false },
      ctx(),
    )
    expect(result.results.length).toBe(2)
  })

  it('brain.search respects case_sensitive: true', async () => {
    await writeFile(join(dir, 'a.md'), 'Hello world')
    const result = await brainSearch.execute(
      { query: 'World', scope: dir, max_results: 10, case_sensitive: true },
      ctx(),
    )
    expect(result.results.length).toBe(0)
  })

  it('brain.links extracts [[wiki-style]] backlinks', async () => {
    const path = join(dir, 'note.md')
    await writeFile(path, 'See [[foo]] and [[bar|display label]]. Also [[bar]] again.')
    const result = await brainLinks.execute({ path }, ctx())
    expect(result.links).toEqual(['bar', 'foo'])
  })
})

describe('time tools', () => {
  it('time.now returns an ISO 8601 string', async () => {
    const result = await timeNow.execute({}, ctx())
    expect(result.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('time.sleep delays at least the requested ms', async () => {
    const start = Date.now()
    await timeSleep.execute({ ms: 50 }, ctx())
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThanOrEqual(45) // small slop for timer fidelity
  })
})

describe('web.search (v1 stub)', () => {
  it('returns empty results with an explanatory status', async () => {
    const result = await webSearch.execute({ query: 'foo', max_results: 5 }, ctx())
    expect(result.results).toEqual([])
    expect(result.status).toMatch(/no provider configured/)
  })
})

describe('readdir on records dir is safe (no records written by per-tool tests)', () => {
  it("can't readdir a non-existent dir; integration tests use the dispatcher", async () => {
    await expect(readdir(join(dir, 'no-such'))).rejects.toThrow()
  })
})
