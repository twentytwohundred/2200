import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Supervisor } from '../../../src/runtime/supervisor/supervisor.js'
import { DEFAULT_RUNTIME_MODE } from '../../../src/runtime/config/runtime-mode.js'

let home: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-sup-mode-'))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('Supervisor runtime-mode plumbing', () => {
  it('defaults to self-hosted when no mode is supplied', async () => {
    const sup = await Supervisor.create({ home })
    expect(sup.getRuntimeMode()).toBe(DEFAULT_RUNTIME_MODE)
    expect(sup.getRuntimeMode()).toBe('self-hosted')
    await sup.shutdown()
  })

  it('honors an explicit hosted-byok option', async () => {
    const sup = await Supervisor.create({ home, runtimeMode: 'hosted-byok' })
    expect(sup.getRuntimeMode()).toBe('hosted-byok')
    await sup.shutdown()
  })

  it('honors an explicit hosted-managed option', async () => {
    const sup = await Supervisor.create({ home, runtimeMode: 'hosted-managed' })
    expect(sup.getRuntimeMode()).toBe('hosted-managed')
    await sup.shutdown()
  })
})
