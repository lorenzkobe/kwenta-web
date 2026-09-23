import { Loader2 } from 'lucide-react'
import { timeAgo, cn } from '@/lib/utils'

/**
 * "These numbers came from the offline cache."
 *
 * Balances are server-computed and do not move offline (CLAUDE.md rule 8), so a cached copy has to
 * be visibly different from a fresh one — otherwise a screen showing last week's amounts is
 * indistinguishable from one showing the truth, and the user settles up against a balance that has
 * already moved. `fetchEndpoint` returns `fromCache`/`fetchedAt` for exactly this, and most
 * screens were dropping both on the floor.
 */
export function SavedCopyNotice({
  fetchedAt,
  className,
  tone = 'light',
}: {
  fetchedAt: string | null
  className?: string
  /** `dark` for placement on the coloured hero panels, which have their own contrast. */
  tone?: 'light' | 'dark'
}) {
  return (
    <p
      role="status"
      className={cn(
        'text-xs',
        tone === 'dark' ? 'text-white/55' : 'text-stone-500',
        className,
      )}
    >
      {fetchedAt
        ? `Showing a saved copy from ${timeAgo(fetchedAt)} — these numbers may have moved since.`
        : 'Showing a saved copy — these numbers may have moved since.'}
    </p>
  )
}

/**
 * "A saved copy is on screen and the server's answer is on its way."
 *
 * Deliberately quieter than `SavedCopyNotice`: every navigation to a screen opened before paints
 * its saved copy first, and a full "these numbers may have moved" line on each of those would
 * flash on every tap. The copy is still marked as not-yet-confirmed, so a cached number never
 * passes for a fresh one. Pages pass `query.revalidating`.
 */
export function RefreshingChip({ show, className }: { show: boolean; className?: string }) {
  if (!show) return null
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-stone-100 px-2 py-0.5 text-[11px] font-medium text-stone-500',
        className,
      )}
    >
      <Loader2 className="size-3 animate-spin" aria-hidden="true" />
      Updating…
    </span>
  )
}
