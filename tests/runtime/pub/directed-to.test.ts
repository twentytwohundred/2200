/**
 * Unit tests for the directed_to resolver (Epic 3 PR D).
 *
 * Pure-function tests; one section per rule plus combinatorial cases
 * (multiple rules could match, first wins; own messages never match).
 */
import { describe, expect, it } from 'vitest'
import {
  isDirectedTo,
  type ResolverAgentIdentity,
  type ResolverMessage,
  type ResolverPubMeta,
} from '../../../src/runtime/pub/directed-to.js'

const SELF: ResolverAgentIdentity = {
  agent_id: 'agent-self',
  handle: '@hobby',
}

const OTHER_AGENT_ID = 'agent-other'

const EMPTY_PUB: ResolverPubMeta = {
  member_agent_ids: ['agent-self', OTHER_AGENT_ID, 'agent-third'],
  owner_id: null,
}

const NO_SENT = new Set<string>()

describe('isDirectedTo: own messages never match', () => {
  it('returns not matched when message.agent_id === self.agent_id, even if all rules would otherwise match', () => {
    const message: ResolverMessage = {
      message_id: 'm1',
      agent_id: 'agent-self',
      content: '@hobby this is my own message',
      mentions: ['agent-self'],
      reply_to: 'mine-1',
    }
    const result = isDirectedTo({
      message,
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: new Set(['mine-1']),
    })
    expect(result.matched).toBe(false)
    expect(result.rule).toBeNull()
  })
})

describe('Rule 1: direct mention', () => {
  it('matches when mentions[] contains agent_id', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'hey',
        mentions: ['agent-self'],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
    expect(result.rule).toBe('direct_mention')
    expect(result.detail).toContain('mentions[]')
  })

  it('matches @<handle> in content even without mentions[] (v0.3.0 fallback)', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'hey @hobby can you take a look?',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
    expect(result.rule).toBe('direct_mention')
    expect(result.detail).toContain('@hobby')
  })

  it('handles @<handle> at start of content', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: '@hobby ping',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
  })

  it('handles handle stored without leading @', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'hey @hobby',
        mentions: [],
        reply_to: null,
      },
      agent: { agent_id: SELF.agent_id, handle: 'hobby' },
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
  })

  it('does NOT match @<other-handle> when content contains a similar but non-matching handle', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'hey @hobbyist (note the suffix)',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(false)
  })

  it('case-insensitive handle match', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: '@HOBBY hi',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
  })
})

describe('Rule 1: @team broadcast (wakes every Agent)', () => {
  it('matches @team in content even when this Agent is not in mentions[] and not by handle', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: '@team morning status briefing please',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
    expect(result.rule).toBe('direct_mention')
    expect(result.detail).toBe('@all broadcast')
  })

  it('matches @all and @everyone (broadcast aliases) for any Agent', () => {
    for (const content of ['@all who is around?', 'heads up @everyone, deploy in 5']) {
      const result = isDirectedTo({
        message: {
          message_id: 'm',
          agent_id: OTHER_AGENT_ID,
          content,
          mentions: [],
          reply_to: null,
        },
        agent: SELF,
        pub: EMPTY_PUB,
        sentMessageIds: NO_SENT,
      })
      expect(result.matched).toBe(true)
      expect(result.detail).toBe('@all broadcast')
    }
  })

  it('does NOT match @allow / @everyone-else (word-boundary guard)', () => {
    for (const content of ['the @allow list is set', 'tell @everyone-else to wait']) {
      const result = isDirectedTo({
        message: {
          message_id: 'm',
          agent_id: OTHER_AGENT_ID,
          content,
          mentions: [],
          reply_to: null,
        },
        agent: SELF,
        pub: EMPTY_PUB,
        sentMessageIds: NO_SENT,
      })
      expect(result.matched).toBe(false)
    }
  })

  it('matches case-insensitively (@Team, @TEAM)', () => {
    for (const variant of ['@Team hi', '@TEAM hi', '@TeAm hi']) {
      const result = isDirectedTo({
        message: {
          message_id: 'm',
          agent_id: OTHER_AGENT_ID,
          content: variant,
          mentions: [],
          reply_to: null,
        },
        agent: SELF,
        pub: EMPTY_PUB,
        sentMessageIds: NO_SENT,
      })
      expect(result.matched).toBe(true)
      expect(result.detail).toBe('@all broadcast')
    }
  })

  it('matches @team mid-sentence with surrounding text', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'hey @team, can we sync on the deploy?',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
  })

  it('does NOT match @teammate (word-boundary guard)', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'hey @teammate, just you',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(false)
  })

  it('does NOT match @teams (word-boundary guard)', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'all the @teams should review',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(false)
  })

  it('does NOT wake the sender on their own @team message', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: 'agent-self',
        content: '@team Hi, I just came online.',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(false)
  })

  it('wakes any peer Agent regardless of their handle (the broadcast property)', () => {
    // Demonstrate that @team works for an Agent whose handle is nothing like "@team".
    const simon: ResolverAgentIdentity = { agent_id: 'agent-simon', handle: '@simon' }
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: '@team please confirm you each got the update',
        mentions: [],
        reply_to: null,
      },
      agent: simon,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
    expect(result.rule).toBe('direct_mention')
    expect(result.detail).toBe('@all broadcast')
  })

  it('falls through to @<handle> check when @team is absent', () => {
    // Make sure the @team rule does not block the existing @handle path.
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: '@hobby specific question for you',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
    expect(result.detail).toContain('@hobby')
  })
})

