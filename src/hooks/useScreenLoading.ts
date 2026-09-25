import { useEffect, useState } from 'react'
import { useAppStore } from '@/store/app-store'

/** A screen fetch shorter than this never shows a loading signal, so a fast answer does not flash. */
export const SCREEN_LOADING_DELAY_MS = 200

/**
 * True once screen fetches have been in flight continuously for `SCREEN_LOADING_DELAY_MS`, and
 * false on the very render the last one ends. The ONE signal the header's loading bar and the
 * Refresh button's "Updating…" read, so the two never disagree for a frame.
 */
export function useScreenLoading(): boolean {
  const active = useAppStore((s) => s.screenLoadCount > 0)
  const [delayElapsed, setDelayElapsed] = useState(false)

  useEffect(() => {
    if (!active) return
    const id = window.setTimeout(() => setDelayElapsed(true), SCREEN_LOADING_DELAY_MS)
    return () => {
      window.clearTimeout(id)
      setDelayElapsed(false)
    }
  }, [active])

  return active && delayElapsed
}
