import { useState, useEffect } from 'react'
import { ArrowRight, X } from 'lucide-react'
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
}) {
  const [label, setLabel] = useState('')
  const [amountStr, setAmountStr] = useState(() => String(defaultAmount))
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (open) {
      setLabel('')
      setAmountStr(String(defaultAmount))
    }
  }, [open, groupId, fromUserId, toUserId, defaultAmount])

  if (!open) return null

  async function handleSubmit() {
    const amount = parseFloat(amountStr.replace(',', '.'))
    if (!Number.isFinite(amount) || amount <= 0) return
    setSaving(true)
    try {
      await createSettlement(
        groupId,
        fromUserId,
        toUserId,
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

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={() => !saving && onOpenChange(false)}
        aria-hidden
      />
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-slate-200 bg-white shadow-[0_20px_60px_rgba(15,23,42,0.18)]">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold">Record payment</h2>
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
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium text-slate-500">Payment</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-slate-800">{fromName}</span>
              <ArrowRight className="size-3.5 text-slate-400" />
              <span className="font-medium text-slate-800">{toName}</span>
            </div>
            {amountEditable ? (
              <div className="mt-3">
                <label htmlFor="settlement-amt" className="text-xs font-medium text-slate-500">
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
              <p className="mt-2 text-lg font-semibold text-blue-600">
                {formatCurrency(amount, currency)}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="settlement-label" className="text-sm font-medium text-slate-800">
              Label <span className="font-normal text-slate-400">(optional)</span>
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
            <p className="text-xs text-slate-500">
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
              {saving ? 'Saving…' : 'Record payment'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
