import { useCallback } from 'react'
import { ArrowDownLeft, ArrowUpRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { fetchGroupMemberBreakdown } from '@/api/balances'
import { useServerData } from '@/hooks/useServerData'
import { formatCurrency } from '@/lib/utils'

/**
 * Read-only view of a single member's pending balances within a group: who they still pay and who
 * still pays them, from that member's own perspective (migration 064), so the numbers match what
 * that member sees on their own device.
 */
export function MemberBalancesDialog({
  open,
  onOpenChange,
  groupId,
  currency,
  currentUserId,
  member,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  currency: string
  currentUserId: string
  member: { userId: string; name: string; isCurrentUser: boolean } | null
}) {
  const memberId = member?.userId ?? null
  const load = useCallback(
    () => fetchGroupMemberBreakdown(currentUserId, groupId, memberId!),
    [currentUserId, groupId, memberId],
  )
  // Deliberately no `endpointKey`: `kwenta_group_member_breakdown` is outside `kwenta_read`'s
  // whitelist, so a write can never recompute it. That is the point — it also backs the
  // pre-write guards, which must always ask the server directly (migration 064 header).
  const state = useServerData(open && memberId ? load : null, [
    open,
    groupId,
    memberId,
    currentUserId,
  ])

  if (!open || !member) return null

  // The payload names its own subject, so a result still in flight for a newly-selected member
  // can never be rendered under that member's heading.
  const breakdown =
    state.data && state.data.memberUserId === member.userId ? state.data : null
  const loading = breakdown === null && state.error === null
  const possessive = member.isCurrentUser ? 'Your' : `${member.name}'s`
  const subject = member.isCurrentUser ? 'You' : member.name
  // Only a breakdown the server actually produced can support "all settled up". A refusal now
  // arrives as `state.error` (ServerDeclinedError) and renders as an error, not as a zero.
  const hasNothing =
    breakdown !== null && breakdown.pays.length === 0 && breakdown.receives.length === 0

  return (
    <div className="fixed inset-0 z-60 flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
        aria-hidden
      />
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-teal-800/15 text-sm font-semibold text-teal-800">
              {member.name.charAt(0).toUpperCase()}
            </div>
            <h2 className="truncate text-base font-semibold">{possessive} balances</h2>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-full"
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-5 px-5 py-4">
          {loading && (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="h-10 animate-pulse rounded-xl bg-stone-100" />
              ))}
            </div>
          )}

          {state.error && !breakdown && (
            <p className="py-6 text-center text-sm text-red-600">{state.error}</p>
          )}

          {hasNothing && (
            <p className="py-6 text-center text-sm text-stone-400">
              {subject} {member.isCurrentUser ? 'are' : 'is'} all settled up in this group.
            </p>
          )}

          {!loading && breakdown && breakdown.pays.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-amber-600">
                <ArrowUpRight className="size-3.5" />
                {subject} {member.isCurrentUser ? 'pay' : 'pays'}
              </h3>
              <ul className="space-y-1.5">
                {breakdown.pays.map((p) => (
                  <li
                    key={p.memberUserId}
                    className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-2.5"
                  >
                    <span className="truncate text-sm font-medium text-stone-800">{p.displayName}</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-amber-600">
                      {formatCurrency(p.amount, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!loading && breakdown && breakdown.receives.length > 0 && (
            <section>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-600">
                <ArrowDownLeft className="size-3.5" />
                {subject} {member.isCurrentUser ? 'receive from' : 'receives from'}
              </h3>
              <ul className="space-y-1.5">
                {breakdown.receives.map((p) => (
                  <li
                    key={p.memberUserId}
                    className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-2.5"
                  >
                    <span className="truncate text-sm font-medium text-stone-800">{p.displayName}</span>
                    <span className="shrink-0 text-sm font-semibold tabular-nums text-emerald-600">
                      {formatCurrency(p.amount, currency)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}
