import { timeAgo } from '@/lib/utils'

/**
 * The state the refresh control is in, in priority order.
 *
 * This used to live as a nested ternary inside AppHeader's JSX, which meant the precedence
 * between "offline", "syncing", "error" and "stale" — the thing that actually decides whether
 * the button can be pressed — was not testable and not visible in one place. It is a state
 * machine, so it is written as one.
 */
export type RefreshState =
  | 'offline'
  | 'syncing'
  | 'error'
  | 'pending-upload'
  | 'stale'
  | 'idle'

/**
 * How long since the last successful refresh before the control admits the data may be behind.
 *
 * This exists because `pullStale` is in-memory: it resets to `false` on every app launch, so on
 * a cold start after hours away the control claimed everything was current until the first sync
 * completed. Elapsed time is the only signal that survives a reload.
 */
export const STALE_AFTER_MS = 15 * 60 * 1000

export type RefreshStateInput = {
  isOnline: boolean
  syncStatus: 'idle' | 'syncing' | 'error'
  /** Local writes not yet confirmed by the server. */
  hasPendingUpload: boolean
  /** Set by the sync manager when a refresh failed; in-memory, so it does not survive a reload. */
  pullStale: boolean
  /** `Number.POSITIVE_INFINITY` when this device has never completed a refresh. */
  msSinceLastRefresh: number
}

/**
 * Precedence matters more than any individual state: offline outranks everything (nothing can
 * be done), a sync in flight outranks a past error (it may be the recovery), and an unsent
 * write outranks mere staleness (the user's own data is the more urgent fact).
 */
export function resolveRefreshState(input: RefreshStateInput): RefreshState {
  if (!input.isOnline) return 'offline'
  if (input.syncStatus === 'syncing') return 'syncing'
  if (input.syncStatus === 'error') return 'error'
  if (input.hasPendingUpload) return 'pending-upload'
  if (input.pullStale || input.msSinceLastRefresh >= STALE_AFTER_MS) return 'stale'
  return 'idle'
}

/**
 * Only offline and in-flight block a press.
 *
 * In particular `error` and `stale` must stay pressable — those are exactly the states where
 * the user wants to retry, and disabling them would leave the only recovery path being to wait
 * out the backoff timer.
 */
export function isRefreshDisabled(state: RefreshState): boolean {
  return state === 'offline' || state === 'syncing'
}

export function refreshStatusLabel(state: RefreshState, retrySeconds: number | null): string {
  switch (state) {
    case 'offline':
      return 'Offline'
    case 'syncing':
      return 'Refreshing…'
    case 'error':
      return retrySeconds !== null ? `Retry in ~${retrySeconds}s` : "Couldn't sync"
    case 'pending-upload':
      return 'Waiting to sync'
    case 'stale':
      return 'Data may be behind'
    case 'idle':
      return 'Refresh'
  }
}

/** Freshness line, e.g. "Updated 4m ago". Never shows a bare timestamp. */
export function lastUpdatedLabel(lastRefreshAt: string | null): string {
  if (!lastRefreshAt) return 'Not synced yet'
  const ago = timeAgo(lastRefreshAt)
  // timeAgo returns "Just now" rather than a duration, so "Updated Just now" would read wrong.
  return ago === 'Just now' ? 'Updated just now' : `Updated ${ago}`
}

/** Tooltip text. Explains what a press will do, not just what the state is. */
export function refreshTitle(state: RefreshState, retrySeconds: number | null): string {
  switch (state) {
    case 'offline':
      return "You're offline — connect to refresh your data"
    case 'syncing':
      return 'Refreshing…'
    case 'error':
      return retrySeconds !== null
        ? `Sync failed — retry in ~${retrySeconds}s (tap to retry now)`
        : 'Sync failed — tap to retry'
    case 'pending-upload':
      return 'Waiting to sync — tap to sync now'
    case 'stale':
      return 'Some data may be out of date — tap to refresh'
    case 'idle':
      return 'Tap to refresh'
  }
}

/**
 * Accessible name. Carries the freshness text because the visible label omits it on small
 * screens, so a screen-reader user would otherwise lose it entirely.
 */
export function refreshAriaLabel(state: RefreshState, lastUpdated: string): string {
  switch (state) {
    case 'offline':
      return 'Offline — cannot refresh'
    case 'syncing':
      return 'Refreshing'
    case 'error':
      return 'Refresh data. Last sync failed'
    default:
      return `Refresh data. ${lastUpdated}`
  }
}
