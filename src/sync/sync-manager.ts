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
 * 'user' is the Refresh button. It is the one reason that ALWAYS re-reads the screens, even when
 * the sync moved no local row: pressing Refresh is an explicit request for fresh data, and a
 * server-side change that alters no row this device holds — a counterparty renaming their own
 * account, whose profile is outside this user's pull scope by design — would otherwise never
 * reach the screen at all.
 */
type SyncRunReason = 'initial' | 'explicit' | 'user' | 'backup' | 'online'
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

/**
 * Minimum gap between refreshes triggered by the tab becoming active.
 *
 * `focus` and `visibilitychange` BOTH fire when a user returns to the tab, and each pull is the
 * caller's complete row set. Without this, one tab switch cost two full round trips: the second
 * call landed while the first was in flight, set `rerunRequested`, and ran again after it.
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

function onTabActivated() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  const nowMs = monotonicNow()
  if (nowMs - lastActivationRefreshAt < ACTIVATION_REFRESH_MIN_INTERVAL_MS) return
  const previous = lastActivationRefreshAt
  lastActivationRefreshAt = nowMs
  void runSync('online').then((ran) => {
    // runSync bails out before doing any work when offline, without a session yet, or with one
    // already in flight. Claiming the window anyway would swallow the next real activation.
    if (!ran && lastActivationRefreshAt === nowMs) lastActivationRefreshAt = previous
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
 * @returns whether a sync was actually attempted. False means it bailed out before doing any work
 * (offline, no session yet, one already in flight, backup tick with nothing to do).
 */
async function runSync(reason: SyncRunReason): Promise<boolean> {
  if (isSyncing) {
    // A sync is already in flight. If this is a new request driven by a local mutation
    // or coming back online, remember to run once more afterwards so the newer write
    // (not in the in-flight snapshot) still gets pushed.
    if (reason === 'explicit' || reason === 'user' || reason === 'online') rerunRequested = true
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
  useAppStore.getState().setSyncRetryAt(null)

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
        scheduleRetry()
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
      scheduleRetry()
    } else {
      await markPendingMutationsApplied(userId)
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
      // changed.
      if (reason === 'user' || result.pushed > 0 || result.changed > 0) {
        useAppStore.getState().bumpDataVersion()
      }
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
  void runSync('initial')

  if (backupTimer) clearInterval(backupTimer)
  backupTimer = setInterval(() => void runSync('backup'), SYNC_BACKUP_INTERVAL_MS)

  window.addEventListener('online', onBrowserOnline)
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
    window.removeEventListener('online', onBrowserOnline)
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

/** User-triggered sync from the UI (e.g. header). Runs immediately, no debounce. */
export function requestSyncNow() {
  resetBackoff()
  void runSync('user')
}

/** Test-only: reset the tab-activation rate limiter between cases. */
export function __resetActivationRefreshThrottleForTests() {
  lastActivationRefreshAt = Number.NEGATIVE_INFINITY
}
