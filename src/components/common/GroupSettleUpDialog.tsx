import { useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { recordDecomposedSettlement } from '@/db/operations'
import type { SuggestedPayerGroup } from '@/lib/settlement'
import { formatCurrency } from '@/lib/utils'

export function GroupSettleUpDialog({
  open,
  onOpenChange,
  groupId,
  currency,
  markedBy,
  payer,
  onRecorded,
  onUsePayInto,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  currency: string
  /** Signed-in user; recorded as markedBy. */
  markedBy: string
  payer: SuggestedPayerGroup | null
  onRecorded: () => void
  onUsePayInto: () => void
}) {
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [showLegs, setShowLegs] = useState(false)

  if (!open || !payer) return null

  // A leg whose payer isn't the physical payer means the physical payer is covering it.
  const hasOnBehalf = payer.legs.some((l) => l.fromUserId !== payer.fromUserId)

  async function handleRecord() {
    if (!payer) return
    setSaving(true)
    try {
      await recordDecomposedSettlement({
        groupId,
        currency,
        markedBy,
        legs: payer.legs,
        label: note.trim() || undefined,
      })
      toast.success('Payment recorded')
      onRecorded()
      onOpenChange(false)
      setNote('')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not record payment.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-60 flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={() => !saving && onOpenChange(false)}
        aria-hidden
      />
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <h2 className="text-base font-semibold">Settle up</h2>
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
          <p className="text-sm text-stone-600">
            <span className="font-medium text-stone-800">{payer.fromName}</span> pays{' '}
            <span className="font-semibold text-teal-800">
              {formatCurrency(payer.total, currency)}
            </span>
          </p>

          <ul className="space-y-2">
            {payer.recipients.map((r) => (
              <li
                key={r.toUserId}
                className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-2.5 text-sm"
              >
                <span className="font-medium text-stone-800">{r.toName}</span>
                <span className="font-semibold text-stone-800">
                  {formatCurrency(r.amount, currency)}
                </span>
              </li>
            ))}
          </ul>

          {hasOnBehalf && (
            <div className="text-xs text-stone-500">
              <button
                type="button"
                className="font-medium text-teal-800 underline-offset-2 hover:underline"
                onClick={() => setShowLegs((s) => !s)}
              >
                {showLegs ? 'Hide' : 'How this settles'}
              </button>
              {showLegs && (
                <ul className="mt-2 space-y-1">
                  {payer.legs.map((l) => (
                    <li key={`${l.fromUserId}-${l.toUserId}`}>
                      •{' '}
                      {l.fromUserId === payer.fromUserId
                        ? payer.fromName
                        : (payer.recipients.find((r) => r.toUserId === l.fromUserId)?.toName ??
                          l.fromUserId)}{' '}
                      pays{' '}
                      {payer.recipients.find((r) => r.toUserId === l.toUserId)?.toName ?? l.toUserId}{' '}
                      {formatCurrency(l.amount, currency)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <Input
            placeholder="Add a note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            className="rounded-lg"
            disabled={saving}
          />

          <div className="flex flex-col gap-2">
            <Button
              type="button"
              variant="success"
              className="w-full rounded-xl"
              disabled={saving}
              onClick={() => void handleRecord()}
            >
              {saving ? 'Recording…' : 'Record payment'}
            </Button>
            <button
              type="button"
              className="text-center text-xs text-stone-500 underline-offset-2 hover:underline"
              disabled={saving}
              onClick={() => {
                onOpenChange(false)
                onUsePayInto()
              }}
            >
              Need to adjust amounts? Use Pay into group
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
