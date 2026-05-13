/**
 * Custom-endpoint storage.
 *
 * Reads / writes the single JSON file at `<home>/config/endpoints.json`.
 * Atomic write via temp+rename; mode 0600 on the file because it carries
 * bearer tokens.
 */
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { homePaths } from '../storage/layout.js'
import {
  CustomEndpointSchema,
  EMPTY_ENDPOINTS_FILE,
  EndpointIdSchema,
  EndpointsFileSchema,
  type CustomEndpoint,
  type EndpointId,
  type EndpointModel,
  type EndpointsFile,
} from './types.js'

export class EndpointStore {
  constructor(private readonly home: string) {}

  private path(): string {
    return homePaths(this.home).configEndpoints
  }

  /** Load the file; returns the empty shape when missing or malformed. */
  async load(): Promise<EndpointsFile> {
    try {
      const raw = await readFile(this.path(), 'utf8')
      const parsed = EndpointsFileSchema.safeParse(JSON.parse(raw))
      if (parsed.success) return parsed.data
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return { ...EMPTY_ENDPOINTS_FILE }
  }

  private async save(file: EndpointsFile): Promise<void> {
    const p = this.path()
    await mkdir(dirname(p), { recursive: true })
    const tmp = `${p}.tmp-${process.pid.toString()}-${Date.now().toString(36)}`
    await writeFile(tmp, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    await rename(tmp, p)
    try {
      await chmod(p, 0o600)
    } catch {
      /* best-effort on platforms that don't support chmod */
    }
  }

  async list(): Promise<CustomEndpoint[]> {
    const file = await this.load()
    return [...file.endpoints].sort((a, b) =>
      a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0,
    )
  }

  async get(id: EndpointId): Promise<CustomEndpoint | null> {
    const file = await this.load()
    return file.endpoints.find((e) => e.id === id) ?? null
  }

  async create(args: {
    id?: EndpointId
    name: string
    base_url: string
    api_key?: string
    models?: EndpointModel[]
    now?: () => Date
  }): Promise<CustomEndpoint> {
    const now = args.now ?? ((): Date => new Date())
    const ts = now().toISOString()
    const id = args.id ?? deriveSlug(args.name)
    EndpointIdSchema.parse(id)
    const file = await this.load()
    if (file.endpoints.some((e) => e.id === id)) {
      throw new Error(`endpoint with id "${id}" already exists`)
    }
    const entry = CustomEndpointSchema.parse({
      schema_version: 1,
      id,
      name: args.name,
      base_url: args.base_url,
      api_key: args.api_key ?? '',
      models: args.models ?? [],
      created_at: ts,
      updated_at: ts,
    })
    await this.save({
      schema_version: 1,
      endpoints: [...file.endpoints, entry],
    })
    return entry
  }

  async update(
    id: EndpointId,
    patch: Partial<Pick<CustomEndpoint, 'name' | 'base_url' | 'api_key' | 'models'>>,
    now: () => Date = (): Date => new Date(),
  ): Promise<CustomEndpoint> {
    const file = await this.load()
    const current = file.endpoints.find((e) => e.id === id)
    if (!current) throw new Error(`endpoint not found: ${id}`)
    const next: CustomEndpoint = CustomEndpointSchema.parse({
      ...current,
      ...patch,
      updated_at: now().toISOString(),
    })
    await this.save({
      schema_version: 1,
      endpoints: file.endpoints.map((e) => (e.id === id ? next : e)),
    })
    return next
  }

  async delete(id: EndpointId): Promise<void> {
    const file = await this.load()
    if (!file.endpoints.some((e) => e.id === id)) return
    await this.save({
      schema_version: 1,
      endpoints: file.endpoints.filter((e) => e.id !== id),
    })
  }
}

/**
 * Derive a slug from the user-provided name. Lowercase, dashes for
 * whitespace and non-slug chars, collapse runs, trim. Fall back to a
 * generic slug if nothing survives.
 */
function deriveSlug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50)
  return base.length === 0 ? `endpoint-${Date.now().toString(36)}` : base
}

export const __testing__ = { deriveSlug }
