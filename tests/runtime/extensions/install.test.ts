import { mkdtemp, mkdir, rm, writeFile, readFile, stat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  installExtension,
  uninstallExtension,
  updateExtension,
  ExtensionInstallError,
  type ApprovePermissions,
} from '../../../src/runtime/extensions/install.js'
import { readGrants } from '../../../src/runtime/extensions/grants.js'
import { extensionStatePaths, extensionStateDir } from '../../../src/runtime/storage/layout.js'
import type { ResolvedSource } from '../../../src/runtime/extensions/source.js'
import type { ExtensionPermission } from '../../../src/runtime/extensions/types.js'

let home: string
let sourceRoot: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-ext-inst-'))
  sourceRoot = await mkdtemp(join(tmpdir(), '2200-ext-src-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
  await rm(sourceRoot, { recursive: true, force: true })
})

interface MakeSourceArgs {
  name: string
  version?: string
  permissions?: ExtensionPermission[]
  installHook?: { file: string; content: string }
  uninstallHook?: { file: string; content: string }
  updateHook?: { file: string; content: string }
  tickHook?: { file: string; content: string }
  schedules?: { id: string; cron: string; description?: string }[]
}

async function makeSource(args: MakeSourceArgs): Promise<string> {
  const dir = join(sourceRoot, `${args.name}-${args.version ?? '0.1.0'}`)
  await mkdir(dir, { recursive: true })
  const manifest: Record<string, unknown> = {
    schema_version: 1,
    name: args.name,
    version: args.version ?? '0.1.0',
    display_name: args.name,
    description: `Test extension ${args.name}`,
    author: 'Test',
    permissions: args.permissions ?? [],
    schedules: args.schedules ?? [],
    tools: [],
    hooks: {},
  }
  const hooks: Record<string, string> = {}
  if (args.installHook) {
    hooks['install'] = args.installHook.file
    const path = join(dir, args.installHook.file)
    await writeFile(path, args.installHook.content, 'utf8')
    await chmod(path, 0o755)
  }
  if (args.uninstallHook) {
    hooks['uninstall'] = args.uninstallHook.file
    const path = join(dir, args.uninstallHook.file)
    await writeFile(path, args.uninstallHook.content, 'utf8')
    await chmod(path, 0o755)
  }
  if (args.updateHook) {
    hooks['update'] = args.updateHook.file
    const path = join(dir, args.updateHook.file)
    await writeFile(path, args.updateHook.content, 'utf8')
    await chmod(path, 0o755)
  }
  if (args.tickHook) {
    hooks['tick'] = args.tickHook.file
    const path = join(dir, args.tickHook.file)
    await writeFile(path, args.tickHook.content, 'utf8')
    await chmod(path, 0o755)
  }
  manifest['hooks'] = hooks
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  return dir
}

function localSource(rootDir: string, origin = rootDir): ResolvedSource {
  return {
    rootDir,
    kind: 'local',
    origin,
    cleanup: () => Promise.resolve(),
  }
}

const approveAll: ApprovePermissions = (manifest) =>
  Promise.resolve({
    requested: manifest.permissions,
    approved: manifest.permissions,
  })

