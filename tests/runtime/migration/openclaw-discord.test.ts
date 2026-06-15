/**
 * Tests for reading the Discord channel config out of an OpenClaw home.
 *
 * Why this matters: the migration carries the operator's Discord
 * connection so they never hunt for and re-paste a bot token. The parse
 * must be faithful (token + the right channel ids) and must NOT silently
 * corrupt Discord snowflake ids ... user ids stored as bare JSON numbers
 * exceed JS's safe-integer range, so they are skipped rather than carried
 * wrong (channel ids are object keys, so they survive as strings).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectOpenClawDiscord } from '../../../src/runtime/migration/openclaw.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function ocHome(config: unknown): string {
  const home = mkdtempSync(join(tmpdir(), '2200-oc-'))
  dirs.push(home)
  // A raw string is written verbatim so a test can include a Discord
  // snowflake id (too large for a JS number literal) as real JSON text.
  const text = typeof config === 'string' ? config : JSON.stringify(config)
  writeFileSync(join(home, 'openclaw.json'), text)
  return home
}

describe('collectOpenClawDiscord', () => {
  it('extracts the bot token and channel ids; skips number user ids', async () => {
    // `users` as a bare JSON number is a real Discord id too large for JS
    // to represent exactly; carrying it would corrupt it, so it's dropped.
    // Written as raw JSON text so the snowflake never becomes a JS literal.
    const home = ocHome(
      `{"channels":{"discord":{"enabled":true,"token":"MTQ3.bot.token","groupPolicy":"allowlist",
        "guilds":{"1459223096748675124":{"requireMention":false,
        "users":[264380092245999617,"999000111222333444"],
        "channels":{"1471927760208396571":{"enabled":true}}}}}}}`,
    )
    const got = await collectOpenClawDiscord(home)
    expect(got).not.toBeNull()
    expect(got?.botToken).toBe('MTQ3.bot.token')
    expect(got?.channelIds).toEqual(['1471927760208396571'])
    // the bare-number id is skipped; the string id is kept
    expect(got?.userIds).toEqual(['999000111222333444'])
  })

  it('returns null when Discord is absent, disabled, or tokenless', async () => {
    expect(await collectOpenClawDiscord(ocHome({ channels: {} }))).toBeNull()
    expect(
      await collectOpenClawDiscord(
        ocHome({ channels: { discord: { enabled: false, token: 't' } } }),
      ),
    ).toBeNull()
    expect(
      await collectOpenClawDiscord(ocHome({ channels: { discord: { enabled: true } } })),
    ).toBeNull()
  })

  it('drops disabled channels and dedupes', async () => {
    const home = ocHome({
      channels: {
        discord: {
          enabled: true,
          token: 't',
          guilds: {
            g1: { channels: { '100': { enabled: true }, '200': { enabled: false } } },
            g2: { channels: { '100': { enabled: true }, '300': {} } },
          },
        },
      },
    })
    const got = await collectOpenClawDiscord(home)
    expect(got?.channelIds.sort()).toEqual(['100', '300'])
  })
})
