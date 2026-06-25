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
  /**
   * True when any fresh event is a profile-link. Those expose historical rows
   * whose `updated_at` predates the pull cursor, so the caller must clear the
   * cursor to force a full pull rather than an incremental one.
   */
  hasProfileLink: boolean
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

export function planRealtimeBatch(
  batch: UserEventRow[],
  alreadySeen: (id: string) => boolean,
): RealtimeBatchPlan {
  let latestCreatedAt: string | null = null
  const fresh: UserEventRow[] = []
  const seenInBatch = new Set<string>()
  let hasProfileLink = false

  for (const ev of batch) {
    if (latestCreatedAt === null || ev.created_at > latestCreatedAt) {
      latestCreatedAt = ev.created_at
    }
    if (seenInBatch.has(ev.id) || alreadySeen(ev.id)) continue
    seenInBatch.add(ev.id)
    fresh.push(ev)
    if (ev.entity_type === 'profiles' && isRecord(ev.payload) && ev.payload.linked_profile_id) {
      hasProfileLink = true
    }
  }

  return { fresh, latestCreatedAt, hasProfileLink }
}
