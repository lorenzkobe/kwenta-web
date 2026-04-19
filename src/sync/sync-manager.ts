import { hydrateLinkedRemoteProfilesForActor } from '@/lib/people'
import { flushQueuedKwentaNotifications, hasQueuedKwentaNotifications } from '@/lib/kwenta-notifications'
import { markPendingMutationsApplied, markPendingMutationsConflict } from '@/sync/cloud-first-mutations'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'
import { KWENTA_LAST_PULL_STORAGE_KEY } from '@/lib/kwenta-storage-keys'
import {
  fullSync,
  getMillisecondsSinceLastPull,
  hasUnsyncedLocalDataForUser,
  syncRoundTrip,
} from './sync-service'

/** Slow backup in case a CRUD-triggered sync was missed */
const SYNC_BACKUP_INTERVAL_MS = 5 * 60 * 1000
/** When there is nothing to upload, still pull at most this often from the backup timer (avoids empty RPCs every tick). */
const BACKUP_PULL_STALE_AFTER_MS = 15 * 60 * 1000

type SyncRunReason = 'initial' | 'explicit' | 'backup' | 'online'
const BACKOFF_INITIAL_MS = 30_000
const BACKOFF_MAX_MS = 5 * 60 * 1000
const TRIGGER_DEBOUNCE_MS = 400

let backupTimer: ReturnType<typeof setInterval> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let isSyncing = false
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

async function runSync(reason: SyncRunReason) {
  if (isSyncing) return

  const { isOnline } = useAppStore.getState()
  if (!isOnline) return

  const session = await resolveSessionWithRetry()
  if (!session?.user) return

  const userId = session.user.id

  if (reason === 'backup') {
    const needsPush = await hasUnsyncedLocalDataForUser(userId)
    const needsPull = getMillisecondsSinceLastPull() >= BACKUP_PULL_STALE_AFTER_MS
    const needsNotificationFlush = await hasQueuedKwentaNotifications(userId)
    if (!needsPush && !needsPull && !needsNotificationFlush) return
  }

  isSyncing = true
  useAppStore.getState().setSyncStatus('syncing')
  useAppStore.getState().setSyncRetryAt(null)

  try {
    // After sign-out we clear IndexedDB + last-pull; on the next sign-in use one kwenta_sync round-trip
    // (syncRoundTrip) instead of many pullChanges HTTP calls. Auth gates sync until Dexie has the profile row.
    // If something is still unsynced after that (e.g. offline edits), fullSync runs next.
    const needsInitialPull = !localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY)
    if (needsInitialPull) {
      const initialResult = await syncRoundTrip(userId)
      if (initialResult.errors.length > 0) {
        console.warn('[sync] initial sync round-trip failed:', initialResult.errors)
        useAppStore.getState().setSyncStatus('error')
        useAppStore.getState().setInitialCloudHydration('failed')
        scheduleRetry()
        return
      }
      await hydrateLinkedRemoteProfilesForActor(userId)
      const stillUnsynced = await hasUnsyncedLocalDataForUser(userId)
      if (!stillUnsynced) {
        resetBackoff()
        useAppStore.getState().setSyncStatus('idle')
        await flushQueuedKwentaNotifications({ assumeCloudAck: true })
        return
      }
    }

    const result = await fullSync(userId)
    if (result.errors.length > 0) {
      console.warn('[sync] errors:', result.errors)
      await markPendingMutationsConflict(userId, 'replay_sync_error', result.errors.join(' | '))
      useAppStore.getState().setSyncStatus('error')
      if (!localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY)) {
        useAppStore.getState().setInitialCloudHydration('failed')
      }
      scheduleRetry()
    } else {
      await markPendingMutationsApplied(userId)
      resetBackoff()
      useAppStore.getState().setSyncStatus('idle')
      await flushQueuedKwentaNotifications({ assumeCloudAck: true })
      await hydrateLinkedRemoteProfilesForActor(userId)
    }
  } catch (err) {
    if (isDatabaseClosedError(err)) {
      // Expected during sign-out/local wipe races; don't escalate/retry.
      useAppStore.getState().setSyncStatus('idle')
      return
    }
    console.warn('[sync] failed:', err)
    useAppStore.getState().setSyncStatus('error')
    if (!localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY)) {
      useAppStore.getState().setInitialCloudHydration('failed')
    }
    scheduleRetry()
  } finally {
    isSyncing = false
  }
}

export function startSyncManager() {
  void runSync('initial')

  if (backupTimer) clearInterval(backupTimer)
  backupTimer = setInterval(() => void runSync('backup'), SYNC_BACKUP_INTERVAL_MS)

  window.addEventListener('online', onBrowserOnline)

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
