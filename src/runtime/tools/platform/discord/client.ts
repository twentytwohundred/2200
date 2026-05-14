/**
 * Discord REST client (thin wrapper around `@discordjs/core/http-only`).
 *
 * Bot-token authenticated. No gateway / WebSocket / voice ... outbound
 * REST only, which covers the v1 tool surface (send / read / list /
 * react / thread). The full discord.js framework is intentionally not
 * pulled in: it triples bundle size for capabilities we do not use.
 *
 * Token resolution is lazy: the client is constructed without a token,
 * and the token is read from `_2200_DISCORD_BOT_TOKEN` at first call.
 * This lets the agent process boot without Discord configured and
 * surface a clean error to the model if it tries to call a Discord tool
 * before credentials are wired.
 */
import { REST } from '@discordjs/rest'
import { API } from '@discordjs/core/http-only'

export const DISCORD_BOT_TOKEN_ENV = '_2200_DISCORD_BOT_TOKEN'

export class DiscordCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DiscordCredentialError'
  }
}

/**
 * Lazy Discord API holder. Reuses the same REST instance across calls
 * so rate-limit state survives, but does not touch the network until a
 * tool actually invokes a method.
 */
export class DiscordClient {
  private api: API | null = null
  private readonly tokenReader: () => string | undefined

  constructor(tokenReader?: () => string | undefined) {
    this.tokenReader = tokenReader ?? (() => process.env[DISCORD_BOT_TOKEN_ENV])
  }

  /** Returns the API client, instantiating it on first use. */
  get(): API {
    if (this.api) return this.api
    const token = this.tokenReader()
    if (!token || token.trim().length === 0) {
      throw new DiscordCredentialError(
        `Discord bot token is not configured. Set ${DISCORD_BOT_TOKEN_ENV} ` +
          `in the supervisor environment, or run \`2200 platform discord set-token\`.`,
      )
    }
    const rest = new REST({ version: '10' }).setToken(token.trim())
    this.api = new API(rest)
    return this.api
  }

  /** Test seam: forcibly inject an API instance. */
  setApiForTest(api: API): void {
    this.api = api
  }
}

/** Module-level singleton. Resolved at first call per agent process. */
export const defaultDiscordClient = new DiscordClient()
