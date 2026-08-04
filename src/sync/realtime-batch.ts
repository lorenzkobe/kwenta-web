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
