/**
 * Minimal stdlib-only logger.
 *
 * Why hand-rolled vs. pino/winston/debug: at v1, the runtime needs a logger
 * that writes structured-ish lines to stderr, gated by an env-var-controlled
 * level. That is ~30 lines. Pulling a logging library means another dep,
 * another package version to track, and pre-commits to a logging vocabulary
 * before we have evidence the project needs it.
 *
 * Levels: error > warn > info > debug. Default level: info. Override via
 * `LOG_LEVEL` env var. Output goes to stderr (stdout is reserved for
 * intended program output).
 *
 * Format: `<ISO-ts> <LEVEL> <component> <message>` followed by structured
 * fields as JSON when present.
 */

export type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 40,
  warn: 30,
  info: 20,
  debug: 10,
}

function activeLevel(): LogLevel {
  const raw = (process.env['LOG_LEVEL'] ?? '').toLowerCase()
  if (raw === 'error' || raw === 'warn' || raw === 'info' || raw === 'debug') {
    return raw
  }
  return 'info'
}

export interface Logger {
  error(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  debug(message: string, fields?: Record<string, unknown>): void
  child(component: string): Logger
}

function fieldsToString(fields: Record<string, unknown> | undefined): string {
  if (!fields || Object.keys(fields).length === 0) return ''
  try {
    return ' ' + JSON.stringify(fields)
  } catch {
    return ' [unserializable fields]'
  }
}

function emit(
  component: string,
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const min = activeLevel()
  if (LEVEL_RANK[level] < LEVEL_RANK[min]) return
  const ts = new Date().toISOString()
  const line = `${ts} ${level.toUpperCase().padEnd(5)} ${component} ${message}${fieldsToString(fields)}\n`
  process.stderr.write(line)
}

export function createLogger(component: string): Logger {
  return {
    error: (m, f) => {
      emit(component, 'error', m, f)
    },
    warn: (m, f) => {
      emit(component, 'warn', m, f)
    },
    info: (m, f) => {
      emit(component, 'info', m, f)
    },
    debug: (m, f) => {
      emit(component, 'debug', m, f)
    },
    child: (sub) => createLogger(`${component}/${sub}`),
  }
}
