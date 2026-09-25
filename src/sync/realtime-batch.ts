// Pure planning logic for coalescing a burst of realtime user-events.
//
// A single logical change (e.g. a bundled settle-up) fans out into one
// `kwenta_user_events` row per settlement leg per group member, so the live
// subscription receives N events for one action. Processing each individually
// fires N `kwenta_reconcile_user_event` RPCs. This planner lets the caller drain
// the whole queue at once, group it by entity, and reconcile each entity once.
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

/** What a targeted `kwenta_reconcile_user_event` (028) can serve, one entity at a time. */
export type ReconcileEntityType = 'bills' | 'groups' | 'settlements' | 'profiles' | 'profile_peer_links'

export interface EntityEvents {
  entityType: ReconcileEntityType
  entityId: string
  /** The events filed under this entity, in arrival order. */
  events: UserEventRow[]
}

export interface EntityGrouping {
  /** One entry per entity, in order of first appearance. */
  groups: EntityEvents[]
  /** An event a per-entity reconcile cannot serve is in the batch: take the complete bundle instead. */
  fullSync: boolean
}

function payloadString(ev: UserEventRow, key: string): string | null {
  const payload = ev.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/** The entity an event belongs to, or null when only a full sync can serve it. */
function entityOf(ev: UserEventRow): { entityType: ReconcileEntityType; entityId: string } | null {
  // A hard delete has no row left to reconcile.
  if (ev.op === 'DELETE') return null
  switch (ev.entity_type) {
    case 'bills':
    case 'settlements':
    case 'profile_peer_links':
      return { entityType: ev.entity_type, entityId: ev.entity_id }
    case 'profiles':
      // A link hands this user a contact's whole history (old `updated_at`s), which no
      // single-entity reconcile returns.
      return payloadString(ev, 'linked_profile_id') ? null : { entityType: 'profiles', entityId: ev.entity_id }
    case 'groups': {
      return { entityType: 'groups', entityId: payloadString(ev, 'group_id') ?? ev.entity_id }
    }
    case 'group_members': {
      const groupId = payloadString(ev, 'group_id')
      return groupId ? { entityType: 'groups', entityId: groupId } : null
    }
    default:
      return null
  }
}

/**
 * Groups a burst by the entity a targeted reconcile fetches. One remote bill edit fires one event
 * per row — the bill, each item, each split, all filed under the bill (072) — and a membership
 * change also refreshes its group, so the burst is usually ONE entity. Callers dedupe first
 * (`planRealtimeBatch`).
 */
export function groupByEntity(events: readonly UserEventRow[]): EntityGrouping {
  const byKey = new Map<string, EntityEvents>()
  let fullSync = false
  for (const ev of events) {
    const entity = entityOf(ev)
    if (!entity) {
      fullSync = true
      continue
    }
    const key = `${entity.entityType}:${entity.entityId}`
    const group = byKey.get(key)
    if (group) group.events.push(ev)
    else byKey.set(key, { ...entity, events: [ev] })
  }
  return { groups: [...byKey.values()], fullSync }
}

/** Tables whose rows an event can name as the one that fired it (migration 072). */
const MIRRORED_EVENT_TABLES = ['bills', 'bill_items', 'item_splits', 'settlements', 'groups', 'group_members'] as const
export type MirroredEventTable = (typeof MIRRORED_EVENT_TABLES)[number]

/** 072's tables plus the profile and peer-link rows 077 names: every row realtime can echo-skip. */
export const ECHO_EVENT_TABLES = [...MIRRORED_EVENT_TABLES, 'profiles', 'profile_peer_links'] as const
export type EchoEventTable = (typeof ECHO_EVENT_TABLES)[number]

export interface EventRowVersion<T extends string = MirroredEventTable> {
  table: T
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
export function eventRowVersion(ev: Pick<UserEventRow, 'op' | 'payload'>): EventRowVersion | null
export function eventRowVersion<T extends string>(
  ev: Pick<UserEventRow, 'op' | 'payload'>,
  tables: readonly T[],
): EventRowVersion<T> | null
export function eventRowVersion(
  ev: Pick<UserEventRow, 'op' | 'payload'>,
  tables: readonly string[] = MIRRORED_EVENT_TABLES,
): EventRowVersion<string> | null {
  if (ev.op === 'DELETE') return null
  const payload = ev.payload
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const row = (payload as Record<string, unknown>).row
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null
  const { table, id, updated_at: updatedAt } = row as Record<string, unknown>
  if (typeof table !== 'string' || !tables.includes(table)) return null
  if (typeof id !== 'string' || id === '' || typeof updatedAt !== 'string' || updatedAt === '') return null
  return { table, id, updatedAt }
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
