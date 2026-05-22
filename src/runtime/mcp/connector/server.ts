/**
 * MCP connector server (PR 2 / Phase 1 real-tool surface).
 *
 * Constructs an `@modelcontextprotocol/sdk` `McpServer` instance with
 * the locked Phase 1 tool surface plus the existing `liveness` probe
 * from PR 1a:
 *
 *   - `liveness`                  ... proof-of-life probe.
 *   - `contribute_to_thread`      ... structured contribution into the
 *                                     fleet (per-Agent or per-thread).
 *   - `get_fleet_context`         ... small orientation packet for a
 *                                     returning conversation.
 *
 * No tool with external effects, no write-to-task surface, no Agent
 * creation. The `propose_work_package` tool (which arrives inert into
 * the Inbox until a human approves) lands in PR 4.
 *
 * Supply-chain note (Grok review, 2026-05-22): we mount
 * StreamableHTTPServerTransport from `@modelcontextprotocol/sdk`
 * directly. Pin updates and re-review the SDK's security posture on
 * each version bump.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ConnectorAuditEmitter } from './audit.js'
import { buildFleetContext, type FleetContextDeps } from './fleet-context.js'
import {
  validateThreadSlug,
  writeAgentContribution,
  writeThreadContribution,
  type ContributionPayload,
} from './contributions.js'

export interface ConnectorMcpServerDeps {
  /** 2200 home directory. */
  home: string
  /** Supervisor snapshot reader used by `get_fleet_context`. */
  snapshot: FleetContextDeps['snapshot']
  /** Inbox audit emitter shared with the listener. */
  audit: ConnectorAuditEmitter
  /** Set of agent names the connector may write contributions to. Null means "any agent on disk." */
  knownAgents?: () => Promise<Set<string>>
}

export interface ConnectorMcpServerHandle {
  readonly mcpServer: McpServer
  readonly transport: StreamableHTTPServerTransport
  close(): Promise<void>
}

const SERVER_INFO = {
  name: '2200-mcp-connector',
  version: '0.2.0',
}

const SERVER_OPTIONS = {
  // Brief description shown to MCP clients on initialize.
  instructions:
    "2200's fleet-facing MCP connector. Phase 1: structured contributions land in the fleet's Brain (per-Agent or shared research threads); the operator approves anything with external effects through the Inbox. Tools: `liveness` (probe), `contribute_to_thread` (ingest research / reasoning into a target), `get_fleet_context` (small orientation packet for re-engagement).",
}

const SourceSchema = z.object({
  url: z.url().optional(),
  title: z.string().min(1).optional(),
  note: z.string().min(1).optional(),
})

const PayloadShape = {
  research_findings: z.string().min(1),
  reasoning: z.string().min(1),
  sources: z.array(SourceSchema).default([]),
  open_questions: z.array(z.string().min(1)).default([]),
  proposed_direction: z.string().optional(),
  related_threads: z.array(z.string().min(1)).optional(),
}

const ContributeInputShape = {
  ...PayloadShape,
  target: z
    .union([
      z.object({ thread: z.string().min(1) }).strict(),
      z.object({ agent: z.string().min(1) }).strict(),
    ])
    .describe(
      "Either { thread: '<name>' } for the shared research thread surface, or { agent: '<name>' } for a private contribution into one Agent's brain.",
    ),
  thread_display_name: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional human-readable thread name. Preserved on first write so the brain note title is more readable than the normalized slug.',
    ),
  primary_agent: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Optional primary Agent assignment for a brand-new thread. Recorded once on first contribution; ignored on subsequent writes.',
    ),
}

const ContributeOutputShape = {
  status: z.literal('accepted'),
  target_kind: z.enum(['thread', 'agent']),
  target_name: z.string(),
  contribution_slug: z.string(),
  contribution_path: z.string(),
  created_target: z.boolean(),
}

const FleetContextOutputShape = {
  schema_version: z.literal(1),
  served_at: z.string(),
  agents: z.array(
    z.object({
      name: z.string(),
      state: z.string(),
      current_task_id: z.string().nullable(),
      last_heartbeat: z.string().nullable(),
    }),
  ),
  threads: z.array(
    z.object({
      slug: z.string(),
      display_name: z.string(),
      primary_agent: z.string().nullable(),
      contribution_count: z.number(),
      last_contribution_at: z.string().nullable(),
    }),
  ),
  recent_activity: z.array(
    z.object({
      ts: z.string(),
      tier: z.string(),
      agent: z.string(),
      kind: z.string(),
    }),
  ),
}

