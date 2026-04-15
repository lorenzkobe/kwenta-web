import { useState, useEffect } from 'react'
import { ArrowRight, Trash2, X } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { toast } from 'sonner'
import { db } from '@/db/db'
import {
  deleteBundledPayment,
  deleteSettlement,
  updateBundledPaymentLabel,
  updateSettlement,
} from '@/db/operations'
import type { SettlementHistoryItem } from '@/lib/settlement'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { normalizeAmountInput, stripLeadingZerosAmount } from '@/lib/amount-input'
import { formatCurrency } from '@/lib/utils'

export function EditSettlementDialog({
  item,
  onClose,
  onSaved,
}: {
  item: SettlementHistoryItem
  onClose: () => void
  onSaved: () => void
}) {
  const { userId } = useCurrentUser()
  const [amountStr, setAmountStr] = useState(() => String(item.amount))
  const [label, setLabel] = useState(item.label ?? '')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false)

  useEffect(() => {
    setAmountStr(String(item.amount))
    setLabel(item.label ?? '')
  }, [item])

  const members = useLiveQuery(async () => {
    const [fromP, toP] = await Promise.all([
      db.profiles.get(item.fromUserId),
      db.profiles.get(item.toUserId),
    ])
    return {
      fromName: fromP?.display_name ?? '?',
      toName: toP?.display_name ?? '?',
    }
  }, [item.fromUserId, item.toUserId])

  async function handleSave() {
    if (!userId) return
    setSaving(true)
    try {
      if (item.isBundled && item.bundleId) {
        await updateBundledPaymentLabel(item.bundleId, { label: label.trim() }, userId)
      } else {
        const amount = parseFloat(amountStr.replace(',', '.'))
        if (!Number.isFinite(amount) || amount <= 0) return
        await updateSettlement(
          item.id,
          {
            fromUserId: item.fromUserId,
            toUserId: item.toUserId,
            amount,
            currency: item.currency,
            label: label.trim(),
          },
          userId,
        )
      }
      onSaved()
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not save payment changes.'
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  async function executeRemove() {
    if (!userId) return
    setDeleting(true)
    try {
      if (item.isBundled && item.bundleId) {
        await deleteBundledPayment(item.bundleId, userId)
      } else {
        await deleteSettlement(item.id, userId)
      }
      onSaved()
      onClose()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not remove payment right now.'
      toast.error(message)
    } finally {
      setDeleting(false)
    }
  }

  const invalidAmount =
    !amountStr.trim() ||
    !Number.isFinite(parseFloat(amountStr.replace(',', '.'))) ||
    parseFloat(amountStr.replace(',', '.')) <= 0

  return (
    <>
    <div className="fixed inset-0 z-60 flex items-end justify-center p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <h2 className="text-base font-semibold">Edit payment</h2>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
            <p className="text-xs font-medium text-stone-500">Payment direction</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium text-stone-800">{members?.fromName ?? '?'}</span>
              <ArrowRight className="size-3.5 text-stone-400" />
              <span className="font-medium text-stone-800">{members?.toName ?? '?'}</span>
            </div>
            <p className="mt-1 text-xs text-stone-400">Payer and receiver are fixed when editing.</p>
          </div>
          {item.isBundled ? (
            <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
              <p className="text-xs font-medium text-stone-500">Amount ({item.currency})</p>
              <p className="mt-1 text-lg font-semibold text-teal-800">
                {formatCurrency(item.amount, item.currency)}
              </p>
              <p className="mt-1 text-xs text-stone-500">
                Bundled payments keep amounts fixed. You can edit the label or remove the full payment.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <label htmlFor="edit-settlement-amount" className="text-sm font-medium text-stone-800">
                Amount ({item.currency})
              </label>
              <Input
                id="edit-settlement-amount"
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
                className="rounded-lg"
              />
            </div>
          )}

          <div className="flex flex-col gap-2">
            <label htmlFor="edit-settlement-label" className="text-sm font-medium text-stone-800">
              Label <span className="font-normal text-stone-400">(optional)</span>
            </label>
            <Input
              id="edit-settlement-label"
              type="text"
              placeholder="e.g. Cash, dinner"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={120}
              className="rounded-lg"
            />
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
            <Button
              variant="outline"
              className="order-2 w-full rounded-xl border-red-200 text-red-600 hover:bg-red-50 sm:order-1 sm:w-auto"
              type="button"
              onClick={() => setRemoveConfirmOpen(true)}
              disabled={deleting || saving}
            >
              <Trash2 className="size-3.5" />
              Remove
            </Button>
            <Button
              className="order-1 w-full rounded-xl sm:order-2 sm:min-w-32"
              onClick={handleSave}
              disabled={!userId || saving || deleting || (!item.isBundled && invalidAmount)}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>

    <ConfirmDialog
      open={removeConfirmOpen}
      onOpenChange={setRemoveConfirmOpen}
      title="Remove this payment?"
      description={
        item.isBundled
          ? 'This removes the whole bundled payment and all included recipient payments.'
          : 'Balances will update to match. You can record a new payment if needed.'
      }
      confirmLabel="Remove"
      variant="danger"
      onConfirm={executeRemove}
    />
    </>
  )
}
