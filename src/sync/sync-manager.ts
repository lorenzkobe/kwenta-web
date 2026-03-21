import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'
import { fullSync } from './sync-service'

const SYNC_INTERVAL_MS = 60_000

let syncTimer: ReturnType<typeof setInterval> | null = null
let isSyncing = false

async function runSync() {
  const { isOnline } = useAppStore.getState()
  if (!isOnline || isSyncing) return

  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.user) return

  const userId = session.user.id

  isSyncing = true
  useAppStore.getState().setSyncStatus('syncing')

  try {
    const result = await fullSync(userId)
    if (result.errors.length > 0) {
      console.warn('[sync] errors:', result.errors)
      useAppStore.getState().setSyncStatus('error')
    } else {
      useAppStore.getState().setSyncStatus('idle')
    }
  } catch (err) {
    console.warn('[sync] failed:', err)
    useAppStore.getState().setSyncStatus('error')
  } finally {
    isSyncing = false
  }
}

export function startSyncManager() {
  runSync()

  if (syncTimer) clearInterval(syncTimer)
  syncTimer = setInterval(runSync, SYNC_INTERVAL_MS)

  window.addEventListener('online', runSync)

  return () => {
    if (syncTimer) {
      clearInterval(syncTimer)
      syncTimer = null
    }
    window.removeEventListener('online', runSync)
  }
}

export function triggerSync() {
  runSync()
}
