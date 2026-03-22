import { useState, useEffect, useMemo } from 'react'
import { ArrowLeftRight, ArrowRight, X } from 'lucide-react'
import { createSettlement } from '@/db/operations'
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string | null
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
      await createSettlement(
        groupId,
        effectiveFrom,
        effectiveTo,
        amount,
        currency,
        markedBy,
        label.trim() || undefined,
      )
      onRecorded()
      onOpenChange(false)
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
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
            <p className="text-xs font-medium text-stone-500">Payment</p>

            {pickerOn ? (
              <div className="mt-3">
                <p className="text-xs text-stone-500">Left paid right · swap if it’s reversed</p>
                <div className="mt-2 flex items-center gap-2 sm:gap-3">
                  <span
                    className="min-w-0 flex-1 truncate text-end text-sm font-semibold text-stone-900"
                    title={displayFromName}
                  >
                    {displayFromName}
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    className="shrink-0 rounded-full"
                    disabled={saving}
                    onClick={swapParties}
                    aria-label="Swap payer and payee"
                  >
                    <ArrowLeftRight className="size-4" aria-hidden />
                  </Button>
                  <span
                    className="min-w-0 flex-1 truncate text-start text-sm font-semibold text-stone-900"
                    title={displayToName}
                  >
                    {displayToName}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-stone-800">{displayFromName}</span>
                <ArrowRight className="size-3.5 text-stone-400" />
                <span className="font-medium text-stone-800">{displayToName}</span>
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
                  onChange={(e) => setAmountStr(e.target.value)}
                  className="mt-1 rounded-lg"
                />
              </div>
            ) : (
              <p className="mt-2 text-lg font-semibold text-teal-800">
                {formatCurrency(amount, currency)}
              </p>
            )}
          </div>

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
