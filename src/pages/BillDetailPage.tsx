import { useState, useCallback, useMemo } from 'react'
import { fetchBillDetail, fetchBillSettlementHistory, fetchPersonalBills } from '@/api/balances'
import { useServerData } from '@/hooks/useServerData'
import { ArrowLeft, Clock, Loader2, Pencil, ReceiptText, Share2, Trash2, Users } from 'lucide-react'
import { toast } from 'sonner'
import {
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  type BillCategory,
} from '@/lib/bill-categories'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { deleteBill } from '@/db/operations'
import { loadStagedBillDetail } from '@/lib/staged-rows'
import { BILL_BACK_QUERY, billDetailBackPath, withBillBackQuery } from '@/lib/bill-navigation'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn, formatCurrency } from '@/lib/utils'
import { makeExportFilename } from '@/lib/export-utils'
import { generateBillDetailPDF } from '@/lib/export-pdf'
import { exportBillsToCSV } from '@/lib/export-csv'
import { Button } from '@/components/ui/button'
import { SettlementHistoryList } from '@/components/common/SettlementHistoryList'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ExportImageDialog } from '@/components/export/ExportImageDialog'
import { BillExportCard } from '@/components/export/BillExportCard'

export function BillDetailPage() {
  const { billId } = useParams<{ billId: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const { userId } = useCurrentUser()
  const backPath = billDetailBackPath({
    backSearchParam: searchParams.get(BILL_BACK_QUERY),
    locationState: location.state,
  })
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)

  // The whole screen in one call: bill, items, splits with resolved names, the viewer's own
  // share, and one row per counterparty with that bill's net and whether the PERSON is square.
  // This replaced getBillWithDetails plus a per-participant loop that computed a full
  // cross-group tab for every other person on the bill.
  // A bill written offline lives only in the local queue, so the endpoint cannot answer for it
  // and the screen reported a load failure for a bill the user had just saved. The staged copy is
  // descriptive only — no pairwise nets, since those are server aggregates for a row the server
  // has never seen — and it is used ONLY when the bill is still unsent on this device.
  const loadDetail = useCallback(async () => {
    if (!userId || !billId) throw new Error('no user')
    try {
      return await fetchBillDetail(userId, billId)
    } catch (error) {
      const staged = await loadStagedBillDetail(billId, userId)
      if (staged) return { data: staged, fromCache: true, fetchedAt: staged.bill.createdAt }
      throw error
    }
  }, [userId, billId])
  const detail = useServerData(userId && billId ? loadDetail : null, [userId, billId, loadDetail])

  const bill = useMemo(() => {
    if (!detail.data) return null
    return { ...detail.data.bill, items: detail.data.items }
  }, [detail.data])

  const loading = !userId || (detail.loading && !detail.data)
  const groupName = detail.data?.groupName ?? null
  const mySplitTotal = detail.data?.mySplitTotal ?? null
  const billPairRows = useMemo(() => detail.data?.pairs ?? [], [detail.data])

  const loadPayments = useCallback(
    () =>
      userId && billId
        ? fetchBillSettlementHistory(userId, billId)
        : Promise.reject(new Error('no user')),
    [userId, billId],
  )
  const payments = useServerData(userId && billId ? loadPayments : null, [userId, billId])
  // Held stable across renders: `billPayments` memoises off it, and a fresh array each render
  // would rebuild the export payload every time.
  const billPaymentHistory = useMemo(
    () => (payments.loading && !payments.data ? undefined : (payments.data ?? [])),
    [payments.loading, payments.data],
  )

  // The export lists every stored payment row, not the bundled view: `legs` is exactly that,
  // already name-resolved, so it needs no second query.
  const billPayments = useMemo(
    () =>
      (billPaymentHistory ?? []).flatMap((h) =>
        h.legs.map((l) => ({
          fromName: l.fromName,
          toName: l.toName,
          amount: l.amount,
          currency: h.currency,
          createdAt: h.createdAt,
          label: h.label,
        })),
      ),
    [billPaymentHistory],
  )

  async function executeDeleteBill() {
    if (!billId || !userId) return
    try {
      await deleteBill(billId, userId)
      navigate(backPath)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete this bill right now.')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-teal-800" />
      </div>
    )
  }

  if (!bill) {
    return (
      <div className="space-y-5">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to={backPath}>
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        {detail.error ? (
          // "Not found" is a claim about the data; a failed request is a claim about the network.
          // Saying the first when the second happened sends the user looking for a deleted bill.
          <div
            role="alert"
            className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-950 shadow-sm"
          >
            <p className="font-medium">Could not load this bill</p>
            <p className="mt-1 text-xs text-amber-900/80">{detail.error}</p>
            <Button size="sm" variant="ghost" className="mt-3 rounded-full text-amber-900" onClick={detail.refresh}>
              Try again
            </Button>
          </div>
        ) : (
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
            <p className="text-center text-sm text-stone-500">Bill not found</p>
          </div>
        )}
      </div>
    )
  }

  const canEdit = Boolean(userId && bill.createdBy === userId)
  return (
    <>
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to={backPath}>
            <ArrowLeft className="size-4" />
            Back
          </Link>
        </Button>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            className="rounded-full"
            aria-label="Share bill"
            onClick={() => setExportOpen(true)}
          >
            <Share2 className="size-4" />
          </Button>
          {canEdit && (
            <>
              <Button asChild variant="ghost" size="sm" className="rounded-full">
                <Link to={withBillBackQuery(`/app/bills/new?edit=${billId}`, backPath)}>
                  <Pencil className="size-4" />
                  Edit
                </Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full text-red-600"
                onClick={() => setDeleteConfirmOpen(true)}
              >
                <Trash2 className="size-4" />
                Delete
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{bill.title}</h1>
            <p className="mt-1 text-sm text-stone-500">
              Paid by {bill.payorName}
              {bill.paidBy !== bill.createdBy && (
                <span> · recorded by {bill.creatorName}</span>
              )}
              {' · '}{new Date(bill.createdAt).toLocaleDateString()}
            </p>
            {bill.category && CATEGORY_LABELS[bill.category as BillCategory] && (
              <span
                className={cn(
                  'mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium',
                  CATEGORY_COLORS[bill.category as BillCategory],
                )}
              >
                {(() => { const Icon = CATEGORY_ICONS[bill.category as BillCategory]; return <Icon className="size-3" /> })()}
                {CATEGORY_LABELS[bill.category as BillCategory]}
              </span>
            )}
          </div>
          <div className="text-right">
            <p className="text-2xl font-semibold text-teal-800">
              {formatCurrency(bill.totalAmount, bill.currency)}
            </p>
            {mySplitTotal !== null && (
              <p className="mt-1 text-sm font-medium text-stone-600">
                Your split: {formatCurrency(mySplitTotal, bill.currency)}
              </p>
            )}
            <p className="text-xs text-stone-400">{bill.currency}</p>
          </div>
        </div>

        {bill.note && (
          <div className="mt-4 rounded-2xl bg-stone-100/80 px-4 py-3">
            <p className="text-sm text-stone-600">{bill.note}</p>
          </div>
        )}
      </div>

      {userId && billPairRows.length > 0 && (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">This bill&apos;s balance</h2>
          <p className="mt-1 text-xs text-stone-500">
            What this bill adds to your running balance with each person. Record payments on their page —
            it settles across everything you share.
          </p>
          <ul className="mt-4 space-y-2">
            {billPairRows.map((row) => (
              <li key={row.otherId}>
                <Link
                  to={`/app/people/${row.otherId}`}
                  className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-50/80 px-4 py-3 transition-colors hover:bg-stone-100"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-stone-800">
                      {row.net < 0
                        ? `You owe ${row.displayName}`
                        : `${row.displayName} owes you`}{' '}
                      {formatCurrency(Math.abs(row.net), bill.currency)}
                    </p>
                    <p className="mt-0.5 text-xs text-stone-500">
                      {row.squareOverall
                        ? "You're square overall — settled ✓"
                        : 'From this bill · open their page to settle'}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm font-medium text-teal-800">Open →</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(billPaymentHistory?.length ?? 0) > 0 && (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2">
            <Clock className="size-4 text-teal-800" />
            <h2 className="text-lg font-semibold">Payment history</h2>
          </div>
          <div className="mt-4">
            <SettlementHistoryList items={billPaymentHistory ?? []} currentUserId={userId} />
          </div>
        </div>
      )}

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        {bill.items.length > 1 ? (
          <>
            <div className="flex items-center gap-2">
              <ReceiptText className="size-4 text-teal-800" />
              <h2 className="text-lg font-semibold">Items ({bill.items.length})</h2>
            </div>
            <div className="mt-4 space-y-3">
              {bill.items.map((item) => (
                <div key={item.id} className="rounded-2xl border border-stone-200 bg-stone-100/60 p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-stone-800">{item.name}</p>
                    <p className="font-semibold text-stone-800">
                      {item.splits[0]?.splitType === 'quantity'
                        ? `${formatCurrency(item.amount, bill.currency)}/each`
                        : formatCurrency(item.amount, bill.currency)}
                    </p>
                  </div>
                  {item.splits.length > 0 && (
                    <div className="mt-3 border-t border-stone-200 pt-3">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-stone-400">
                        <Users className="size-3.5" />
                        Split ({item.splits[0].splitType})
                      </div>
                      <div className="mt-3 space-y-1.5">
                        {item.splits.map((split) => (
                          <div key={split.id} className="flex items-center justify-between text-sm">
                            <span className="text-stone-600">{split.displayName}</span>
                            {split.splitType === 'quantity' ? (
                              <span className="flex items-center gap-1">
                                <span className="text-stone-400">
                                  {split.splitValue} × {formatCurrency(item.amount, bill.currency)} =
                                </span>
                                <span className="font-medium text-stone-800">
                                  {formatCurrency(split.computedAmount, bill.currency)}
                                </span>
                              </span>
                            ) : (
                              <span className="font-medium text-stone-800">
                                {formatCurrency(split.computedAmount, bill.currency)}
                              </span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Users className="size-4 text-teal-800" />
                <h2 className="text-lg font-semibold">Split</h2>
              </div>
              {bill.items[0]?.splits[0]?.splitType === 'quantity' && (
                <span className="text-sm text-stone-500">
                  {formatCurrency(bill.items[0].amount, bill.currency)}/each
                </span>
              )}
            </div>
            <div className="mt-4 space-y-1.5">
              {(bill.items[0]?.splits ?? []).map((split) => (
                <div key={split.id} className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 text-sm">
                  <span className="text-stone-600">{split.displayName}</span>
                  {split.splitType === 'quantity' ? (
                    <span className="flex items-center gap-1">
                      <span className="text-stone-400">
                        {split.splitValue} × {formatCurrency(bill.items[0].amount, bill.currency)} =
                      </span>
                      <span className="font-medium text-stone-800">
                        {formatCurrency(split.computedAmount, bill.currency)}
                      </span>
                    </span>
                  ) : (
                    <span className="font-medium text-stone-800">
                      {formatCurrency(split.computedAmount, bill.currency)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>

    </div>

    <ConfirmDialog
      open={deleteConfirmOpen}
      onOpenChange={setDeleteConfirmOpen}
      title="Delete this bill?"
      description={
        bill
          ? `"${bill.title}" will be removed. This cannot be undone on this device.`
          : 'This bill will be removed. This cannot be undone on this device.'
      }
      confirmLabel="Delete bill"
      variant="danger"
      onConfirm={executeDeleteBill}
    />

    {exportOpen && bill && (
      <ExportImageDialog
        filename={makeExportFilename('Bills', 'png').replace('.png', '')}
        onExportPDF={() => generateBillDetailPDF(detail.data!)}
        onExportCSV={
                  userId
                    ? async () => {
                        // This dialog offers a whole-list CSV from a single bill's screen, so the
                        // rows are not already on hand. Fetch them rather than exporting an empty
                        // file or recomputing the settled flag locally.
                        const { data } = await fetchPersonalBills(userId)
                        await exportBillsToCSV(userId, [...data.mine, ...data.shared])
                      }
                    : undefined
                }
        onClose={() => setExportOpen(false)}
      >
        <BillExportCard bill={bill} groupName={groupName ?? null} payments={billPayments ?? []} />
      </ExportImageDialog>
    )}
    </>
  )
}
