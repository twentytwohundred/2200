/**
 * Capability schema tests (Phase F §1 schema).
 *
 * Covers: validation of well-formed entries, hardline rejections
 * (description constraints, env-var blocklist, id format), default
 * application, and the discriminated auth shape.
 */
import { describe, expect, it } from 'vitest'
import {
  CapabilityFrontmatterSchema,
  PROVIDER_ENV_BLOCKLIST,
  validateDescription,
  type CapabilityFrontmatter,
} from '../../../src/runtime/onboarding/capability-schema.js'

const MINIMAL: Partial<CapabilityFrontmatter> = {
  id: 'sample',
  label: 'Sample',
  category: 'email',
  description: 'Read and label mail in a sample inbox.',
}

const GMAIL_FULL: Partial<CapabilityFrontmatter> = {
  id: 'google-workspace',
  label: 'Google Workspace',
  category: 'email',
  description: 'Read, label, draft, and send Gmail or Workspace mail.',
  homepage: 'https://workspace.google.com',
  publisher: 'first-party',
  source: {
    attribution: 'openclaw',
    openclaw_path: 'skills/gog/SKILL.md',
    notes: 'Adapted from OpenClaw gog skill.',
  },
  auth: [
    {
      name: 'GOOGLE_WORKSPACE_OAUTH',
      kind: 'oauth_download_client_secret',
      scopes: [
        'https://www.googleapis.com/auth/gmail.modify',
        'https://www.googleapis.com/auth/calendar',
      ],
      env_var: 'GOOGLE_WORKSPACE_OAUTH_REF',
      obtain_url: 'https://console.cloud.google.com/apis/credentials',
    },
  ],
  unlocks: {
    tools: ['gmail_search', 'gmail_send', 'gcal_list_events'],
    skills: ['gmail-triage'],
    extensions: [],
    providers: [],
  },
  network_egress: {
    domains: ['www.googleapis.com', 'oauth2.googleapis.com', 'gmail.googleapis.com'],
  },
  tags: ['email', 'inbox', 'gmail', 'workspace', 'calendar'],
  requires: { bins: [], os: [], capabilities: [] },
  walkthrough: { estimated_minutes: 12, difficulty: 'medium' },
}

// ---------------------------------------------------------------------------
// validateDescription (the 60-char hardline)
// ---------------------------------------------------------------------------

