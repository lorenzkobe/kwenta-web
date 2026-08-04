import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { useAppStore } from '@/store/app-store'
import { requestRefreshOnNavigation, startSyncManager } from '@/sync/sync-manager'

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

/**
 * Refresh from the cloud when the user opens a different screen, so a page shows server truth
 * rather than whatever the cache happened to hold. Rate-limited inside the sync manager.
 *
 * Skips the first render — mounting the shell already runs the initial sync.
 */
export function useRefreshOnNavigation(cloudSyncActive: boolean) {
  const { pathname } = useLocation()
  const previousPathname = useRef<string | null>(null)

  useEffect(() => {
    if (!cloudSyncActive) {
      previousPathname.current = null
      return
    }
    if (previousPathname.current === null) {
      previousPathname.current = pathname
      return
    }
    if (previousPathname.current === pathname) return
    previousPathname.current = pathname
    requestRefreshOnNavigation()
  }, [cloudSyncActive, pathname])
}
