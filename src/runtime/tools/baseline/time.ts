/**
 * time.* baseline tools (now, sleep).
 *
 * Per [[2026-04-25-tool-baseline]]:
 *   time.now    -> pure (current timestamp)
 *   time.sleep  -> pure (non-burning; supervisor wakes loop after delay)
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

// ---------------------------------------------------------------------------
// time.now
// ---------------------------------------------------------------------------

const TimeNowArgsSchema = z.object({}).strict()

export const timeNow = defineTool({
  name: 'time_now',
  description: 'Return the current UTC timestamp in ISO 8601 form.',
  idempotency: 'pure',
  argsSchema: TimeNowArgsSchema,
  execute: () => {
    return Promise.resolve({ ts: new Date().toISOString() })
  },
})

// ---------------------------------------------------------------------------
// time.sleep
// ---------------------------------------------------------------------------

const TimeSleepArgsSchema = z.object({
  ms: z.number().int().positive().max(3_600_000),
})

export const timeSleep = defineTool({
  name: 'time_sleep',
  description: 'Pause for N milliseconds. Non-burning; backed by setTimeout.',
  idempotency: 'pure',
  argsSchema: TimeSleepArgsSchema,
  execute: async (args) => {
    await new Promise<void>((resolve) => setTimeout(resolve, args.ms))
    return { slept_ms: args.ms }
  },
})

export const timeTools: ToolDefinition[] = [timeNow, timeSleep]
