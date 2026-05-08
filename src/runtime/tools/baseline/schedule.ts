/**
 * schedule.* baseline tools.
 *
 * Lets an Agent manage its own cron / interval schedules at runtime.
 * Until this lands, schedules were operator-only via the CLI
 * (`2200 schedule add/list/remove/...`); an Agent's first-task seed
 * referenced upcoming cadence work but had no way to actually wire
 * the schedule itself.
 *
 * Each tool calls the supervisor's existing `cli.schedule.*` RPC
 * (the same code path the CLI uses), with the `agent` parameter
 * locked to `ctx.callingAgent`. Agents can only manage their own
 * schedules; cross-Agent schedule manipulation goes through the
 * operator (CLI or web).
 *
 * The supervisor RPC client is injected via a getter so the
 * baselineServers factory can run before the agent's RPC channel is
 * open. By the time these tools execute (inside a task loop), the
 * agent has long since registered with the supervisor.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import type { JsonRpcClient } from '../../control-plane/client.js'

export type SupervisorRpcGetter = () => JsonRpcClient | undefined

const ScheduleAddTimingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    /** Standard 5-field cron expression. e.g. '0 8 * * 1-5' = weekdays 8am. */
    expression: z.string().min(1),
    /** IANA tz, e.g. 'America/New_York'. Defaults to UTC. */
    timezone: z.string().default('UTC'),
  }),
  z.object({
    kind: z.literal('interval'),
    /** Minimum 5 seconds; supervisor enforces. */
    interval_seconds: z.number().int().min(5),
  }),
])

function requireClient(get: SupervisorRpcGetter): JsonRpcClient {
  const client = get()
  if (!client) {
    throw new Error(
      'supervisor RPC client not available; the Agent has not registered with the supervisor yet. This usually means a tool was called from boot code rather than from a task loop.',
    )
  }
  return client
}

const ScheduleAddArgsSchema = z.object({
  /** What you want done when the schedule fires. Becomes the task body verbatim. */
  prompt: z.string().min(1),
  /** Optional human-friendly label for the schedule. Defaults to the first line of `prompt`. */
  description: z.string().optional(),
  timing: ScheduleAddTimingSchema,
})

export function makeScheduleAdd(get: SupervisorRpcGetter): ToolDefinition {
  return defineTool({
    name: 'schedule.add',
    description:
      "Add a new schedule for yourself. Cron-shaped windows ('0 8 * * 1-5' for weekdays 8am) or interval-based (every N seconds, min 5). The `prompt` is what gets handed to you as the task body when the schedule fires; write it as a complete instruction, not a label. Returns the schedule id and next_fire_at.",
    idempotency: 'destructive',
    argsSchema: ScheduleAddArgsSchema,
    execute: async (args, ctx) => {
      const client = requireClient(get)
      const result = await client.call('cli.schedule.add', {
        agent: ctx.callingAgent,
        prompt: args.prompt,
        ...(args.description !== undefined ? { description: args.description } : {}),
        timing: args.timing,
      })
      return result
    },
  })
}

const ScheduleListArgsSchema = z.object({})

export function makeScheduleList(get: SupervisorRpcGetter): ToolDefinition {
  return defineTool({
    name: 'schedule.list',
    description:
      'List your current schedules. Each entry carries id, description, prompt, timing, enabled, last_fired_at, next_fire_at.',
    idempotency: 'pure',
    argsSchema: ScheduleListArgsSchema,
    execute: async (_args, ctx) => {
      const client = requireClient(get)
      const result = await client.call('cli.schedule.list', { agent: ctx.callingAgent })
      return result
    },
  })
}

const ScheduleRemoveArgsSchema = z.object({
  id: z.string().min(1),
})

export function makeScheduleRemove(get: SupervisorRpcGetter): ToolDefinition {
  return defineTool({
    name: 'schedule.remove',
    description:
      "Remove one of your schedules by id. Idempotent: removing a missing id returns ok without erroring (the supervisor's RPC handles this).",
    idempotency: 'destructive',
    argsSchema: ScheduleRemoveArgsSchema,
    execute: async (args, ctx) => {
      const client = requireClient(get)
      const result = await client.call('cli.schedule.remove', {
        agent: ctx.callingAgent,
        id: args.id,
      })
      return result
    },
  })
}

const ScheduleSetEnabledArgsSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
})

export function makeScheduleSetEnabled(get: SupervisorRpcGetter): ToolDefinition {
  return defineTool({
    name: 'schedule.set_enabled',
    description:
      'Pause or resume one of your schedules without removing it. Disabled schedules stop firing but their config is preserved; re-enable later to resume from the next fire window.',
    idempotency: 'destructive',
    argsSchema: ScheduleSetEnabledArgsSchema,
    execute: async (args, ctx) => {
      const client = requireClient(get)
      const result = await client.call('cli.schedule.set-enabled', {
        agent: ctx.callingAgent,
        id: args.id,
        enabled: args.enabled,
      })
      return result
    },
  })
}

const ScheduleRunOnceArgsSchema = z.object({
  id: z.string().min(1),
})

export function makeScheduleRunOnce(get: SupervisorRpcGetter): ToolDefinition {
  return defineTool({
    name: 'schedule.run_once',
    description:
      'Fire one of your schedules immediately, regardless of its next_fire_at. Useful for testing a freshly-added schedule, or for catching up after a missed window. Returns the synthetic task id.',
    idempotency: 'destructive',
    argsSchema: ScheduleRunOnceArgsSchema,
    execute: async (args, ctx) => {
      const client = requireClient(get)
      const result = await client.call('cli.schedule.run-once', {
        agent: ctx.callingAgent,
        id: args.id,
      })
      return result
    },
  })
}

export function scheduleTools(get: SupervisorRpcGetter): ToolDefinition[] {
  return [
    makeScheduleAdd(get),
    makeScheduleList(get),
    makeScheduleRemove(get),
    makeScheduleSetEnabled(get),
    makeScheduleRunOnce(get),
  ]
}
