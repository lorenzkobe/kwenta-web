import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'
import {
  fullSync,
  getMillisecondsSinceLastPull,
  hasUnsyncedLocalDataForUser,
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

async function runSync(reason: SyncRunReason) {
  if (isSyncing) return

  const { isOnline } = useAppStore.getState()
  if (!isOnline) return

  const {
    data: { session },
  } = await supabase.auth.getSession()
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
    const result = await fullSync(userId)
    if (result.errors.length > 0) {
      console.warn('[sync] errors:', result.errors)
      useAppStore.getState().setSyncStatus('error')
      scheduleRetry()
    } else {
      resetBackoff()
      useAppStore.getState().setSyncStatus('idle')
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
