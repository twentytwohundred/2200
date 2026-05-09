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

// Flattened timing shape. DeepSeek and Grok both struggle with Zod
// discriminated unions ({kind: ..., ...}); they drop the kind tag,
// mix branches, etc. Split into two top-level optional args and
// validate "exactly one set" via refinement. Either ergonomic in
// the tool surface AND robust to model-side JSON quirks.

function requireClient(get: SupervisorRpcGetter): JsonRpcClient {
  const client = get()
  if (!client) {
    throw new Error(
      'supervisor RPC client not available; the Agent has not registered with the supervisor yet. This usually means a tool was called from boot code rather than from a task loop.',
    )
  }
  return client
}

const ScheduleAddArgsSchema = z
  .object({
    /** What you want done when the schedule fires. Becomes the task body verbatim. */
    prompt: z.string().min(1),
    /** Optional human-friendly label for the schedule. Defaults to the first line of `prompt`. */
    description: z.string().optional(),
    /**
     * Standard 5-field cron expression in the chosen timezone. e.g.
     * '0 8 * * 1-5' is weekdays at 8am. Pass either `cron` OR
     * `interval_seconds`, not both.
     */
    cron: z.string().min(1).optional(),
    /** IANA tz, e.g. 'America/New_York'. Defaults to UTC. Only used when `cron` is set. */
    timezone: z.string().optional(),
    /**
     * Run every N seconds (minimum 5). Pass either `cron` OR
     * `interval_seconds`, not both.
     */
    interval_seconds: z.number().int().min(5).optional(),
  })
  .refine(
    (a) =>
      (a.cron !== undefined && a.interval_seconds === undefined) ||
      (a.cron === undefined && a.interval_seconds !== undefined),
    { message: 'Pass exactly one of `cron` or `interval_seconds`' },
  )

export function makeScheduleAdd(get: SupervisorRpcGetter): ToolDefinition {
  return defineTool({
    name: 'schedule_add',
    description:
      "Add a new schedule for yourself. Pass either `cron` (a standard 5-field cron expression like '0 8 * * 1-5' for weekdays 8am, plus optional `timezone`) OR `interval_seconds` (minimum 5). The `prompt` is what gets handed to you as the task body when the schedule fires; write it as a complete instruction, not a label. Returns the schedule id and next_fire_at.",
    idempotency: 'destructive',
    argsSchema: ScheduleAddArgsSchema,
    execute: async (args, ctx) => {
      const client = requireClient(get)
      let timing:
        | { kind: 'cron'; expression: string; timezone: string }
        | { kind: 'interval'; interval_seconds: number }
      if (args.cron !== undefined) {
        timing = {
          kind: 'cron',
          expression: args.cron,
          timezone: args.timezone ?? 'UTC',
        }
      } else if (args.interval_seconds !== undefined) {
        timing = { kind: 'interval', interval_seconds: args.interval_seconds }
      } else {
        // The Zod refine should have caught this, but narrow defensively.
        throw new Error('schedule.add: pass exactly one of `cron` or `interval_seconds`')
      }
      const result = await client.call('cli.schedule.add', {
        agent: ctx.callingAgent,
        prompt: args.prompt,
        ...(args.description !== undefined ? { description: args.description } : {}),
        timing,
      })
      return result
    },
  })
}

const ScheduleListArgsSchema = z.object({})

export function makeScheduleList(get: SupervisorRpcGetter): ToolDefinition {
  return defineTool({
    name: 'schedule_list',
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
    name: 'schedule_remove',
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
    name: 'schedule_set_enabled',
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
    name: 'schedule_run_once',
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
