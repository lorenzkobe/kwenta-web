import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, ReceiptText, Share2, Trash2, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import { deleteBill } from '@/db/operations'
import {
  fetchPersonalBills,
  fetchPersonalBillsPage,
  personalBillsPageKey,
  type PersonalBillRow,
} from '@/api/balances'
import { useServerData } from '@/hooks/useServerData'
import { loadStagedPersonalBillRows } from '@/lib/staged-rows'
import { SavedCopyNotice } from '@/components/common/SavedCopyNotice'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { formatCurrency, timeAgo, cn } from '@/lib/utils'
import { OriginalAmountLine } from '@/components/common/CurrencyConversionField'
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

const PAGE_SIZE = 20

/** A server row plus one fact only this device knows: whether the write is still queued. */
type EnrichedBill = PersonalBillRow & { pending: boolean }

type PageMeta = { mine: number; shared: number; categories: string[] }

/** Rows loaded past the first page by "Show more", for the list identified by `key`. */
type MoreRows = { key: string; rows: PersonalBillRow[]; matching: number }

/** The largest page the server returns in one call (kwenta_personal_bills_page clamps `p_limit`). */
const MAX_PAGE_ROWS = 500

const EMPTY_UNSENT = { newBills: [] as PersonalBillRow[], pendingIds: new Set<string>() }

const cursorOf = (b: PersonalBillRow) => ({ id: b.id, createdAt: b.createdAt, title: b.title })

/**
 * Unsent bills this device holds, split by whether the server has ever seen them.
 *
 * `loadStagedPersonalBillRows` returns every personal bill with an unsent write, which includes an
 * offline EDIT of a bill the server already holds. Only a bill whose `create_bill` is still in the
 * write queue is new to the server; counting or prepending an edit would double-count it and put
 * it above rows it sorts below. (`synced_at` cannot tell them apart: an edit clears it too.)
 */
async function loadUnsentBills(userId: string) {
  const [rows, creates] = await Promise.all([
    loadStagedPersonalBillRows(userId),
    db.pending_mutations
      .where('actor_user_id')
      .equals(userId)
      .filter(
        (m) =>
          m.operation === 'create_bill' &&
          (m.status === 'pending' || m.status === 'conflict' || m.status === 'blocked_by_earlier'),
      )
      .toArray(),
  ])
  const created = new Set(creates.map((m) => m.entity_id))
  return {
    newBills: rows.filter((b) => created.has(b.id)),
    pendingIds: new Set(rows.map((b) => b.id)),
  }
}

