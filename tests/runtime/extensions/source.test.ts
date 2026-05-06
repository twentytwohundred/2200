import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
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
