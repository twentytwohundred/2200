/**
 * Task store: file-backed persistence for tasks.
 *
 * Tasks live at `<home>/agents/<name>/tasks/<task_id>.md`. Each is a markdown
 * file with YAML frontmatter parsed by `yaml`. Atomic writes via temp+rename
 * (state-on-disk discipline).
 *
 * v1 is single-task: at most one task in `pending` or `running` at a time per
 * Agent. The store does not enforce that constraint; the loop does. The store
 * exposes list/get/save/delete and a "highest-priority pending" pickup helper.
 */
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { atomicWriteFile } from '../../util/atomic-write.js'
import { agentPaths } from '../../storage/layout.js'
import { TaskFrontmatterSchema, type TaskFrontmatter, type TaskRecord } from './types.js'

const FRONTMATTER_DELIM = '---'

/** Where this Agent's tasks live. */
export function tasksDir(home: string, agentName: string): string {
  return join(agentPaths(home, agentName).root, 'tasks')
}

export function taskPath(home: string, agentName: string, taskId: string): string {
  return join(tasksDir(home, agentName), `${taskId}.md`)
}

export class TaskParseError extends Error {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(`${message} (${path})`)
    this.name = 'TaskParseError'
  }
}

function splitFrontmatter(raw: string): { frontmatter: string; body: string } {
  if (!raw.startsWith(FRONTMATTER_DELIM)) {
    throw new Error('expected leading `---` frontmatter delimiter')
  }
  const afterFirst = raw.slice(FRONTMATTER_DELIM.length)
  const closeIdx = afterFirst.indexOf(`\n${FRONTMATTER_DELIM}`)
  if (closeIdx === -1) {
    throw new Error('expected closing `---` frontmatter delimiter')
  }
  const frontmatter = afterFirst.slice(0, closeIdx).trim()
  const body = afterFirst.slice(closeIdx + 1 + FRONTMATTER_DELIM.length).replace(/^\n/, '')
  return { frontmatter, body }
}

/** Serialize a TaskRecord to its on-disk markdown form. */
export function serializeTask(record: TaskRecord): string {
  const fm = stringify(record.frontmatter, { lineWidth: 0 }).trimEnd()
  const body = record.body.endsWith('\n') ? record.body : record.body + '\n'
  return `${FRONTMATTER_DELIM}\n${fm}\n${FRONTMATTER_DELIM}\n${body}`
}

/** Parse a task file's contents into a validated TaskRecord. */
export function parseTask(raw: string, path: string): TaskRecord {
  let split: ReturnType<typeof splitFrontmatter>
  try {
    split = splitFrontmatter(raw)
  } catch (err) {
    throw new TaskParseError(err instanceof Error ? err.message : String(err), path)
  }
  let fmObj: unknown
  try {
    fmObj = parse(split.frontmatter)
  } catch (err) {
    throw new TaskParseError(
      `frontmatter YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
      path,
    )
  }
  const parsed = TaskFrontmatterSchema.safeParse(fmObj)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new TaskParseError(
      `frontmatter schema validation failed: ${issue?.path.join('.') ?? '<root>'}: ${issue?.message ?? 'unknown'}`,
      path,
    )
  }
  return { frontmatter: parsed.data, body: split.body }
}

export class TaskStore {
  constructor(
    private readonly home: string,
    private readonly agentName: string,
  ) {}

  private dir(): string {
    return tasksDir(this.home, this.agentName)
  }

  private pathFor(taskId: string): string {
    return taskPath(this.home, this.agentName, taskId)
  }

  /** Save a task atomically. Creates the tasks/ dir on first write. */
  async save(record: TaskRecord): Promise<void> {
    await mkdir(this.dir(), { recursive: true })
    await atomicWriteFile(this.pathFor(record.frontmatter.id), serializeTask(record))
  }

  /** Read a task by id. Returns null if missing. */
  async get(taskId: string): Promise<TaskRecord | null> {
    let raw: string
    try {
      raw = await readFile(this.pathFor(taskId), 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw err
    }
    return parseTask(raw, this.pathFor(taskId))
  }

  /** Delete a task. No-op if missing. */
  async delete(taskId: string): Promise<void> {
    await rm(this.pathFor(taskId), { force: true })
  }

  /**
   * List all tasks for this Agent, sorted by `created` descending (most recent
   * first). Tasks that fail to parse are skipped with a console.warn rather
   * than aborting the whole list.
   */
  async list(): Promise<TaskRecord[]> {
    let entries: string[]
    try {
      entries = await readdir(this.dir())
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    const records: TaskRecord[] = []
    for (const name of entries) {
      if (!name.endsWith('.md')) continue
      const id = name.slice(0, -3)
      try {
        const r = await this.get(id)
        if (r) records.push(r)
      } catch {
        continue
      }
    }
    records.sort((a, b) => b.frontmatter.created.localeCompare(a.frontmatter.created))
    return records
  }

  /**
   * Pick the highest-priority pending task. Among ties, oldest wins (FIFO at
   * the same priority). Returns null if there are no pending tasks.
   */
  async pickPending(): Promise<TaskRecord | null> {
    const all = await this.list()
    const pending = all.filter((t) => t.frontmatter.state === 'pending')
    if (pending.length === 0) return null
    pending.sort((a, b) => {
      if (a.frontmatter.priority !== b.frontmatter.priority) {
        return b.frontmatter.priority - a.frontmatter.priority
      }
      return a.frontmatter.created.localeCompare(b.frontmatter.created)
    })
    return pending[0] ?? null
  }

  /** Mutate a task's frontmatter via a function and persist. */
  async update(
    taskId: string,
    mutator: (fm: TaskFrontmatter) => TaskFrontmatter,
  ): Promise<TaskRecord | null> {
    const cur = await this.get(taskId)
    if (!cur) return null
    const next: TaskRecord = {
      frontmatter: mutator(cur.frontmatter),
      body: cur.body,
    }
    await this.save(next)
    return next
  }
}