export function BillsPage() {
  const { userId } = useCurrentUser()
  const [filter, setFilter] = useState<BillFilter>('all')
  const [sort, setSort] = useState<BillSort>('date_desc')
  const [filterCategory, setFilterCategory] = useState<string | null>(null)
  const [tab, setTab] = useState<'mine' | 'shared'>('mine')
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [more, setMore] = useState<MoreRows | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [reloading, setReloading] = useState(false)
  // Bumped whenever the loaded list is replaced or reset, so a slower answer for the old list
  // is dropped instead of being appended to the new one.
  const generation = useRef(0)

  // The Shared tab has no controls: it always asks for everything, newest first.
  const bucket = tab
  const settled = tab === 'mine' ? filter : 'all'
  const category = tab === 'mine' ? filterCategory : null
  const sortKey = tab === 'mine' ? sort : 'date_desc'
  const endpointKey = personalBillsPageKey({ bucket, settled, category, sort: sortKey })

  // The first page is an ordinary cached read (paints a saved copy, refetches on every bump).
  // "Show more" asks only for the rows after the last one held, so nothing already loaded is
  // downloaded again and a bill added meanwhile cannot shift a row onto two pages.
  const loadBills = useCallback(
    () =>
      userId
        ? fetchPersonalBillsPage(userId, { bucket, limit: PAGE_SIZE, settled, category, sort: sortKey })
        : Promise.reject(new Error('no user')),
    [userId, bucket, settled, category, sortKey],
  )
  const billsQuery = useServerData(userId ? loadBills : null, [userId, endpointKey], endpointKey)
  const page = billsQuery.data
  const extraRows = more && more.key === endpointKey ? more.rows : []
  const extraCount = useRef(0)
  useEffect(() => {
    extraCount.current = extraRows.length
  })

  // A fresh first page (a write, a sync, Refresh) means the rows loaded past it may be stale:
  // reload exactly that many, in one call or successive ones of at most 500, and replace them.
  // They stay on screen meanwhile — the list never snaps back to 20.
  //
  // A fresh first page always supersedes a "Show more" still in flight (its rows were fetched
  // against the old list), and "Show more" is off while this reload runs, so the two can never
  // write the list in an order that resurrects a deleted bill or drops appended rows.
  useEffect(() => {
    if (!userId || !page || billsQuery.fromCache) {
      setReloading(false)
      return
    }
    const mine = ++generation.current
    const held = extraCount.current
    if (held === 0) {
      setReloading(false)
      return
    }
    setReloading(true)
    let cancelled = false
    void (async () => {
      try {
        const rows: PersonalBillRow[] = []
        let last = page.rows[page.rows.length - 1]
        let matching = page.matching
        while (last && rows.length < held) {
          const res = await fetchPersonalBillsPage(userId, {
            bucket,
            settled,
            category,
            sort: sortKey,
            limit: Math.min(held - rows.length, MAX_PAGE_ROWS),
            after: cursorOf(last),
          })
          if (cancelled || mine !== generation.current) return
          if (res.data.rows.length === 0) break
          rows.push(...res.data.rows)
          last = rows[rows.length - 1]
          matching = res.data.matching
        }
        setMore({ key: endpointKey, rows, matching })
      } catch {
        // The rows already on screen stay; the next bump reloads them.
      } finally {
        if (mine === generation.current) setReloading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [page, billsQuery.fromCache, userId, bucket, settled, category, sortKey, endpointKey])

  // Tab totals and category chips come with every page, but a tab switch or a filter change has no
  // page for a moment; keep the last ones so the badges and the filter row do not blink away.
  const [meta, setMeta] = useState<PageMeta | null>(null)
  if (page && (meta?.mine !== page.mine || meta.shared !== page.shared || meta.categories !== page.categories)) {
    setMeta({ mine: page.mine, shared: page.shared, categories: page.categories })
  }
  const shownMeta = page ?? meta

  // The one fact the server cannot know: which of these rows this device has not sent yet.
  // Written offline, it is queued locally and must be flagged rather than shown as confirmed.
  // A bill the server has never seen is the ONLY thing decorating cannot surface, so those rows
  // are added; an unsent edit of a bill the server holds only flags that bill's row.
  const unsent = useLiveQuery(
    async () => (userId ? loadUnsentBills(userId) : EMPTY_UNSENT),
    [userId],
    EMPTY_UNSENT,
  )

  const serverRows: EnrichedBill[] = [...(page?.rows ?? []), ...extraRows].map((b) => ({
    ...b,
    pending: unsent.pendingIds.has(b.id),
  }))

  // A new bill the server already returned keeps the server's copy, so a row never renders twice
  // while `synced_at` catches up. New bills are unsettled, so they match only the filters that
  // admit an unsettled bill of their category, and they sit above the server's rows.
  const loadedIds = new Set(serverRows.map((b) => b.id))
  const unsentOnly = unsent.newBills.filter((b) => !loadedIds.has(b.id))
  const unsentMatching: EnrichedBill[] = unsentOnly
    .filter((b) => filter !== 'settled' && (!filterCategory || b.category === filterCategory))
    .map((b) => ({ ...b, pending: true }))

  const myBills = tab === 'mine' ? [...unsentMatching, ...serverRows] : []
  const sharedBills = tab === 'shared' ? serverRows : []
  const myTotal = (shownMeta?.mine ?? 0) + unsentOnly.length
  const sharedTotal = shownMeta?.shared ?? 0
  const matching = extraRows.length > 0 && more ? more.matching : (page?.matching ?? 0)
  const remaining = page ? matching - serverRows.length : 0

  const presentCategories = BILL_CATEGORIES.filter(
    (c) => shownMeta?.categories.includes(c) || c === filterCategory,
  )

  const loadingBills = !userId || (billsQuery.loading && !billsQuery.data)

  function resetLoaded() {
    generation.current++
    setMore(null)
    setLoadingMore(false)
    setReloading(false)
  }

  function changeControls(patch: { filter?: BillFilter; sort?: BillSort; category?: string | null }) {
    if (patch.filter !== undefined) setFilter(patch.filter)
    if (patch.sort !== undefined) setSort(patch.sort)
    if (patch.category !== undefined) setFilterCategory(patch.category)
    resetLoaded()
  }

  function switchTab(next: 'mine' | 'shared') {
    setTab(next)
    resetLoaded()
  }

  async function showMore() {
    const last = serverRows[serverRows.length - 1]
    if (!userId || !last || loadingMore || reloading) return
    const mine = generation.current
    setLoadingMore(true)
    try {
      const res = await fetchPersonalBillsPage(userId, {
        bucket,
        settled,
        category,
        sort: sortKey,
        limit: PAGE_SIZE,
        after: cursorOf(last),
      })
      if (mine !== generation.current) return
      const rows = res.data.rows
      setMore({
        key: endpointKey,
        rows: [...extraRows, ...rows],
        // A page with nothing in it means the rest is gone; stop offering a button that does nothing.
        matching: rows.length > 0 ? res.data.matching : serverRows.length,
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not load more bills.')
    } finally {
      setLoadingMore(false)
    }
  }

  // Fetched on tap rather than held: the page only ever has one screenful, and the full list is
  // needed once. Throws offline with no saved copy, which the dialog reports without exporting.
  async function loadExportRows(uid: string) {
    const { data } = await fetchPersonalBills(uid)
    const fetched = new Set([...data.mine, ...data.shared].map((b) => b.id))
    return [...unsent.newBills.filter((b) => !fetched.has(b.id)), ...data.mine, ...data.shared]
  }

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
            {myTotal + sharedTotal} bill{myTotal + sharedTotal !== 1 ? 's' : ''} · Group bills stay in each group
          </p>
        </div>
        <div className="flex items-center gap-2 self-start sm:self-auto">
          {tab === 'mine' && myTotal > 0 && (
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
          onClick={() => switchTab('mine')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-all',
            tab === 'mine' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:bg-white/50 hover:text-stone-700',
          )}
        >
          My bills
          {myTotal > 0 && (
            <span className={cn('rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums', tab === 'mine' ? 'bg-stone-100 text-stone-600' : 'bg-stone-300/70 text-stone-600')}>
              {myTotal}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => switchTab('shared')}
          className={cn(
            'flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2 text-sm font-medium transition-all',
            tab === 'shared' ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:bg-white/50 hover:text-stone-700',
          )}
        >
          Shared with me
          {sharedTotal > 0 && (
            <span className={cn('rounded-full px-1.5 py-0.5 text-xs font-semibold tabular-nums', tab === 'shared' ? 'bg-stone-100 text-stone-600' : 'bg-stone-300/70 text-stone-600')}>
              {sharedTotal}
            </span>
          )}
        </button>
      </div>

      {tab === 'mine' && myTotal > 0 && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-stone-500">Filter</span>
            <Select value={filter} onValueChange={(v) => changeControls({ filter: v as BillFilter })}>
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
            <Select value={sort} onValueChange={(v) => changeControls({ sort: v as BillSort })}>
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
                onClick={() => changeControls({ category: active ? null : cat })}
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

      {billsQuery.fromCache && !billsQuery.revalidating && billsQuery.data && (
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
          {myBills.length === 0 && myTotal > 0 ? (
            <div className="rounded-3xl border border-stone-200 bg-white p-5 text-center text-sm text-stone-500 shadow-sm">
              No bills match this filter.
            </div>
          ) : myBills.length === 0 ? (
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
              {myBills.map((bill) => (
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
                      <div className="text-right">
                        <span className="text-sm font-semibold text-stone-800">
                          {formatCurrency(bill.totalAmount, bill.currency)}
                        </span>
                        <OriginalAmountLine currency={bill.originalCurrency} amount={bill.originalTotal} />
                      </div>
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
              {remaining > 0 && (
                <button
                  type="button"
                  onClick={() => void showMore()}
                  disabled={loadingMore || reloading}
                  className="w-full rounded-2xl border border-stone-200 py-3 text-sm font-medium text-stone-500 transition-colors hover:bg-stone-50 disabled:opacity-60"
                >
                  Show more ({remaining} remaining)
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
                    <div className="shrink-0 text-right">
                      <span className="text-sm font-semibold text-stone-800">
                        {formatCurrency(bill.totalAmount, bill.currency)}
                      </span>
                      <OriginalAmountLine currency={bill.originalCurrency} amount={bill.originalTotal} />
                    </div>
                  </div>
                </Link>
              ))}
              {remaining > 0 && (
                <button
                  type="button"
                  onClick={() => void showMore()}
                  disabled={loadingMore || reloading}
                  className="w-full rounded-2xl border border-stone-200 py-3 text-sm font-medium text-stone-500 transition-colors hover:bg-stone-50 disabled:opacity-60"
                >
                  Show more ({remaining} remaining)
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
        onExportPDF={async () => generateBillsPDF(userId, await loadExportRows(userId))}
        onExportCSV={async () => exportBillsToCSV(userId, await loadExportRows(userId))}
        onClose={() => setExportOpen(false)}
      />
    )}
    </>
  )
}
