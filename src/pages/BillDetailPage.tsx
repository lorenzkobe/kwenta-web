import { useState, useEffect, useCallback } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, Check, Loader2, Pencil, ReceiptText, Share2, Trash2, Users } from 'lucide-react'
import {
  CATEGORY_COLORS,
  CATEGORY_ICONS,
  CATEGORY_LABELS,
  type BillCategory,
} from '@/lib/bill-categories'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getBillWithDetails, deleteBill } from '@/db/operations'
import { db } from '@/db/db'
import { BILL_BACK_QUERY, billDetailBackPath, withBillBackQuery } from '@/lib/bill-navigation'
import {
  computePairwiseNet,
  computePairwiseNetForBill,
  expandProfileIdsForSplitMatching,
  participantUnionForBill,
  resolveProfileDisplay,
} from '@/lib/people'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { fullSync } from '@/sync/sync-service'
import { cn, formatCurrency } from '@/lib/utils'
import { makeExportFilename } from '@/lib/export-utils'
import { generateBillDetailPDF } from '@/lib/export-pdf'
import { exportBillsToCSV } from '@/lib/export-csv'
import { Button } from '@/components/ui/button'
import { RecordSettlementDialog } from '@/components/common/RecordSettlementDialog'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { ExportImageDialog } from '@/components/export/ExportImageDialog'
import { BillExportCard } from '@/components/export/BillExportCard'

