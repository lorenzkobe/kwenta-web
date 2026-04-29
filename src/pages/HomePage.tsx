import { ChevronRight, Loader2, Plus, ReceiptText, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useOverallBalanceRollups } from '@/hooks/useOverallBalanceRollups'
import { mapById, uniqueStrings } from '@/lib/db-query-helpers'
import { formatCurrency, timeAgo } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const EPS = 0.005

function currencyLines(m: Map<string, number>): { cur: string; v: number }[] {
  const out: { cur: string; v: number }[] = []
  for (const [cur, v] of m) {
    if (v > EPS) out.push({ cur, v })
  }
  return out
}

function OverallAmountLines({
  lines,
  className,
}: {
  lines: { cur: string; v: number }[]
  className: string
}) {
  if (lines.length === 0) {
    return <p className={`mt-1 text-2xl font-semibold ${className}`}>{formatCurrency(0)}</p>
  }
  if (lines.length === 1) {
    const [{ cur, v }] = lines
    return (
      <p className={`mt-1 text-2xl font-semibold ${className}`}>{formatCurrency(v, cur)}</p>
    )
  }
  return (
    <ul className="mt-1 space-y-0.5">
      {lines.map(({ cur, v }) => (
        <li key={cur} className={`text-lg font-semibold ${className}`}>
          {formatCurrency(v, cur)}
        </li>
      ))}
    </ul>
  )
}

function BreakdownLines({
  label,
  m,
  colorClass,
}: {
  label: string
  m: Map<string, number>
  colorClass: string
}) {
  const lines = [...m.entries()].filter(([, v]) => v > EPS)
  if (lines.length === 0) {
    return (
      <p className="text-stone-500">
        <span className="font-medium text-stone-600">{label}</span> {formatCurrency(0)}
      </p>
    )
  }
  return (
    <div className="text-stone-600">
      <span className="font-medium text-stone-700">{label}</span>{' '}
      <span className={colorClass}>
        {lines.map(([cur, v], i) => (
          <span key={cur}>
            {i > 0 ? ' · ' : null}
            {formatCurrency(v, cur)}
          </span>
        ))}
      </span>
    </div>
  )
}

