/**
 * Tests for the MCP restart manager (Epic 9 Phase A PR D).
 *
 * Pure unit tests with the launch function and sleep injected. Verifies:
 *   - the locked backoff schedule (200/1000/5000, then 30s × 2^n
 *     capped at 300s)
 *   - first restart emits a Passive notification
 *   - 5th consecutive failure emits an Important notification
 *   - successful launch after a crash resets the failure counter
 *   - the forwarding tool definition routes through the current handle
 *   - tool calls during the restart window throw "currently down"
 *   - stop() prevents further restarts even if a close event fires
 */
import { describe, expect, it, vi } from 'vitest'
import {
  computeBackoffMs,
  EXPONENTIAL_BASE_MS,
  FAST_RETRY_MS,
  MAX_BACKOFF_MS,
  McpServerManager,
  notificationTierForAttempt,
  type RestartNotifier,
} from '../../../src/runtime/mcp/restart-manager.js'
import type {
  LaunchStdioMcpArgs,
  StdioMcpServerHandle,
} from '../../../src/runtime/mcp/stdio-transport.js'
import type { ToolContext, ToolDefinition } from '../../../src/runtime/mcp/tool.js'
import { defineTool } from '../../../src/runtime/mcp/tool.js'
import { z } from 'zod'

const FAKE_CTX: ToolContext = {
  callingAgent: 'hobby',
  home: '/tmp/unused',
  brainDir: '/tmp/unused',
  projectDir: '/tmp/unused',
  taskId: null,
  callId: 'test-call',
}

interface FakeHandleControls {
  handle: StdioMcpServerHandle
  triggerClose(): void
  closed: { value: boolean }
}

function makeFakeHandle(opts: { name: string; toolNames: string[] }): FakeHandleControls {
  const closed = { value: false }
  const tools = new Map<string, ToolDefinition>()
  let onclose: (() => void) | undefined

  for (const toolName of opts.toolNames) {
    tools.set(
      toolName,
      defineTool({
        name: toolName,
        description: `tool ${toolName}`,
        idempotency: 'destructive',
        argsSchema: z.record(z.string(), z.unknown()),
        execute: (_args, _ctx) => Promise.resolve({ ok: true, tool: toolName }),
      }),
    )
  }

  const handle = {
    name: opts.name,
    tools,
    client: {
      // The Client surface we exercise is just .onclose and .close()
      get onclose() {
        return onclose
      },
      set onclose(fn: (() => void) | undefined) {
        onclose = fn
      },
      close: () => {
        closed.value = true
        return Promise.resolve()
      },
    } as unknown as StdioMcpServerHandle['client'],
    close: async () => {
      closed.value = true
      return Promise.resolve()
    },
  } as unknown as StdioMcpServerHandle

  return {
    handle,
    triggerClose() {
      onclose?.()
    },
    closed,
  }
}

const LAUNCH_ARGS: LaunchStdioMcpArgs = {
  name: 'fake',
  command: '/bin/true',
  args: [],
  env: {},
}

describe('computeBackoffMs', () => {
  it('uses fixed values for the first three retries', () => {
    expect(computeBackoffMs(1)).toBe(FAST_RETRY_MS[0])
    expect(computeBackoffMs(2)).toBe(FAST_RETRY_MS[1])
    expect(computeBackoffMs(3)).toBe(FAST_RETRY_MS[2])
  })

  it('starts the exponential phase at attempt 4 from EXPONENTIAL_BASE_MS', () => {
    expect(computeBackoffMs(4)).toBe(EXPONENTIAL_BASE_MS)
    expect(computeBackoffMs(5)).toBe(EXPONENTIAL_BASE_MS * 2)
    expect(computeBackoffMs(6)).toBe(EXPONENTIAL_BASE_MS * 4)
    expect(computeBackoffMs(7)).toBe(EXPONENTIAL_BASE_MS * 8)
  })

  it('caps at MAX_BACKOFF_MS', () => {
    expect(computeBackoffMs(8)).toBe(MAX_BACKOFF_MS)
    expect(computeBackoffMs(20)).toBe(MAX_BACKOFF_MS)
    expect(computeBackoffMs(100)).toBe(MAX_BACKOFF_MS)
  })

  it('returns 0 for non-positive attempts', () => {
    expect(computeBackoffMs(0)).toBe(0)
    expect(computeBackoffMs(-1)).toBe(0)
  })
})

