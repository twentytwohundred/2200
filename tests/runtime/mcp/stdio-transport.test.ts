/**
 * Tests for the stdio MCP transport (Epic 9 Phase A PR B).
 *
 * Spawns the fake MCP server in `fixtures/fake-mcp-server.mjs` for
 * each test. Asserts:
 *   - the connect + tools/list handshake produces the expected
 *     namespaced tool definitions
 *   - call routing returns the MCP server's content array verbatim
 *   - MCP error responses (isError: true) become thrown errors with
 *     the server's text propagated to the message
 *   - env var propagation: the supervisor's resolved env reaches
 *     the child process
 *   - close() cleans up cleanly
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  spawnStdioMcpServer,
  type StdioMcpServerHandle,
} from '../../../src/runtime/mcp/stdio-transport.js'
import type { ToolContext } from '../../../src/runtime/mcp/tool.js'

const FIXTURE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-mcp-server.mjs',
)

const FAKE_CTX: ToolContext = {
  callingAgent: 'hobby',
  home: '/tmp/unused-by-mcp-tools',
  brainDir: '/tmp/unused/brain',
  projectDir: '/tmp/unused/project',
  taskId: null,
  callId: 'test-call',
}

let handle: StdioMcpServerHandle | undefined

beforeEach(() => {
  handle = undefined
})

afterEach(async () => {
  if (handle !== undefined) {
    await handle.close()
    handle = undefined
  }
})

async function spawnFakeServer(
  opts: {
    name?: string
    env?: Record<string, string>
  } = {},
): Promise<StdioMcpServerHandle> {
  return spawnStdioMcpServer({
    name: opts.name ?? 'fake',
    command: process.execPath,
    args: [FIXTURE_PATH],
    env: {
      // Inherit PATH so the child can find node.
      PATH: process.env['PATH'] ?? '',
      ...(opts.env ?? {}),
    },
  })
}

describe('spawnStdioMcpServer', () => {
  it('lists the fake servers tools, namespaced by the supplied name', async () => {
    handle = await spawnFakeServer({ name: 'fake' })
    expect(handle.name).toBe('fake')
    const toolNames = Array.from(handle.tools.keys()).sort()
    expect(toolNames).toEqual(['fake_echo', 'fake_fail', 'fake_read_env'])
  })

  it('describes each tool from the MCP server description field', async () => {
    handle = await spawnFakeServer()
    const echo = handle.tools.get('fake_echo')!
    expect(echo.description).toContain('Echo a message')
    expect(echo.idempotency).toBe('destructive')
  })

  it('routes a successful tool call and returns the content array', async () => {
    handle = await spawnFakeServer()
    const echo = handle.tools.get('fake_echo')!
    const result = (await echo.execute({ message: 'hello world' }, FAKE_CTX)) as {
      content: { type: string; text: string }[]
    }
    expect(result.content[0]?.type).toBe('text')
    expect(result.content[0]?.text).toBe('echo: hello world')
  })

  it('translates MCP error responses (isError: true) into thrown errors', async () => {
    handle = await spawnFakeServer()
    const fail = handle.tools.get('fake_fail')!
    await expect(fail.execute({ reason: 'simulated failure' }, FAKE_CTX)).rejects.toThrow(
      /fake_fail/,
    )
    await expect(fail.execute({ reason: 'another' }, FAKE_CTX)).rejects.toThrow(/another/)
  })

  it('propagates env vars to the child process', async () => {
    handle = await spawnFakeServer({
      env: { CUSTOM_VAR_FOR_TEST: 'a-test-secret-value' },
    })
    const readEnv = handle.tools.get('fake_read_env')!
    const result = (await readEnv.execute({ name: 'CUSTOM_VAR_FOR_TEST' }, FAKE_CTX)) as {
      content: { type: string; text: string }[]
    }
    expect(result.content[0]?.text).toBe('a-test-secret-value')
  })

  it('namespaces tools by the supplied server name', async () => {
    handle = await spawnFakeServer({ name: 'github' })
    expect(Array.from(handle.tools.keys())).toContain('github_echo')
    expect(handle.tools.has('fake_echo')).toBe(false)
  })

  it('close() shuts down without throwing', async () => {
    handle = await spawnFakeServer()
    await handle.close()
    handle = undefined
  })

  it('throws when the command does not exist', async () => {
    await expect(
      spawnStdioMcpServer({
        name: 'noexist',
        command: '/nonexistent/binary/path',
        args: [],
        env: {},
      }),
    ).rejects.toThrow()
  })
})
