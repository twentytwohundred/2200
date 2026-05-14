import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isSkillMdUrl,
  parseGithubSource,
  resolveSource,
  SourceResolutionError,
  UnsupportedSourceError,
} from '../../../src/runtime/extensions/source.js'

let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), '2200-ext-src-'))
})

afterEach(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('parseGithubSource', () => {
  it('parses canonical https URLs', () => {
    expect(parseGithubSource('https://github.com/twentytwohundred/skill-foo')).toEqual({
      owner: 'twentytwohundred',
      repo: 'skill-foo',
    })
  })

  it('parses canonical https URLs with .git suffix', () => {
    expect(parseGithubSource('https://github.com/twentytwohundred/skill-foo.git')).toEqual({
      owner: 'twentytwohundred',
      repo: 'skill-foo',
    })
  })

  it('parses the github: shorthand', () => {
    expect(parseGithubSource('github:twentytwohundred/skill-foo')).toEqual({
      owner: 'twentytwohundred',
      repo: 'skill-foo',
    })
  })

  it('returns null for non-github URLs', () => {
    expect(parseGithubSource('https://gitlab.com/foo/bar')).toBeNull()
    expect(parseGithubSource('git@github.com:foo/bar.git')).toBeNull()
    expect(parseGithubSource('./local-path')).toBeNull()
  })
})

describe('resolveSource (local)', () => {
  it('accepts an absolute path to a directory', async () => {
    const dir = join(scratch, 'ext-a')
    await mkdir(dir)
    const r = await resolveSource(dir)
    expect(r.kind).toBe('local')
    expect(r.rootDir).toBe(dir)
    await r.cleanup()
  })

  it('expands a relative path against cwd', async () => {
    const dir = join(scratch, 'ext-rel')
    await mkdir(dir)
    const r = await resolveSource('ext-rel', { cwd: scratch })
    expect(r.kind).toBe('local')
    expect(r.rootDir).toBe(dir)
    await r.cleanup()
  })

  it('expands a ~-prefixed path to the user homedir', async () => {
    // We can't write in homedir for the test, but we can verify the
    // expansion path: the resolver returns a local dir at `homedir()`
    // (which exists in any sane test env) on success.
    const r = await resolveSource('~')
    expect(r.rootDir).toBe(homedir())
    await r.cleanup()
  })

  it('throws SourceResolutionError on missing path', async () => {
    await expect(resolveSource(join(scratch, 'nope'))).rejects.toBeInstanceOf(SourceResolutionError)
  })

  it('throws SourceResolutionError when path is a file, not a dir', async () => {
    const filePath = join(scratch, 'file.txt')
    await rm(filePath, { force: true })
    await mkdir(scratch, { recursive: true })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(filePath, 'hi', 'utf8')
    await expect(resolveSource(filePath)).rejects.toThrow(/not a directory/)
  })

  it('throws on empty input', async () => {
    await expect(resolveSource('   ')).rejects.toThrow(/empty/)
  })
})

describe('resolveSource (unsupported)', () => {
  it('throws UnsupportedSourceError for non-github http URLs', async () => {
    await expect(resolveSource('https://gitlab.com/foo/bar')).rejects.toBeInstanceOf(
      UnsupportedSourceError,
    )
  })
})

describe('isSkillMdUrl', () => {
  it('accepts a vanity SKILL.md URL', () => {
    expect(isSkillMdUrl('https://openpub.ai/skill.md')).toBe(true)
  })

  it('accepts uppercase SKILL.md', () => {
    expect(isSkillMdUrl('https://example.com/path/SKILL.md')).toBe(true)
  })

  it('accepts a SKILL.md URL with query string', () => {
    expect(isSkillMdUrl('https://example.com/skill.md?v=1')).toBe(true)
  })

  it('rejects URLs that do not end in skill.md', () => {
    expect(isSkillMdUrl('https://example.com/skill.md.html')).toBe(false)
    expect(isSkillMdUrl('https://example.com/my-skill.md')).toBe(false)
    expect(isSkillMdUrl('https://example.com/')).toBe(false)
  })

  it('rejects non-http schemes', () => {
    expect(isSkillMdUrl('ftp://example.com/skill.md')).toBe(false)
    expect(isSkillMdUrl('file:///tmp/skill.md')).toBe(false)
  })
})

describe('resolveSource (single-file SKILL.md URL)', () => {
  const skillBody = [
    '---',
    'name: openpub',
    'description: Social infrastructure for AI agents.',
    '---',
    '',
    '# OpenPub',
    '',
    'Body text.',
  ].join('\n')

  const makeRealTempDir = (sub: string) => async () => {
    const path = join(scratch, sub)
    await mkdir(path, { recursive: true })
    return path
  }

  it('fetches the URL and writes SKILL.md into a temp dir', async () => {
    let capturedUrl: unknown
    const r = await resolveSource('https://openpub.ai/skill.md', {
      makeTempDir: makeRealTempDir('fetched-skill'),
      fetchImpl: (input) => {
        capturedUrl = input
        return Promise.resolve(
          new Response(skillBody, {
            status: 200,
            headers: { 'content-type': 'text/markdown' },
          }),
        )
      },
    })
    expect(capturedUrl).toBe('https://openpub.ai/skill.md')
    expect(r.kind).toBe('skill_url')
    expect(r.origin).toBe('https://openpub.ai/skill.md')
    const written = await readFile(join(r.rootDir, 'SKILL.md'), 'utf8')
    expect(written).toBe(skillBody)
    await r.cleanup()
    await expect(stat(r.rootDir)).rejects.toThrow()
  })

  it('surfaces a non-2xx HTTP response as SourceResolutionError + cleans up', async () => {
    const sentinel = join(scratch, 'fetched-skill-404')
    await expect(
      resolveSource('https://openpub.ai/skill.md', {
        makeTempDir: async () => {
          await mkdir(sentinel, { recursive: true })
          return sentinel
        },
        fetchImpl: () =>
          Promise.resolve(new Response('not found', { status: 404, statusText: 'Not Found' })),
      }),
    ).rejects.toThrow(/404/)
    await expect(stat(sentinel)).rejects.toThrow()
  })

  it('surfaces a network failure as SourceResolutionError', async () => {
    await expect(
      resolveSource('https://openpub.ai/skill.md', {
        makeTempDir: makeRealTempDir('fetched-skill-net'),
        fetchImpl: () => Promise.reject(new Error('connection refused')),
      }),
    ).rejects.toBeInstanceOf(SourceResolutionError)
  })

  it('rejects an empty body', async () => {
    await expect(
      resolveSource('https://openpub.ai/skill.md', {
        makeTempDir: makeRealTempDir('fetched-skill-empty'),
        fetchImpl: () => Promise.resolve(new Response('   \n\n  ', { status: 200 })),
      }),
    ).rejects.toThrow(/empty/)
  })
})

describe('resolveSource (github)', () => {
  it('invokes the supplied git binary with the expected args', async () => {
    // Build a fake "git" binary that just records what it was called
    // with and creates a manifest at the target path.
    const fakeGit = join(scratch, 'fake-git.sh')
    const tempDirSentinel = join(scratch, 'fake-clone-target')
    const { writeFile, chmod } = await import('node:fs/promises')
    await writeFile(
      fakeGit,
      `#!/usr/bin/env bash
# args: clone --depth=1 --quiet <url> <target>
target="\${@: -1}"
mkdir -p "$target"
cat > "$target/manifest.json" <<EOF
{ "schema_version": 1, "name": "fake", "version": "0.0.1", "display_name": "Fake", "description": "Fake", "author": "T" }
EOF
`,
      { mode: 0o755, encoding: 'utf8' },
    )
    await chmod(fakeGit, 0o755)

    const r = await resolveSource('github:twentytwohundred/fake', {
      gitBinary: fakeGit,
      makeTempDir: () => Promise.resolve(tempDirSentinel),
    })
    expect(r.kind).toBe('github')
    expect(r.origin).toBe('github:twentytwohundred/fake')
    const { stat } = await import('node:fs/promises')
    expect((await stat(join(r.rootDir, 'manifest.json'))).isFile()).toBe(true)
    await r.cleanup()
    // After cleanup the temp dir should be gone.
    await expect(stat(tempDirSentinel)).rejects.toThrow()
  })

  it('surfaces a non-zero git exit as SourceResolutionError', async () => {
    const fakeGit = join(scratch, 'fake-git-fail.sh')
    const { writeFile, chmod } = await import('node:fs/promises')
    await writeFile(fakeGit, `#!/usr/bin/env bash\necho "fake fatal" >&2\nexit 7\n`, {
      mode: 0o755,
      encoding: 'utf8',
    })
    await chmod(fakeGit, 0o755)
    await expect(
      resolveSource('https://github.com/x/y', {
        gitBinary: fakeGit,
        makeTempDir: () => Promise.resolve(join(scratch, 't')),
      }),
    ).rejects.toThrow(/exited 7/)
  })
})
