import { useCallback, useMemo, useState } from 'react'
import { Plus, ReceiptText, Share2, Trash2, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useLiveQuery } from 'dexie-react-hooks'
import { deleteBill } from '@/db/operations'
import { fetchPersonalBills, type PersonalBillRow } from '@/api/balances'
import { useServerData } from '@/hooks/useServerData'
import { loadStagedPersonalBillRows } from '@/lib/staged-rows'
import { SavedCopyNotice } from '@/components/common/SavedCopyNotice'
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

/** A server row plus one fact only this device knows: whether the write is still queued. */
type EnrichedBill = PersonalBillRow & { pending: boolean }

export function BillsPage() {
  const { userId } = useCurrentUser()
  const [filter, setFilter] = useState<BillFilter>('all')
  const [sort, setSort] = useState<BillSort>('date_desc')
  const [filterCategory, setFilterCategory] = useState<string | null>(null)
  const [tab, setTab] = useState<'mine' | 'shared'>('mine')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [myBillsShown, setMyBillsShown] = useState(10)
  const [sharedBillsShown, setSharedBillsShown] = useState(10)
  const [lastFilterKey, setLastFilterKey] = useState(`${filter}|${sort}|${filterCategory}`)
  const filterKey = `${filter}|${sort}|${filterCategory}`
  let resolvedMyBillsShown = myBillsShown
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey)
    setMyBillsShown(10)
    resolvedMyBillsShown = 10
  }

  // One call returns both buckets with participants, payer, item count and the settled flag
  // already resolved. This replaced a per-bill fan-out: each bill re-read its own items, resolved
  // every participant name, and asked isPersonalBillFullySettled — which computes a whole
  // person-level tab. The Shared tab is no longer lazy because it costs nothing extra now.
  const loadBills = useCallback(
    () => (userId ? fetchPersonalBills(userId) : Promise.reject(new Error('no user'))),
    [userId],
  )
  const billsQuery = useServerData(userId ? loadBills : null, [userId, loadBills])

  // The one fact the server cannot know: which of these rows this device has not sent yet.
  // Written offline, it is queued locally and must be flagged rather than shown as confirmed.
  // These rows are also the ONLY source for a bill the server has never seen — decorating the
  // server's response could never surface one, so an offline save appeared nowhere at all.
  const stagedBills = useLiveQuery(
    async () => (userId ? loadStagedPersonalBillRows(userId) : []),
    [userId],
    [] as PersonalBillRow[],
  )
  const unsentBillIds = useMemo(() => new Set(stagedBills.map((b) => b.id)), [stagedBills])

  const withPending = useCallback(
    (rows: PersonalBillRow[] | undefined): EnrichedBill[] =>
      (rows ?? []).map((b) => ({ ...b, pending: unsentBillIds.has(b.id) })),
    [unsentBillIds],
  )

  const myBills = useMemo(() => {
    if (!billsQuery.data) return undefined
    const confirmed = withPending(billsQuery.data.mine)
    // A staged bill the server has already accepted comes back in `mine`; keep the server's copy
    // so a row never renders twice while `synced_at` catches up.
    const seen = new Set(confirmed.map((b) => b.id))
    const staged = stagedBills
      .filter((b) => !seen.has(b.id))
      .map((b) => ({ ...b, pending: true }))
    return [...staged, ...confirmed]
  }, [billsQuery.data, withPending, stagedBills])
  const sharedEnriched = useMemo(
    () => (billsQuery.data ? withPending(billsQuery.data.shared) : undefined),
    [billsQuery.data, withPending],
  )

  // Counted off the rendered lists, not the raw response, so the tab badges and the header total
  // agree with what is actually on screen once staged bills are included.
  const counts = useMemo(() => {
    if (myBills === undefined) return undefined
    return {
      my: myBills.length,
      shared: sharedEnriched?.length ?? 0,
      myCategories: myBills.map((b) => b.category),
    }
  }, [myBills, sharedEnriched])

  const billBuckets = myBills === undefined ? undefined : { myBills, sharedBills: sharedEnriched ?? [] }

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
          return b.createdAt.localeCompare(a.createdAt)
        case 'date_asc':
          return a.createdAt.localeCompare(b.createdAt)
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
    list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return list
  }, [billBuckets?.sharedBills])

  const presentCategories = useMemo(() => {
    const cats = new Set((counts?.myCategories ?? []).filter(Boolean) as string[])
    return BILL_CATEGORIES.filter((c) => cats.has(c))
  }, [counts?.myCategories])

  const loadingBills = !userId || (billsQuery.loading && !billsQuery.data)
  const exportRows = useMemo(
    () => [...(billBuckets?.myBills ?? []), ...(billBuckets?.sharedBills ?? [])],
    [billBuckets?.myBills, billBuckets?.sharedBills],
  )

  async function executeDeleteBill() {
    if (!userId || !deleteTarget) return
    try {
      await deleteBill(deleteTarget.id, userId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete this bill right now.')
    }
  }

  return (
    <>
    <div className="space-y-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Personal bills</h1>
          <p className="mt-1 text-sm text-stone-600">
            {(counts?.my ?? 0) + (counts?.shared ?? 0)} bill{((counts?.my ?? 0) + (counts?.shared ?? 0)) !== 1 ? 's' : ''} · Group bills stay in each group
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {tab === 'mine' && (billBuckets?.myBills.length ?? 0) > 0 && (
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

      <div className="flex gap-1 rounded-xl bg-stone-200/70 p-1">
        <button
          type="button"
          onClick={() => { setTab('mine'); setMyBillsShown(10) }}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-all',
            tab === 'mine' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:bg-white/50 hover:text-stone-700',
          )}
        >
          My bills
          {(counts?.my ?? 0) > 0 && (
            <span className={cn('rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums', tab === 'mine' ? 'bg-stone-100 text-stone-600' : 'bg-stone-300/70 text-stone-600')}>
              {counts!.my}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => { setTab('shared'); setSharedBillsShown(10) }}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-all',
            tab === 'shared' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:bg-white/50 hover:text-stone-700',
          )}
        >
          Shared with me
          {(counts?.shared ?? 0) > 0 && (
            <span className={cn('rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums', tab === 'shared' ? 'bg-stone-100 text-stone-600' : 'bg-stone-300/70 text-stone-600')}>
              {counts!.shared}
            </span>
          )}
        </button>
      </div>

      {tab === 'mine' && billBuckets && billBuckets.myBills.length > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-stone-500">Filter</span>
            <Select value={filter} onValueChange={(v) => setFilter(v as BillFilter)}>
              <SelectTrigger className="h-8 rounded-full px-3 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="unsettled">Not settled</SelectItem>
                <SelectItem value="settled">Settled</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-stone-500">Sort</span>
            <Select value={sort} onValueChange={(v) => setSort(v as BillSort)}>
              <SelectTrigger className="h-8 rounded-full px-3 text-xs">
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

      {billsQuery.fromCache && billsQuery.data && (
        <SavedCopyNotice fetchedAt={billsQuery.fetchedAt} />
      )}

      {billsQuery.error && !billsQuery.data ? (
        // An empty list and an unreachable server must not look the same — one of them means
        // "you have no bills" and the user may act on it.
        <div
          role="alert"
          className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950 shadow-sm"
        >
          <p className="font-medium">Bills unavailable</p>
          <p className="mt-1 text-xs text-amber-900/80">{billsQuery.error}</p>
          <Button size="sm" variant="ghost" className="mt-3 rounded-full text-amber-900" onClick={billsQuery.refresh}>
            Try again
          </Button>
        </div>
      ) : loadingBills ? (
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
      ) : tab === 'mine' ? (
        <div className="space-y-3">
          {(billBuckets?.myBills.length ?? 0) > 0 && bills.length === 0 ? (
            <div className="rounded-3xl border border-stone-200 bg-white p-5 text-center text-sm text-stone-500 shadow-sm">
              No bills match this filter.
            </div>
          ) : !billBuckets || billBuckets.myBills.length === 0 ? (
            <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col items-center py-12 text-center">
                <div className="rounded-2xl bg-stone-100 p-4">
                  <ReceiptText className="size-6 text-stone-400" />
                </div>
                <p className="mt-3 text-sm font-medium text-stone-500">No personal bills yet</p>
                <p className="mt-1 text-xs text-stone-400">
                  Bills you add without a group show up here.
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
            <>
              {bills.slice(0, resolvedMyBillsShown).map((bill) => (
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
                        {bill.pending && (
                          <span
                            title="Saved on this device. It will upload when you're back online."
                            className="rounded-full bg-stone-200 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-stone-600"
                          >
                            Not synced
                          </span>
                        )}
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
                        <span>{timeAgo(bill.createdAt)}</span>
                        <span>·</span>
                        <span>
                          {bill.itemCount} item{bill.itemCount !== 1 ? 's' : ''}
                        </span>
                      </div>
                      {bill.participants.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {bill.participants.map((p) => (
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
                        {formatCurrency(bill.totalAmount, bill.currency)}
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
              {bills.length > resolvedMyBillsShown && (
                <button
                  type="button"
                  onClick={() => setMyBillsShown((n) => n + 10)}
                  className="w-full rounded-2xl border border-stone-200 py-3 text-sm font-medium text-stone-500 transition-colors hover:bg-stone-50"
                >
                  Show more ({bills.length - resolvedMyBillsShown} remaining)
                </button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {sharedBills.length === 0 ? (
            <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex flex-col items-center py-12 text-center">
                <div className="rounded-2xl bg-stone-100 p-4">
                  <ReceiptText className="size-6 text-stone-400" />
                </div>
                <p className="mt-3 text-sm font-medium text-stone-500">No bills shared with you</p>
                <p className="mt-1 text-xs text-stone-400">
                  When someone splits a personal bill with you, it shows up here.
                </p>
              </div>
            </div>
          ) : (
            <>
              {sharedBills.slice(0, sharedBillsShown).map((bill) => (
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
                        {bill.pending && (
                          <span
                            title="Saved on this device. It will upload when you're back online."
                            className="rounded-full bg-stone-200 px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide text-stone-600"
                          >
                            Not synced
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-stone-500">
                        <span>{timeAgo(bill.createdAt)}</span>
                        <span>·</span>
                        <span>Paid by {bill.payorName ?? 'Someone'}</span>
                      </div>
                    </div>
                    <span className="text-sm font-semibold text-stone-800">
                      {formatCurrency(bill.totalAmount, bill.currency)}
                    </span>
                  </div>
                </Link>
              ))}
              {sharedBills.length > sharedBillsShown && (
                <button
                  type="button"
                  onClick={() => setSharedBillsShown((n) => n + 10)}
                  className="w-full rounded-2xl border border-stone-200 py-3 text-sm font-medium text-stone-500 transition-colors hover:bg-stone-50"
                >
                  Show more ({sharedBills.length - sharedBillsShown} remaining)
                </button>
              )}
            </>
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
        // Both buckets: a bill someone else created and split you into is still part of the
        // user's personal record, and the pre-migration exporter always included it.
        onExportPDF={() => generateBillsPDF(userId, exportRows)}
        onExportCSV={() => exportBillsToCSV(userId, exportRows)}
        onClose={() => setExportOpen(false)}
      />
    )}
    </>
  )
}