describe('validateDescription', () => {
  it('accepts a clean 53-char description (the gmail seed)', () => {
    expect(validateDescription('Read, label, draft, and send Gmail or Workspace mail.')).toBeNull()
  })

  it('rejects when over 60 chars', () => {
    const tooLong =
      'Read, label, draft, send, archive, and triage mail in your Gmail or Workspace account.'
    const result = validateDescription(tooLong)
    expect(result?.kind).toBe('too-long')
    if (result?.kind === 'too-long') {
      expect(result.length).toBe(tooLong.length)
      expect(result.max).toBe(60)
    }
  })

  it('rejects when no terminating period', () => {
    expect(validateDescription('Read and label mail in Gmail')).toEqual({ kind: 'no-period' })
  })

  it('accepts trailing whitespace after period', () => {
    expect(validateDescription('Read and label mail.   ')).toBeNull()
  })

  it('rejects multi-sentence descriptions', () => {
    const result = validateDescription('Read mail. Label it. Done.')
    expect(result?.kind).toBe('multi-sentence')
  })

  it('rejects marketing word "amazing"', () => {
    const result = validateDescription('Amazing mail tool.')
    expect(result?.kind).toBe('marketing-word')
    if (result?.kind === 'marketing-word') expect(result.word).toBe('amazing')
  })

  it('rejects marketing word "powerful" case-insensitively', () => {
    const result = validateDescription('Powerful inbox manager.')
    expect(result?.kind).toBe('marketing-word')
  })

  it('rejects hyphenated marketing word "cutting-edge"', () => {
    const result = validateDescription('Cutting-edge inbox.')
    expect(result?.kind).toBe('marketing-word')
    if (result?.kind === 'marketing-word') expect(result.word).toBe('cutting-edge')
  })

  it('does NOT reject "send" or "draft" or other neutral verbs', () => {
    expect(validateDescription('Read, label, draft, and send Gmail.')).toBeNull()
  })

  it('does NOT reject "elegantly" (word-boundary protects against inflections)', () => {
    // The word-boundary guard rejects only the exact word "elegant".
    // "elegantly" is a different word; operators can use it. If we
    // want to reject inflections too, add them to MARKETING_WORDS
    // explicitly.
    expect(validateDescription('Renders elegantly.')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// CapabilityFrontmatterSchema ... happy paths
// ---------------------------------------------------------------------------

describe('CapabilityFrontmatterSchema: valid entries', () => {
  it('parses a minimal valid entry and applies defaults', () => {
    const parsed = CapabilityFrontmatterSchema.parse(MINIMAL)
    expect(parsed.id).toBe('sample')
    expect(parsed.publisher).toBe('first-party')
    expect(parsed.network_egress.domains).toBe('unrestricted')
    expect(parsed.auth).toEqual([])
    expect(parsed.unlocks).toEqual({ tools: [], skills: [], extensions: [], providers: [] })
    expect(parsed.tags).toEqual([])
    expect(parsed.requires).toEqual({ bins: [], os: [], capabilities: [] })
    expect(parsed.walkthrough).toEqual({})
    expect(parsed.source.attribution).toBe('original')
  })

  it('parses the gmail (google-workspace bundle) full entry', () => {
    const parsed = CapabilityFrontmatterSchema.parse(GMAIL_FULL)
    expect(parsed.id).toBe('google-workspace')
    expect(parsed.auth).toHaveLength(1)
    expect(parsed.auth[0]?.kind).toBe('oauth_download_client_secret')
    expect(parsed.auth[0]?.env_var).toBe('GOOGLE_WORKSPACE_OAUTH_REF')
    expect(parsed.unlocks.tools).toContain('gmail_search')
    expect(parsed.network_egress.domains).toEqual([
      'www.googleapis.com',
      'oauth2.googleapis.com',
      'gmail.googleapis.com',
    ])
    expect(parsed.source.attribution).toBe('openclaw')
  })

  it('accepts publisher overrides (local, custom string)', () => {
    expect(CapabilityFrontmatterSchema.parse({ ...MINIMAL, publisher: 'local' }).publisher).toBe(
      'local',
    )
    expect(
      CapabilityFrontmatterSchema.parse({ ...MINIMAL, publisher: 'acme.example.com' }).publisher,
    ).toBe('acme.example.com')
  })

  it('accepts network_egress as declared domain list OR unrestricted', () => {
    expect(
      CapabilityFrontmatterSchema.parse({
        ...MINIMAL,
        network_egress: { domains: ['api.example.com'] },
      }).network_egress.domains,
    ).toEqual(['api.example.com'])
    expect(
      CapabilityFrontmatterSchema.parse({
        ...MINIMAL,
        network_egress: { domains: 'unrestricted' },
      }).network_egress.domains,
    ).toBe('unrestricted')
  })
})

// ---------------------------------------------------------------------------
// CapabilityFrontmatterSchema ... rejections
// ---------------------------------------------------------------------------

describe('CapabilityFrontmatterSchema: id format', () => {
  it('rejects uppercase letters', () => {
    expect(() => CapabilityFrontmatterSchema.parse({ ...MINIMAL, id: 'Sample' })).toThrow()
  })

  it('rejects leading digit', () => {
    expect(() => CapabilityFrontmatterSchema.parse({ ...MINIMAL, id: '2sample' })).toThrow()
  })

  it('rejects spaces', () => {
    expect(() => CapabilityFrontmatterSchema.parse({ ...MINIMAL, id: 'sample app' })).toThrow()
  })

  it('rejects underscores', () => {
    expect(() => CapabilityFrontmatterSchema.parse({ ...MINIMAL, id: 'sample_app' })).toThrow()
  })

  it('accepts dashed lowercase ids', () => {
    expect(CapabilityFrontmatterSchema.parse({ ...MINIMAL, id: 'google-workspace' }).id).toBe(
      'google-workspace',
    )
  })
})

describe('CapabilityFrontmatterSchema: description hardline', () => {
  it('rejects a too-long description with a precise message', () => {
    const tooLong =
      'Read, label, draft, send, archive, and triage mail in your Gmail or Workspace account.'
    expect(() => CapabilityFrontmatterSchema.parse({ ...MINIMAL, description: tooLong })).toThrow(
      /hardline is ≤60/,
    )
  })

  it('rejects a missing-period description', () => {
    expect(() =>
      CapabilityFrontmatterSchema.parse({ ...MINIMAL, description: 'Send mail in Gmail' }),
    ).toThrow(/end with a period/)
  })

  it('rejects a multi-sentence description', () => {
    expect(() =>
      CapabilityFrontmatterSchema.parse({
        ...MINIMAL,
        description: 'Send mail. Label inbox. Done.',
      }),
    ).toThrow(/single sentence/)
  })

  it('rejects a description with a marketing word', () => {
    expect(() =>
      CapabilityFrontmatterSchema.parse({
        ...MINIMAL,
        description: 'Powerful inbox manager for Gmail.',
      }),
    ).toThrow(/marketing word.*powerful/)
  })
})

describe('CapabilityFrontmatterSchema: provider-env blocklist (substrate-level)', () => {
  it('rejects auth.env_var that shadows ANTHROPIC_API_KEY', () => {
    expect(() =>
      CapabilityFrontmatterSchema.parse({
        ...MINIMAL,
        auth: [
          {
            name: 'ANTHROPIC_KEY',
            kind: 'api_key',
            env_var: 'ANTHROPIC_API_KEY',
          },
        ],
      }),
    ).toThrow(/shadows a substrate-level reserved name/)
  })

  it('rejects every blocked name', () => {
    for (const blocked of PROVIDER_ENV_BLOCKLIST) {
      expect(() =>
        CapabilityFrontmatterSchema.parse({
          ...MINIMAL,
          auth: [
            {
              name: 'reserved-shadow',
              kind: 'api_key',
              env_var: blocked,
            },
          ],
        }),
      ).toThrow()
    }
  })

  it('accepts a Capability-scoped env_var name', () => {
    const ok = CapabilityFrontmatterSchema.parse({
      ...MINIMAL,
      auth: [
        {
          name: 'gmail-oauth',
          kind: 'oauth_download_client_secret',
          env_var: 'GMAIL_OAUTH_REF',
        },
      ],
    })
    expect(ok.auth[0]?.env_var).toBe('GMAIL_OAUTH_REF')
  })
})

describe('CapabilityFrontmatterSchema: auth kind discriminator', () => {
  it('accepts every documented auth kind', () => {
    const kinds = [
      'api_key',
      'api_key_dual',
      'bot_token',
      'bot_token_plus_app_token',
      'app_id_secret_tenant',
      'oauth_browser_pkce',
      'oauth_download_client_secret',
      'service_account_json',
      'webhook_secret_plus_bot',
      'basic_username_password',
      'local_config_wizard',
      'local_permission_grant',
      'no_credentials',
      'hosted_service_ref',
    ] as const
    for (const kind of kinds) {
      const ok = CapabilityFrontmatterSchema.parse({
        ...MINIMAL,
        auth: [{ name: 'sample-cred', kind, env_var: 'SAMPLE_CRED_REF' }],
      })
      expect(ok.auth[0]?.kind).toBe(kind)
    }
  })

  it('rejects an unknown auth kind', () => {
    expect(() =>
      CapabilityFrontmatterSchema.parse({
        ...MINIMAL,
        auth: [{ name: 'x', kind: 'magic_link', env_var: 'X_REF' }],
      }),
    ).toThrow()
  })
})
