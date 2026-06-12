/**
 * Tests for connector inbound routing (the policy layer between
 * external-platform gateways and Agent wake-ups).
 *
 * Why this matters: this router decides which strangers on the public
 * internet (WhatsApp/Discord senders) can wake an Agent. Until
 * 2026-06-12 it had zero tests. The contract being pinned, per
 * [[2026-05-16-connector-extensions]]:
 *
 *   - secure by default: unknown DM senders pair (operator approval),
 *     unknown groups block, group activation requires a mention
 *   - self-echoes never wake anyone (ack-spiral guard at the
 *     connector layer)
 *   - account isolation: a binding only matches its own account
 *   - platform-resolved mentions are authoritative over substring
 *     matching (Discord's `mentioned: false` must win even when the
 *     text happens to contain "@agent")
 */
import { describe, expect, it } from 'vitest'
import { routeInbound } from '../../../src/runtime/connectors/router.js'
import type { ConnectorInboundEvent } from '../../../src/runtime/connectors/inbound-types.js'
import type {
  AgentConnectorBinding,
  IdentityFrontmatter,
} from '../../../src/runtime/identity/types.js'

function makeBinding(overrides: Partial<AgentConnectorBinding> = {}): AgentConnectorBinding {
  return {
    connector_id: 'whatsapp',
    account: 'default',
    credentials: {},
    allowlist: { dm: [], group: [] },
    policies: { dm_policy: 'pairing', group_policy: 'allowlist', require_mention: true },
    ...overrides,
  }
}

/** The router reads only `frontmatter.connectors`; the cast keeps fixtures honest about that. */
function identityWith(agent: string, bindings: AgentConnectorBinding[]) {
  return { agent, frontmatter: { connectors: bindings } as unknown as IdentityFrontmatter }
}

function makeEvent(overrides: {
  conversation?: Partial<ConnectorInboundEvent['conversation']>
  sender?: Partial<ConnectorInboundEvent['sender']>
  connector_id?: string
  account?: string
  text?: string
  platform_extras?: Record<string, unknown>
}): ConnectorInboundEvent {
  return {
    connector_id: overrides.connector_id ?? 'whatsapp',
    account: overrides.account ?? 'default',
    kind: 'message',
    conversation: {
      id: 'conv-1',
      kind: 'dm',
      ...overrides.conversation,
    },
    sender: { id: '+15551234567', is_self: false, ...overrides.sender },
    text: overrides.text ?? 'hello',
    attachments: [],
    received_at: '2026-06-12T00:00:00.000Z',
    platform_extras: overrides.platform_extras ?? {},
  }
}

describe('routeInbound ... structural guards', () => {
  it('self-echo events wake nobody, regardless of policy', () => {
    const decisions = routeInbound({
      event: makeEvent({ sender: { is_self: true } }),
      identities: [
        identityWith('hobby', [
          makeBinding({
            policies: { dm_policy: 'open', group_policy: 'open', require_mention: false },
          }),
        ]),
      ],
    })
    expect(decisions).toEqual([])
  })

  it('agents without a binding for the connector are absent from the result', () => {
    const decisions = routeInbound({
      event: makeEvent({}),
      identities: [identityWith('hobby', [makeBinding({ connector_id: 'discord' })])],
    })
    expect(decisions).toEqual([])
  })

  it('a binding for a different account blocks with account_mismatch', () => {
    const decisions = routeInbound({
      event: makeEvent({ account: 'work' }),
      identities: [identityWith('hobby', [makeBinding({ account: 'personal' })])],
    })
    expect(decisions).toEqual([
      expect.objectContaining({ kind: 'block', agent: 'hobby', reason: 'account_mismatch' }),
    ])
  })

  it('returns one decision per bound Agent (passes and blocks together)', () => {
    const decisions = routeInbound({
      event: makeEvent({ sender: { id: '+1000' } }),
      identities: [
        identityWith('open-agent', [
          makeBinding({
            policies: { dm_policy: 'open', group_policy: 'allowlist', require_mention: true },
          }),
        ]),
        identityWith('closed-agent', [
          makeBinding({
            policies: { dm_policy: 'disabled', group_policy: 'allowlist', require_mention: true },
          }),
        ]),
      ],
    })
    expect(decisions).toHaveLength(2)
    expect(decisions.find((d) => d.agent === 'open-agent')?.kind).toBe('pass')
    expect(decisions.find((d) => d.agent === 'closed-agent')?.kind).toBe('block')
  })
})