describe('Rule 2: reply_to_mine', () => {
  it('matches when reply_to is in our sent set', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'thanks',
        mentions: [],
        reply_to: 'my-message-id',
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: new Set(['my-message-id']),
    })
    expect(result.matched).toBe(true)
    expect(result.rule).toBe('reply_to_mine')
  })

  it('does not match when reply_to is to someone else', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'thanks',
        mentions: [],
        reply_to: 'someone-elses-message',
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: new Set(['my-message-id']),
    })
    expect(result.matched).toBe(false)
  })

  it('does not match when reply_to is null', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'just chatter',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: new Set(['my-message-id']),
    })
    expect(result.matched).toBe(false)
  })
})

describe('Rule 3: sole_recipient pub', () => {
  it('matches when pub has exactly 2 members and one is self, the other is sender', () => {
    const pub: ResolverPubMeta = {
      member_agent_ids: ['agent-self', OTHER_AGENT_ID],
      owner_id: null,
    }
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'hey there',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
    expect(result.rule).toBe('sole_recipient')
  })

  it('does not match when pub has more than 2 members', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'hey',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB, // 3 members
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(false)
  })

  it('does not match when self is not in the pub', () => {
    const pub: ResolverPubMeta = {
      member_agent_ids: [OTHER_AGENT_ID, 'agent-third'],
      owner_id: null,
    }
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'hey',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(false)
  })
})

describe('Rule 4: pub_ownership (inactive at v1)', () => {
  it('matches when pub.owner_id matches self.agent_id', () => {
    const pub: ResolverPubMeta = {
      member_agent_ids: ['agent-self', OTHER_AGENT_ID, 'agent-third'],
      owner_id: 'agent-self',
    }
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'fyi',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
    expect(result.rule).toBe('pub_ownership')
  })

  it('does not match when owner_id is null (v1 path: pubs always have a human owner_id)', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'fyi',
        mentions: [],
        reply_to: null,
      },
      agent: SELF,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(false)
  })
})

describe('Rule 5: domain_match', () => {
  it('matches when content contains a configured domain (case-insensitive)', () => {
    const agent: ResolverAgentIdentity = {
      agent_id: 'agent-self',
      handle: '@carl',
      domains: ['weather arb', 'vendor calls'],
    }
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'New WEATHER ARB opportunity for tonight',
        mentions: [],
        reply_to: null,
      },
      agent,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(true)
    expect(result.rule).toBe('domain_match')
    expect(result.detail).toContain('weather arb')
  })

  it('does not match when domains is empty/absent', () => {
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'WEATHER ARB',
        mentions: [],
        reply_to: null,
      },
      agent: SELF, // no domains
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(false)
  })

  it('does not match when content does not contain any domain', () => {
    const agent: ResolverAgentIdentity = {
      agent_id: 'agent-self',
      handle: '@carl',
      domains: ['weather arb'],
    }
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'just regular chatter',
        mentions: [],
        reply_to: null,
      },
      agent,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.matched).toBe(false)
  })
})

describe('rule precedence: first match wins', () => {
  it('direct_mention wins over domain_match when both apply', () => {
    const agent: ResolverAgentIdentity = {
      agent_id: 'agent-self',
      handle: '@hobby',
      domains: ['ping'],
    }
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: '@hobby ping',
        mentions: ['agent-self'],
        reply_to: null,
      },
      agent,
      pub: EMPTY_PUB,
      sentMessageIds: NO_SENT,
    })
    expect(result.rule).toBe('direct_mention')
  })

  it('reply_to_mine wins over sole_recipient when both apply', () => {
    const pub: ResolverPubMeta = {
      member_agent_ids: ['agent-self', OTHER_AGENT_ID],
      owner_id: null,
    }
    const result = isDirectedTo({
      message: {
        message_id: 'm',
        agent_id: OTHER_AGENT_ID,
        content: 'thanks',
        mentions: [],
        reply_to: 'mine-1',
      },
      agent: SELF,
      pub,
      sentMessageIds: new Set(['mine-1']),
    })
    expect(result.rule).toBe('reply_to_mine')
  })
})
