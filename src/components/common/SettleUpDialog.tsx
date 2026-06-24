import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { PersonalReconcilePlan, PersonalReconcileSlice } from '@/lib/people'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const round2 = (n: number) => Math.round(n * 100) / 100

function SliceList({
  title,
  slices,
  currency,
}: {
  title: string
  slices: PersonalReconcileSlice[]
  currency: string
}) {
  if (slices.length === 0) return null
  return (
    <div className="space-y-1.5 rounded-xl border border-stone-200 bg-stone-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{title}</p>
      {slices.map((slice, index) => (
        <div
          key={`${slice.billId}-${slice.source}-${index}`}
          className="flex items-center justify-between gap-3 text-sm text-stone-700"
        >
          <span className="truncate">{slice.billTitle || 'Bill'}</span>
          <span className="font-medium">{formatCurrency(slice.amount, currency)}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * "Settle up" — reconcile personal bills between you and one person in both
 * directions. Mutual debts cancel (offset, free); any leftover net is covered by
 * available credit. Each covered bill gets a logged settlement.
 */
export function SettleUpDialog({
  open,
  onOpenChange,
  plan,
  personName,
  saving,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  plan: PersonalReconcilePlan
  personName: string
  saving: boolean
  onSubmit: (amount: number) => Promise<void>
}) {
  const [amountText, setAmountText] = useState(String(plan.maxApplicable))

  const amount = useMemo(() => {
    const parsed = Number.parseFloat(amountText)
    if (!Number.isFinite(parsed) || parsed < 0) return 0
    return Math.min(round2(parsed), plan.maxApplicable)
  }, [amountText, plan.maxApplicable])

  // Bills grouped by direction (using the full-amount plan for the preview).
  const youOwe = useMemo(
    () => [...plan.offsetSlices, ...plan.creditSlices].filter((s) => s.direction === 'me_to_other'),
    [plan.offsetSlices, plan.creditSlices],
  )
  const theyOwe = useMemo(
    () => [...plan.offsetSlices, ...plan.creditSlices].filter((s) => s.direction === 'other_to_me'),
    [plan.offsetSlices, plan.creditSlices],
  )

  // Net still owed after applying `amount` (offset is free, then credit).
  const footer = useMemo(() => {
    const netMagnitude = round2(Math.abs(plan.theyOweMeTotal - plan.iOweThemTotal))
    const creditApplied = Math.min(plan.creditCap, Math.max(0, round2(amount - plan.offsetCap)))
    const residual = round2(Math.max(0, netMagnitude - creditApplied))
    if (residual <= 0.005) {
      return `After this, you and ${personName} are even.`
    }
    const theyOweMore = plan.theyOweMeTotal - plan.iOweThemTotal > 0.005
    return theyOweMore
      ? `${personName} will still owe you ${formatCurrency(residual, plan.currency)}.`
      : `You'll still owe ${personName} ${formatCurrency(residual, plan.currency)}.`
  }, [amount, personName, plan])

  const disabled = saving || amount <= 0.005

  if (!open) return null

  return (
    <div className="fixed inset-0 z-60 flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={() => !saving && onOpenChange(false)}
        aria-hidden
      />
      <div className="relative w-full max-w-lg animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Settle up with {personName}</h2>
            <p className="mt-1 text-xs text-stone-500">
              Cancels what you each owe and records a payment on every covered bill.
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-full"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="space-y-1.5 rounded-xl border border-stone-200 bg-white px-4 py-3">
            <label className="text-xs font-medium uppercase tracking-wide text-stone-500" htmlFor="settle-up-amount">
              Amount to settle
            </label>
            <div className="flex items-center justify-between gap-3">
              <input
                id="settle-up-amount"
                type="number"
                inputMode="decimal"
                min={0}
                step="0.01"
                value={amountText}
                onChange={(event) => setAmountText(event.target.value)}
                disabled={saving}
                className="w-full bg-transparent text-lg font-semibold text-stone-900 outline-none"
              />
              <button
                type="button"
                className="shrink-0 rounded-full bg-stone-100 px-3 py-1 text-xs font-medium text-stone-600 hover:bg-stone-200"
                disabled={saving}
                onClick={() => setAmountText(String(plan.maxApplicable))}
              >
                Max {formatCurrency(plan.maxApplicable, plan.currency)}
              </button>
            </div>
          </div>

          <SliceList title={`${personName} paid — you owe`} slices={youOwe} currency={plan.currency} />
          <SliceList title={`You paid — ${personName} owes`} slices={theyOwe} currency={plan.currency} />

          <p className="rounded-xl bg-teal-50/70 px-4 py-3 text-sm font-medium text-teal-900">{footer}</p>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              className="rounded-xl"
              disabled={disabled}
              onClick={() => void onSubmit(amount)}
            >
              {saving ? 'Settling…' : 'Settle up'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
