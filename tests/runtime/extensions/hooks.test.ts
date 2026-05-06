import { mkdtemp, mkdir, rm, writeFile, readFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildHookEnv,
  resolveHookCommand,
  runHook,
  HookExecError,
} from '../../../src/runtime/extensions/hooks.js'
import { writeGrants } from '../../../src/runtime/extensions/grants.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-ext-hook-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function makeExt(args: {
  name: string
  hookFile?: string
  hookContent?: string
  hookMode?: number
  version?: string
}): Promise<{ root: string; scriptRel: string }> {
  const root = join(home, 'extensions', args.name)
  await mkdir(root, { recursive: true })
  if (args.hookFile && args.hookContent !== undefined) {
    const path = join(root, args.hookFile)
    await writeFile(path, args.hookContent, 'utf8')
    if (args.hookMode !== undefined) await chmod(path, args.hookMode)
  }
  return { root, scriptRel: args.hookFile ?? 'install.sh' }
}

describe('resolveHookCommand', () => {
  it('routes .js / .mjs / .cjs through node', () => {
    expect(resolveHookCommand('/x/y/install.js').command).toBe(process.execPath)
    expect(resolveHookCommand('/x/y/install.mjs').command).toBe(process.execPath)
    expect(resolveHookCommand('/x/y/install.cjs').command).toBe(process.execPath)
  })

  it('routes .sh / .bash through bash', () => {
    expect(resolveHookCommand('/x/y/install.sh').command).toBe('bash')
    expect(resolveHookCommand('/x/y/install.bash').command).toBe('bash')
  })

  it('runs other extensions directly', () => {
    expect(resolveHookCommand('/x/y/install').command).toBe('/x/y/install')
  })
})

describe('buildHookEnv', () => {
  it('exposes capability-derived variables and inherits the whitelist', async () => {
    const grants = await writeGrants(home, 'capx', ['network', 'fs.scratch'])
    const env = buildHookEnv({
      home,
      name: 'capx',
      version: '1.2.3',
      hook: 'install',
      scriptAbsolute: join(home, 'extensions/capx/install.sh'),
      rootAbsolute: join(home, 'extensions/capx'),
      grants,
      inheritedEnv: { PATH: '/usr/bin', HOME: '/tmp', SECRET: 'leak' },
    })
    expect(env['EXTENSION_2200_HOME']).toBe(home)
    expect(env['EXTENSION_NAME']).toBe('capx')
    expect(env['EXTENSION_VERSION']).toBe('1.2.3')
    expect(env['EXTENSION_HOOK']).toBe('install')
    expect(env['EXTENSION_PERMS']).toBe('fs.scratch,network')
    expect(env['EXTENSION_SCRATCH_DIR']).toContain('/state/extensions/capx/scratch')
    expect(env['EXTENSION_LOG_FILE']).toContain('install.log')
    expect(env['PATH']).toBe('/usr/bin')
    expect(env['HOME']).toBe('/tmp')
    expect(env['SECRET']).toBeUndefined()
  })

  it('omits EXTENSION_SCRATCH_DIR when fs.scratch is not granted', async () => {
    const grants = await writeGrants(home, 'noscratch', ['network'])
    const env = buildHookEnv({
      home,
      name: 'noscratch',
      version: '0.0.1',
      hook: 'install',
      scriptAbsolute: '/x',
      rootAbsolute: '/x',
      grants,
      inheritedEnv: {},
    })
    expect(env['EXTENSION_SCRATCH_DIR']).toBeUndefined()
  })

  it('exposes FROM/TO version only on update', async () => {
    const grants = await writeGrants(home, 'upd', [])
    const upd = buildHookEnv({
      home,
      name: 'upd',
      version: '0.2.0',
      hook: 'update',
      scriptAbsolute: '/x',
      rootAbsolute: '/x',
      grants,
      fromVersion: '0.1.0',
      toVersion: '0.2.0',
      inheritedEnv: {},
    })
    expect(upd['EXTENSION_FROM_VERSION']).toBe('0.1.0')
    expect(upd['EXTENSION_TO_VERSION']).toBe('0.2.0')

    const inst = buildHookEnv({
      home,
      name: 'upd',
      version: '0.2.0',
      hook: 'install',
      scriptAbsolute: '/x',
      rootAbsolute: '/x',
      grants,
      inheritedEnv: {},
    })
    expect(inst['EXTENSION_FROM_VERSION']).toBeUndefined()
    expect(inst['EXTENSION_TO_VERSION']).toBeUndefined()
  })
})