describe('McpServerManager', () => {
  it('discovers tools on first launch and registers forwarding definitions', async () => {
    const fake = makeFakeHandle({ name: 'fake', toolNames: ['fake_echo', 'fake_read'] })
    const manager = new McpServerManager({
      serverName: 'fake',
      launchArgs: LAUNCH_ARGS,
      notifier: vi.fn(),
      launch: () => Promise.resolve(fake.handle),
    })
    await manager.start()
    expect([...manager.knownToolNames].sort()).toEqual(['fake_echo', 'fake_read'])
    expect(manager.tools.has('fake_echo')).toBe(true)
    expect(manager.isUp).toBe(true)
  })

  it('forwards tool calls to the current handle', async () => {
    const fake = makeFakeHandle({ name: 'fake', toolNames: ['fake_echo'] })
    const manager = new McpServerManager({
      serverName: 'fake',
      launchArgs: LAUNCH_ARGS,
      notifier: vi.fn(),
      launch: () => Promise.resolve(fake.handle),
    })
    await manager.start()
    const tool = manager.tools.get('fake_echo')!
    const result = (await tool.execute({}, FAKE_CTX)) as { ok: boolean; tool: string }
    expect(result.ok).toBe(true)
    expect(result.tool).toBe('fake_echo')
  })

  it('emits a Passive notification on the first restart', async () => {
    let attempt = 0
    const handle1 = makeFakeHandle({ name: 'fake', toolNames: ['fake_echo'] })
    const handle2 = makeFakeHandle({ name: 'fake', toolNames: ['fake_echo'] })
    const launch = vi.fn(() => {
      attempt++
      return Promise.resolve(attempt === 1 ? handle1.handle : handle2.handle)
    })
    const notifier = vi.fn<RestartNotifier>(() => Promise.resolve())
    const manager = new McpServerManager({
      serverName: 'fake',
      launchArgs: LAUNCH_ARGS,
      notifier,
      launch,
      sleep: () => Promise.resolve(),
    })
    await manager.start()
    expect(launch).toHaveBeenCalledTimes(1)

    handle1.triggerClose()
    // Yield event loop so the restart loop runs
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    expect(notifier).toHaveBeenCalled()
    const firstCall = notifier.mock.calls[0]?.[0]
    expect(firstCall?.tier).toBe('passive')
    expect(firstCall?.body).toContain('fake')
    expect(launch).toHaveBeenCalledTimes(2)
    expect(manager.failureCount).toBe(0) // reset after success
    await manager.stop()
  })

  it('notification tier policy: Passive on attempt 1, Important on attempt 5, none otherwise', () => {
    expect(notificationTierForAttempt(1)).toBe('passive')
    expect(notificationTierForAttempt(2)).toBeNull()
    expect(notificationTierForAttempt(3)).toBeNull()
    expect(notificationTierForAttempt(4)).toBeNull()
    expect(notificationTierForAttempt(5)).toBe('important')
    expect(notificationTierForAttempt(6)).toBeNull()
    expect(notificationTierForAttempt(100)).toBeNull()
  })

  it('throws "currently down" on tool calls while the server is between launches', async () => {
    let resolveLaunch: ((value: StdioMcpServerHandle) => void) | undefined
    let launchInvocations = 0
    const initialHandle = makeFakeHandle({ name: 'fake', toolNames: ['fake_echo'] })
    const replacementHandle = makeFakeHandle({ name: 'fake', toolNames: ['fake_echo'] })
    const launch = async (): Promise<StdioMcpServerHandle> => {
      launchInvocations++
      if (launchInvocations === 1) return initialHandle.handle
      // Block the second launch so the test can call a tool while
      // the manager is mid-restart.
      return new Promise<StdioMcpServerHandle>((resolve) => {
        resolveLaunch = resolve
      })
    }
    const manager = new McpServerManager({
      serverName: 'fake',
      launchArgs: LAUNCH_ARGS,
      notifier: vi.fn(),
      launch,
      sleep: () => Promise.resolve(),
    })
    await manager.start()
    const tool = manager.tools.get('fake_echo')!

    // Kill the underlying server.
    initialHandle.triggerClose()
    // Yield once so the restart loop starts and the second launch is pending.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    await expect(tool.execute({}, FAKE_CTX)).rejects.toThrow(/currently down/)

    // Let the second launch finish so stop() does not hang.
    resolveLaunch!(replacementHandle.handle)
    await manager.stop()
  })

  it('stop() prevents further restarts and closes the current handle', async () => {
    const handle1 = makeFakeHandle({ name: 'fake', toolNames: ['t'] })
    const launch = vi.fn(() => Promise.resolve(handle1.handle))
    const manager = new McpServerManager({
      serverName: 'fake',
      launchArgs: LAUNCH_ARGS,
      notifier: vi.fn(),
      launch,
      sleep: () => Promise.resolve(),
    })
    await manager.start()
    expect(handle1.closed.value).toBe(false)
    await manager.stop()
    expect(handle1.closed.value).toBe(true)
    // Trigger close after stop ... no new launch should run.
    handle1.triggerClose()
    await new Promise((r) => setImmediate(r))
    expect(launch).toHaveBeenCalledTimes(1)
  })

  it('a successful restart resets the consecutive-failures counter', async () => {
    let launchCount = 0
    const handles = [
      makeFakeHandle({ name: 'fake', toolNames: ['t'] }),
      makeFakeHandle({ name: 'fake', toolNames: ['t'] }),
      makeFakeHandle({ name: 'fake', toolNames: ['t'] }),
    ]
    const launch = vi.fn(() => {
      const h = handles[launchCount]!.handle
      launchCount++
      return Promise.resolve(h)
    })
    const manager = new McpServerManager({
      serverName: 'fake',
      launchArgs: LAUNCH_ARGS,
      notifier: vi.fn(),
      launch,
      sleep: () => Promise.resolve(),
    })
    await manager.start()
    expect(manager.failureCount).toBe(0)
    handles[0]!.triggerClose()
    for (let i = 0; i < 10 && launchCount < 2; i++) {
      await new Promise((r) => setImmediate(r))
    }
    expect(manager.failureCount).toBe(0) // success after restart resets
    await manager.stop()
  })
})
