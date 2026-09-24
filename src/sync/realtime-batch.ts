// Pure planning logic for coalescing a burst of realtime user-events.
//
// A single logical change (e.g. a bundled settle-up) fans out into one
// `kwenta_user_events` row per settlement leg per group member, so the live
// subscription receives N events for one action. Processing each individually
// fires N `kwenta_reconcile_user_event` RPCs. This planner lets the caller drain
// the whole queue at once and decide: a lone event keeps the lightweight
// targeted reconcile, while a burst collapses into a single syncRoundTrip.
//
// Kept dependency-free so it is trivially unit-testable (no supabase/Dexie).

export type UserEventRow = {
  id: string
  user_id: string
  event_type: string
  entity_type: string
  entity_id: string
  op: string
  payload: unknown | null
  created_at: string
}

export interface RealtimeBatchPlan {
  /** Events not yet processed (deduped by id, in arrival order). */
  fresh: UserEventRow[]
  /**
   * Max `created_at` across the WHOLE batch — including already-seen events — so
   * the caller can advance the last-seen cursor past everything it drained and
   * reconnect catch-up won't refetch them.
   */
  latestCreatedAt: string | null
}

/**
 * Newest `created_at` in a set of events, or null when empty.
 *
 * The last-seen cursor must ALWAYS come from here — i.e. from the server clock that stamped the
 * rows — and never from `Date.now()`/`now()`. A device running fast that writes its own time as the
 * cursor filters out (`.gt('created_at', cursor)`) every event the server creates until real time
 * catches up, and the cursor only ever moves forward, so those events are lost for good.
 */
export function latestEventCreatedAt(events: readonly UserEventRow[]): string | null {
  let latest: string | null = null
  for (const ev of events) {
    if (latest === null || ev.created_at > latest) latest = ev.created_at
  }
  return latest
}

export function planRealtimeBatch(
  batch: UserEventRow[],
  alreadySeen: (id: string) => boolean,
): RealtimeBatchPlan {
  const fresh: UserEventRow[] = []
  const seenInBatch = new Set<string>()

  for (const ev of batch) {
    if (seenInBatch.has(ev.id) || alreadySeen(ev.id)) continue
    seenInBatch.add(ev.id)
    fresh.push(ev)
  }

  // Across the WHOLE batch, including already-seen events, so the cursor advances past everything
  // drained and reconnect catch-up will not refetch them.
  return { fresh, latestCreatedAt: latestEventCreatedAt(batch) }
}

/** Tables whose rows an event can name as the one that fired it (migration 072). */
const MIRRORED_EVENT_TABLES = ['bills', 'bill_items', 'item_splits', 'settlements', 'groups', 'group_members'] as const
export type MirroredEventTable = (typeof MIRRORED_EVENT_TABLES)[number]

export interface EventRowVersion {
  table: MirroredEventTable
  id: string
  updatedAt: string
}

/**
 * The row that fired an event and the version it was stored at, or null when the event does not
 * say (a pre-072 server, a hard delete) or says it in any shape this cannot read with certainty.
 * `row.table` names the CHANGED row, which differs from `entity_type` for item and split events
 * (filed under their bill) and for the groups refresh that a membership change emits. A DELETE
 * never qualifies: a row that is gone has no version to hold.
 */
export function eventRowVersion(ev: Pick<UserEventRow, 'op' | 'payload'>): EventRowVersion | null {
  if (ev.op === 'DELETE') return null
  const payload = ev.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = (payload as Record<string, unknown>).row
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const { table, id, updated_at: updatedAt } = row as Record<string, unknown>
  if (typeof table !== 'string' || !(MIRRORED_EVENT_TABLES as readonly string[]).includes(table)) return null
  if (typeof id !== 'string' || id === '' || typeof updatedAt !== 'string' || updatedAt === '') return null
  return { table: table as MirroredEventTable, id, updatedAt }
}

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
