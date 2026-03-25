import { hydrateLinkedRemoteProfilesForActor } from '@/lib/people'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'
import {
  fullSync,
  getMillisecondsSinceLastPull,
  hasUnsyncedLocalDataForUser,
  KWENTA_LAST_PULL_STORAGE_KEY,
  pullChanges,
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

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

function scheduleRetry() {
  clearRetryTimer()
  retryTimer = setTimeout(() => {
    retryTimer = null
    void runSync('explicit')
  }, backoffMs)
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS)
}

function resetBackoff() {
  backoffMs = BACKOFF_INITIAL_MS
  clearRetryTimer()
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
    if (!needsPush && !needsPull) return
  }

  isSyncing = true
  useAppStore.getState().setSyncStatus('syncing')

  try {
    // After sign-out we clear IndexedDB + last-pull; on the next sign-in there is nothing to upload
    // until the user does work locally. Pull first; only run kwenta_sync (push + pull) if something
    // is still unsynced (e.g. brand-new account stub, or session expiry with offline edits).
    const needsInitialPull = !localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY)
    if (needsInitialPull) {
      const pullResult = await pullChanges(userId)
      if (pullResult.errors.length > 0) {
        console.warn('[sync] initial pull failed:', pullResult.errors)
        useAppStore.getState().setSyncStatus('error')
        scheduleRetry()
        return
      }
      await hydrateLinkedRemoteProfilesForActor(userId)
      const stillUnsynced = await hasUnsyncedLocalDataForUser(userId)
      if (!stillUnsynced) {
        resetBackoff()
        useAppStore.getState().setSyncStatus('idle')
        return
      }
    }

    const result = await fullSync(userId)
    if (result.errors.length > 0) {
      console.warn('[sync] errors:', result.errors)
      useAppStore.getState().setSyncStatus('error')
      scheduleRetry()
    } else {
      resetBackoff()
      useAppStore.getState().setSyncStatus('idle')
      await hydrateLinkedRemoteProfilesForActor(userId)
    }
  } catch (err) {
    console.warn('[sync] failed:', err)
    useAppStore.getState().setSyncStatus('error')
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
