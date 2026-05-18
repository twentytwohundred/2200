/**
 * Walkthrough runner tests (Phase F §8).
 */
import { describe, expect, it } from 'vitest'
import {
  computeWalkthroughPlan,
  renderWalkthroughIntro,
  renderCapabilityWalkthrough,
  renderWalkthroughClose,
  type VaultHasChecker,
} from '../../../src/runtime/onboarding/walkthrough-runner.js'
import type { CapabilityRecord } from '../../../src/runtime/onboarding/capability-loader.js'
import type {
  CapabilityFrontmatter,
  CredentialDecl,
} from '../../../src/runtime/onboarding/capability-schema.js'

function makeCap(args: {
  id: string
  label?: string
  description?: string
  auth?: CredentialDecl[]
  estimated_minutes?: number
  body?: string
}): CapabilityRecord {
  const fm: CapabilityFrontmatter = {
    id: args.id,
    label: args.label ?? args.id,
    category: 'email',
    description: args.description ?? 'A short description ending with a period.',
    publisher: 'first-party',
    source: { attribution: 'original' },
    auth: args.auth ?? [],
    unlocks: { tools: [], skills: [], extensions: [], providers: [] },
    network_egress: { domains: 'unrestricted' },
    tags: [],
    requires: { bins: [], os: [], capabilities: [] },
    walkthrough: args.estimated_minutes ? { estimated_minutes: args.estimated_minutes } : {},
  }
  return {
    frontmatter: fm,
    body: args.body ?? '# walkthrough body\n\nSteps go here.',
    source_path: `/test/${args.id}.md`,
    source_kind: 'first-party',
  }
}

function makeVault(sealed: string[]): VaultHasChecker {
  const set = new Set(sealed)
  return { has: (name) => Promise.resolve(set.has(name)) }
}

const gmailCred: CredentialDecl = {
  name: 'GOOGLE_WORKSPACE_OAUTH',
  kind: 'oauth_download_client_secret',
  env_var: 'GOOGLE_WORKSPACE_OAUTH_REF',
}

const stripeCred: CredentialDecl = {
  name: 'STRIPE_SECRET_KEY',
  kind: 'api_key',
  env_var: 'STRIPE_SECRET_KEY_REF',
}

const discordCred: CredentialDecl = {
  name: 'DISCORD_BOT_TOKEN',
  kind: 'bot_token',
  env_var: 'DISCORD_BOT_TOKEN_REF',
}

// ---------------------------------------------------------------------------
// computeWalkthroughPlan
// ---------------------------------------------------------------------------

describe('computeWalkthroughPlan: empty + edge cases', () => {
  it('returns an empty plan when capabilityIds is empty', async () => {
    const plan = await computeWalkthroughPlan({
      agentName: 'hobby',
      capabilityIds: [],
      catalog: [makeCap({ id: 'gmail', auth: [gmailCred] })],
      vault: makeVault([]),
    })
    expect(plan.needs_walkthrough).toEqual([])
    expect(plan.already_provisioned).toEqual([])
    expect(plan.unknown_capabilities).toEqual([])
  })

  it('lists unknown capability ids separately', async () => {
    const plan = await computeWalkthroughPlan({
      agentName: 'hobby',
      capabilityIds: ['gmail', 'made-up-id'],
      catalog: [makeCap({ id: 'gmail', auth: [gmailCred] })],
      vault: makeVault([]),
    })
    expect(plan.unknown_capabilities).toEqual(['made-up-id'])
  })

  it('treats Capabilities with empty auth as already-provisioned', async () => {
    const plan = await computeWalkthroughPlan({
      agentName: 'hobby',
      capabilityIds: ['weather'],
      catalog: [makeCap({ id: 'weather', auth: [] })],
      vault: makeVault([]),
    })
    expect(plan.already_provisioned).toEqual(['weather'])
    expect(plan.needs_walkthrough).toEqual([])
  })
})

