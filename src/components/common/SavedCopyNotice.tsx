import { timeAgo, cn } from '@/lib/utils'

/**
 * "These numbers came from the offline cache."
 *
 * Balances are server-computed and do not move offline (CLAUDE.md rule 8), so a cached copy has to
 * be visibly different from a fresh one — otherwise a screen showing last week's amounts is
 * indistinguishable from one showing the truth, and the user settles up against a balance that has
 * already moved. `fetchWithCache` returns `fromCache`/`fetchedAt` for exactly this, and most
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
