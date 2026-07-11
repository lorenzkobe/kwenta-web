import { useMemo, useState } from 'react'
import { Banknote, ChevronRight, Pencil, Receipt } from 'lucide-react'
import type { MoneyFlowResult, MoneyFlowRow } from '@/lib/money-flow'
import { cn, formatCurrency } from '@/lib/utils'

const PAGE = 20

interface DisplayRow {
  key: string
  kind: 'bill' | 'payment'
  /** Underlying bill id for bill rows (for opening the detail sheet); null for payments. */
  billId: string | null
  title: string
  contextLabel: string
  createdAt: string
  currency: string
  /** + they owe me effect / − I owe them. */
  signedAmount: number
  runningNet: number
  settlementIds: string[]
  bundleId: string | null
}

/** Merge adjacent payment legs sharing a bundleId into one atomic payment line. */
function collapse(rows: MoneyFlowRow[]): DisplayRow[] {
  const out: DisplayRow[] = []
  for (const r of rows) {
    const kind: 'bill' | 'payment' = r.type === 'payment' ? 'payment' : 'bill'
    const last = out[out.length - 1]
    if (
      kind === 'payment' &&
      r.bundleId &&
      last &&
      last.kind === 'payment' &&
      last.bundleId === r.bundleId &&
      last.currency === r.currency
    ) {
      last.signedAmount = Math.round((last.signedAmount + r.signedAmount) * 100) / 100
      last.runningNet = r.runningNet
      last.settlementIds.push(r.id)
      continue
    }
    out.push({
      key: `${r.type}-${r.id}`,
      kind,
      billId: kind === 'bill' ? r.id : null,
      title: r.title,
      contextLabel: r.contextLabel,
      createdAt: r.createdAt,
      currency: r.currency,
      signedAmount: r.signedAmount,
      runningNet: r.runningNet,
      settlementIds: kind === 'payment' ? [r.id] : [],
      bundleId: r.bundleId,
    })
  }
  return out
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function PersonStatement({
  result,
  onEditPayment,
  editableSettlementIds,
  onOpenBill,
}: {
  result: MoneyFlowResult | undefined
  /** Given a settlement id in a payment row, open its editor. */
  onEditPayment?: (settlementId: string) => void
  editableSettlementIds?: Set<string>
  /** Given a bill id in a bill row, open its detail sheet. */
  onOpenBill?: (billId: string) => void
}) {
  const [filter, setFilter] = useState<'all' | 'payments'>('all')
  const [visible, setVisible] = useState(PAGE)

  // Newest-first for display; each row keeps its as-of running balance.
  const rowsDesc = useMemo(() => {
    if (!result) return []
    const collapsed = collapse(result.rows)
    const filtered = filter === 'payments' ? collapsed.filter((r) => r.kind === 'payment') : collapsed
    return [...filtered].reverse()
  }, [result, filter])

  const shown = rowsDesc.slice(0, visible)

  if (!result) {
    return <p className="mt-3 text-sm text-stone-500">Loading statement…</p>
  }

  return (
    <div className="mt-3">
      <div className="mb-3 flex w-fit gap-1 rounded-full border border-stone-200 bg-stone-100/80 p-0.5 text-xs">
        {(['all', 'payments'] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              'rounded-full px-3 py-1 font-medium transition-colors',
              filter === f ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800',
            )}
          >
            {f === 'all' ? 'Everything' : 'Payments only'}
          </button>
        ))}
      </div>

      {rowsDesc.length === 0 ? (
        <p className="text-sm text-stone-500">
          {filter === 'payments' ? 'No payments recorded yet.' : 'No bills or payments between you yet.'}
        </p>
      ) : (
        <>
          <ul className="space-y-2">
            {shown.map((row) => {
              const isBill = row.kind === 'bill'
              const positive = row.signedAmount >= 0
              const editableId = row.settlementIds.find((id) => editableSettlementIds?.has(id))
              const clickable = isBill && row.billId != null && onOpenBill != null
              const rowClass =
                'flex w-full items-start justify-between gap-3 rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3'
              const inner = (
                <>
                  <div className="flex min-w-0 items-start gap-3">
                    <div
                      className={cn(
                        'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full',
                        isBill ? 'bg-stone-200/80 text-stone-600' : 'bg-teal-500/15 text-teal-700',
                      )}
                    >
                      {isBill ? <Receipt className="size-4" /> : <Banknote className="size-4" />}
                    </div>
                    <div className="min-w-0 text-left">
                      <p className="text-sm font-medium text-stone-800">{row.title}</p>
                      <p className="mt-0.5 text-xs text-stone-500">{row.contextLabel}</p>
                      <p className="mt-0.5 text-[11px] text-stone-400">{fmtDate(row.createdAt)}</p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-start gap-2 text-right">
                    <div>
                      <span
                        className={cn(
                          'text-sm font-semibold',
                          isBill
                            ? positive
                              ? 'text-emerald-700'
                              : 'text-amber-700'
                            : 'text-teal-700',
                        )}
                      >
                        {isBill ? (positive ? '+' : '−') : ''}
                        {formatCurrency(Math.abs(row.signedAmount), row.currency)}
                      </span>
                      <p className="mt-0.5 text-xs text-stone-500">
                        Bal {formatCurrency(row.runningNet, row.currency)}
                      </p>
                    </div>
                    {clickable && <ChevronRight className="mt-0.5 size-4 shrink-0 text-stone-400" />}
                    {row.kind === 'payment' && editableId && onEditPayment && (
                      <button
                        type="button"
                        className="mt-0.5 rounded-full p-1 text-stone-400 transition-colors hover:bg-stone-200 hover:text-stone-700"
                        aria-label="Edit payment"
                        onClick={() => onEditPayment(editableId)}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    )}
                  </div>
                </>
              )
              return (
                <li key={row.key}>
                  {clickable ? (
                    <button
                      type="button"
                      className={cn(rowClass, 'text-left transition-colors hover:border-stone-300 hover:bg-stone-100')}
                      aria-label={`Open bill ${row.title}`}
                      onClick={() => onOpenBill!(row.billId!)}
                    >
                      {inner}
                    </button>
                  ) : (
                    <div className={rowClass}>{inner}</div>
                  )}
                </li>
              )
            })}
          </ul>
          {rowsDesc.length > visible && (
            <button
              type="button"
              onClick={() => setVisible((n) => n + PAGE)}
              className="mt-3 w-full rounded-xl border border-stone-200 py-2.5 text-sm font-medium text-stone-500 transition-colors hover:bg-stone-50"
            >
              Show more ({rowsDesc.length - visible} remaining)
            </button>
          )}
        </>
      )}
    </div>
  )
}
