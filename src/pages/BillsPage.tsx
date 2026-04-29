import { useMemo, useState } from 'react'
import { Plus, ReceiptText, Share2, Trash2, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { deleteBill } from '@/db/operations'
import { isPersonalBillFullySettled } from '@/lib/personal-bill-status'
import { participantUnionForBill } from '@/lib/people'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { formatCurrency, timeAgo, cn } from '@/lib/utils'
import {
  BILL_CATEGORIES,
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  type BillCategory,
} from '@/lib/bill-categories'
import { exportBillsToCSV } from '@/lib/export-csv'
import { generateBillsPDF } from '@/lib/export-pdf'
import type { Bill } from '@/types'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ExportDataDialog } from '@/components/export/ExportDataDialog'
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
  created_by: string
  payorName?: string
  itemCount: number
  settled: boolean
  category: string | null
  participantPills: { id: string; label: string }[]
}

export function BillsPage() {
  const { userId } = useCurrentUser()
  const [filter, setFilter] = useState<BillFilter>('all')
  const [sort, setSort] = useState<BillSort>('date_desc')
  const [filterCategory, setFilterCategory] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)

  const billBuckets = useLiveQuery(async () => {
    if (!userId) return { myBills: [] as EnrichedBill[], sharedBills: [] as EnrichedBill[] }
    const currentUserId = userId
    const myRaw = (await db.bills.where('created_by').equals(currentUserId).toArray()).filter(
      (b) => !b.is_deleted && b.group_id === null,
    )

    const mySplits = (await db.item_splits.where('user_id').equals(currentUserId).toArray()).filter(
      (split) => !split.is_deleted,
    )
    const itemIds = [...new Set(mySplits.map((split) => split.item_id))]
    const splitItems =
      itemIds.length > 0 ? await db.bill_items.where('id').anyOf(itemIds).toArray() : []
    const billIds = [...new Set(splitItems.filter((item) => !item.is_deleted).map((item) => item.bill_id))]
    const splitBills = billIds.length > 0 ? await db.bills.where('id').anyOf(billIds).toArray() : []
    const sharedRaw = splitBills.filter(
      (bill) => !bill.is_deleted && bill.group_id === null && bill.created_by !== currentUserId,
    )

    async function enrichBill(bill: Bill): Promise<EnrichedBill> {
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
          label: uid === currentUserId ? 'You' : name,
        })
      }
      participantPills.sort((a, b) => {
        if (a.label === 'You') return -1
        if (b.label === 'You') return 1
        return a.label.localeCompare(b.label)
      })
      const payor = await db.profiles.get(bill.paid_by)
      const settled = await isPersonalBillFullySettled(bill.id, currentUserId)
      return {
        id: bill.id,
        title: bill.title,
        currency: bill.currency,
        total_amount: bill.total_amount,
        created_at: bill.created_at,
        created_by: bill.created_by,
        payorName: payor?.display_name ?? 'Someone',
        itemCount: activeItems.length,
        settled,
        category: bill.category ?? null,
        participantPills,
      }
    }

    const [myBills, sharedBills] = await Promise.all([
      Promise.all(myRaw.map((bill) => enrichBill(bill))),
      Promise.all(sharedRaw.map((bill) => enrichBill(bill))),
    ])

    return { myBills, sharedBills }
  }, [userId])

  const bills = useMemo(() => {
    const list = billBuckets?.myBills ?? []
    let out = list
    if (filter === 'settled') out = out.filter((b) => b.settled)
    if (filter === 'unsettled') out = out.filter((b) => !b.settled)
    if (filterCategory) out = out.filter((b) => b.category === filterCategory)
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
  }, [billBuckets?.myBills, filter, sort, filterCategory])

  const sharedBills = useMemo(() => {
    const list = [...(billBuckets?.sharedBills ?? [])]
    list.sort((a, b) => b.created_at.localeCompare(a.created_at))
    return list
  }, [billBuckets?.sharedBills])

  const presentCategories = useMemo(() => {
    const cats = new Set((billBuckets?.myBills ?? []).map((b) => b.category).filter(Boolean) as string[])
    return BILL_CATEGORIES.filter((c) => cats.has(c))
  }, [billBuckets?.myBills])

  const loadingBills = billBuckets === undefined

  async function executeDeleteBill() {
    if (!userId || !deleteTarget) return
    await deleteBill(deleteTarget.id, userId)
  }

  return (
    <>
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Personal bills</h1>
          <p className="mt-1 text-sm text-stone-600">
            {(billBuckets?.myBills.length ?? 0) + sharedBills.length} bill{((billBuckets?.myBills.length ?? 0) + sharedBills.length) !== 1 ? 's' : ''} · Group bills stay in each
            group
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {(billBuckets?.myBills.length ?? 0) > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-10 rounded-full"
              onClick={() => setExportOpen(true)}
            >
              <Share2 className="size-4" />
              Export
            </Button>
          )}
          <Button asChild className="h-10 shrink-0 rounded-full">
            <Link to="/app/bills/new">
              <Plus className="size-4" />
              Add bill
            </Link>
          </Button>
        </div>
      </div>

      {billBuckets && billBuckets.myBills.length > 0 && (
        <div className="flex flex-col gap-3 rounded-2xl border border-stone-200 bg-white p-3 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
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
          {presentCategories.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {presentCategories.map((cat) => {
                const Icon = CATEGORY_ICONS[cat as BillCategory]
                const active = filterCategory === cat
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setFilterCategory(active ? null : cat)}
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors',
                      active
                        ? CATEGORY_COLORS[cat as BillCategory]
                        : 'bg-stone-100 text-stone-600 hover:bg-stone-200',
                    )}
                  >
                    <Icon className="size-3" />
                    {CATEGORY_LABELS[cat as BillCategory]}
                  </button>
                )
              })}
            </div>
          )}
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

      {loadingBills ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div
              key={`bill-skeleton-${idx}`}
              className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="h-4 w-1/3 animate-pulse rounded bg-stone-200" />
                  <div className="mt-2 h-3 w-1/4 animate-pulse rounded bg-stone-200" />
                  <div className="mt-3 flex gap-1.5">
                    <span className="h-5 w-14 animate-pulse rounded-full bg-stone-200" />
                    <span className="h-5 w-18 animate-pulse rounded-full bg-stone-200" />
                  </div>
                </div>
                <div className="h-4 w-16 animate-pulse rounded bg-stone-200" />
              </div>
            </div>
          ))}
        </div>
      ) : (!billBuckets || (billBuckets.myBills.length === 0 && sharedBills.length === 0)) ? (
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
      ) : (
        <div className="space-y-5">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-stone-700">Bills you created</p>
            </div>
            {(billBuckets?.myBills.length ?? 0) > 0 && bills.length === 0 ? (
              <div className="rounded-3xl border border-stone-200 bg-white p-5 text-center text-sm text-stone-500 shadow-sm">
                No bills match this filter.
              </div>
            ) : billBuckets && billBuckets.myBills.length === 0 ? (
              <div className="rounded-3xl border border-stone-200 bg-white p-5 text-center text-sm text-stone-500 shadow-sm">
                You have not created a personal bill yet.
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
                          {bill.category && CATEGORY_LABELS[bill.category as BillCategory] && (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.65rem] font-medium',
                                CATEGORY_COLORS[bill.category as BillCategory],
                              )}
                            >
                              {(() => { const Icon = CATEGORY_ICONS[bill.category as BillCategory]; return <Icon className="size-2.5" /> })()}
                              {CATEGORY_LABELS[bill.category as BillCategory]}
                            </span>
                          )}
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
                          onClick={() => setDeleteTarget({ id: bill.id, title: bill.title })}
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

          {sharedBills.length > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-stone-700">Shared with you</p>
              </div>
              <div className="space-y-3">
                {sharedBills.map((bill) => (
                  <Link
                    key={bill.id}
                    to={`/app/bills/${bill.id}`}
                    className="block rounded-2xl border border-stone-200 bg-white p-4 shadow-sm transition-colors hover:bg-stone-50"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
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
                          <span>Paid by {bill.payorName ?? 'Someone'}</span>
                        </div>
                      </div>
                      <span className="text-sm font-semibold text-stone-800">
                        {formatCurrency(bill.total_amount, bill.currency)}
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>

    <ConfirmDialog
      open={deleteTarget !== null}
      onOpenChange={(open) => !open && setDeleteTarget(null)}
      title="Delete this bill?"
      description={
        deleteTarget
          ? `"${deleteTarget.title}" will be removed. This cannot be undone on this device.`
          : 'This bill will be removed. This cannot be undone on this device.'
      }
      confirmLabel="Delete bill"
      variant="danger"
      onConfirm={executeDeleteBill}
    />

    {exportOpen && userId && (
      <ExportDataDialog
        title="Export personal bills"
        description="Download all your personal bills as a PDF report or CSV spreadsheet."
        onExportPDF={() => generateBillsPDF(userId)}
        onExportCSV={() => exportBillsToCSV(userId)}
        onClose={() => setExportOpen(false)}
      />
    )}
    </>
  )
}
