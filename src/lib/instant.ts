/**
 * Timestamps as the server writes them, compared to the microsecond.
 *
 * `Date.parse` keeps milliseconds, and more than three fractional digits is implementation-defined
 * in browsers (a NaN there would silently reorder or equate rows). So the fraction is stripped
 * before parsing and compared as a padded string, which is exact to the nanosecond.
 */

const TIMESTAMP_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}(?::?\d{2})?)$/

function parseInstant(value: string): { seconds: number; nanos: string } | null {
  const m = typeof value === 'string' ? TIMESTAMP_RE.exec(value) : null
  if (!m) return null
  const [, date, time, fraction = '', zone] = m
  let offset = zone
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '')
    offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2, 4) || '00'}`
  }
  const ms = Date.parse(`${date}T${time}${offset}`)
  if (Number.isNaN(ms)) return null
  return { seconds: ms / 1000, nanos: fraction.padEnd(9, '0') }
}

/**
 * Whether two timestamps name the same instant, to the microsecond. Postgres stores microseconds
 * and `Date.parse` keeps milliseconds, so two versions of one row written within the same
 * millisecond would compare equal there — and an event for the second would be skipped as if the
 * first were it. False for anything unparseable.
 */
export function sameInstant(a: string, b: string): boolean {
  const x = parseInstant(a)
  const y = parseInstant(b)
  return x !== null && y !== null && x.seconds === y.seconds && x.nanos === y.nanos
}

/**
 * Chronological order of two timestamps, to the microsecond: negative when `a` is earlier.
 * Unparseable values compare equal to each other and sort after every parseable one, so the order
 * stays total and stable; a caller breaks the tie with something else (an id).
 */
export function compareInstants(a: string, b: string): number {
  const x = parseInstant(a)
  const y = parseInstant(b)
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
  if (x.seconds !== y.seconds) return x.seconds < y.seconds ? -1 : 1
  return x.nanos < y.nanos ? -1 : x.nanos > y.nanos ? 1 : 0
}
