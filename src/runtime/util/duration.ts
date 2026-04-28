/**
 * Parse a friendly duration string into seconds.
 *
 * Accepted forms (case-insensitive, no whitespace):
 *   "30s", "5m", "2h", "1d"
 *
 * No fractional values, no compound forms like "1h30m". Compound is
 * deliberately omitted — operators with finer-grained needs use cron.
 */
export class DurationParseError extends Error {}

const PATTERN = /^(\d+)(s|m|h|d)$/i

export function parseDurationSeconds(input: string): number {
  const match = PATTERN.exec(input.trim())
  if (!match) {
    throw new DurationParseError(
      `invalid duration "${input}"; expected forms like "30s", "5m", "2h", "1d"`,
    )
  }
  const n = Number.parseInt(match[1] ?? '0', 10)
  const unit = (match[2] ?? '').toLowerCase()
  if (n === 0) {
    throw new DurationParseError(`duration "${input}" must be > 0`)
  }
  switch (unit) {
    case 's':
      return n
    case 'm':
      return n * 60
    case 'h':
      return n * 60 * 60
    case 'd':
      return n * 60 * 60 * 24
    default:
      throw new DurationParseError(`unreachable: bad unit "${unit}"`)
  }
}
