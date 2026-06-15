/**
 * Discord cutover for the OpenClaw migration.
 *
 * The same Discord bot token cannot run from two places at once — if both
 * OpenClaw and 2200 connect it, BOTH Agents answer, which is exactly the
 * "which Skippy am I talking to?" confusion we are eliminating. So the
 * cutover is ORDERED, with rollback:
 *
 *   1. Stop OpenClaw            (frees the bot token; brief Discord gap)
 *   2. Wire 2200's Discord      (seal token + binding + start gateway)
 *   3. Verify 2200 connected    (the gateway reports its bot identity)
 *      ├─ connected → done. Exactly one Agent answers, and it's 2200's.
 *      └─ failed    → roll back: restart OpenClaw so the operator is never
 *                     left dark on Discord.
 *
 * This module is pure orchestration: every side effect is injected, so the
 * sequence and the rollback paths are unit-tested without a live Discord,
 * daemon, or OpenClaw. The real effects are wired by the migration flow.
 */

export interface DiscordCutoverEffects {
  /** Stop the source OpenClaw instance (frees the bot token). */
  stopOpenClaw: () => Promise<{ ok: boolean; detail: string }>
  /** Restart OpenClaw (rollback when 2200's Discord doesn't come up). */
  startOpenClaw: () => Promise<{ ok: boolean; detail: string }>
  /** Seal the token, write the binding, and start 2200's Discord gateway. */
  wireDiscord: (input: {
    botToken: string
    channelIds: string[]
    userIds: string[]
  }) => Promise<void>
  /** Poll until 2200's gateway reports a live Discord connection (or gives up). */
  verifyConnected: () => Promise<{ connected: boolean; botUsername: string | null; detail: string }>
  /** Progress sink. */
  log: (level: 'info' | 'success' | 'warn', message: string) => void
}

export type DiscordCutoverReason = 'ok' | 'oc-stop-failed' | 'wire-failed' | 'verify-failed'

export interface DiscordCutoverResult {
  ok: boolean
  botUsername: string | null
  /** True when a failure was rolled back by restarting OpenClaw. */
  rolledBack: boolean
  reason: DiscordCutoverReason
  detail: string
}

export async function carryDiscordWithCutover(
  effects: DiscordCutoverEffects,
  discord: { botToken: string; channelIds: string[]; userIds: string[] },
): Promise<DiscordCutoverResult> {
  effects.log('info', 'Moving your Discord connection to 2200 (same bot, same channel)...')

  // 1. Free the bot token. We must stop OpenClaw BEFORE 2200 connects, or
  //    both answer. If we can't stop it, do NOT connect 2200 — leave
  //    Discord on OpenClaw rather than create two live bots.
  const stop = await effects.stopOpenClaw()
  if (!stop.ok) {
    effects.log(
      'warn',
      `Couldn't stop OpenClaw (${stop.detail}). Leaving Discord on OpenClaw so you don't end up ` +
        `with two bots answering. Move it later from the Extensions store.`,
    )
    return {
      ok: false,
      botUsername: null,
      rolledBack: false,
      reason: 'oc-stop-failed',
      detail: stop.detail,
    }
  }
  effects.log('info', `OpenClaw stopped (${stop.detail}). Connecting 2200 to Discord...`)

  // 2. Wire 2200's Discord (seal token, write binding, start gateway).
  try {
    await effects.wireDiscord(discord)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    effects.log('warn', `Couldn't set up Discord on 2200 (${detail}). Rolling back to OpenClaw...`)
    const re = await effects.startOpenClaw()
    reportRollback(effects, re)
    return { ok: false, botUsername: null, rolledBack: re.ok, reason: 'wire-failed', detail }
  }

  // 3. Verify 2200 actually reached Discord.
  const v = await effects.verifyConnected()
  if (!v.connected) {
    effects.log('warn', `2200 didn't come up on Discord (${v.detail}). Rolling back to OpenClaw...`)
    const re = await effects.startOpenClaw()
    reportRollback(effects, re)
    return {
      ok: false,
      botUsername: null,
      rolledBack: re.ok,
      reason: 'verify-failed',
      detail: v.detail,
    }
  }

  effects.log(
    'success',
    `Discord is live on 2200${v.botUsername ? ` as @${v.botUsername}` : ''}. ` +
      `OpenClaw is stopped (NOT deleted) — exactly one of your Agents answers on Discord now.`,
  )
  return {
    ok: true,
    botUsername: v.botUsername,
    rolledBack: false,
    reason: 'ok',
    detail: 'connected',
  }
}

function reportRollback(effects: DiscordCutoverEffects, re: { ok: boolean; detail: string }): void {
  if (re.ok) {
    effects.log('info', `OpenClaw restarted (${re.detail}); Discord is back where it was.`)
  } else {
    effects.log(
      'warn',
      `Couldn't restart OpenClaw automatically (${re.detail}). Restart it by hand: openclaw gateway start`,
    )
  }
}
