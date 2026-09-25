import { hydrateLinkedRemoteProfilesForActor } from '@/lib/people'
import { maybeAutoRepairData } from '@/lib/kwenta-data-repair'
import { flushQueuedKwentaNotifications, hasQueuedKwentaNotifications } from '@/lib/kwenta-notifications'
import { markPendingMutationsApplied } from '@/sync/cloud-first-mutations'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'
import { readLastRefreshAt, readRealtimeCursor } from '@/lib/kwenta-storage-keys'
import { requestRealtimeCatchUp } from '@/sync/realtime-events'
import {
  clearRealtimeProcessingFailed,
  realtimeHealthToken,
  realtimeProcessingFailed,
} from '@/sync/realtime-health'
import { currentSessionEpoch, isSessionEpochCurrent } from '@/sync/session-epoch'
import { drainWriteQueue } from '@/sync/write-queue'
import {
  fullSync,
  getMillisecondsSinceLastRefresh,
  isFullSyncInFlight,
  mayHaveStagedRows,
  hasUnsyncedLocalDataForUser,
  newestUserEventSince,
  syncRoundTrip,
} from './sync-service'

/** How often the backup tick asks whether the mirror needs a refresh. */
const SYNC_BACKUP_INTERVAL_MS = 5 * 60 * 1000
/**
 * The bound on changes that emit no event. Contacts, renames and peer links emit events since 077,
 * so what is left is rare enough for an hourly safety refresh (it was 5 minutes on focus and 15 on
 * the backup tick).
 */
const MIRROR_SAFETY_REFRESH_MS = 60 * 60 * 1000

/**
 * 'start', 'activation' and 'backup' go through the `refreshIfNeeded` gate and never queue a re-run
 * behind a sync already in flight: that sync IS the refresh they asked for (a focus during the
 * startup sync used to cost a second complete bundle).
 *
 * 'explicit' (a retry, a local change) and 'user' (the Refresh button) always sync. 'user' is also
 * the one reason that ALWAYS re-reads the screens, even when the sync moved no local row: pressing
 * Refresh is an explicit request for fresh data, and a server-side change that alters no row this
 * device holds would otherwise never reach the screen at all.
 */
type RefreshReason = 'start' | 'activation' | 'backup'
type SyncRunReason = RefreshReason | 'explicit' | 'user'
const BACKOFF_INITIAL_MS = 30_000
const BACKOFF_MAX_MS = 5 * 60 * 1000
const TRIGGER_DEBOUNCE_MS = 400

let backupTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let isSyncing = false
// Set when an explicit or user sync is requested while one is already running, so the in-flight
// sync (which already snapshotted Dexie) doesn't drop the newer mutation.
let rerunRequested = false
let backoffMs = BACKOFF_INITIAL_MS

function isDatabaseClosedError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.name === 'DatabaseClosedError' ||
    err.message.includes('DatabaseClosedError') ||
    err.message.includes('Database has been closed')
  )
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function scheduleRetry() {
  clearRetryTimer()
  const retryAt = Date.now() + backoffMs
  useAppStore.getState().setSyncRetryAt(retryAt)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void runSync('explicit')
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
}

function resetBackoff() {
  backoffMs = BACKOFF_INITIAL_MS
  clearRetryTimer()
  useAppStore.getState().setSyncRetryAt(null)
}

/**
 * Minimum gap between refreshes triggered by the tab becoming active.
 *
 * `focus` and `visibilitychange` BOTH fire when a user returns to the tab. Without this, one tab
 * switch cost two gate runs (and, before the gate, two complete round trips).
 */
const ACTIVATION_REFRESH_MIN_INTERVAL_MS = 5_000
let lastActivationRefreshAt = Number.NEGATIVE_INFINITY

