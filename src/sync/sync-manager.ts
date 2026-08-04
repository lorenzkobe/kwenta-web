import { hydrateLinkedRemoteProfilesForActor } from '@/lib/people'
import { maybeAutoRepairData } from '@/lib/kwenta-data-repair'
import { flushQueuedKwentaNotifications, hasQueuedKwentaNotifications } from '@/lib/kwenta-notifications'
import { markPendingMutationsApplied, markPendingMutationsConflict } from '@/sync/cloud-first-mutations'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'
import { readLastRefreshAt } from '@/lib/kwenta-storage-keys'
import {
  fullSync,
  getMillisecondsSinceLastRefresh,
  hasUnsyncedLocalDataForUser,
  syncRoundTrip,
} from './sync-service'

/** Slow backup in case a CRUD-triggered sync was missed */
const SYNC_BACKUP_INTERVAL_MS = 5 * 60 * 1000
/** When there is nothing to upload, still refresh at most this often from the backup timer (avoids empty RPCs every tick). */
const BACKUP_REFRESH_STALE_AFTER_MS = 15 * 60 * 1000

/**
 * 'navigation' is a PASSIVE refresh: it never queues a re-run and never touches the retry
 * schedule. See {@link requestRefreshOnNavigation}.
 */
type SyncRunReason = 'initial' | 'explicit' | 'backup' | 'online' | 'navigation'
const BACKOFF_INITIAL_MS = 30_000
const BACKOFF_MAX_MS = 5 * 60 * 1000
const TRIGGER_DEBOUNCE_MS = 400

let backupTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let isSyncing = false
// Set when a new explicit/online sync is requested while one is already running, so
// the in-flight sync (which already snapshotted Dexie) doesn't drop the newer mutation.
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

function onBrowserOnline() {
  resetBackoff()
  void runSync('online')
}

function onVisibilityActive() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  void runSync('online')
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
 * @returns whether a sync was actually attempted. False means it bailed out before doing any work
 * (offline, no session yet, one already in flight, backup tick with nothing to do).
 */
