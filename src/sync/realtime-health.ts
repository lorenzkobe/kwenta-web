/**
 * Whether a realtime event failed to reach the mirror since the last successful sync.
 *
 * The realtime cursor advances past an event even when applying it failed, so the next catch-up
 * will not retry it. The full sync that used to run on every tab focus healed that silently; now
 * that a focus only probes for NEW events, this flag is what makes it sync instead.
 *
 * Failures are counted rather than flagged so a sync clears only what it can have covered: one
 * already running when a failure lands may have read the server before the failed change.
 */
let failures = 0
let clearedThrough = 0

export function markRealtimeProcessingFailed(): void {
  failures += 1
}

export function realtimeProcessingFailed(): boolean {
  return failures > clearedThrough
}

/** Take before a sync starts; pass to {@link clearRealtimeProcessingFailed} once it succeeded. */
export function realtimeHealthToken(): number {
  return failures
}

/** A sync that started at `token` succeeded: failures marked before it are healed, later ones not. */
export function clearRealtimeProcessingFailed(token: number = failures): void {
  clearedThrough = Math.max(clearedThrough, token)
}
