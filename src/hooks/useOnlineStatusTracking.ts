import { useEffect } from 'react'
import { startOnlineStatusTracking } from '@/lib/online-status'

/**
 * Mounted once at the app root, so no route ever misses a connection change. It reads no state,
 * so a flip re-renders only the components that select `isOnline`, not the whole tree.
 */
export function useOnlineStatusTracking(): void {
  useEffect(() => startOnlineStatusTracking(), [])
}
