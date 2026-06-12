/**
 * Web-app bearer tokens.
 *
 * One JSON file per token at `<home>/state/web-tokens/<id>.json`. Phase A
 * stores token values in plaintext, matching the master-key plaintext
 * limitation already documented for v1; Epic 17 (managed service)
 * hardens. See wiki/epics/15-web-app.md.
 *
 * Token shape:
 *   { id, label, value, created_at }
 *
 * - `id`: short ULID-like identifier ... used in the filename and
 *   surfaced by `2200 web token list` so a user can identify which
 *   token to rotate.
 * - `label`: free-form ("default", "phone", etc.). Defaults to "default".
 * - `value`: 32 random bytes hex-encoded. The bearer token sent in
 *   `Authorization: Bearer <value>`.
 * - `created_at`: ISO-8601 UTC.
 *
 * Tokens are revoked by deleting the file.
 */
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'

export const WebTokenSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  value: z.string().length(64),
  created_at: z.string(),
})
export type WebToken = z.infer<typeof WebTokenSchema>

function newId(): string {
  return randomBytes(8).toString('hex')
}

function newValue(): string {
  return randomBytes(32).toString('hex')
}

function nowIso(): string {
  return new Date().toISOString()
}

export class WebTokenStore {
  constructor(private readonly dir: string) {}

  /** Issue a new token. Caller must persist the returned plaintext value somewhere safe. */
  async issue(label = 'default'): Promise<WebToken> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    const token: WebToken = {
      id: newId(),
      label,
      value: newValue(),
      created_at: nowIso(),
    }
    const path = join(this.dir, `${token.id}.json`)
    await writeFile(path, JSON.stringify(token, null, 2), { encoding: 'utf-8', mode: 0o600 })
    return token
  }

  async list(): Promise<WebToken[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const tokens: WebToken[] = []
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      try {
        const raw = await readFile(join(this.dir, entry), 'utf-8')
        const parsed = WebTokenSchema.parse(JSON.parse(raw))
        tokens.push(parsed)
      } catch {
        /* skip malformed token files */
      }
    }
    return tokens.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  /**
   * Look up a token by its plaintext bearer value. Returns null if no
   * match. Constant-time compare per candidate (same discipline as the
   * connector listener's static-bearer check): `===` short-circuits on
   * the first differing character, which leaks prefix-match timing to
   * whoever can reach the HTTP listener. Length is not secret (always
   * 64 hex chars), so the length pre-check leaks nothing.
   */
  async findByValue(value: string): Promise<WebToken | null> {
    const tokens = await this.list()
    const candidate = Buffer.from(value, 'utf-8')
    for (const t of tokens) {
      const stored = Buffer.from(t.value, 'utf-8')
      if (stored.length === candidate.length && timingSafeEqual(stored, candidate)) {
        return t
      }
    }
    return null
  }

  /** Delete a token by id. Returns true if a token was removed. */
  async revoke(id: string): Promise<boolean> {
    try {
      await unlink(join(this.dir, `${id}.json`))
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw err
    }
  }

  /** Convenience: revoke all then issue one. Used by `2200 web token rotate`. */
  async rotate(label = 'default'): Promise<WebToken> {
    const existing = await this.list()
    for (const t of existing) {
      await this.revoke(t.id)
    }
    return this.issue(label)
  }

  /**
   * Ensure at least one token exists. If the store is empty (fresh install,
   * or all tokens revoked), issue one with label "default" and return it.
   * If tokens already exist, return the most recent one.
   */
  async ensure(label = 'default'): Promise<WebToken> {
    const tokens = await this.list()
    if (tokens.length === 0) return this.issue(label)
    const latest = tokens[tokens.length - 1]
    if (!latest) return this.issue(label)
    return latest
  }
}