describe('computeWalkthroughPlan: sealed vs unsealed routing', () => {
  it('puts sealed Capabilities in already_provisioned', async () => {
    const plan = await computeWalkthroughPlan({
      agentName: 'hobby',
      capabilityIds: ['gmail'],
      catalog: [makeCap({ id: 'gmail', auth: [gmailCred] })],
      vault: makeVault(['GOOGLE_WORKSPACE_OAUTH_REF']),
    })
    expect(plan.already_provisioned).toEqual(['gmail'])
    expect(plan.needs_walkthrough).toEqual([])
  })

  it('puts unsealed Capabilities in needs_walkthrough with the missing-credentials list', async () => {
    const plan = await computeWalkthroughPlan({
      agentName: 'hobby',
      capabilityIds: ['stripe'],
      catalog: [makeCap({ id: 'stripe', auth: [stripeCred] })],
      vault: makeVault([]),
    })
    expect(plan.needs_walkthrough).toHaveLength(1)
    expect(plan.needs_walkthrough[0]?.capability.frontmatter.id).toBe('stripe')
    expect(plan.needs_walkthrough[0]?.missing_credentials).toEqual([stripeCred])
  })

  it('partial-seal: lists only the missing credentials, not the sealed ones', async () => {
    const dualAuth = makeCap({
      id: 'multi-cred-cap',
      auth: [gmailCred, stripeCred],
    })
    const plan = await computeWalkthroughPlan({
      agentName: 'hobby',
      capabilityIds: ['multi-cred-cap'],
      catalog: [dualAuth],
      vault: makeVault(['GOOGLE_WORKSPACE_OAUTH_REF']),
    })
    expect(plan.needs_walkthrough).toHaveLength(1)
    expect(plan.needs_walkthrough[0]?.missing_credentials).toEqual([stripeCred])
  })
})

describe('computeWalkthroughPlan: ordering', () => {
  it('sorts needs_walkthrough by capability id ascending', async () => {
    const plan = await computeWalkthroughPlan({
      agentName: 'hobby',
      capabilityIds: ['stripe', 'discord', 'anthropic'],
      catalog: [
        makeCap({ id: 'stripe', auth: [stripeCred] }),
        makeCap({ id: 'discord', auth: [discordCred] }),
        makeCap({
          id: 'anthropic',
          auth: [{ name: 'X', kind: 'api_key', env_var: 'X_REF' }],
        }),
      ],
      vault: makeVault([]),
    })
    expect(plan.needs_walkthrough.map((s) => s.capability.frontmatter.id)).toEqual([
      'anthropic',
      'discord',
      'stripe',
    ])
  })
})

// ---------------------------------------------------------------------------
// renderWalkthroughIntro
// ---------------------------------------------------------------------------

describe('renderWalkthroughIntro', () => {
  it('returns empty string when plan has no walkthroughs', () => {
    expect(
      renderWalkthroughIntro({
        agent_name: 'hobby',
        needs_walkthrough: [],
        already_provisioned: [],
        unknown_capabilities: [],
      }),
    ).toBe('')
  })

  it('uses singular phrasing for a 1-Capability plan', () => {
    const out = renderWalkthroughIntro({
      agent_name: 'hobby',
      needs_walkthrough: [
        { capability: makeCap({ id: 'gmail', label: 'Gmail' }), missing_credentials: [gmailCred] },
      ],
      already_provisioned: [],
      unknown_capabilities: [],
    })
    expect(out).toContain('one integration')
    expect(out).toContain('**Gmail**')
  })

  it('uses "A and B" phrasing for 2 Capabilities', () => {
    const out = renderWalkthroughIntro({
      agent_name: 'hobby',
      needs_walkthrough: [
        { capability: makeCap({ id: 'gmail', label: 'Gmail' }), missing_credentials: [gmailCred] },
        {
          capability: makeCap({ id: 'stripe', label: 'Stripe' }),
          missing_credentials: [stripeCred],
        },
      ],
      already_provisioned: [],
      unknown_capabilities: [],
    })
    expect(out).toContain('Gmail and Stripe')
    expect(out).toContain('2 integrations')
  })

  it('uses Oxford comma for 3+ Capabilities', () => {
    const out = renderWalkthroughIntro({
      agent_name: 'hobby',
      needs_walkthrough: [
        { capability: makeCap({ id: 'gmail', label: 'Gmail' }), missing_credentials: [gmailCred] },
        {
          capability: makeCap({ id: 'slack', label: 'Slack' }),
          missing_credentials: [discordCred],
        },
        {
          capability: makeCap({ id: 'stripe', label: 'Stripe' }),
          missing_credentials: [stripeCred],
        },
      ],
      already_provisioned: [],
      unknown_capabilities: [],
    })
    expect(out).toContain('Gmail, Slack, and Stripe')
    expect(out).toContain('3 integrations')
  })

  it('sums estimated_minutes across all Capabilities', () => {
    const out = renderWalkthroughIntro({
      agent_name: 'hobby',
      needs_walkthrough: [
        {
          capability: makeCap({ id: 'a', estimated_minutes: 10 }),
          missing_credentials: [gmailCred],
        },
        {
          capability: makeCap({ id: 'b', estimated_minutes: 5 }),
          missing_credentials: [stripeCred],
        },
      ],
      already_provisioned: [],
      unknown_capabilities: [],
    })
    expect(out).toContain('about 15 minutes total')
  })

  it('defaults missing estimated_minutes to 5 per Capability', () => {
    const out = renderWalkthroughIntro({
      agent_name: 'hobby',
      needs_walkthrough: [
        { capability: makeCap({ id: 'a' }), missing_credentials: [gmailCred] }, // no estimated_minutes
      ],
      already_provisioned: [],
      unknown_capabilities: [],
    })
    expect(out).toContain('about 5 minutes total')
  })
})

