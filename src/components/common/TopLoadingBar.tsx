import { useScreenLoading } from '@/hooks/useScreenLoading'
import { useAppStore } from '@/store/app-store'

/**
 * Indeterminate bar on the header's bottom edge while a screen fetch or a sync is in flight. It
 * replaced a per-page "Updating…" chip that pushed each list down for every revalidation; this is
 * absolutely positioned, so nothing below it moves. Decorative: the Refresh button carries the
 * accessible busy state.
 */
export function TopLoadingBar() {
  const screenLoading = useScreenLoading()
  const syncing = useAppStore((s) => s.syncStatus === 'syncing')
  if (!screenLoading && !syncing) return null

  return (
    <div
      data-testid="top-loading-bar"
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 -bottom-px h-0.5 overflow-hidden bg-teal-800/15"
    >
      <div className="h-full w-full bg-teal-700 motion-safe:w-1/3 motion-safe:animate-[kwentaLoadingBar_1.2s_ease-in-out_infinite]" />
    </div>
  )
}
