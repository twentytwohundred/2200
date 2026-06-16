/**
 * Per-baseline-tool tests.
 *
 * Each tool is exercised through its `execute` function directly with
 * absolute paths (post-resolution shape). The dispatcher integration
 * tests cover the wrapping and path resolution; these focus on the
 * tool's own behavior.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  brainList,
  brainDelete,
} from '../../../src/runtime/tools/baseline/brain.js'
import { closeAllBrains } from '../../../src/runtime/brain/registry.js'
import { initHome, initAgentDirs } from '../../../src/runtime/storage/init.js'
import { writeFile as fsWriteFile } from 'node:fs/promises'
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
  it('exports exactly 52 tools (43 prior + 9 embassy shelf tools)', () => {
    // 2026-05-15 v1 scope: bumped to 37 with `credential_request`,
    // 38 with `credential_has`, 39 with `http_request`. 2026-05-16
    // bumped to 40 with `whatsapp_send` and 41 with `discord_send`
    // ... outbound tools for the WhatsApp Inbox + Discord connectors
    // respectively (decision 2026-05-16-connector-per-agent-identity).
    // Bumped to 42 with `task_await_response` (decision
    // 2026-05-16-task-continuation-primitive): the multi-hop
    // primitive that parks a task on a wait_for block.
    // Bumped to 43 with `restart_self`: Agent-self process restart
    // (no cross-Agent target; cross-Agent restart goes through the
    // operator). Field-driven by Jodin's 2026-05-18 stuck-asking-
    // operator-to-restart loop.
    // 2026-05-26 PR-B2: bumped to 52 with the nine embassy-internal
    // shelf tools (shelf_place, shelf_resolve, shelf_reopen,
    // shelf_reprioritize, shelf_remove, shelf_list_mine, shelf_read,
    // shelf_curate_from_inbox, shelf_request_human_placement). These
    // are registered in the global baseline so the dispatcher can
    // resolve them, but the identity-level `tools:` allowlist
    // restricts actual call permission to embassy Agents.
    expect(BASELINE_TOOL_NAMES).toHaveLength(52)
  })

  it('baselineServers() builds eighteen servers (adds shelf)', () => {
    const servers = baselineServers()
    expect(servers.map((s) => s.name).sort()).toEqual([
      'brain',
      'chat',
      'credential',
      'discord',
      'fs',
      'http',
      'image',
      'notification',
      'pub',
      'restart',
      'schedule',
      'shelf',
      'shell',
      'system',
      'task',
      'time',
      'web',
      'whatsapp',
    ])
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

describe('system_whoami', () => {
  it('returns agent_name + provider + model_id from the live identity getter', async () => {
    const servers = baselineServers({
      getIdentity: () =>
        ({
          source_path: '/x',
          body: '',
          frontmatter: {
            agent_name: 'hobby',
            model: { provider: 'deepseek', model_id: 'deepseek-chat' },
            // Cast: only the fields the tool reads need to be valid.
          },
        }) as never,
    })
    const sys = servers.find((s) => s.name === 'system')
    expect(sys).toBeDefined()
    const whoami = sys?.tools.get('system_whoami')
    expect(whoami).toBeDefined()
    const result = await whoami!.execute({}, ctx())
    expect(result).toEqual({
      agent_name: 'hobby',
      provider: 'deepseek',
      model_id: 'deepseek-chat',
      followup_model_id: null,
    })
  })

  it('includes followup_model_id when present', async () => {
    const servers = baselineServers({
      getIdentity: () =>
        ({
          source_path: '/x',
          body: '',
          frontmatter: {
            agent_name: 'hobby',
            model: {
              provider: 'deepseek',
              model_id: 'deepseek-chat',
              followup_model_id: 'deepseek-reasoner',
            },
          },
        }) as never,
    })
    const sys = servers.find((s) => s.name === 'system')!
    const whoami = sys.tools.get('system_whoami')!
    const result = (await whoami.execute({}, ctx())) as {
      followup_model_id: string | null
    }
    expect(result.followup_model_id).toBe('deepseek-reasoner')
  })

  it('throws when invoked without a live identity getter', async () => {
    const servers = baselineServers()
    const sys = servers.find((s) => s.name === 'system')!
    const whoami = sys.tools.get('system_whoami')!
    await expect(whoami.execute({}, ctx())).rejects.toThrow(/system\.whoami unavailable/)
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

describe('shell_run', () => {
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
  // The Epic 8 brain.* tools route through the per-Agent BrainStore +
  // BrainIndex registry, which expects an initialized home dir.
  let home: string
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), '2200-brain-tools-'))
    await initHome(home)
    const idPath = join(home, 'hobby.identity.md')
    await fsWriteFile(
      idPath,
      `---
schema_version: 1
agent_name: hobby
agent_role: test
model:
  tier: frontier
  provider: anthropic
  model_id: claude-opus-4-7
tools: []
project_dir: /tmp/hobby/project
brain_dir: /tmp/hobby/brain
created: 2026-04-26
---

# Identity
`,
    )
    await initAgentDirs(home, 'hobby', idPath)
  })
  afterEach(async () => {
    closeAllBrains()
    await rm(home, { recursive: true, force: true })
  })

  function brainCtx(): ToolContext {
    return ctx({ home, callingAgent: 'hobby' })
  }

  it('brain.write then brain.read round-trip', async () => {
    const w = await brainWrite.execute({ title: 'My note', body: 'hello world' }, brainCtx())
    expect(w.slug).toBe('my-note')
    expect(w.created_or_updated).toBe('created')
    const r = await brainRead.execute({ slug: 'my-note' }, brainCtx())
    expect(r.title).toBe('My note')
    expect(r.body.trim()).toBe('hello world')
    expect(r.type).toBe('freeform')
  })

  it('brain.search finds notes via FTS5', async () => {
    await brainWrite.execute({ title: 'first', body: 'apple banana' }, brainCtx())
    await brainWrite.execute({ title: 'second', body: 'cherry date' }, brainCtx())
    const r = await brainSearch.execute({ query: 'apple', limit: 10 }, brainCtx())
    expect(r.hits.map((h) => h.slug)).toEqual(['first'])
  })

  it('brain.list filters by type', async () => {
    await brainWrite.execute({ title: 'fb', body: 'x', type: 'feedback' }, brainCtx())
    await brainWrite.execute({ title: 'pj', body: 'x', type: 'project' }, brainCtx())
    const r = await brainList.execute({ type: 'feedback', limit: 10 }, brainCtx())
    expect(r.notes.map((n) => n.slug)).toEqual(['fb'])
  })

  it('brain.delete removes both file and index entry', async () => {
    await brainWrite.execute({ title: 'goner', body: 'apple' }, brainCtx())
    const before = await brainSearch.execute({ query: 'apple', limit: 10 }, brainCtx())
    expect(before.hits).toHaveLength(1)
    await brainDelete.execute({ slug: 'goner' }, brainCtx())
    const after = await brainSearch.execute({ query: 'apple', limit: 10 }, brainCtx())
    expect(after.hits).toHaveLength(0)
  })

  it('brain.write upsert preserves created and bumps updated', async () => {
    const w1 = await brainWrite.execute({ title: 't', body: 'a', slug: 'pinned' }, brainCtx())
    expect(w1.created_or_updated).toBe('created')
    const w2 = await brainWrite.execute({ title: 't', body: 'b', slug: 'pinned' }, brainCtx())
    expect(w2.created_or_updated).toBe('updated')
    const r = await brainRead.execute({ slug: 'pinned' }, brainCtx())
    expect(r.body.trim()).toBe('b')
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

describe('web.search', () => {
  it('returns an actionable status when no search key is configured', async () => {
    const prevBrave = process.env['BRAVE_API_KEY']
    const prevPath = process.env['TWENTYTWOHUNDRED_RUNTIME_ENV']
    delete process.env['BRAVE_API_KEY']
    // Point the live runtime.env read at a nonexistent path so this is hermetic
    // (independent of the dev machine's real ~/.config/2200/runtime.env).
    process.env['TWENTYTWOHUNDRED_RUNTIME_ENV'] = join(tmpdir(), 'no-such-2200-runtime.env')
    try {
      const result = await webSearch.execute({ query: 'foo', max_results: 5 }, ctx())
      expect(result.results).toEqual([])
      expect(result.status).toMatch(/BRAVE_API_KEY/)
    } finally {
      if (prevBrave !== undefined) process.env['BRAVE_API_KEY'] = prevBrave
      if (prevPath === undefined) delete process.env['TWENTYTWOHUNDRED_RUNTIME_ENV']
      else process.env['TWENTYTWOHUNDRED_RUNTIME_ENV'] = prevPath
    }
  })

  it('picks up a key added to runtime.env without a restart (the live-read fix)', async () => {
    // The agent process was spawned WITHOUT a Brave key; the operator then
    // pasted one in Settings (which writes runtime.env). The next search must
    // use it ... no daemon/agent restart.
    const prevBrave = process.env['BRAVE_API_KEY']
    const prevPath = process.env['TWENTYTWOHUNDRED_RUNTIME_ENV']
    delete process.env['BRAVE_API_KEY']
    const tmp = await mkdtemp(join(tmpdir(), '2200-rtenv-'))
    const envFile = join(tmp, 'runtime.env')
    await writeFile(envFile, 'export BRAVE_API_KEY=live-key\n')
    process.env['TWENTYTWOHUNDRED_RUNTIME_ENV'] = envFile
    const fetchMock = vi.fn(
      (_url: unknown, _init: unknown): Promise<Response> =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              web: { results: [{ url: 'https://x', title: 'X', description: 'd' }] },
            }),
          text: () => Promise.resolve(''),
        } as unknown as Response),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      const result = await webSearch.execute({ query: 'foo', max_results: 5 }, ctx())
      expect(result.provider).toBe('brave')
      expect(result.results.map((r) => r.url)).toEqual(['https://x'])
      // and it used the key from the file, not process.env
      const init = fetchMock.mock.calls[0]?.[1] as { headers: Record<string, string> }
      expect(init.headers['x-subscription-token']).toBe('live-key')
    } finally {
      vi.unstubAllGlobals()
      if (prevBrave !== undefined) process.env['BRAVE_API_KEY'] = prevBrave
      if (prevPath === undefined) delete process.env['TWENTYTWOHUNDRED_RUNTIME_ENV']
      else process.env['TWENTYTWOHUNDRED_RUNTIME_ENV'] = prevPath
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe('readdir on records dir is safe (no records written by per-tool tests)', () => {
  it("can't readdir a non-existent dir; integration tests use the dispatcher", async () => {
    await expect(readdir(join(dir, 'no-such'))).rejects.toThrow()
  })
})
