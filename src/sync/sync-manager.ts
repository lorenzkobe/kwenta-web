import { hydrateLinkedRemoteProfilesForActor } from '@/lib/people'
import { maybeAutoRepairData } from '@/lib/kwenta-data-repair'
import { flushQueuedKwentaNotifications, hasQueuedKwentaNotifications } from '@/lib/kwenta-notifications'
import { markPendingMutationsApplied, markPendingMutationsConflict } from '@/sync/cloud-first-mutations'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'
import { readLastRefreshAt, readRealtimeCursor, realtimeCursorKey } from '@/lib/kwenta-storage-keys'
import {
  clearRealtimeProcessingFailed,
  realtimeHealthToken,
  realtimeProcessingFailed,
} from '@/sync/realtime-health'
import {
  fullSync,
  getMillisecondsSinceLastRefresh,
  isFullSyncInFlight,
  mayHaveStagedRows,
  hasUnsyncedLocalDataForUser,
  newestUserEventSince,
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

/**
 * Whether a tab activation needs the full sync, cheapest question first. It used to always run
 * one: the complete bundle plus a scan of every Dexie table, on every focus. Now it does only when
 * something says the mirror may be behind:
 *   - no completed refresh yet, or the last one is at least the backup interval old — the bound on
 *     changes that emit no event (a contact or merge made on another device, a rename);
 *   - a realtime event failed to apply (its cursor moved on anyway);
 *   - a queued notification or a staged write — the sync is what sends them (index counts first,
 *     so a quiet focus reads no table in full);
 *   - no server cursor to ask from, or the server has an event newer than it.
 * `newest` is set when the probe found newer events: the cursor may move there once the sync
 * that follows has succeeded.
 */
async function activationNeedsSync(userId: string): Promise<{ sync: boolean; newest: string | null }> {
  const yes = { sync: true, newest: null }
  if (!readLastRefreshAt()) return yes
  if (getMillisecondsSinceLastRefresh() >= SYNC_BACKUP_INTERVAL_MS) return yes
  if (realtimeProcessingFailed()) return yes
  if (await hasQueuedKwentaNotifications(userId)) return yes
  // Gated for focus only. The backup tick must keep calling hasUnsyncedLocalDataForUser ungated:
  // it is what bounds the rows this gate can miss (see mayHaveStagedRows).
  if ((await mayHaveStagedRows()) && (await hasUnsyncedLocalDataForUser(userId))) return yes
  const cursor = readRealtimeCursor(userId)
  if (!cursor) return yes
  const probe = await newestUserEventSince(userId, cursor)
  return { sync: probe.newer, newest: probe.newest }
}

/** @returns whether the activation was handled (probed, or synced) — false gives the window back. */
async function refreshOnActivation(): Promise<boolean> {
  if (!useAppStore.getState().isOnline) return false
  const session = await resolveSessionWithRetry()
  if (!session?.user) return false
  const userId = session.user.id
  let decision: { sync: boolean; newest: string | null }
  try {
    decision = await activationNeedsSync(userId)
  } catch {
    // Unsure (a closed database, a failed read): do what every focus used to do.
    decision = { sync: true, newest: null }
  }
  if (!decision.sync) return true
  // A sync already running may have read the server before the event the probe found.
  const coversProbe = !isFullSyncInFlight(userId)
  const ran = await runSync('online')
  if (ran && coversProbe && decision.newest && useAppStore.getState().syncStatus === 'idle') {
    advanceRealtimeCursor(userId, decision.newest)
  }
  return ran
}

/** Moves the realtime cursor forward to a SERVER timestamp; never backwards. */
function advanceRealtimeCursor(userId: string, serverCreatedAt: string) {
  try {
    const current = readRealtimeCursor(userId)
    if (!current || Date.parse(serverCreatedAt) > Date.parse(current)) {
      localStorage.setItem(realtimeCursorKey(userId), serverCreatedAt)
    }
  } catch {
    // Storage unavailable: the next focus just probes (and syncs) again.
  }
}

function onTabActivated() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  const nowMs = monotonicNow()
  if (nowMs - lastActivationRefreshAt < ACTIVATION_REFRESH_MIN_INTERVAL_MS) return
  const previous = lastActivationRefreshAt
  lastActivationRefreshAt = nowMs
  void refreshOnActivation().then((ran) => {
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
  const healthToken = realtimeHealthToken()
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
