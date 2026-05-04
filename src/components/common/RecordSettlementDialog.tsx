import { useState, useEffect, useMemo } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { toast } from 'sonner'
import { createSettlement } from '@/db/operations'
import { normalizeAmountInput, stripLeadingZerosAmount } from '@/lib/amount-input'
import { formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function RecordSettlementDialog({
  open,
  onOpenChange,
  groupId,
  currency,
  fromUserId,
  toUserId,
  defaultAmount,
  amountEditable = false,
  fromName,
  toName,
  markedBy,
  onRecorded,
  title = 'Record payment',
  confirmLabel,
  partyPicker,
  billId = null,
  onSubmit,
  showPaymentModeToggle = false,
  paymentMode = 'general',
  onPaymentModeChange,
  helperLines,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string | null
  /** When set, stored on the settlement for bill-level allocation (Phase B). */
  billId?: string | null
  currency: string
  fromUserId: string
  toUserId: string
  defaultAmount: number
  amountEditable?: boolean
  fromName: string
  toName: string
  markedBy: string
  onRecorded: () => void
  title?: string
  confirmLabel?: string
  partyPicker?: { id: string; label: string }[]
  onSubmit?: (args: {
    groupId: string | null
    billId: string | null
    fromUserId: string
    toUserId: string
    amount: number
    currency: string
    label?: string
    markedBy: string
  }) => Promise<void | boolean>
  showPaymentModeToggle?: boolean
  paymentMode?: 'general' | 'distributed'
  onPaymentModeChange?: (mode: 'general' | 'distributed') => void
  helperLines?: string[]
}) {
  const pickerOn = Boolean(partyPicker && partyPicker.length === 2)

  const [label, setLabel] = useState('')
  const [amountStr, setAmountStr] = useState(() => String(defaultAmount))
  const [saving, setSaving] = useState(false)
  const [fromId, setFromId] = useState(fromUserId)
  const [toId, setToId] = useState(toUserId)

  const labelById = useMemo(() => {
    if (!pickerOn || !partyPicker) return null
    return Object.fromEntries(partyPicker.map((p) => [p.id, p.label]))
  }, [pickerOn, partyPicker])

  useEffect(() => {
    if (!open) return
    setLabel('')
    setAmountStr(String(defaultAmount))
    if (pickerOn) {
      setFromId(fromUserId)
      setToId(toUserId)
    }
  }, [open, groupId, fromUserId, toUserId, defaultAmount, pickerOn])

  const effectiveFrom = pickerOn ? fromId : fromUserId
  const effectiveTo = pickerOn ? toId : toUserId
  const displayFromName = pickerOn && labelById ? labelById[effectiveFrom] ?? '…' : fromName
  const displayToName = pickerOn && labelById ? labelById[effectiveTo] ?? '…' : toName

  function swapParties() {
    setFromId(toId)
    setToId(fromId)
  }

  if (!open) return null

  async function handleSubmit() {
    const amount = parseFloat(amountStr.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return
    setSaving(true)
    try {
      if (onSubmit) {
        const handled = await onSubmit({
          groupId,
          billId,
          fromUserId: effectiveFrom,
          toUserId: effectiveTo,
          amount,
          currency,
          label: label.trim() || undefined,
          markedBy,
        })
        if (handled === false) return
      } else {
        await createSettlement(
          groupId,
          effectiveFrom,
          effectiveTo,
          amount,
          currency,
          markedBy,
          label.trim() || undefined,
          billId,
        )
      }
      onRecorded()
      onOpenChange(false)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not record payment right now.'
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const amount = parseFloat(amountStr.replace(',', '.'))
  const invalidAmount = !Number.isFinite(amount) || amount <= 0
  const submitLabel = confirmLabel ?? title

  return (
    <div className="fixed inset-0 z-60 flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={() => !saving && onOpenChange(false)}
        aria-hidden
      />
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <h2 className="text-base font-semibold">{title}</h2>
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
          {showPaymentModeToggle && onPaymentModeChange && (
            <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Payment type</p>
              <div className="grid grid-cols-2 gap-1 rounded-lg border border-stone-200 bg-white p-1">
                <button
                  type="button"
                  className={`rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                    paymentMode === 'general'
                      ? 'bg-teal-800/10 text-teal-900'
                      : 'text-stone-500 hover:text-stone-800'
                  }`}
                  onClick={() => onPaymentModeChange('general')}
                  disabled={saving}
                >
                  General
                </button>
                <button
                  type="button"
                  className={`rounded-md px-2 py-2 text-xs font-medium transition-colors ${
                    paymentMode === 'distributed'
                      ? 'bg-teal-800/10 text-teal-900'
                      : 'text-stone-500 hover:text-stone-800'
                  }`}
                  onClick={() => onPaymentModeChange('distributed')}
                  disabled={saving}
                >
                  Distribute
                </button>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
            <p className="text-xs font-medium text-stone-500">Payment</p>

            {pickerOn ? (
              <div className="mt-3">
                <p className="text-xs text-stone-500">
                  Tap the arrow if payer and recipient should be reversed
                </p>
                <div className="mt-2 flex items-center gap-2 sm:gap-3">
                  <div className="min-w-0 flex-1 text-end">
                    <p className="text-[0.65rem] font-medium uppercase tracking-wide text-stone-400">From</p>
                    <p className="truncate text-sm font-semibold text-stone-900" title={displayFromName}>
                      {displayFromName}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="shrink-0 rounded-full"
                    disabled={saving}
                    onClick={swapParties}
                    aria-label="Flip direction: swap who pays and who receives"
                  >
                    <ArrowRight className="size-4" aria-hidden />
                  </Button>
                  <div className="min-w-0 flex-1">
                    <p className="text-[0.65rem] font-medium uppercase tracking-wide text-stone-400">To</p>
                    <p className="truncate text-sm font-semibold text-stone-900" title={displayToName}>
                      {displayToName}
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex items-center gap-2">
                <div className="min-w-0 flex-1 text-end">
                  <p className="text-[0.65rem] font-medium uppercase tracking-wide text-stone-400">From</p>
                  <p className="truncate text-sm font-semibold text-stone-900" title={displayFromName}>{displayFromName}</p>
                </div>
                <ArrowRight className="size-3.5 shrink-0 text-stone-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-[0.65rem] font-medium uppercase tracking-wide text-stone-400">To</p>
                  <p className="truncate text-sm font-semibold text-stone-900" title={displayToName}>{displayToName}</p>
                </div>
              </div>
            )}

            {amountEditable ? (
              <div className="mt-3">
                <label htmlFor="settlement-amt" className="text-xs font-medium text-stone-500">
                  Amount
                </label>
                <Input
                  id="settlement-amt"
                  type="text"
                  inputMode="decimal"
                  value={amountStr}
                  onChange={(e) => setAmountStr(normalizeAmountInput(e.target.value))}
                  onBlur={() =>
                    setAmountStr((s) => {
                      const next = stripLeadingZerosAmount(s)
                      return next === s ? s : next
                    })
                  }
                  className="mt-1 rounded-lg"
                />
              </div>
            ) : (
              <p className="mt-2 text-lg font-semibold text-teal-800">
                {formatCurrency(amount, currency)}
              </p>
            )}
          </div>

          {helperLines && helperLines.length > 0 && (
            <div className="space-y-1 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2">
              {helperLines.map((line) => (
                <p key={line} className="text-xs text-stone-600">
                  {line}
                </p>
              ))}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label htmlFor="settlement-label" className="text-sm font-medium text-stone-800">
              Label <span className="font-normal text-stone-400">(optional)</span>
            </label>
            <Input
              id="settlement-label"
              type="text"
              placeholder="e.g. Cash, dinner, GCash"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
              className="rounded-lg"
            />
            <p className="text-xs text-stone-500">
              {groupId
                ? "Shown in this group's history and in your global payment list with the group name."
                : 'Shown in your payment history and on this person.'}
            </p>
          </div>

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
              disabled={saving || (amountEditable && invalidAmount)}
              onClick={handleSubmit}
            >
              {saving ? 'Saving…' : submitLabel}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
