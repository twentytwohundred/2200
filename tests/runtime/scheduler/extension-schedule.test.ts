import { mkdtemp, mkdir, rm, writeFile, chmod, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Scheduler } from '../../../src/runtime/scheduler/service.js'
import { installExtension } from '../../../src/runtime/extensions/install.js'
import {
  listExtensionSchedules,
  writeExtensionSchedule,
} from '../../../src/runtime/extensions/schedules.js'
import type { ResolvedSource } from '../../../src/runtime/extensions/source.js'

let home: string
let sourceRoot: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-sched-ext-'))
  sourceRoot = await mkdtemp(join(tmpdir(), '2200-sched-src-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(sourceRoot, { recursive: true, force: true })
})

async function makeExtensionWithTick(args: {
  name: string
  tickContent: string
  schedules: { id: string; cron: string; description?: string }[]
}): Promise<string> {
  const dir = join(sourceRoot, args.name)
  await mkdir(dir, { recursive: true })
  const tickPath = 'tick.sh'
  await writeFile(join(dir, tickPath), args.tickContent, 'utf8')
  await chmod(join(dir, tickPath), 0o755)
  const manifest = {
    schema_version: 1,
    name: args.name,
    version: '0.1.0',
    display_name: args.name,
    description: 'Tick test',
    author: 'Test',
    permissions: ['schedule'],
    schedules: args.schedules,
    tools: [],
    hooks: { tick: tickPath },
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return dir
}

function localSource(rootDir: string): ResolvedSource {
  return { rootDir, kind: 'local', origin: rootDir, cleanup: () => Promise.resolve() }
}

interface CapturedTimer {
  cb: () => void
  ms: number
}

function makeFakeTimer() {
  const timers: CapturedTimer[] = []
  let nextId = 1
  const handles = new Map<number, CapturedTimer>()
  const setTimer = (cb: () => void, ms: number): NodeJS.Timeout => {
    const id = nextId++
    const t = { cb, ms }
    timers.push(t)
    handles.set(id, t)
    return id as unknown as NodeJS.Timeout
  }
  const clearTimer = (handle: NodeJS.Timeout): void => {
    const t = handles.get(handle as unknown as number)
    if (t) {
      const idx = timers.indexOf(t)
      if (idx >= 0) timers.splice(idx, 1)
      handles.delete(handle as unknown as number)
    }
  }
  return { timers, setTimer, clearTimer }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('Scheduler arms extension schedules', () => {
  it('finds and arms a schedule persisted by an extension install', async () => {
    const src = await makeExtensionWithTick({
      name: 'armtest',
      tickContent: `#!/usr/bin/env bash\ntouch "$EXTENSION_2200_HOME/tick-fired-$EXTENSION_SCHEDULE_ID"\n`,
      schedules: [{ id: 'tick-1', cron: '*/5 * * * *' }],
    })
    await installExtension({
      home,
      source: localSource(src),
      approve: (m) => Promise.resolve({ requested: m.permissions, approved: m.permissions }),
    })
    const fake = makeFakeTimer()
    const scheduler = new Scheduler({
      home,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
    })
    const armed = await scheduler.start()
    expect(armed).toBe(1)
    expect(fake.timers).toHaveLength(1)
    scheduler.stop()
  })
})

describe('Scheduler fires extension schedules through the tick hook', () => {
  it('runs the tick hook with EXTENSION_SCHEDULE_ID on fire', async () => {
    const src = await makeExtensionWithTick({
      name: 'firetest',
      tickContent: `#!/usr/bin/env bash\ntouch "$EXTENSION_2200_HOME/tick-fired-$EXTENSION_SCHEDULE_ID"\n`,
      schedules: [{ id: 'tick-a', cron: '*/5 * * * *' }],
    })
    await installExtension({
      home,
      source: localSource(src),
      approve: (m) => Promise.resolve({ requested: m.permissions, approved: m.permissions }),
    })

    const fake = makeFakeTimer()
    const scheduler = new Scheduler({
      home,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
    })
    await scheduler.start()
    // Fire the captured timer manually.
    expect(fake.timers).toHaveLength(1)
    const firstTimer = fake.timers[0]
    if (!firstTimer) throw new Error('expected a captured timer')
    firstTimer.cb()
    // Wait for the FULL fire path to settle: tick hook spawn → log
    // append → recordFired (which sets last_fired_at) → re-arm.
    // Checking last_fired_at is the last-meaningful side effect, so
    // the test cleanup doesn't race the in-flight writes.
    await waitFor(async () => {
      const list = await listExtensionSchedules(home, 'firetest')
      return list[0]?.last_fired_at !== null && list[0]?.last_fired_at !== undefined
    }, 5000)
    expect(await fileExists(join(home, 'tick-fired-tick-a'))).toBe(true)
    const log = await readFile(join(home, 'state', 'extensions', 'firetest', 'tick.log'), 'utf8')
    expect(log).toContain('hook=tick')
    expect(log).toContain('exit=0')
    scheduler.stop()
  })

  it('skips firing when the schedule permission is missing post-install', async () => {
    // Install with the schedule permission so it lands, then revoke
    // by re-writing grants without it (simulating a user revoking
    // the permission out-of-band).
    const src = await makeExtensionWithTick({
      name: 'revoked',
      tickContent: `#!/usr/bin/env bash\ntouch "$EXTENSION_2200_HOME/should-not-exist"\n`,
      schedules: [{ id: 'tick-1', cron: '*/5 * * * *' }],
    })
    await installExtension({
      home,
      source: localSource(src),
      approve: (m) => Promise.resolve({ requested: m.permissions, approved: m.permissions }),
    })
    // Revoke schedule permission directly.
    const { writeGrants } = await import('../../../src/runtime/extensions/grants.js')
    await writeGrants(home, 'revoked', [])

    const fake = makeFakeTimer()
    const scheduler = new Scheduler({
      home,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
    })
    await scheduler.start()
    expect(fake.timers).toHaveLength(1)
    const firstTimer = fake.timers[0]
    if (!firstTimer) throw new Error('expected a captured timer')
    firstTimer.cb()
    // Wait for fire() to complete (recordFired sets last_fired_at)
    // BEFORE checking the sentinel: this ensures the entire fire
    // path settled, including the permission-skip branch's
    // recordFired step. Cleanup then runs against a quiescent home.
    await waitFor(async () => {
      const list = await listExtensionSchedules(home, 'revoked')
      return list[0]?.last_fired_at !== null && list[0]?.last_fired_at !== undefined
    }, 5000)
    expect(await fileExists(join(home, 'should-not-exist'))).toBe(false)
    scheduler.stop()
  })
})

describe('Scheduler reload picks up newly added extension schedules', () => {
  it('arms schedules added after start() on reload', async () => {
    const fake = makeFakeTimer()
    const scheduler = new Scheduler({
      home,
      setTimer: fake.setTimer,
      clearTimer: fake.clearTimer,
    })
    expect(await scheduler.start()).toBe(0)
    expect(fake.timers).toHaveLength(0)

    // Drop a schedule on disk under <home>/state/extensions/late/.
    // The extension's static dir must also exist for listAll to walk
    // it (the function scans <home>/extensions/* for names).
    await mkdir(join(home, 'extensions', 'late'), { recursive: true })
    await writeExtensionSchedule({
      home,
      extensionName: 'late',
      extensionVersion: '0.1.0',
      schedule: { id: 'tick-late', cron: '*/5 * * * *' },
    })

    expect(await scheduler.reload()).toBe(1)
    expect(fake.timers).toHaveLength(1)
    expect((await listExtensionSchedules(home, 'late')).length).toBe(1)
    scheduler.stop()
  })
})

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const tick = 25
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise<void>((r) => setTimeout(r, tick))
  }
}