async function runSync(reason: SyncRunReason): Promise<boolean> {
  // A passive refresh must not participate in the error/backoff state machine at all: it is a
  // read triggered by the user looking at a screen, not by anything that needs delivering.
  const isPassiveRefresh = reason === 'navigation'

  if (isSyncing) {
    // A sync is already in flight. If this is a new request driven by a local mutation
    // or coming back online, remember to run once more afterwards so the newer write
    // (not in the in-flight snapshot) still gets pushed. A navigation refresh has no write to
    // deliver, so queueing one here just chains full-bundle round trips behind every tap.
    if (reason === 'explicit' || reason === 'online') rerunRequested = true
    return false
  }

  const { isOnline } = useAppStore.getState()
  if (!isOnline) return false

  const session = await resolveSessionWithRetry()
  if (!session?.user) return false

  const userId = session.user.id

  if (reason === 'backup') {
    const needsPush = await hasUnsyncedLocalDataForUser(userId)
    const needsPull = getMillisecondsSinceLastRefresh() >= BACKUP_REFRESH_STALE_AFTER_MS
    const needsNotificationFlush = await hasQueuedKwentaNotifications(userId)
    if (!needsPush && !needsPull && !needsNotificationFlush) return false
  }

  isSyncing = true
  useAppStore.getState().setSyncStatus('syncing')
  // A passive refresh does not own the retry schedule, so it must not blank the countdown either —
  // the timer it belongs to is still running, and hiding it just makes recovery look stalled.
  if (!isPassiveRefresh) useAppStore.getState().setSyncRetryAt(null)

  try {
    // After sign-out we clear IndexedDB + the refresh marker; on the next sign-in use one kwenta_sync round-trip
    // (syncRoundTrip) instead of many pullChanges HTTP calls. Auth gates sync until Dexie has the profile row.
    // If something is still unsynced after that (e.g. offline edits), fullSync runs next.
    const needsInitialPull = !readLastRefreshAt()
    if (needsInitialPull) {
      const initialResult = await syncRoundTrip(userId)
      if (initialResult.errors.length > 0) {
        console.warn('[sync] initial sync round-trip failed:', initialResult.errors)
        useAppStore.getState().setSyncStatus('error')
        useAppStore.getState().setPullStale(true)
        useAppStore.getState().setInitialCloudHydration('failed')
        if (!isPassiveRefresh) scheduleRetry()
        return true
      }
      await hydrateLinkedRemoteProfilesForActor(userId)
      const stillUnsynced = await hasUnsyncedLocalDataForUser(userId)
      if (!stillUnsynced) {
        resetBackoff()
        useAppStore.getState().setSyncStatus('idle')
        useAppStore.getState().setPullStale(false)
        useAppStore.getState().bumpDataVersion()
        await flushQueuedKwentaNotifications({ assumeCloudAck: true })
        void maybeAutoRepairData(userId)
        return true
      }
    }

    const result = await fullSync(userId)
    if (result.errors.length > 0) {
      console.warn('[sync] errors:', result.errors)
      await markPendingMutationsConflict(userId, 'replay_sync_error', result.errors.join(' | '))
      useAppStore.getState().setSyncStatus('error')
      useAppStore.getState().setPullStale(true)
      if (!readLastRefreshAt()) {
        useAppStore.getState().setInitialCloudHydration('failed')
      }
      if (!isPassiveRefresh) scheduleRetry()
    } else {
      await markPendingMutationsApplied(userId)
      resetBackoff()
      useAppStore.getState().setSyncStatus('idle')
      useAppStore.getState().setPullStale(false)
      // Server-backed screens read through RPCs, not Dexie, so `useLiveQuery` sees nothing when
      // a sync brings in remote changes. This is the signal that makes them re-fetch.
      useAppStore.getState().bumpDataVersion()
      await flushQueuedKwentaNotifications({ assumeCloudAck: true })
      await hydrateLinkedRemoteProfilesForActor(userId)
      void maybeAutoRepairData(userId)
    }
  } catch (err) {
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
    if (!isPassiveRefresh) scheduleRetry()
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
  void runSync('initial')

  if (backupTimer) clearInterval(backupTimer)
  backupTimer = setInterval(() => void runSync('backup'), SYNC_BACKUP_INTERVAL_MS)

  window.addEventListener('online', onBrowserOnline)
  window.addEventListener('visibilitychange', onVisibilityActive)
  window.addEventListener('focus', onVisibilityActive)

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
    window.removeEventListener('online', onBrowserOnline)
    window.removeEventListener('visibilitychange', onVisibilityActive)
    window.removeEventListener('focus', onVisibilityActive)
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

/** User-triggered sync from the UI (e.g. header). Runs immediately, no debounce. */
export function requestSyncNow() {
  resetBackoff()
  void runSync('explicit')
}

/**
 * Minimum gap between navigation-driven refreshes. Every refresh pulls the full bundle, so
 * without this, tapping through screens would fire one RPC per route change.
 */
const NAVIGATION_REFRESH_MIN_INTERVAL_MS = 5_000
let lastNavigationRefreshAt = Number.NEGATIVE_INFINITY

/**
 * Monotonic time source. `Date.now()` can jump BACKWARDS (NTP correcting a fast clock, a manual
 * date change, a phone re-syncing after travel), which would make `now - last` negative — always
 * under the interval — and silently disable navigation refresh for the whole duration of the skew.
 * That is the same device-clock dependency the pull cursor was removed to escape.
 */
function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/**
 * Call on route change so opening a screen shows server truth rather than whatever the cache
 * happened to hold. Rate-limited; a skipped refresh is harmless because focus/online/backup
 * triggers and realtime still run.
 */
export function requestRefreshOnNavigation() {
  const nowMs = monotonicNow()
  if (nowMs - lastNavigationRefreshAt < NAVIGATION_REFRESH_MIN_INTERVAL_MS) return
  const previousRefreshAt = lastNavigationRefreshAt
  lastNavigationRefreshAt = nowMs
  void runSync('navigation').then((ran) => {
    // runSync can bail before doing any work — offline, a sync already in flight, or (right after
    // sign-in, exactly when this hook first fires) a session that has not resolved yet. Claiming
    // the window anyway means the next screen change is swallowed by the throttle and renders
    // whatever the cache held, which is the staleness this hook exists to remove. Give it back.
    if (!ran && lastNavigationRefreshAt === nowMs) lastNavigationRefreshAt = previousRefreshAt
  })
}

/** Test-only: reset the navigation rate limiter between cases. */
export function __resetNavigationRefreshThrottleForTests() {
  lastNavigationRefreshAt = Number.NEGATIVE_INFINITY
}