describe('DM policy', () => {
  it('default policy (pairing) sends unknown senders to operator approval, not through', () => {
    const decisions = routeInbound({
      event: makeEvent({ sender: { id: '+19998887777' } }),
      identities: [identityWith('hobby', [makeBinding()])],
    })
    expect(decisions[0]).toEqual(
      expect.objectContaining({ kind: 'pair', reason: 'unknown_dm_sender' }),
    )
  })

  it('pairing passes senders already on the allowlist', () => {
    const decisions = routeInbound({
      event: makeEvent({ sender: { id: '+19998887777' } }),
      identities: [
        identityWith('hobby', [makeBinding({ allowlist: { dm: ['+19998887777'], group: [] } })]),
      ],
    })
    expect(decisions[0]?.kind).toBe('pass')
  })

  it('allowlist policy blocks unknown senders outright', () => {
    const decisions = routeInbound({
      event: makeEvent({ sender: { id: '+19998887777' } }),
      identities: [
        identityWith('hobby', [
          makeBinding({
            policies: { dm_policy: 'allowlist', group_policy: 'allowlist', require_mention: true },
          }),
        ]),
      ],
    })
    expect(decisions[0]).toEqual(
      expect.objectContaining({ kind: 'block', reason: 'dm_sender_not_allowlisted' }),
    )
  })

  it("a '*' DM allowlist admits anyone", () => {
    const decisions = routeInbound({
      event: makeEvent({ sender: { id: 'total-stranger' } }),
      identities: [
        identityWith('hobby', [
          makeBinding({
            allowlist: { dm: ['*'], group: [] },
            policies: { dm_policy: 'allowlist', group_policy: 'allowlist', require_mention: true },
          }),
        ]),
      ],
    })
    expect(decisions[0]?.kind).toBe('pass')
  })

  it('disabled blocks even allowlisted senders', () => {
    const decisions = routeInbound({
      event: makeEvent({ sender: { id: '+1000' } }),
      identities: [
        identityWith('hobby', [
          makeBinding({
            allowlist: { dm: ['+1000'], group: [] },
            policies: { dm_policy: 'disabled', group_policy: 'allowlist', require_mention: true },
          }),
        ]),
      ],
    })
    expect(decisions[0]).toEqual(
      expect.objectContaining({ kind: 'block', reason: 'dm_policy_disabled' }),
    )
  })
})

describe('group policy', () => {
  const groupEvent = (extras: Record<string, unknown> = {}, text = 'hello room') =>
    makeEvent({
      conversation: { id: 'group-42', kind: 'group' },
      text,
      platform_extras: extras,
    })

  it('default policy blocks unknown groups silently', () => {
    const decisions = routeInbound({
      event: groupEvent(),
      identities: [identityWith('hobby', [makeBinding()])],
    })
    expect(decisions[0]).toEqual(
      expect.objectContaining({ kind: 'block', reason: 'group_not_allowlisted' }),
    )
  })

  it('an allowlisted group still requires a mention by default', () => {
    const decisions = routeInbound({
      event: groupEvent({}, 'no mention here'),
      identities: [
        identityWith('hobby', [makeBinding({ allowlist: { dm: [], group: ['group-42'] } })]),
      ],
    })
    expect(decisions[0]).toEqual(
      expect.objectContaining({ kind: 'block', reason: 'mention_required' }),
    )
  })

  it('allowlisted group + @mention in text passes (substring fallback)', () => {
    const decisions = routeInbound({
      event: groupEvent({}, 'hey @Hobby can you look at this'),
      identities: [
        identityWith('hobby', [makeBinding({ allowlist: { dm: [], group: ['group-42'] } })]),
      ],
    })
    expect(decisions[0]?.kind).toBe('pass')
  })

  it('platform-resolved `mentioned: false` is authoritative over matching text', () => {
    // Discord pre-resolves mentions. Text that merely CONTAINS
    // "@hobby" (quoted, code block, coincidence) must not wake the
    // Agent when the platform says it was not a real mention.
    const decisions = routeInbound({
      event: groupEvent({ mentioned: false }, 'someone wrote @hobby in a quote'),
      identities: [
        identityWith('hobby', [makeBinding({ allowlist: { dm: [], group: ['group-42'] } })]),
      ],
    })
    expect(decisions[0]).toEqual(
      expect.objectContaining({ kind: 'block', reason: 'mention_required' }),
    )
  })

  it('platform-resolved `mentioned: true` passes without text matching', () => {
    const decisions = routeInbound({
      event: groupEvent({ mentioned: true }, 'reply chain with no literal handle'),
      identities: [
        identityWith('hobby', [makeBinding({ allowlist: { dm: [], group: ['group-42'] } })]),
      ],
    })
    expect(decisions[0]?.kind).toBe('pass')
  })

  it('a custom mention detector overrides the substring default', () => {
    const decisions = routeInbound({
      event: groupEvent({}, 'wake word: jarvis'),
      identities: [
        identityWith('hobby', [makeBinding({ allowlist: { dm: [], group: ['group-42'] } })]),
      ],
      mentionDetector: (_agent, text) => text?.includes('jarvis') ?? false,
    })
    expect(decisions[0]?.kind).toBe('pass')
  })

  it('require_mention false passes allowlisted groups without a mention', () => {
    const decisions = routeInbound({
      event: groupEvent({}, 'ambient chatter'),
      identities: [
        identityWith('hobby', [
          makeBinding({
            allowlist: { dm: [], group: ['group-42'] },
            policies: { dm_policy: 'pairing', group_policy: 'allowlist', require_mention: false },
          }),
        ]),
      ],
    })
    expect(decisions[0]?.kind).toBe('pass')
  })

  it('group_policy disabled blocks even allowlisted groups', () => {
    const decisions = routeInbound({
      event: groupEvent({ mentioned: true }),
      identities: [
        identityWith('hobby', [
          makeBinding({
            allowlist: { dm: [], group: ['group-42'] },
            policies: { dm_policy: 'pairing', group_policy: 'disabled', require_mention: false },
          }),
        ]),
      ],
    })
    expect(decisions[0]).toEqual(
      expect.objectContaining({ kind: 'block', reason: 'group_policy_disabled' }),
    )
  })
})