export function HomePage() {
  const { userId, profile } = useCurrentUser()
  const {
    loading: balancesLoading,
    groupReceive,
    groupPay,
    personalReceive,
    personalPay,
    overallReceive,
    overallPay,
  } = useOverallBalanceRollups(userId ?? undefined)

  const stats = useLiveQuery(async () => {
    if (!userId) return { billCount: 0, totalSpent: 0, groupCount: 0 }
    const mySplits = await db.item_splits.where('user_id').equals(userId).toArray()
    const activeSplits = mySplits.filter((s) => !s.is_deleted)
    const myItemIds = [...new Set(activeSplits.map((s) => s.item_id))]
    const myItems = myItemIds.length > 0
      ? await db.bill_items.where('id').anyOf(myItemIds).toArray()
      : []
    const activeItemBillIds = new Set(myItems.filter((i) => !i.is_deleted).map((i) => i.bill_id))
    const myBills = activeItemBillIds.size > 0
      ? await db.bills.where('id').anyOf([...activeItemBillIds]).toArray()
      : []
    const activeBillIds = new Set(myBills.filter((b) => !b.is_deleted).map((b) => b.id))
    const totalSpent = activeSplits
      .filter((s) => {
        const item = myItems.find((i) => i.id === s.item_id)
        return item && !item.is_deleted && activeBillIds.has(item.bill_id)
      })
      .reduce((sum, s) => sum + s.computed_amount, 0)
    const memberships = await db.group_members.where('user_id').equals(userId).toArray()
    const activeGroups = memberships.filter((m) => !m.is_deleted)
    return { billCount: activeBillIds.size, totalSpent, groupCount: activeGroups.length }
  }, [userId])

  const recentBills = useLiveQuery(async () => {
    if (!userId) return []
    const bills = await db.bills.where('paid_by').equals(userId).toArray()
    const active = bills.filter((b) => !b.is_deleted)
    active.sort((a, b) => b.created_at.localeCompare(a.created_at))
    const slice = active.slice(0, 5)
    const groupIds = uniqueStrings(slice.map((bill) => bill.group_id))
    const groups = groupIds.length > 0 ? await db.groups.where('id').anyOf(groupIds).toArray() : []
    const groupById = mapById(groups.filter((group) => !group.is_deleted))

    return slice.map((b) => ({
      id: b.id,
      title: b.title,
      amount: b.total_amount,
      currency: b.currency,
      createdAt: b.created_at,
      groupName: b.group_id ? groupById.get(b.group_id)?.name : undefined,
    }))
  }, [userId])

  const statsLoading = stats === undefined
  const recentBillsLoading = recentBills === undefined

  function greeting() {
    const hour = new Date().getHours()
    if (hour < 12) return 'Good morning'
    if (hour < 18) return 'Good afternoon'
    return 'Good evening'
  }

  const receiveLines = currencyLines(overallReceive)
  const payLines = currencyLines(overallPay)

  return (
    <div className="space-y-5">
      <p className="text-center text-xs text-stone-500 lg:text-left">
        <Link to="/app/settings" className="font-medium text-teal-800 underline-offset-2 hover:underline">
          Profile
        </Link>{' '}
        has account settings and recent activity.
      </p>

      <section className="rounded-[2rem] border border-teal-900/25 bg-gradient-to-br from-teal-900 via-teal-950 to-stone-900 p-5 text-white shadow-[0_20px_70px_rgba(19,78,74,0.2)] lg:p-8">
        <Badge className="border-none bg-white/12 text-white">
          <Sparkles className="mr-1 size-3.5" />
          Dashboard
        </Badge>
        <h2 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">
          {greeting()}
          {profile?.display_name && profile.display_name !== 'You' ? `, ${profile.display_name}` : ''}
        </h2>
        <p className="mt-2 max-w-xl text-sm leading-7 text-white/80">
          Your overview of bills, groups, and expenses.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
            <p className="text-xs font-medium text-white/65">Total bills</p>
            {statsLoading ? (
              <div className="mt-2 h-8 w-16 animate-pulse rounded bg-white/25" />
            ) : (
              <p className="mt-1 text-2xl font-semibold">{stats?.billCount ?? 0}</p>
            )}
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
            <p className="text-xs font-medium text-white/65">Total spent</p>
            {statsLoading ? (
              <div className="mt-2 h-8 w-24 animate-pulse rounded bg-white/25" />
            ) : (
              <p className="mt-1 text-2xl font-semibold">{formatCurrency(stats?.totalSpent ?? 0)}</p>
            )}
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/10 p-4">
            <p className="text-xs font-medium text-white/65">Active groups</p>
            {statsLoading ? (
              <div className="mt-2 h-8 w-16 animate-pulse rounded bg-white/25" />
            ) : (
              <p className="mt-1 text-2xl font-semibold">{stats?.groupCount ?? 0}</p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold">Balances</h3>
        <p className="mt-1 text-sm text-stone-600">What you should receive and pay across groups and personal bills.</p>

        {balancesLoading ? (
          <div className="mt-4 flex justify-center py-8">
            <Loader2 className="size-6 animate-spin text-teal-800" aria-label="Loading balances" />
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/8 p-4">
              <p className="text-xs font-medium text-emerald-600/70">To receive</p>
              <OverallAmountLines lines={receiveLines} className="text-emerald-600" />
              <div className="mt-3 space-y-1.5 border-t border-emerald-500/15 pt-3 text-xs">
                <BreakdownLines label="Personal" m={personalReceive} colorClass="font-semibold text-emerald-600" />
                <BreakdownLines label="Group" m={groupReceive} colorClass="font-semibold text-emerald-600" />
              </div>
            </div>
            <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4">
              <p className="text-xs font-medium text-amber-600/70">To pay</p>
              <OverallAmountLines lines={payLines} className="text-amber-600" />
              <div className="mt-3 space-y-1.5 border-t border-amber-500/15 pt-3 text-xs">
                <BreakdownLines label="Personal" m={personalPay} colorClass="font-semibold text-amber-600" />
                <BreakdownLines label="Group" m={groupPay} colorClass="font-semibold text-amber-600" />
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <h3 className="text-base font-semibold">Quick actions</h3>
        <Link
          to="/app/bills/new"
          className="mt-4 flex items-center justify-between rounded-2xl border border-stone-200 bg-stone-100/80 px-4 py-3.5 transition-colors hover:bg-stone-100"
        >
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-teal-800/15 p-2 text-teal-800">
              <ReceiptText className="size-4" />
            </span>
            <span>
              <span className="block text-sm font-semibold">Add bill</span>
              <span className="block text-xs text-stone-500">Restaurant, utilities, or debt</span>
            </span>
          </div>
          <ChevronRight className="size-4 text-stone-400" />
        </Link>
      </section>

      <section className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ReceiptText className="size-4 text-teal-800" />
            <h3 className="text-base font-semibold">Recent bills</h3>
          </div>
          {!recentBillsLoading && (recentBills?.length ?? 0) > 0 && (
            <Button asChild variant="ghost" size="xs" className="rounded-full text-teal-800">
              <Link to="/app/bills">View all</Link>
            </Button>
          )}
        </div>

        {recentBillsLoading ? (
          <div className="mt-4 space-y-2">
            {Array.from({ length: 3 }).map((_, idx) => (
              <div
                key={`recent-skeleton-${idx}`}
                className="rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3"
              >
                <div className="h-4 w-1/3 animate-pulse rounded bg-stone-200" />
                <div className="mt-2 h-3 w-1/4 animate-pulse rounded bg-stone-200" />
              </div>
            ))}
          </div>
        ) : (!recentBills || recentBills.length === 0) ? (
          <div className="mt-4 flex flex-col items-center py-8 text-center">
            <div className="rounded-2xl bg-stone-100 p-4">
              <ReceiptText className="size-6 text-stone-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-stone-500">No bills yet</p>
            <p className="mt-1 text-xs text-stone-400">Add your first bill to get started</p>
            <Button asChild size="sm" className="mt-4 rounded-full">
              <Link to="/app/bills/new">
                <Plus className="size-3.5" />
                Add bill
              </Link>
            </Button>
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {recentBills.map((bill) => (
              <Link
                key={bill.id}
                to={`/app/bills/${bill.id}`}
                className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 transition-colors hover:bg-stone-100/80"
              >
                <div>
                  <p className="text-sm font-medium text-stone-800">{bill.title}</p>
                  <p className="text-xs text-stone-400">
                    {bill.groupName ? (
                      <>
                        <span className="font-medium text-stone-500">{bill.groupName}</span>
                        <span> · </span>
                      </>
                    ) : null}
                    {timeAgo(bill.createdAt)}
                  </p>
                </div>
                <span className="text-sm font-semibold text-stone-800">
                  {formatCurrency(bill.amount, bill.currency)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
