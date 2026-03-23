import { useMemo, useState } from 'react'
import { Plus, ReceiptText, Trash2, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { deleteBill } from '@/db/operations'
import { isPersonalBillFullySettled } from '@/lib/personal-bill-status'
import { participantUnionForBill } from '@/lib/people'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { formatCurrency, timeAgo, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

type BillFilter = 'all' | 'settled' | 'unsettled'
type BillSort = 'date_desc' | 'date_asc' | 'title_asc' | 'title_desc'

type EnrichedBill = {
  id: string
  title: string
  currency: string
  total_amount: number
  created_at: string
  itemCount: number
  settled: boolean
  participantPills: { id: string; label: string }[]
}

export function BillsPage() {
  const { userId } = useCurrentUser()
  const [filter, setFilter] = useState<BillFilter>('all')
  const [sort, setSort] = useState<BillSort>('date_desc')

  const enrichedBills = useLiveQuery(async () => {
    if (!userId) return [] as EnrichedBill[]
    const all = await db.bills.where('created_by').equals(userId).toArray()
    const active = all.filter((b) => !b.is_deleted && b.group_id == null)
    return Promise.all(
      active.map(async (bill) => {
        const items = await db.bill_items.where('bill_id').equals(bill.id).toArray()
        const activeItems = items.filter((i) => !i.is_deleted)
        const union = await participantUnionForBill(bill.id)
        const participantPills: { id: string; label: string }[] = []
        const seen = new Set<string>()
        for (const uid of union) {
          if (seen.has(uid)) continue
          seen.add(uid)
          const p = await db.profiles.get(uid)
          const name = p?.display_name ?? 'Someone'
          participantPills.push({
            id: uid,
            label: uid === userId ? 'You' : name,
          })
        }
        participantPills.sort((a, b) => {
          if (a.label === 'You') return -1
          if (b.label === 'You') return 1
          return a.label.localeCompare(b.label)
        })
        const settled = await isPersonalBillFullySettled(bill.id, userId)
        return {
          id: bill.id,
          title: bill.title,
          currency: bill.currency,
          total_amount: bill.total_amount,
          created_at: bill.created_at,
          itemCount: activeItems.length,
          settled,
          participantPills,
        }
      }),
    )
  }, [userId])

  const bills = useMemo(() => {
    const list = enrichedBills ?? []
    let out = list
    if (filter === 'settled') out = out.filter((b) => b.settled)
    if (filter === 'unsettled') out = out.filter((b) => !b.settled)
    const copy = [...out]
    copy.sort((a, b) => {
      switch (sort) {
        case 'date_desc':
          return b.created_at.localeCompare(a.created_at)
        case 'date_asc':
          return a.created_at.localeCompare(b.created_at)
        case 'title_asc':
          return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
        case 'title_desc':
          return b.title.localeCompare(a.title, undefined, { sensitivity: 'base' })
        default:
          return 0
      }
    })
    return copy
  }, [enrichedBills, filter, sort])

  async function handleDelete(billId: string) {
    if (!userId) return
    await deleteBill(billId, userId)
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Personal bills</h1>
          <p className="mt-1 text-sm text-stone-600">
            {enrichedBills?.length ?? 0} bill{(enrichedBills?.length ?? 0) !== 1 ? 's' : ''} · Group bills stay in each
            group
          </p>
        </div>
        <Button asChild className="h-10 shrink-0 rounded-full self-start sm:self-auto">
          <Link to="/app/bills/new">
            <Plus className="size-4" />
            Add bill
          </Link>
        </Button>
      </div>

      {enrichedBills && enrichedBills.length > 0 && (
        <div className="flex flex-col gap-2 rounded-2xl border border-stone-200 bg-white p-3 shadow-sm sm:flex-row sm:flex-wrap sm:items-center">
          <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-48">
            <span className="text-xs font-medium text-stone-500">Filter</span>
            <Select value={filter} onValueChange={(v) => setFilter(v as BillFilter)}>
              <SelectTrigger className="h-10 rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="unsettled">Not settled</SelectItem>
                <SelectItem value="settled">Settled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-56">
            <span className="text-xs font-medium text-stone-500">Sort</span>
            <Select value={sort} onValueChange={(v) => setSort(v as BillSort)}>
              <SelectTrigger className="h-10 rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="date_desc">Date · Newest first</SelectItem>
                <SelectItem value="date_asc">Date · Oldest first</SelectItem>
                <SelectItem value="title_asc">Name · A → Z</SelectItem>
                <SelectItem value="title_desc">Name · Z → A</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-3 rounded-2xl border border-teal-800/20 bg-teal-800/5 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-800">Looking for group bills?</p>
          <p className="mt-1 text-xs text-stone-600">
            Shared expenses live inside each group. Open a group to add or view bills there.
          </p>
        </div>
        <Button asChild variant="secondary" className="h-10 shrink-0 rounded-full">
          <Link to="/app/groups">
            <Users className="size-4" />
            Go to groups
          </Link>
        </Button>
      </div>

      {(!enrichedBills || enrichedBills.length === 0) ? (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col items-center py-12 text-center">
            <div className="rounded-2xl bg-stone-100 p-4">
              <ReceiptText className="size-6 text-stone-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-stone-500">No personal bills yet</p>
            <p className="mt-1 text-xs text-stone-400">
              Bills you add without a group show up here. Open a group for shared group expenses.
            </p>
            <Button asChild size="sm" className="mt-4 h-10 rounded-full">
              <Link to="/app/bills/new">
                <Plus className="size-3.5" />
                Add bill
              </Link>
            </Button>
          </div>
        </div>
      ) : bills.length === 0 ? (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 text-center text-sm text-stone-500 shadow-sm">
          No bills match this filter.
        </div>
      ) : (
        <div className="space-y-3">
          {bills.map((bill) => (
            <div
              key={bill.id}
              className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm transition-colors hover:bg-stone-50"
            >
              <div className="flex items-start justify-between gap-3">
                <Link to={`/app/bills/${bill.id}`} className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-semibold text-stone-800">{bill.title}</p>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide',
                        bill.settled
                          ? 'bg-emerald-500/15 text-emerald-800'
                          : 'bg-amber-500/15 text-amber-900',
                      )}
                    >
                      {bill.settled ? 'Settled' : 'Open'}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                    <span>{timeAgo(bill.created_at)}</span>
                    <span>·</span>
                    <span>
                      {bill.itemCount} item{bill.itemCount !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {bill.participantPills.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {bill.participantPills.map((p) => (
                        <span
                          key={p.id}
                          className="inline-flex max-w-40 truncate rounded-full border border-teal-800/20 bg-teal-800/8 px-2.5 py-0.5 text-[0.7rem] font-medium text-teal-900"
                        >
                          {p.label}
                        </span>
                      ))}
                    </div>
                  )}
                </Link>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-stone-800">
                    {formatCurrency(bill.total_amount, bill.currency)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-full text-stone-400 hover:text-red-600"
                    onClick={() => handleDelete(bill.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