type BillDetails = Awaited<ReturnType<typeof getBillWithDetails>>

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
  const [billState, setBillState] = useState<BillDetails>(null)
  const [loadingState, setLoadingState] = useState(true)
  const liveBill = useLiveQuery(async () => {
    if (!billId) return null
    return getBillWithDetails(billId)
  }, [billId])
  const [billPairRows, setBillPairRows] = useState<
    { otherId: string; displayName: string; net: number; autoOffset?: boolean; globalNet?: number }[]
  >([])
  const [recordSettlement, setRecordSettlement] = useState<{
    fromUserId: string
    toUserId: string
    amount: number
    fromName: string
    toName: string
  } | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [mySplitTotal, setMySplitTotal] = useState<number | null>(null)
  const [exportOpen, setExportOpen] = useState(false)

  const reloadBill = useCallback(() => {
    if (!billId) return
    getBillWithDetails(billId).then((data) => {
      setBillState(data)
      setLoadingState(false)
    })
  }, [billId])

  useEffect(() => {
    if (!billId) return
    const id = billId
    let cancelled = false

    async function load() {
      setLoadingState(true)
      let data = await getBillWithDetails(id)
      if (!data && userId && !cancelled) {
        await fullSync(userId)
        if (!cancelled) {
          data = await getBillWithDetails(id)
        }
      }
      if (!cancelled) {
        setBillState(data)
        setLoadingState(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [billId, userId])

  const bill = liveBill === undefined ? billState : liveBill
  const loading = liveBill === undefined ? loadingState : false
  const groupId = bill?.group_id ?? null

  const groupName = useLiveQuery(async () => {
    if (!groupId) return null
    const g = await db.groups.get(groupId)
    return g?.name ?? null
  }, [groupId])

  const reloadBillPairs = useCallback(async () => {
    if (!billId || !userId || !bill) {
      setBillPairRows([])
      return
    }
    const union = await participantUnionForBill(billId)
    union.add(bill.paid_by)
    const others = [...union].filter((id) => id !== userId)
    const rows: { otherId: string; displayName: string; net: number; autoOffset?: boolean; globalNet?: number }[] = []
    for (const oid of others) {
      const net = await computePairwiseNetForBill(billId, userId, oid)
      if (Math.abs(net) < 0.005) continue
      const disp = await resolveProfileDisplay(oid, userId)
      let autoOffset: boolean | undefined
      let globalNet: number | undefined
      if (net < 0) {
        const globalByCurrency = await computePairwiseNet(userId, oid)
        const gNet = globalByCurrency.get(bill.currency) ?? 0
        if (gNet >= 0) {
          autoOffset = true
          globalNet = gNet
        }
      }
      rows.push({ otherId: oid, displayName: disp.displayName, net, autoOffset, globalNet })
    }
    rows.sort((a, b) => a.displayName.localeCompare(b.displayName))
    setBillPairRows(rows)
  }, [billId, userId, bill])

  useEffect(() => {
    const t = setTimeout(() => {
      void reloadBillPairs()
    }, 0)
    return () => clearTimeout(t)
  }, [reloadBillPairs])

  useEffect(() => {
    if (!bill || !userId || bill.group_id !== null) {
      const t = setTimeout(() => setMySplitTotal(null), 0)
      return () => clearTimeout(t)
    }

    let cancelled = false
    void (async () => {
      const myIds = await expandProfileIdsForSplitMatching(userId, userId)
      let total = 0
      let included = false
      for (const item of bill.items) {
        for (const split of item.splits) {
          if (!myIds.has(split.user_id)) continue
          included = true
          total += split.computed_amount
        }
      }
      if (cancelled) return
      setMySplitTotal(included ? Math.round(total * 100) / 100 : null)
    })()

    return () => {
      cancelled = true
    }
  }, [bill, userId])

  async function executeDeleteBill() {
    if (!billId || !userId) return
    await deleteBill(billId, userId)
    navigate(backPath)
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
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <p className="text-center text-sm text-stone-500">Bill not found</p>
        </div>
      </div>
    )
  }

  const canEdit = Boolean(userId && bill.created_by === userId)
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
              {bill.paid_by !== bill.created_by && (
                <span> · recorded by {bill.creatorName}</span>
              )}
              {' · '}{new Date(bill.created_at).toLocaleDateString()}
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
              {formatCurrency(bill.total_amount, bill.currency)}
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

      {userId && billPairRows.some((r) => !r.autoOffset) && (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">Settle on this bill</h2>
          <p className="mt-1 text-xs text-stone-500">
            Amounts use this bill&apos;s splits and payments tagged to this bill.
          </p>
          <ul className="mt-4 space-y-2">
            {billPairRows.map((row) =>
              row.autoOffset ? (
                <li
                  key={row.otherId}
                  className="flex flex-col gap-1 rounded-xl border border-stone-200 bg-stone-50/80 px-4 py-3"
                >
                  <p className="text-sm font-medium text-stone-500">
                    Covered — {row.displayName} owes you{' '}
                    {formatCurrency(row.globalNet ?? 0, bill.currency)} overall
                  </p>
                  <p className="text-xs text-stone-400">
                    Your {formatCurrency(Math.abs(row.net), bill.currency)} share is offset by
                    their balance
                  </p>
                </li>
              ) : (
                <li
                  key={row.otherId}
                  className="flex flex-col gap-2 rounded-xl border border-stone-200 bg-stone-50/80 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-sm font-medium text-stone-800">
                      {row.net < 0
                        ? `You owe ${row.displayName}`
                        : `${row.displayName} owes you`}
                    </p>
                    <p className="text-xs text-stone-500">
                      {formatCurrency(Math.abs(row.net), bill.currency)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="success"
                    size="sm"
                    className="h-10 shrink-0 rounded-lg"
                    onClick={() => {
                      if (row.net < 0) {
                        setRecordSettlement({
                          fromUserId: userId,
                          toUserId: row.otherId,
                          amount: Math.abs(row.net),
                          fromName: 'You',
                          toName: row.displayName,
                        })
                      } else {
                        setRecordSettlement({
                          fromUserId: row.otherId,
                          toUserId: userId,
                          amount: row.net,
                          fromName: row.displayName,
                          toName: 'You',
                        })
                      }
                    }}
                  >
                    <Check className="size-3.5" />
                    Record payment
                  </Button>
                </li>
              ),
            )}
          </ul>
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
                      {formatCurrency(item.amount, bill.currency)}
                    </p>
                  </div>
                  {item.splits.length > 0 && (
                    <div className="mt-3 border-t border-stone-200 pt-3">
                      <div className="flex items-center gap-1.5 text-xs font-medium text-stone-400">
                        <Users className="size-3.5" />
                        Split ({item.splits[0].split_type})
                      </div>
                      <div className="mt-3 space-y-1.5">
                        {item.splits.map((split) => (
                          <div key={split.id} className="flex items-center justify-between text-sm">
                            <span className="text-stone-600">{split.displayName}</span>
                            <span className="font-medium text-stone-800">
                              {formatCurrency(split.computed_amount, bill.currency)}
                            </span>
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
            <div className="flex items-center gap-2">
              <Users className="size-4 text-teal-800" />
              <h2 className="text-lg font-semibold">Split</h2>
            </div>
            <div className="mt-4 space-y-1.5">
              {(bill.items[0]?.splits ?? []).map((split) => (
                <div key={split.id} className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 text-sm">
                  <span className="text-stone-600">{split.displayName}</span>
                  <span className="font-medium text-stone-800">
                    {formatCurrency(split.computed_amount, bill.currency)}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {recordSettlement && billId && userId && (
        <RecordSettlementDialog
          open
          onOpenChange={(o) => {
            if (!o) setRecordSettlement(null)
          }}
          groupId={bill.group_id}
          billId={billId}
          currency={bill.currency}
          fromUserId={recordSettlement.fromUserId}
          toUserId={recordSettlement.toUserId}
          defaultAmount={recordSettlement.amount}
          fromName={recordSettlement.fromName}
          toName={recordSettlement.toName}
          markedBy={userId}
          onRecorded={() => {
            reloadBill()
            void reloadBillPairs()
            setRecordSettlement(null)
          }}
        />
      )}
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
        onExportPDF={() => generateBillDetailPDF(bill.id)}
        onExportCSV={userId ? () => exportBillsToCSV(userId) : undefined}
        onClose={() => setExportOpen(false)}
      >
        <BillExportCard bill={bill} groupName={groupName ?? null} />
      </ExportImageDialog>
    )}
    </>
  )
}