// ---------------------------------------------------------------------------
// renderCapabilityWalkthrough
// ---------------------------------------------------------------------------

describe('renderCapabilityWalkthrough', () => {
  it('includes label, description, missing-creds count, and body', () => {
    const slot = {
      capability: makeCap({
        id: 'gmail',
        label: 'Gmail',
        description: 'Read and send Gmail mail.',
        body: '# Setup walkthrough\n\nStep 1...',
      }),
      missing_credentials: [gmailCred],
    }
    const out = renderCapabilityWalkthrough(slot)
    expect(out).toContain('## Gmail')
    expect(out).toContain('Read and send Gmail mail.')
    expect(out).toContain('`GOOGLE_WORKSPACE_OAUTH_REF`')
    expect(out).toContain('# Setup walkthrough')
    expect(out).toContain('Step 1...')
  })

  it('singular phrasing for 1 missing credential', () => {
    const slot = {
      capability: makeCap({ id: 'gmail' }),
      missing_credentials: [gmailCred],
    }
    expect(renderCapabilityWalkthrough(slot)).toContain('1 credential')
  })

  it('lists multiple missing credentials by env_var', () => {
    const slot = {
      capability: makeCap({ id: 'multi' }),
      missing_credentials: [gmailCred, stripeCred],
    }
    const out = renderCapabilityWalkthrough(slot)
    expect(out).toContain('2 credentials')
    expect(out).toContain('`GOOGLE_WORKSPACE_OAUTH_REF`')
    expect(out).toContain('`STRIPE_SECRET_KEY_REF`')
  })
})

// ---------------------------------------------------------------------------
// renderWalkthroughClose
// ---------------------------------------------------------------------------

describe('renderWalkthroughClose', () => {
  it('mentions provisioned + skipped + lane + handoff', () => {
    const out = renderWalkthroughClose({
      agent_name: 'hobby',
      agent_role: 'build agent',
      provisioned: ['Gmail', 'Stripe'],
      skipped: ['Slack'],
    })
    expect(out).toContain('**Gmail, Stripe**')
    expect(out).toContain('**Slack**')
    expect(out).toContain('build agent')
    expect(out).toContain('What would you like to work on first?')
  })

  it('skips the provisioned line when none were provisioned', () => {
    const out = renderWalkthroughClose({
      agent_name: 'hobby',
      agent_role: 'build agent',
      provisioned: [],
      skipped: ['Slack'],
    })
    expect(out).not.toContain('provisioned credentials for')
    expect(out).toContain('**Slack**')
  })

  it('skips the skipped line when none were skipped', () => {
    const out = renderWalkthroughClose({
      agent_name: 'hobby',
      agent_role: 'build agent',
      provisioned: ['Gmail'],
      skipped: [],
    })
    expect(out).toContain('**Gmail**')
    expect(out).not.toContain('Skipped')
  })
})
