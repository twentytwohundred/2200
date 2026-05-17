/**
 * Tool suggestions for onboarding (Epic 14 Phase A PR C).
 *
 * Per the locked Phase A decision: a curated list of intent_tag →
 * mcp_servers[] entry templates. Predictable, auditable, easy for an
 * operator to debug. Post-v1, an LLM-augmentation pass can refine the
 * suggestions or add tools the curated list doesn't cover.
 *
 * The output is a list of `{server, env_hint, rationale}` records that
 * the preview surface (PR D) shows the user before confirming. Each
 * suggested mcp_servers[] entry leaves env values as SecretRef
 * placeholders pointing at env-var names; the operator wires the actual
 * values in their shell or via a `.env` file before starting the Agent.
 *
 * v1 covers the four canonical branches' tagged questions:
 *
 *   - tool_email_account → Gmail MCP server (env: GMAIL_OAUTH_TOKEN_<NAME>)
 *   - tool_project_path → GitHub MCP server (env: GITHUB_TOKEN_<NAME>)
 *   - tool_ops_target → no specific suggestion (operator picks)
 *   - tools_freeform → no automatic suggestion; preview lists the
 *     freeform answer for the operator to decide
 */
import type { McpServerSpec } from '../identity/types.js'
import type { InterviewTranscript } from './types.js'

/**
 * One suggested tool. The preview surface renders these; the user
 * accepts or rejects each.
 */
export interface ToolSuggestion {
  /** The mcp_servers[] entry to add to the Identity. */
  server: McpServerSpec
  /**
   * Human-readable env-var hint. The preview shows
   * "you need to set GITHUB_TOKEN_HOBBY before starting the Agent."
   */
  env_hint: string
  /** Free-form rationale; preview shows "Suggested because: <rationale>". */
  rationale: string
  /** Source intent_tag from the transcript that triggered this. */
  source_tag: string
}

/**
 * Suggest tools based on the transcript's intent_tags. Returns an
 * array (possibly empty) of ToolSuggestion. The CLI / preview decides
 * what to render and whether to write each suggestion into the
 * resulting Identity's mcp_servers[] block.
 *
 * `agentName` is used to compose unique env-var names per Agent
 * (GITHUB_TOKEN_HOBBY, GITHUB_TOKEN_EMMA, ...); the operator sees the
 * pattern in the preview and provisions env vars accordingly.
 */
export function suggestTools(transcript: InterviewTranscript, agentName: string): ToolSuggestion[] {
  const upperName = agentName.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const suggestions: ToolSuggestion[] = []
  const seenServerNames = new Set<string>()

  for (const entry of transcript.entries) {
    const tag = entry.intent_tag
    if (tag === undefined) continue

    const builder = TOOL_BUILDERS[tag]
    if (builder === undefined) continue

    const suggestion = builder({
      agentName,
      upperName,
      answer: entry.answer,
      tag,
    })
    if (suggestion === null) continue
    if (seenServerNames.has(suggestion.server.name)) continue
    seenServerNames.add(suggestion.server.name)
    suggestions.push(suggestion)
  }

  return suggestions
}

interface BuilderArgs {
  agentName: string
  upperName: string
  answer: string
  tag: string
}

type SuggestionBuilder = (args: BuilderArgs) => ToolSuggestion | null

/**
 * The curated table. Adding a new mapping is editing this object plus
 * a small test; no schema bump, no runtime change required.
 */
const TOOL_BUILDERS: Record<string, SuggestionBuilder> = {
  tool_email_account: (a) => ({
    server: {
      name: 'gmail',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-gmail'],
      env: {
        GMAIL_OAUTH_TOKEN: { source: 'env', id: `GMAIL_OAUTH_TOKEN_${a.upperName}` },
      },
    },
    env_hint: `set GMAIL_OAUTH_TOKEN_${a.upperName} in your shell before starting the Agent (one-time OAuth flow lands in Epic 9 Phase B)`,
    rationale: `you mentioned watching ${a.answer || 'an email account'}`,
    source_tag: a.tag,
  }),

  tool_project_path: (a) => ({
    server: {
      name: 'github',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_TOKEN: { source: 'env', id: `GITHUB_TOKEN_${a.upperName}` },
      },
    },
    env_hint: `set GITHUB_TOKEN_${a.upperName} in your shell before starting the Agent (a fine-grained PAT scoped to the relevant repos is sufficient)`,
    rationale: `you described a project on GitHub (${a.answer.slice(0, 80) || 'unspecified path'})`,
    source_tag: a.tag,
  }),

  tool_ops_target: (a) => {
    const lowered = a.answer.toLowerCase()
    if (lowered.includes('slack')) {
      return {
        server: {
          name: 'slack',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-slack'],
          env: {
            SLACK_BOT_TOKEN: { source: 'env', id: `SLACK_BOT_TOKEN_${a.upperName}` },
          },
        },
        env_hint: `set SLACK_BOT_TOKEN_${a.upperName} in your shell before starting the Agent`,
        rationale: `you mentioned Slack in your ops description`,
        source_tag: a.tag,
      }
    }
    // No automatic suggestion for general ops targets at v1; operator
    // picks the right MCP server for their stack post-build.
    return null
  },
}
