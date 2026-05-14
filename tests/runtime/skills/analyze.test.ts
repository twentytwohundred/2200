import { describe, expect, it } from 'vitest'
import { parseSkillContent } from '../../../src/runtime/skills/types.js'
import {
  extractMcpServers,
  extractToolClasses,
  extractToolClassesWithWarnings,
} from '../../../src/runtime/skills/analyze.js'

const FAKE_PATH = '/tmp/test/SKILL.md'

function parse(content: string) {
  return parseSkillContent(content, FAKE_PATH)
}

describe('extractMcpServers (body extraction)', () => {
  it('extracts an OpenPub-style stdio block from a fenced json body', () => {
    const skill = parse(
      [
        '---',
        'name: openpub',
        'description: Social pubs for AI agents.',
        '---',
        '',
        '## Step 2: Install',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "openpub": {',
        '      "command": "npx",',
        '      "args": ["@openpub-ai/hub-mcp"],',
        '      "env": {',
        '        "OPENPUB_AGENT_TOKEN": "<your-token>",',
        '        "OPENPUB_REFRESH_TOKEN": "<your-refresh-token>"',
        '      }',
        '    }',
        '  }',
        '}',
        '```',
      ].join('\n'),
    )
    const servers = extractMcpServers(skill)
    expect(servers).toHaveLength(1)
    const s = servers[0]!
    expect(s.name).toBe('openpub')
    expect(s.transport).toBe('stdio')
    expect(s.source).toBe('body')
    if (s.transport !== 'stdio') throw new Error('wrong transport')
    expect(s.command).toBe('npx')
    expect(s.args).toEqual(['@openpub-ai/hub-mcp'])
    expect(s.required_secrets.map((r) => r.key).sort()).toEqual([
      'OPENPUB_AGENT_TOKEN',
      'OPENPUB_REFRESH_TOKEN',
    ])
    expect(s.required_secrets.every((r) => r.kind === 'stdio_env')).toBe(true)
  })

  it('returns empty when no mcpServers block exists', () => {
    const skill = parse(
      [
        '---',
        'name: pure-knowledge',
        'description: Just instructions, no MCP.',
        '---',
        '',
        '```json',
        '{ "example_tool_call": "search_pubs" }',
        '```',
      ].join('\n'),
    )
    expect(extractMcpServers(skill)).toEqual([])
  })

  it('skips a non-json fenced block before the install block', () => {
    const skill = parse(
      [
        '---',
        'name: openpub',
        'description: Pubs.',
        '---',
        '',
        '```python',
        'print("not json")',
        '```',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "openpub": {',
        '      "command": "npx",',
        '      "args": ["@openpub-ai/hub-mcp"]',
        '    }',
        '  }',
        '}',
        '```',
      ].join('\n'),
    )
    const servers = extractMcpServers(skill)
    expect(servers).toHaveLength(1)
    expect(servers[0]?.name).toBe('openpub')
  })

  it('skips a json fenced block that is not the install block', () => {
    const skill = parse(
      [
        '---',
        'name: openpub',
        'description: Pubs.',
        '---',
        '',
        '```json',
        '{ "example_tool_call": "search_pubs" }',
        '```',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "openpub": { "command": "npx", "args": [] }',
        '  }',
        '}',
        '```',
      ].join('\n'),
    )
    const servers = extractMcpServers(skill)
    expect(servers).toHaveLength(1)
    expect(servers[0]?.name).toBe('openpub')
  })

  it('extracts an http server with bearer auth from the Authorization header', () => {
    const skill = parse(
      [
        '---',
        'name: hosted-mcp',
        'description: Hosted MCP example.',
        '---',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "hosted": {',
        '      "url": "https://api.example.com/mcp",',
        '      "headers": { "Authorization": "Bearer <your-token>" }',
        '    }',
        '  }',
        '}',
        '```',
      ].join('\n'),
    )
    const servers = extractMcpServers(skill)
    expect(servers).toHaveLength(1)
    const s = servers[0]!
    if (s.transport !== 'http') throw new Error('wrong transport')
    expect(s.url).toBe('https://api.example.com/mcp')
    expect(s.auth_kind).toBe('bearer')
    expect(s.required_secrets).toEqual([{ key: 'token', kind: 'http_bearer' }])
  })

  it('extracts an http server with explicit auth.type=bearer', () => {
    const skill = parse(
      [
        '---',
        'name: hosted-mcp',
        'description: Hosted MCP example.',
        '---',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "hosted": {',
        '      "url": "https://api.example.com/mcp",',
        '      "auth": { "type": "bearer" }',
        '    }',
        '  }',
        '}',
        '```',
      ].join('\n'),
    )
    const servers = extractMcpServers(skill)
    const s = servers[0]
    if (s?.transport !== 'http') throw new Error('wrong shape')
    expect(s.auth_kind).toBe('bearer')
    expect(s.required_secrets).toEqual([{ key: 'token', kind: 'http_bearer' }])
  })

  it('skips entries that have both command and url (ambiguous)', () => {
    const skill = parse(
      [
        '---',
        'name: weird',
        'description: Weird.',
        '---',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "weird": { "command": "x", "url": "https://y" }',
        '  }',
        '}',
        '```',
      ].join('\n'),
    )
    expect(extractMcpServers(skill)).toEqual([])
  })

  it('tolerates invalid json in one block and finds the next valid one', () => {
    const skill = parse(
      [
        '---',
        'name: openpub',
        'description: x.',
        '---',
        '',
        '```json',
        '{ broken json [',
        '```',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "openpub": { "command": "npx", "args": [] }',
        '  }',
        '}',
        '```',
      ].join('\n'),
    )
    const servers = extractMcpServers(skill)
    expect(servers).toHaveLength(1)
  })
})

describe('extractMcpServers (frontmatter wins over body)', () => {
  it('prefers a frontmatter mcp.servers block when both are present', () => {
    const skill = parse(
      [
        '---',
        'name: openpub',
        'description: x.',
        'mcp:',
        '  servers:',
        '    openpub:',
        '      command: node',
        '      args: ["./openpub.js"]',
        '      env:',
        '        OPENPUB_TOKEN: ""',
        '---',
        '',
        '```json',
        '{',
        '  "mcpServers": {',
        '    "openpub": { "command": "should-be-ignored", "args": [] }',
        '  }',
        '}',
        '```',
      ].join('\n'),
    )
    const servers = extractMcpServers(skill)
    expect(servers).toHaveLength(1)
    const s = servers[0]!
    expect(s.source).toBe('frontmatter')
    if (s.transport !== 'stdio') throw new Error('wrong transport')
    expect(s.command).toBe('node')
    expect(s.required_secrets.map((r) => r.key)).toEqual(['OPENPUB_TOKEN'])
  })

  it('returns empty when frontmatter mcp.servers exists but is empty', () => {
    const skill = parse(
      ['---', 'name: openpub', 'description: x.', 'mcp:', '  servers: {}', '---'].join('\n'),
    )
    expect(extractMcpServers(skill)).toEqual([])
  })
})

describe('extractToolClasses', () => {
  it('returns the map when present and valid', () => {
    const skill = parse(
      [
        '---',
        'name: openpub',
        'description: x.',
        'tool_classes:',
        '  check_in: external_send',
        '  search_pubs: file_read',
        '---',
      ].join('\n'),
    )
    expect(extractToolClasses(skill)).toEqual({
      check_in: 'external_send',
      search_pubs: 'file_read',
    })
  })

  it('returns empty when absent', () => {
    const skill = parse(['---', 'name: openpub', 'description: x.', '---'].join('\n'))
    expect(extractToolClasses(skill)).toEqual({})
  })

  it('drops entries with invalid class values and reports warnings', () => {
    const skill = parse(
      [
        '---',
        'name: openpub',
        'description: x.',
        'tool_classes:',
        '  check_in: external_send',
        '  weird_one: not_a_class',
        '---',
      ].join('\n'),
    )
    const ext = extractToolClassesWithWarnings(skill)
    expect(ext.classes).toEqual({ check_in: 'external_send' })
    expect(ext.warnings).toHaveLength(1)
    expect(ext.warnings[0]).toMatch(/weird_one/)
    expect(ext.warnings[0]).toMatch(/not_a_class/)
  })

  it('ignores a non-object tool_classes value with a warning', () => {
    const skill = parse(
      ['---', 'name: openpub', 'description: x.', 'tool_classes: "not-an-object"', '---'].join(
        '\n',
      ),
    )
    const ext = extractToolClassesWithWarnings(skill)
    expect(ext.classes).toEqual({})
    expect(ext.warnings.length).toBeGreaterThan(0)
  })
})