/**
 * Monotonic time source. `Date.now()` can jump BACKWARDS (NTP correcting a fast clock, a manual
 * date change, a phone re-syncing after travel), which would make `now - last` negative — always
 * under the interval — and silently disable the refresh for the whole duration of the skew.
 * That is the same device-clock dependency the pull cursor was removed to escape.
 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/**
 * Whether the mirror needs the complete bundle, cheapest question first:
 *   - no completed refresh yet (first sign-in: the hydration splash waits on it), or the last one
 *     is at least MIRROR_SAFETY_REFRESH_MS old;
 *   - a realtime event failed to apply (its cursor moved on anyway);
 *   - a queued notification, or an unsynced row no queue entry owns (a legacy staged write) — the
 *     sync is what sends them (index counts first, so a quiet check reads no table in full);
 *   - no server cursor to ask from.
 * Otherwise one `LIMIT 1` probe; events newer than the cursor go to realtime's per-entity
 * catch-up, which moves the cursor itself, instead of the complete bundle.
 */
async function needsFullSync(userId: string): Promise<boolean> {
  if (!readLastRefreshAt()) return true
  if (getMillisecondsSinceLastRefresh() >= MIRROR_SAFETY_REFRESH_MS) return true
  if (realtimeProcessingFailed()) return true
  if (await hasQueuedKwentaNotifications(userId)) return true
  if ((await mayHaveStagedRows()) && (await hasUnsyncedLocalDataForUser(userId))) return true
  const cursor = readRealtimeCursor(userId)
  if (!cursor) return true
  const probe = await newestUserEventSince(userId, cursor)
  if (probe.newer) requestRealtimeCatchUp()
  return false
}

/**
 * Replays the write queue in the background. It runs alongside the gate and any full sync rather
 * than ahead of them: a full sync never pushes a row a queue entry owns (sync-service excludes
 * them), so the two cannot reorder a write, and a slow head entry must not hold the refresh.
 * Notifications its entries were holding go out once it settles.
 */
function drainQueueInBackground(userId: string): void {
  void drainWriteQueue(userId)
    .then((drained) => {
      if (drained && drained.applied > 0) return flushQueuedKwentaNotifications()
    })
    .catch((err) => {
      if (!isDatabaseClosedError(err)) console.warn('[sync] write queue drain failed:', err)
    })
}

/** Refresh: send the queue now, ignoring its backoff, and release the notifications it held. */
async function drainQueueNow(userId: string): Promise<void> {
  try {
    const drained = await drainWriteQueue(userId, { ignoreBackoff: true })
    if (drained && drained.applied > 0) await flushQueuedKwentaNotifications()
  } catch (err) {
    // The sync still runs; an entry that did not go out stays queued for the next drain.
    if (!isDatabaseClosedError(err)) console.warn('[sync] write queue drain failed:', err)
  }
}

/**
 * App start, tab activation and the backup tick: drain the write queue, then run the full sync only
 * when `needsFullSync` says the mirror may be behind.
 * @returns whether the refresh was handled (checked, or synced) — false gives an activation's
 * throttle window back.
 */
async function refreshIfNeeded(reason: RefreshReason): Promise<boolean> {
  if (!useAppStore.getState().isOnline) return false
  const session = await resolveSessionWithRetry()
  if (!session?.user) return false
  const userId = session.user.id
  drainQueueInBackground(userId)
  let sync: boolean
  try {
    sync = await needsFullSync(userId)
  } catch {
    // Unsure (a closed database, a failed read): sync, as every refresh used to.
    sync = true
  }
  if (!sync) return true
  return runSync(reason, userId)
}

function onTabActivated() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  const nowMs = monotonicNow()
  if (nowMs - lastActivationRefreshAt < ACTIVATION_REFRESH_MIN_INTERVAL_MS) return
  const previous = lastActivationRefreshAt
  lastActivationRefreshAt = nowMs
  void refreshIfNeeded('activation').then((handled) => {
    // runSync bails out before doing any work when offline, without a session yet, or with one
    // already in flight. Claiming the window anyway would swallow the next real activation.
    if (!handled && lastActivationRefreshAt === nowMs) lastActivationRefreshAt = previous
  })
}

