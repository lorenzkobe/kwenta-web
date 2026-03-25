import { useEffect } from 'react'
import { useAppStore } from '@/store/app-store'
import { startRealtimeForUser } from '@/sync/realtime-events'

/**
 * Starts realtime delivery of server-side events that concern the user.
 * Keep `cloudActive` false in local-only mode.
 */
export function useRealtime(cloudActive: boolean, userId: string | null | undefined) {
  const isOnline = useAppStore((s) => s.isOnline)

  useEffect(() => {
    if (!cloudActive || !isOnline || !userId) return
    const stop = startRealtimeForUser(userId)
    return stop
  }, [cloudActive, isOnline, userId])
}