export async function createConnectorMcpServer(
  deps: ConnectorMcpServerDeps,
): Promise<ConnectorMcpServerHandle> {
  const mcpServer = new McpServer(SERVER_INFO, SERVER_OPTIONS)

  mcpServer.registerTool(
    'liveness',
    {
      title: 'liveness',
      description:
        'Proof-of-life probe. Returns "ok" plus the server timestamp. Useful for confirming the connector tunnel + auth are wired correctly without exercising the real tool surface.',
      inputSchema: {},
      outputSchema: {
        status: z.literal('ok'),
        server_time: z.string(),
      },
    },
    (_args, _extra) => {
      const serverTime = new Date().toISOString()
      const payload = { status: 'ok' as const, server_time: serverTime }
      return {
        structuredContent: payload,
        content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      }
    },
  )

  mcpServer.registerTool(
    'contribute_to_thread',
    {
      title: 'contribute_to_thread',
      description:
        "Hand a structured research / reasoning contribution into the fleet. The contribution is persisted as a normal Brain note and surfaces via the fleet's existing brain_search / brain_read surface. Target is one of: a research thread (shared brain) or a specific Agent (that Agent's private brain). Phase 1 contributions are inert from an execution standpoint: they are READ material until a fleet Agent explicitly acts on them.",
      inputSchema: ContributeInputShape,
      outputSchema: ContributeOutputShape,
    },
    async (args, _extra) => {
      const payload: ContributionPayload = {
        research_findings: args.research_findings,
        reasoning: args.reasoning,
        // Normalize sources: strip undefined-valued keys so the optional-
        // property shape lines up with exactOptionalPropertyTypes-strict.
        sources: args.sources.map((s) => {
          const cleaned: { url?: string; title?: string; note?: string } = {}
          if (s.url !== undefined) cleaned.url = s.url
          if (s.title !== undefined) cleaned.title = s.title
          if (s.note !== undefined) cleaned.note = s.note
          return cleaned
        }),
        open_questions: args.open_questions,
        ...(args.proposed_direction !== undefined
          ? { proposed_direction: args.proposed_direction }
          : {}),
        ...(args.related_threads !== undefined ? { related_threads: args.related_threads } : {}),
      }
      const target = args.target
      if ('thread' in target) {
        const slugResult = validateThreadSlug(target.thread)
        if (!slugResult.ok) {
          throw new Error(slugResult.reason)
        }
        const result = await writeThreadContribution({
          home: deps.home,
          threadSlug: slugResult.slug,
          ...(args.thread_display_name !== undefined
            ? { displayName: args.thread_display_name }
            : { displayName: target.thread }),
          ...(args.primary_agent !== undefined ? { primaryAgent: args.primary_agent } : {}),
          payload,
        })
        await deps.audit
          .emitContributionReceived({
            sourceIp: 'connector',
            targetKind: 'thread',
            targetName: slugResult.slug,
            contributionSlug: result.slug,
            contributionPath: result.path,
          })
          .catch(() => undefined)
        const out = {
          status: 'accepted' as const,
          target_kind: 'thread' as const,
          target_name: slugResult.slug,
          contribution_slug: result.slug,
          contribution_path: result.path,
          created_target: result.created,
        }
        return {
          structuredContent: out,
          content: [{ type: 'text' as const, text: JSON.stringify(out) }],
        }
      }
      // Agent-target branch.
      const knownAgents = deps.knownAgents ? await deps.knownAgents() : null
      if (knownAgents && !knownAgents.has(target.agent)) {
        throw new Error(
          `unknown agent: "${target.agent}". The connector cannot write a contribution to an Agent that does not exist on disk.`,
        )
      }
      const result = await writeAgentContribution({
        home: deps.home,
        agentName: target.agent,
        payload,
      })
      await deps.audit
        .emitContributionReceived({
          sourceIp: 'connector',
          targetKind: 'agent',
          targetName: target.agent,
          contributionSlug: result.slug,
          contributionPath: result.path,
        })
        .catch(() => undefined)
      const out = {
        status: 'accepted' as const,
        target_kind: 'agent' as const,
        target_name: target.agent,
        contribution_slug: result.slug,
        contribution_path: result.path,
        created_target: false,
      }
      return {
        structuredContent: out,
        content: [{ type: 'text' as const, text: JSON.stringify(out) }],
      }
    },
  )

  mcpServer.registerTool(
    'get_fleet_context',
    {
      title: 'get_fleet_context',
      description:
        'Return a small, structured orientation packet (current Agents + active research threads + recent fleet activity) so a returning conversation can pick up cleanly. Read-only; safe to call repeatedly. Deliberately small ... the richer standing-brief layer is a later PR.',
      inputSchema: {},
      outputSchema: FleetContextOutputShape,
    },
    async (_args, _extra) => {
      const packet = await buildFleetContext({
        home: deps.home,
        snapshot: deps.snapshot,
      })
      // The SDK's `structuredContent` type expects an index-signature
      // shape; our `FleetContextPacket` is a closed shape. JSON-clone
      // through a parse/stringify lands a plain object with the same
      // fields and the expected type widening.
      const structured = JSON.parse(JSON.stringify(packet)) as Record<string, unknown>
      return {
        structuredContent: structured,
        content: [{ type: 'text' as const, text: JSON.stringify(packet) }],
      }
    },
  )

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })

  // The SDK transport's TS surface declares mandatory `onclose`/`onerror`
  // setters after connection, but our exactOptionalPropertyTypes-strict
  // tsconfig sees the Transport interface's pre-connect optionality and
  // refuses the call. Mirror the cast pattern used in
  // runtime/mcp/http-transport.ts (client side) on the server side here.
  await mcpServer.connect(transport as unknown as Parameters<typeof mcpServer.connect>[0])

  return {
    mcpServer,
    transport,
    async close(): Promise<void> {
      await mcpServer.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
    },
  }
}