describe('runHook', () => {
  it('runs a successful shell hook and captures stdout/stderr', async () => {
    const grants = await writeGrants(home, 'ok', [])
    const { scriptRel } = await makeExt({
      name: 'ok',
      hookFile: 'install.sh',
      hookContent: `#!/usr/bin/env bash\necho hello-from-hook\necho stderr-from-hook >&2\nexit 0\n`,
      hookMode: 0o755,
    })
    const result = await runHook({
      home,
      name: 'ok',
      version: '0.1.0',
      hook: 'install',
      scriptRelative: scriptRel,
      grants,
      timeoutMs: 5000,
    })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    const log = await readFile(result.logPath, 'utf8')
    expect(log).toContain('hello-from-hook')
    expect(log).toContain('stderr-from-hook')
    expect(log).toContain('exit=0')
  })

  it('captures non-zero exit codes without throwing', async () => {
    const grants = await writeGrants(home, 'fail', [])
    const { scriptRel } = await makeExt({
      name: 'fail',
      hookFile: 'install.sh',
      hookContent: `#!/usr/bin/env bash\nexit 17\n`,
      hookMode: 0o755,
    })
    const result = await runHook({
      home,
      name: 'fail',
      version: '0.1.0',
      hook: 'install',
      scriptRelative: scriptRel,
      grants,
      timeoutMs: 5000,
    })
    expect(result.exitCode).toBe(17)
    expect(result.timedOut).toBe(false)
  })

  it('terminates a runaway hook on timeout', async () => {
    const grants = await writeGrants(home, 'runaway', [])
    const { scriptRel } = await makeExt({
      name: 'runaway',
      hookFile: 'install.sh',
      hookContent: `#!/usr/bin/env bash\nsleep 30\n`,
      hookMode: 0o755,
    })
    const result = await runHook({
      home,
      name: 'runaway',
      version: '0.1.0',
      hook: 'install',
      scriptRelative: scriptRel,
      grants,
      timeoutMs: 200,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
    // Either SIGTERM (cooperative) or SIGKILL (after grace) is fine;
    // both prove the timeout machinery worked end-to-end.
    expect(['SIGTERM', 'SIGKILL']).toContain(result.signal)
  })

  it('throws HookExecError when the script does not exist', async () => {
    const grants = await writeGrants(home, 'missing', [])
    await mkdir(join(home, 'extensions', 'missing'), { recursive: true })
    await expect(
      runHook({
        home,
        name: 'missing',
        version: '0.1.0',
        hook: 'install',
        scriptRelative: 'nonexistent.sh',
        grants,
        timeoutMs: 1000,
      }),
    ).rejects.toBeInstanceOf(HookExecError)
  })

  it('passes the capability env into the hook', async () => {
    const grants = await writeGrants(home, 'envprobe', ['network'])
    const { scriptRel } = await makeExt({
      name: 'envprobe',
      hookFile: 'install.sh',
      hookContent: `#!/usr/bin/env bash\necho perms=$EXTENSION_PERMS\necho name=$EXTENSION_NAME\nexit 0\n`,
      hookMode: 0o755,
    })
    const result = await runHook({
      home,
      name: 'envprobe',
      version: '0.1.0',
      hook: 'install',
      scriptRelative: scriptRel,
      grants,
      timeoutMs: 5000,
    })
    expect(result.exitCode).toBe(0)
    const log = await readFile(result.logPath, 'utf8')
    expect(log).toContain('perms=network')
    expect(log).toContain('name=envprobe')
  })
})
