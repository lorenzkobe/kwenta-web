import { useEffect } from 'react'
import { useAppStore } from '@/store/app-store'
import { startSyncManager } from '@/sync/sync-manager'

/**
 * @param cloudSyncActive — pass `true` only when the user has a Supabase session **and** profile bootstrap
 *   finished (`useAuth().user && useAuth().authReady`). Local-only mode should keep this `false` so we do not poll the server.
 */
export function useSync(cloudSyncActive: boolean) {
  const isOnline = useAppStore((s) => s.isOnline)

  useEffect(() => {
    if (!cloudSyncActive || !isOnline) return

    const cleanup = startSyncManager()
    return cleanup
  }, [cloudSyncActive, isOnline])
}
