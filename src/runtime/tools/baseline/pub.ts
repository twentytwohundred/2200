/**
 * pub.* baseline tools (send, read, list_pubs, react).
 *
 * Per Epic 3 [[03-local-pub-integration]]. Four tools added on top
 * of the Epic 2 baseline of fourteen, bringing the baseline total to
 * eighteen.
 *
 * Idempotency:
 *   pub.send       → checkpointed (idempotency-keyed by client_message_id)
 *   pub.read       → pure
 *   pub.list_pubs  → pure
 *   pub.react      → checkpointed (re-react with same emoji is server-side no-op)
 *
 * Connection model: each Agent process maintains a PubClient per pub
 * via `runtime/pub/registry.ts`. Tools resolve `pub_name` to a
 * PubClient, lazily connect on first use, and reuse the live
 * WebSocket for subsequent calls. Reconnect logic lands with PR D
 * (wake source).
 *
 * Pub-server URL resolution: tools read `supervisor.json` from disk
 * to find the port for a named pub. supervisor writes are atomic
 * (temp+rename) so concurrent reads see a consistent snapshot.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition, type ToolContext } from '../../mcp/tool.js'
import { agentPaths } from '../../storage/layout.js'
import { loadState } from '../../supervisor/state.js'
import type { PubRecord } from '../../supervisor/types.js'
import { readCredentialFile } from '../../pub/keypair.js'
import { getOrCreatePubClient } from '../../pub/registry.js'
import { getWatermark, setWatermark } from '../../pub/watermark.js'
import type { PubClient, PubMessage } from '../../pub/client.js'

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a pub_name to its PubRecord (port, pub_md_path, etc.) by
 * reading the supervisor's on-disk state. Throws if the pub does not
 * exist or is not running.
 */
async function resolvePub(home: string, pubName: string): Promise<PubRecord> {
  const state = await loadState(home)
  const record = state.pubs[pubName]
  if (!record) {
    throw new Error(`pub "${pubName}" does not exist on this instance`)
  }
  if (record.state !== 'running') {
    throw new Error(`pub "${pubName}" exists but is not running (state: ${record.state})`)
  }
  return record
}

/**
 * Pick the default pub when the caller omits `pub_name`. Resolves to
 * the single running pub on the instance; throws when zero or
 * multiple pubs exist (the caller MUST disambiguate).
 */
async function resolveDefaultPub(home: string): Promise<PubRecord> {
  const state = await loadState(home)
  const running = Object.values(state.pubs).filter((p) => p.state === 'running')
  if (running.length === 0) {
    throw new Error('no running pubs on this instance; create + start one first')
  }
  if (running.length > 1) {
    throw new Error(
      `multiple running pubs (${running.map((p) => p.name).join(', ')}); specify pub_name explicitly`,
    )
  }
  const only = running[0]
  if (!only) {
    // unreachable given length === 1, but the type narrowing requires it
    throw new Error('internal: pickDefault saw length 1 with no entry')
  }
  return only
}

/**
 * Get-or-create a connected PubClient for the calling Agent and a
 * named pub. Reads the Agent's credential file from disk and uses
 * the registry to lazily construct + connect the client.
 */
async function clientFor(ctx: ToolContext, pub: PubRecord): Promise<PubClient> {
  const credPath = agentPaths(ctx.home, ctx.callingAgent).pubSecret
  const cred = await readCredentialFile(credPath)
  if (!cred.agent_id) {
    throw new Error(
      `Agent "${ctx.callingAgent}" has no registered pub identity (agent_id is null); run "2200 agent create" with a pub:-declared Identity while a pub is running, or re-run agent create after the pub is up`,
    )
  }
  const baseUrl = `http://127.0.0.1:${String(pub.port)}`
  const client = getOrCreatePubClient(ctx.callingAgent, pub.name, { baseUrl, cred })
  await client.connect()
  return client
}

// ---------------------------------------------------------------------------
// pub.send
// ---------------------------------------------------------------------------

const PubSendArgsSchema = z.object({
  /** Pub to send to. Optional when exactly one pub is running. */
  pub_name: z.string().optional(),
  content: z.string().min(1),
  /** Optional list of agent_ids to mention. The pub-server populates `mentions` from in-band `@<handle>` parsing too; callers can pass either or both. */
  mentions: z.array(z.string()).optional(),
  in_reply_to: z.string().optional(),
  /** Idempotency key. v1 server may not enforce; treat as advisory. */
  client_message_id: z.string().optional(),
})

