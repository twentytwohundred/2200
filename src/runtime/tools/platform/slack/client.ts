/**
 * Slack WebClient holder (lazy bot-token resolution).
 *
 * Mirrors the Discord client shape: token resolved at first call, the
 * resulting WebClient cached for the agent process lifetime.
 *
 * v1 uses the workspace bot token (`xoxb-...`) directly. The OAuth
 * install flow is a separate code path (Slack provider entry already
 * exists in `oauth/providers.ts`); for v1 the operator pastes the
 * bot token into env. No incoming events surface yet ... outbound
 * REST only.
 */
import { WebClient } from '@slack/web-api'

export const SLACK_BOT_TOKEN_ENV = '_2200_SLACK_BOT_TOKEN'

export class SlackCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SlackCredentialError'
  }
}

export class SlackClient {
  private client: WebClient | null = null
  private readonly tokenReader: () => string | undefined

  constructor(tokenReader?: () => string | undefined) {
    this.tokenReader = tokenReader ?? (() => process.env[SLACK_BOT_TOKEN_ENV])
  }

  get(): WebClient {
    if (this.client) return this.client
    const token = this.tokenReader()
    if (!token || token.trim().length === 0) {
      throw new SlackCredentialError(
        `Slack bot token is not configured. Set ${SLACK_BOT_TOKEN_ENV} ` +
          `(an "xoxb-..." token from your Slack app's "OAuth & Permissions" page) ` +
          `in the supervisor environment, then restart the daemon.`,
      )
    }
    this.client = new WebClient(token.trim())
    return this.client
  }

  setClientForTest(client: WebClient): void {
    this.client = client
  }
}

export const defaultSlackClient = new SlackClient()