async function resolveSessionWithRetry() {
  let {
    data: { session },
  } = await supabase.auth.getSession()
  if (session?.user) return session
  // Right after sign-in or token refresh, the first getSession() can briefly return null
  // before the client attaches the JWT for PostgREST/RPC.
  await new Promise((r) => setTimeout(r, 200))
  ;({
    data: { session },
  } = await supabase.auth.getSession())
  return session
}

/**
 * @param knownUserId the caller already resolved the session (the refresh gate); skips a second read.
 * @returns whether a sync was actually attempted. False means it bailed out before doing any work
 * (offline, no session yet, one already in flight).
 */
async function runSync(reason: SyncRunReason, knownUserId?: string): Promise<boolean> {
  if (isSyncing) {
    // A sync is already in flight. A local change or Refresh must run once more afterwards so the
    // newer write (not in the in-flight snapshot) still goes out; a refresh is covered by it.
    if (reason === 'explicit' || reason === 'user') rerunRequested = true
    return false
  }

  const { isOnline } = useAppStore.getState()
  if (!isOnline) return false

  let userId = knownUserId
  if (!userId) {
    const session = await resolveSessionWithRetry()
    if (!session?.user) return false
    userId = session.user.id
  }
  // Re-checked after the await above: two callers may both have passed the first check.
  if (isSyncing) {
    if (reason === 'explicit' || reason === 'user') rerunRequested = true
    return false
  }

  isSyncing = true
  const epoch = currentSessionEpoch()
  const healthToken = realtimeHealthToken()
  // The mirror was wiped (sign-out, account switch) while this sync ran; sync-service wrote nothing
  // from it. Its outcome belongs to no session, so it sets no error, retry or hydration state — and
  // since it held `isSyncing`, the next session's own sync may have been turned away: run again.
  const abandon = () => {
    rerunRequested = true
    useAppStore.getState().setSyncStatus('idle')
    return true
  }
  useAppStore.getState().setSyncStatus('syncing')
  useAppStore.getState().setSyncRetryAt(null)

  try {
    // A full sync never sends a row the write queue owns (sync-service excludes them), so every
    // path that exists to get changes out drains the queue too. Refresh waits for it and sends a
    // backed-off head now — the user asked for it — before its sync; a retry or a local change
    // drains in the background (the queue keeps its own backoff and retry timer).
    if (reason === 'user') await drainQueueNow(userId)
    else if (reason === 'explicit') drainQueueInBackground(userId)

    // After sign-out we clear IndexedDB + the refresh marker; on the next sign-in use one kwenta_sync round-trip
    // (syncRoundTrip) instead of many pullChanges HTTP calls. Auth gates sync until Dexie has the profile row.
    // If something is still unsynced after that (e.g. offline edits), fullSync runs next.
    const needsInitialPull = !readLastRefreshAt()
    if (needsInitialPull) {
      const initialResult = await syncRoundTrip(userId)
      if (!isSessionEpochCurrent(epoch)) return abandon()
      if (initialResult.errors.length > 0) {
        console.warn('[sync] initial sync round-trip failed:', initialResult.errors)
        useAppStore.getState().setSyncStatus('error')
        useAppStore.getState().setPullStale(true)
        useAppStore.getState().setInitialCloudHydration('failed')
        scheduleRetry()
        return true
      }
      await hydrateLinkedRemoteProfilesForActor(userId)
      const stillUnsynced = await hasUnsyncedLocalDataForUser(userId)
      if (!stillUnsynced) {
        resetBackoff()
        useAppStore.getState().setSyncStatus('idle')
        useAppStore.getState().setPullStale(false)
        // First hydration always invalidates once. `syncRoundTrip` already bumped if it changed
        // rows, so only bump here when it did not — two bumps would be two fetches per screen.
        if (initialResult.changed === 0) useAppStore.getState().bumpDataVersion()
        clearRealtimeProcessingFailed(healthToken)
        await flushQueuedKwentaNotifications({ assumeCloudAck: true })
        void maybeAutoRepairData(userId)
        return true
      }
    }

    // Joining a sync that was already running: it may predate a failure marked since, so it must
    // not clear it (realtime-health).
    const joinedRunningSync = isFullSyncInFlight(userId)
    const result = await fullSync(userId)
    if (!isSessionEpochCurrent(epoch)) return abandon()
    if (result.errors.length > 0) {
      // Queue entries are not touched: a failed sync (often a network blip) says nothing about
      // whether the server would refuse them — only the drain's own answer marks one refused.
      console.warn('[sync] errors:', result.errors)
      useAppStore.getState().setSyncStatus('error')
      useAppStore.getState().setPullStale(true)
      if (!readLastRefreshAt()) {
        useAppStore.getState().setInitialCloudHydration('failed')
      }
      scheduleRetry()
    } else {
      // Legacy (pre-queue) entries ride this row-scan push; a clean sync confirms them.
      await markPendingMutationsApplied(userId)
      if (!joinedRunningSync) clearRealtimeProcessingFailed(healthToken)
      resetBackoff()
      useAppStore.getState().setSyncStatus('idle')
      useAppStore.getState().setPullStale(false)
      // Server-backed screens read through RPCs, not Dexie, so `useLiveQuery` sees nothing when
      // a sync brings in remote changes. This is the signal that makes them re-fetch.
      //
      // Only when something actually moved. Bumping unconditionally made every sync invalidate
      // every mounted screen, so each one fetched on mount and then again the moment the
      // concurrent sync resolved — the duplicated request pairs visible in the network panel.
      // `pulled` cannot gate this: every bundle is complete, so it is large even when nothing
      // changed. A pull that CHANGED rows is not handled here: `syncRoundTrip` bumps for that
      // itself, for every caller, so this adds only what it cannot know — a push, or Refresh —
      // and only when that bump did not already happen.
      if ((reason === 'user' || result.pushed > 0) && result.changed === 0) {
        useAppStore.getState().bumpDataVersion()
      }
      await flushQueuedKwentaNotifications({ assumeCloudAck: true })
      await hydrateLinkedRemoteProfilesForActor(userId)
      void maybeAutoRepairData(userId)
    }
  } catch (err) {
    if (!isSessionEpochCurrent(epoch)) return abandon()
    if (isDatabaseClosedError(err)) {
      // Expected during sign-out/local wipe races; don't escalate/retry.
      useAppStore.getState().setSyncStatus('idle')
      return true
    }
    console.warn('[sync] failed:', err)
    useAppStore.getState().setSyncStatus('error')
    useAppStore.getState().setPullStale(true)
    if (!readLastRefreshAt()) {
      useAppStore.getState().setInitialCloudHydration('failed')
    }
    scheduleRetry()
  } finally {
    isSyncing = false
    if (rerunRequested) {
      rerunRequested = false
      void runSync('explicit')
    }
  }
  return true
}

