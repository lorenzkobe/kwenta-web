import { RotateCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Button } from '@/components/ui/button'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { readLastRefreshAt } from '@/lib/kwenta-storage-keys'
import {
  isRefreshDisabled,
  lastUpdatedLabel,
  refreshAriaLabel,
  refreshStatusLabel,
  refreshTitle,
  resolveRefreshState,
} from '@/lib/refresh-status'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import { requestSyncNow } from '@/sync/sync-manager'
import { getMillisecondsSinceLastRefresh, hasUnsyncedLocalDataForUser } from '@/sync/sync-service'

/** How often the "Updated 4m ago" label re-renders to age itself. */
const FRESHNESS_TICK_MS = 30_000

export interface RefreshButtonProps {
  /** Render the freshness line under the label (hidden below `sm`, always in the aria-label). */
  showLastUpdated?: boolean
  className?: string
}

/**
 * The app's refresh control.
 *
 * This replaces a status pill that *was* wired to `requestSyncNow` but rendered as a wifi icon
 * labelled "Online" — so the only hint that it refreshed anything was a `title` tooltip, which
 * never appears on touch. In a standalone PWA there is no browser reload button, so that was
 * effectively no refresh affordance at all.
 *
 * All state precedence lives in `@/lib/refresh-status` and is unit-tested; this component only
 * renders it.
 */
export function RefreshButton({ showLastUpdated = false, className }: RefreshButtonProps) {
  const isOnline = useAppStore((s) => s.isOnline)
  const syncStatus = useAppStore((s) => s.syncStatus)
  const syncRetryAt = useAppStore((s) => s.syncRetryAt)
  const pullStale = useAppStore((s) => s.pullStale)
  const { userId } = useCurrentUser()

  const hasPendingUpload = useLiveQuery(
    async () => (userId ? hasUnsyncedLocalDataForUser(userId) : false),
    [userId],
    false,
  )

  // `kwenta_last_refresh` is localStorage, so nothing re-renders when it changes. Tick slowly so
  // the relative label ages on a screen left open, and re-read whenever a sync settles. Derived
  // during render rather than mirrored into state: the read is idempotent, and copying it into
  // state would just be a second source of truth that can lag the first.
  const [freshnessTick, setFreshnessTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setFreshnessTick((n) => n + 1), FRESHNESS_TICK_MS)
    return () => window.clearInterval(id)
  }, [])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read on sync settle and on tick
  const lastRefreshAt = useMemo(() => readLastRefreshAt(), [syncStatus, freshnessTick])

  // Only run the 1s countdown clock while a retry is actually scheduled.
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!syncRetryAt) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [syncRetryAt])

  const retrySeconds = syncRetryAt ? Math.max(0, Math.ceil((syncRetryAt - nowMs) / 1000)) : null

  const state = resolveRefreshState({
    isOnline,
    syncStatus,
    hasPendingUpload: hasPendingUpload === true,
    pullStale,
    msSinceLastRefresh: getMillisecondsSinceLastRefresh(),
  })

  const label = refreshStatusLabel(state, retrySeconds)
  const updated = lastUpdatedLabel(lastRefreshAt)
  const attention = state === 'error' || state === 'stale' || state === 'pending-upload'

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={isRefreshDisabled(state)}
      onClick={() => requestSyncNow()}
      title={refreshTitle(state, retrySeconds)}
      aria-label={refreshAriaLabel(state, updated)}
      aria-busy={state === 'syncing'}
      className={cn(
        'h-auto max-w-44 gap-2 rounded-full border-stone-200/80 bg-stone-50 px-3 py-2 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-90 sm:max-w-none',
        className,
      )}
    >
      {/*
        One icon element in every state. Swapping icons per state (Wifi/WifiOff/CloudUpload, as
        the old pill did) changes the glyph width and reflows the header on every sync; a single
        element that only spins is a transform and cannot.
      */}
      <RotateCw
        aria-hidden
        className={cn(
          'size-3 shrink-0',
          state === 'syncing' && 'animate-spin motion-reduce:animate-none',
          attention && 'text-amber-600',
        )}
      />
      <span className="flex min-w-0 flex-col items-start leading-tight">
        {/* Fixed min-width: "Refreshing…" → "Refresh" must not shift the controls beside it. */}
        <span aria-live="polite" className="min-w-[4.5rem] truncate text-left">
          {label}
        </span>
        {showLastUpdated ? (
          <span className="hidden truncate text-[10px] font-normal text-stone-400 sm:block">
            {updated}
          </span>
        ) : null}
      </span>
    </Button>
  )
}
