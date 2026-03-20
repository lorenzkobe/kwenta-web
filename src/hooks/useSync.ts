import { useEffect } from 'react'
import { useAppStore } from '@/store/app-store'
import { startSyncManager } from '@/sync/sync-manager'

export function useSync() {
  const currentUserId = useAppStore((s) => s.currentUserId)
  const isOnline = useAppStore((s) => s.isOnline)

  useEffect(() => {
    if (!currentUserId || !isOnline) return

    const cleanup = startSyncManager()
    return cleanup
  }, [currentUserId, isOnline])
}
