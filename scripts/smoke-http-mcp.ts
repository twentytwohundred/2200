/**
 * Manual-test smoke for Epic 9 Phase C-1 (HTTP MCP transport).
 *
 * Connects 2200's actual `spawnHttpMcpServer` to a live public MCP endpoint
 * (DeepWiki — no auth, public-mode tools). Verifies:
 *   1. The transport opens and `initialize` succeeds.
 *   2. `tools/list` returns real tools wrapped as 2200 ToolDefinitions.
 *   3. A `tools/call` round-trips and returns a result.
 *
 * Run: pnpm tsx scripts/smoke-http-mcp.ts
 */
import { spawnHttpMcpServer } from '../src/runtime/mcp/http-transport.js'
import type { ToolContext } from '../src/runtime/mcp/tool.js'

const ENDPOINT = 'https://mcp.deepwiki.com/mcp'

async function main(): Promise<void> {
  console.log(`[smoke] connecting to ${ENDPOINT} ...`)
  const handle = await spawnHttpMcpServer({
    name: 'deepwiki',
    url: ENDPOINT,
  })

  try {
    const toolNames = Array.from(handle.tools.keys())
    console.log(`[smoke] connected. ${String(toolNames.length)} tools listed:`)
    for (const n of toolNames) {
      console.log(`         - ${n}`)
    }
    if (toolNames.length === 0) {
      throw new Error('expected at least one tool from DeepWiki public mode')
    }

    const ask = handle.tools.get('deepwiki.ask_question')
    if (!ask) {
      throw new Error(`expected 'deepwiki.ask_question' in tool list`)
    }

    console.log(
      `[smoke] invoking deepwiki.ask_question against modelcontextprotocol/python-sdk ...`,
    )
    const ctx: ToolContext = {
      callingAgent: 'smoke',
      home: '/tmp',
      brainDir: '/tmp',
      projectDir: '/tmp',
      taskId: null,
      callId: 'smoke-1',
    }
    const result = await ask.execute(
      {
        repoName: 'modelcontextprotocol/python-sdk',
        question: 'What is the entry point for creating an MCP server?',
      },
      ctx,
    )
    const text = JSON.stringify(result).slice(0, 600)
    console.log(`[smoke] tool returned (truncated): ${text}...`)
    console.log(`[smoke] OK — HTTP MCP transport closes Phase C-1 against a live endpoint.`)
  } finally {
    await handle.close()
  }
}

main().catch((err: unknown) => {
  console.error(`[smoke] failed:`, err)
  process.exit(1)
})