export const pubSend = defineTool({
  name: 'pub.send',
  description: 'Post a message to a pub. Returns the assigned message_id and timestamp.',
  idempotency: 'checkpointed',
  argsSchema: PubSendArgsSchema,
  execute: async (args, ctx: ToolContext) => {
    const pub = args.pub_name
      ? await resolvePub(ctx.home, args.pub_name)
      : await resolveDefaultPub(ctx.home)
    const client = await clientFor(ctx, pub)
    const result = await client.send({
      content: args.content,
      ...(args.mentions !== undefined ? { mentions: args.mentions } : {}),
      ...(args.in_reply_to !== undefined ? { in_reply_to: args.in_reply_to } : {}),
      ...(args.client_message_id !== undefined
        ? { client_message_id: args.client_message_id }
        : {}),
    })
    return {
      pub_name: pub.name,
      message_id: result.message_id,
      timestamp: result.timestamp,
    }
  },
})

// ---------------------------------------------------------------------------
// pub.read (watermark dedup)
// ---------------------------------------------------------------------------

const PubReadArgsSchema = z.object({
  pub_name: z.string().optional(),
  /**
   * If supplied, returns messages newer than this message_id WITHOUT
   * advancing the watermark (read-only mode). If omitted, returns
   * messages newer than the persisted watermark and advances it.
   */
  since_message_id: z.string().optional(),
  /** Max messages returned. Capped at 500. Default 50 (matches the pub-server rolling window). */
  limit: z.number().int().positive().max(500).default(50),
})

export const pubRead = defineTool({
  name: 'pub.read',
  description:
    'Read messages from a pub since the per-Agent watermark. Default mode advances the watermark; explicit since_message_id is non-mutating.',
  idempotency: 'pure',
  argsSchema: PubReadArgsSchema,
  execute: async (args, ctx: ToolContext) => {
    const pub = args.pub_name
      ? await resolvePub(ctx.home, args.pub_name)
      : await resolveDefaultPub(ctx.home)
    const client = await clientFor(ctx, pub)

    const explicit = args.since_message_id !== undefined
    const since = explicit
      ? args.since_message_id
      : ((await getWatermark(ctx.home, ctx.callingAgent, pub.name))?.last_read_message_id ?? null)

    const messages: PubMessage[] = client.readCached({
      ...(since !== null && since !== undefined ? { since_message_id: since } : {}),
      limit: args.limit,
    })

    const last = messages[messages.length - 1]
    if (!explicit && last) {
      await setWatermark(ctx.home, ctx.callingAgent, pub.name, {
        pub_id: client.roomState()?.pub_id ?? '',
        last_read_message_id: last.message_id,
        last_read_ts: last.timestamp,
      })
    }

    return {
      pub_name: pub.name,
      since_message_id: since,
      advanced_watermark: !explicit && messages.length > 0,
      messages,
    }
  },
})

// ---------------------------------------------------------------------------
// pub.list_pubs
// ---------------------------------------------------------------------------

const PubListPubsArgsSchema = z.object({}).strict()

export const pubListPubs = defineTool({
  name: 'pub.list_pubs',
  description:
    'List pubs on this instance. Reports pub name, state (running/stopped/errored), and port. The Agent participates in pubs that are running.',
  idempotency: 'pure',
  argsSchema: PubListPubsArgsSchema,
  execute: async (_args, ctx: ToolContext) => {
    const state = await loadState(ctx.home)
    const pubs = Object.values(state.pubs).map((p) => ({
      name: p.name,
      state: p.state,
      port: p.port,
    }))
    return { pubs }
  },
})

// ---------------------------------------------------------------------------
// pub.react
// ---------------------------------------------------------------------------

const PubReactArgsSchema = z.object({
  pub_name: z.string().optional(),
  message_id: z.string().min(1),
  emoji: z.string().min(1),
})

export const pubReact = defineTool({
  name: 'pub.react',
  description:
    'Add a reaction to a message in a pub. Re-react with the same emoji is a server-side no-op; re-react with a different emoji replaces.',
  idempotency: 'checkpointed',
  argsSchema: PubReactArgsSchema,
  execute: async (args, ctx: ToolContext) => {
    const pub = args.pub_name
      ? await resolvePub(ctx.home, args.pub_name)
      : await resolveDefaultPub(ctx.home)
    const client = await clientFor(ctx, pub)
    await client.react(args.message_id, args.emoji)
    return { pub_name: pub.name, message_id: args.message_id, emoji: args.emoji, ok: true }
  },
})

export const pubTools: ToolDefinition[] = [pubSend, pubRead, pubListPubs, pubReact]