export function startSyncManager() {
  void refreshIfNeeded('start')

  if (backupTimer) clearInterval(backupTimer)
  backupTimer = setInterval(() => void refreshIfNeeded('backup'), SYNC_BACKUP_INTERVAL_MS)

  // No 'online' listener: `useSync` stops this manager while offline and starts it again on
  // reconnect, so the start refresh above is the reconnect refresh.
  window.addEventListener('visibilitychange', onTabActivated)
  window.addEventListener('focus', onTabActivated)

  return () => {
    if (backupTimer) {
      clearInterval(backupTimer)
      backupTimer = null
    }
    clearRetryTimer()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    window.removeEventListener('visibilitychange', onTabActivated)
    window.removeEventListener('focus', onTabActivated)
  }
}

/**
 * Call after local writes. Debounced; respects online + session inside runSync.
 */
export function triggerSync() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    resetBackoff()
    void runSync('explicit')
  }, TRIGGER_DEBOUNCE_MS)
}

/** User-triggered sync from the UI (e.g. header). Runs immediately, no debounce, never gated. */
export function requestSyncNow() {
  resetBackoff()
  void runSync('user')
}

/** Test-only: reset the tab-activation rate limiter between cases. */
export function __resetActivationRefreshThrottleForTests() {
  lastActivationRefreshAt = Number.NEGATIVE_INFINITY
}