const denyAll: ApprovePermissions = () => Promise.resolve(null)

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('installExtension', () => {
  it('copies files, persists grants, runs install hook', async () => {
    const src = await makeSource({
      name: 'hello',
      permissions: ['network'],
      installHook: {
        file: 'install.sh',
        content: `#!/usr/bin/env bash\necho installed\n`,
      },
    })
    const result = await installExtension({
      home,
      source: localSource(src),
      approve: approveAll,
    })
    expect(result.aborted).toBe(false)
    expect(result.granted).toEqual(['network'])
    expect(result.hookResult?.exitCode).toBe(0)

    const installedDir = join(home, 'extensions', 'hello')
    expect(await dirExists(installedDir)).toBe(true)
    expect(await fileExists(join(installedDir, 'manifest.json'))).toBe(true)

    const grants = await readGrants(home, 'hello')
    expect(grants.permissions).toEqual(['network'])

    const stateFile = extensionStatePaths(home, 'hello').state
    expect(await fileExists(stateFile)).toBe(true)
  })

  it('refuses to overwrite an existing install without --force', async () => {
    const src = await makeSource({ name: 'dup' })
    await installExtension({ home, source: localSource(src), approve: approveAll })
    await expect(
      installExtension({ home, source: localSource(src), approve: approveAll }),
    ).rejects.toBeInstanceOf(ExtensionInstallError)
  })

  it('replaces an existing install with --force', async () => {
    const src1 = await makeSource({ name: 'replaced', version: '0.1.0' })
    await installExtension({ home, source: localSource(src1), approve: approveAll })
    const src2 = await makeSource({ name: 'replaced', version: '0.2.0' })
    const r2 = await installExtension({
      home,
      source: localSource(src2),
      approve: approveAll,
      force: true,
    })
    expect(r2.manifest.version).toBe('0.2.0')
  })

  it('aborts on user denial without writing anything', async () => {
    const src = await makeSource({ name: 'denied' })
    const result = await installExtension({
      home,
      source: localSource(src),
      approve: denyAll,
    })
    expect(result.aborted).toBe(true)
    expect(await dirExists(join(home, 'extensions', 'denied'))).toBe(false)
  })

  it('rolls back when the install hook fails', async () => {
    const src = await makeSource({
      name: 'badhook',
      installHook: { file: 'install.sh', content: `#!/usr/bin/env bash\nexit 9\n` },
    })
    await expect(
      installExtension({
        home,
        source: localSource(src),
        approve: approveAll,
        hookTimeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(ExtensionInstallError)
    expect(await dirExists(join(home, 'extensions', 'badhook'))).toBe(false)
    expect(await dirExists(extensionStateDir(home, 'badhook'))).toBe(false)
  })

  it('initializes a fs.scratch dir when granted', async () => {
    const src = await makeSource({ name: 'scratchy', permissions: ['fs.scratch'] })
    await installExtension({ home, source: localSource(src), approve: approveAll })
    const paths = extensionStatePaths(home, 'scratchy')
    expect(await dirExists(paths.scratch)).toBe(true)
  })

  it('rejects approvals that include permissions not in the manifest', async () => {
    const src = await makeSource({ name: 'misapproved', permissions: ['network'] })
    await expect(
      installExtension({
        home,
        source: localSource(src),
        approve: () =>
          Promise.resolve({
            requested: ['network'] as const,
            approved: ['network', 'pub.send'] as ExtensionPermission[],
          }),
      }),
    ).rejects.toThrow(/not declared in the manifest/)
  })
})

describe('uninstallExtension', () => {
  it('removes static files + state dir on confirm', async () => {
    const src = await makeSource({ name: 'gone' })
    await installExtension({ home, source: localSource(src), approve: approveAll })
    const result = await uninstallExtension({
      home,
      name: 'gone',
      approve: () => Promise.resolve(true),
    })
    expect(result.removed).toBe(true)
    expect(await dirExists(join(home, 'extensions', 'gone'))).toBe(false)
    expect(await dirExists(extensionStateDir(home, 'gone'))).toBe(false)
  })

  it('runs the uninstall hook before tearing down', async () => {
    // The hook itself records evidence of having run via a sentinel
    // file outside the state dir (the uninstall removes the state
    // dir at the end, so the log file inside it is gone by the time
    // the test reads anything).
    const sentinel = join(home, 'farewell.touch')
    const src = await makeSource({
      name: 'hooked',
      uninstallHook: {
        file: 'uninstall.sh',
        content: `#!/usr/bin/env bash\ntouch "${sentinel}"\necho farewell\n`,
      },
    })
    await installExtension({ home, source: localSource(src), approve: approveAll })
    const result = await uninstallExtension({
      home,
      name: 'hooked',
      approve: () => Promise.resolve(true),
    })
    expect(result.hookResult?.exitCode).toBe(0)
    expect(await fileExists(sentinel)).toBe(true)
  })

  it('tears down even when the uninstall hook fails', async () => {
    const src = await makeSource({
      name: 'badbye',
      uninstallHook: { file: 'uninstall.sh', content: `#!/usr/bin/env bash\nexit 3\n` },
    })
    await installExtension({ home, source: localSource(src), approve: approveAll })
    const result = await uninstallExtension({
      home,
      name: 'badbye',
      approve: () => Promise.resolve(true),
      hookTimeoutMs: 5000,
    })
    expect(result.hookFailed).toBe(true)
    expect(await dirExists(join(home, 'extensions', 'badbye'))).toBe(false)
  })

  it('returns removed=false when the extension is not installed', async () => {
    const result = await uninstallExtension({
      home,
      name: 'nope',
      approve: () => Promise.resolve(true),
    })
    expect(result.removed).toBe(false)
  })

  it('aborts on user denial', async () => {
    const src = await makeSource({ name: 'kept' })
    await installExtension({ home, source: localSource(src), approve: approveAll })
    const result = await uninstallExtension({
      home,
      name: 'kept',
      approve: () => Promise.resolve(false),
    })
    expect(result.aborted).toBe(true)
    expect(await dirExists(join(home, 'extensions', 'kept'))).toBe(true)
  })
})

describe('updateExtension', () => {
  it('replaces files and persists new grants on a clean update', async () => {
    const src1 = await makeSource({ name: 'app', version: '0.1.0' })
    await installExtension({ home, source: localSource(src1), approve: approveAll })

    const src2 = await makeSource({
      name: 'app',
      version: '0.2.0',
      permissions: ['network'],
    })
    const result = await updateExtension({
      home,
      source: localSource(src2),
      approveNewPermissions: () => Promise.resolve(true),
    })
    expect(result.aborted).toBe(false)
    expect(result.fromVersion).toBe('0.1.0')
    expect(result.toVersion).toBe('0.2.0')
    expect(result.granted).toEqual(['network'])
    const liveManifest = JSON.parse(
      await readFile(join(home, 'extensions', 'app', 'manifest.json'), 'utf8'),
    ) as { version: string }
    expect(liveManifest.version).toBe('0.2.0')
  })

  it('runs the update hook with FROM/TO versions', async () => {
    const src1 = await makeSource({ name: 'updhook', version: '0.1.0' })
    await installExtension({ home, source: localSource(src1), approve: approveAll })
    const src2 = await makeSource({
      name: 'updhook',
      version: '0.2.0',
      updateHook: {
        file: 'update.sh',
        content: `#!/usr/bin/env bash\necho FROM=$EXTENSION_FROM_VERSION\necho TO=$EXTENSION_TO_VERSION\n`,
      },
    })
    const result = await updateExtension({
      home,
      source: localSource(src2),
      approveNewPermissions: () => Promise.resolve(true),
    })
    expect(result.hookResult?.exitCode).toBe(0)
    const log = await readFile(result.hookResult!.logPath, 'utf8')
    expect(log).toContain('FROM=0.1.0')
    expect(log).toContain('TO=0.2.0')
  })

  it('reverts to the previous version when the update hook fails', async () => {
    const src1 = await makeSource({ name: 'revert', version: '0.1.0' })
    await installExtension({ home, source: localSource(src1), approve: approveAll })
    const src2 = await makeSource({
      name: 'revert',
      version: '0.2.0',
      updateHook: { file: 'update.sh', content: `#!/usr/bin/env bash\nexit 5\n` },
    })
    await expect(
      updateExtension({
        home,
        source: localSource(src2),
        approveNewPermissions: () => Promise.resolve(true),
        hookTimeoutMs: 5000,
      }),
    ).rejects.toBeInstanceOf(ExtensionInstallError)
    const liveManifest = JSON.parse(
      await readFile(join(home, 'extensions', 'revert', 'manifest.json'), 'utf8'),
    ) as { version: string }
    expect(liveManifest.version).toBe('0.1.0')
    const grants = await readGrants(home, 'revert')
    expect(grants.permissions).toEqual([])
  })

  it('refuses to update when not installed', async () => {
    const src = await makeSource({ name: 'fresh', version: '0.1.0' })
    await expect(
      updateExtension({
        home,
        source: localSource(src),
        approveNewPermissions: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(/not installed/)
  })

  it('refuses same-version update without allowSameVersion', async () => {
    const src = await makeSource({ name: 'same', version: '0.1.0' })
    await installExtension({ home, source: localSource(src), approve: approveAll })
    const src2 = await makeSource({ name: 'same', version: '0.1.0' })
    await expect(
      updateExtension({
        home,
        source: localSource(src2),
        approveNewPermissions: () => Promise.resolve(true),
      }),
    ).rejects.toThrow(/already at version 0\.1\.0/)
  })

  it('aborts when the user denies new permissions', async () => {
    const src1 = await makeSource({ name: 'bumpy', version: '0.1.0' })
    await installExtension({ home, source: localSource(src1), approve: approveAll })
    const src2 = await makeSource({
      name: 'bumpy',
      version: '0.2.0',
      permissions: ['pub.send'],
    })
    const result = await updateExtension({
      home,
      source: localSource(src2),
      approveNewPermissions: () => Promise.resolve(false),
    })
    expect(result.aborted).toBe(true)
    const liveManifest = JSON.parse(
      await readFile(join(home, 'extensions', 'bumpy', 'manifest.json'), 'utf8'),
    ) as { version: string }
    expect(liveManifest.version).toBe('0.1.0')
  })
})

describe('schedule lifecycle through install / update / uninstall', () => {
  it('persists schedules on install when the schedule permission is granted', async () => {
    const src = await makeSource({
      name: 'sched-ok',
      permissions: ['schedule'],
      tickHook: { file: 'tick.sh', content: `#!/usr/bin/env bash\necho tick\n` },
      schedules: [{ id: 'tick-1', cron: '0 */1 * * *', description: 'hourly' }],
    })
    const { listExtensionSchedules } = await import('../../../src/runtime/extensions/schedules.js')
    const r = await installExtension({ home, source: localSource(src), approve: approveAll })
    expect(r.schedulesChanged).toBe(true)
    const persisted = await listExtensionSchedules(home, 'sched-ok')
    expect(persisted.map((e) => e.id)).toEqual(['tick-1'])
    expect(persisted[0]?.cron).toBe('0 */1 * * *')
    expect(persisted[0]?.description).toBe('hourly')
  })

  it('refuses to install when schedules exist without the schedule permission', async () => {
    const src = await makeSource({
      name: 'no-sched-perm',
      // permissions intentionally omits 'schedule'
      tickHook: { file: 'tick.sh', content: `#!/usr/bin/env bash\necho tick\n` },
      schedules: [{ id: 'tick-1', cron: '0 */1 * * *' }],
    })
    await expect(
      installExtension({ home, source: localSource(src), approve: approveAll }),
    ).rejects.toThrow(/schedule.*permission is not granted/)
  })

  it('refuses to install when schedules exist without a tick hook', async () => {
    const src = await makeSource({
      name: 'no-tick',
      permissions: ['schedule'],
      // no tickHook declared
      schedules: [{ id: 'tick-1', cron: '0 */1 * * *' }],
    })
    await expect(
      installExtension({ home, source: localSource(src), approve: approveAll }),
    ).rejects.toThrow(/no `hooks.tick` script/)
  })

  it('reports schedulesChanged=false when manifest declares no schedules', async () => {
    const src = await makeSource({ name: 'nosched' })
    const r = await installExtension({ home, source: localSource(src), approve: approveAll })
    expect(r.schedulesChanged).toBe(false)
  })

  it('reconciles schedules across update (preserves last_fired_at on overlap)', async () => {
    const { listExtensionSchedules, recordExtensionScheduleFired } =
      await import('../../../src/runtime/extensions/schedules.js')
    const src1 = await makeSource({
      name: 'recon',
      version: '0.1.0',
      permissions: ['schedule'],
      tickHook: { file: 'tick.sh', content: `#!/usr/bin/env bash\necho tick\n` },
      schedules: [
        { id: 'a', cron: '0 * * * *' },
        { id: 'b', cron: '*/15 * * * *' },
      ],
    })
    await installExtension({ home, source: localSource(src1), approve: approveAll })
    await recordExtensionScheduleFired(home, 'recon', 'a', () => new Date('2026-05-06T12:00:00Z'))

    const src2 = await makeSource({
      name: 'recon',
      version: '0.2.0',
      permissions: ['schedule'],
      tickHook: { file: 'tick.sh', content: `#!/usr/bin/env bash\necho tick\n` },
      schedules: [
        { id: 'a', cron: '0 * * * *' }, // unchanged
        { id: 'c', cron: '*/30 * * * *' }, // new (replaces b)
      ],
    })
    const r = await updateExtension({
      home,
      source: localSource(src2),
      approveNewPermissions: () => Promise.resolve(true),
    })
    expect(r.schedulesChanged).toBe(true)
    const final = await listExtensionSchedules(home, 'recon')
    expect(final.map((e) => e.id)).toEqual(['a', 'c'])
    const a = final.find((e) => e.id === 'a')
    expect(a?.last_fired_at).toBe('2026-05-06T12:00:00.000Z')
  })

  it('reports schedulesChanged=false on update when nothing changed', async () => {
    const src1 = await makeSource({
      name: 'stable',
      version: '0.1.0',
      permissions: ['schedule'],
      tickHook: { file: 'tick.sh', content: `#!/usr/bin/env bash\necho t\n` },
      schedules: [{ id: 'a', cron: '0 * * * *' }],
    })
    await installExtension({ home, source: localSource(src1), approve: approveAll })
    const src2 = await makeSource({
      name: 'stable',
      version: '0.2.0',
      permissions: ['schedule'],
      tickHook: { file: 'tick.sh', content: `#!/usr/bin/env bash\necho t\n` },
      schedules: [{ id: 'a', cron: '0 * * * *' }], // identical to install
    })
    const r = await updateExtension({
      home,
      source: localSource(src2),
      approveNewPermissions: () => Promise.resolve(true),
    })
    expect(r.schedulesChanged).toBe(false)
  })

  it('clears schedules on uninstall and reports schedulesChanged=true', async () => {
    const src = await makeSource({
      name: 'wipeout',
      permissions: ['schedule'],
      tickHook: { file: 'tick.sh', content: `#!/usr/bin/env bash\necho t\n` },
      schedules: [{ id: 'a', cron: '0 * * * *' }],
    })
    await installExtension({ home, source: localSource(src), approve: approveAll })
    const r = await uninstallExtension({
      home,
      name: 'wipeout',
      approve: () => Promise.resolve(true),
    })
    expect(r.removed).toBe(true)
    expect(r.schedulesChanged).toBe(true)
  })

  it('uninstall reports schedulesChanged=false when there were no schedules', async () => {
    const src = await makeSource({ name: 'nosched-bye' })
    await installExtension({ home, source: localSource(src), approve: approveAll })
    const r = await uninstallExtension({
      home,
      name: 'nosched-bye',
      approve: () => Promise.resolve(true),
    })
    expect(r.removed).toBe(true)
    expect(r.schedulesChanged).toBe(false)
  })
})
