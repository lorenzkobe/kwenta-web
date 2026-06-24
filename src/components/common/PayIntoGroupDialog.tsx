import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { allocateLumpSum, type LumpSumMode, type OwedParty } from '@/lib/group-payments'
import { createBundledGroupSettlement } from '@/db/operations'
import { formatCurrency } from '@/lib/utils'

export function PayIntoGroupDialog({
  open,
  onOpenChange,
  groupId,
  currency,
  fromUserId,
  markedBy,
  owed,
  onRecorded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  currency: string
  fromUserId: string
  markedBy: string
  owed: OwedParty[]
  onRecorded: () => void
}) {
  const [mode, setMode] = useState<LumpSumMode>('equal')
  const [total, setTotal] = useState('')
  const [percentages, setPercentages] = useState<Record<string, string>>({})
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const totalNum = parseFloat(total.replace(',', '.')) || 0
  const pctNum = useMemo(
    () => Object.fromEntries(owed.map((p) => [p.userId, parseFloat(percentages[p.userId] ?? '') || 0])),
    [owed, percentages],
  )
  const customNum = useMemo(
    () => Object.fromEntries(owed.map((p) => [p.userId, parseFloat(customAmounts[p.userId] ?? '') || 0])),
    [owed, customAmounts],
  )

  const result = useMemo(
    () =>
      allocateLumpSum({
        mode,
        total: totalNum,
        owed,
        percentages: pctNum,
        customAmounts: customNum,
      }),
    [mode, totalNum, owed, pctNum, customNum],
  )

  async function handleSubmit() {
    if (result.allocations.length === 0) {
      toast.error('Nothing to pay — enter an amount.')
      return
    }
    setSaving(true)
    try {
      await createBundledGroupSettlement({
        groupId,
        fromUserId,
        recipients: result.allocations.map((a) => ({ toUserId: a.userId, amount: a.amount })),
        currency,
        markedBy,
        enforceCap: true,
      })
      if (result.unallocated > 0.005) {
        toast.warning(
          `${formatCurrency(result.unallocated, currency)} couldn't be applied — it would overpay.`,
        )
      }
      onRecorded()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not record payment.')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-60 flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={() => !saving && onOpenChange(false)}
        aria-hidden
      />
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <h2 className="text-base font-semibold">Pay into group</h2>
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
          <div className="flex gap-2">
            {(['equal', 'percentage', 'custom'] as LumpSumMode[]).map((m) => (
              <Button
                key={m}
                type="button"
                variant={mode === m ? 'default' : 'outline'}
                size="sm"
                onClick={() => setMode(m)}
                disabled={saving}
              >
                {m === 'equal' ? 'Equal' : m === 'percentage' ? 'Percentage' : 'Custom'}
              </Button>
            ))}
          </div>

          {mode !== 'custom' && (
            <Input
              inputMode="decimal"
              placeholder="Total amount"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              className="rounded-lg"
              disabled={saving}
            />
          )}

          {owed.length === 0 ? (
            <p className="py-4 text-center text-sm text-stone-400">
              You don&apos;t owe anyone in this group.
            </p>
          ) : (
            <ul className="space-y-2">
              {owed.map((p) => {
                const alloc = result.allocations.find((a) => a.userId === p.userId)?.amount ?? 0
                return (
                  <li key={p.userId} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-800">{p.name}</p>
                      <p className="text-xs text-stone-500">
                        You owe {formatCurrency(p.owed, currency)}
                      </p>
                    </div>
                    {mode === 'percentage' && (
                      <Input
                        className="w-20 rounded-lg"
                        inputMode="decimal"
                        placeholder="%"
                        value={percentages[p.userId] ?? ''}
                        onChange={(e) =>
                          setPercentages((s) => ({ ...s, [p.userId]: e.target.value }))
                        }
                        disabled={saving}
                      />
                    )}
                    {mode === 'custom' && (
                      <Input
                        className="w-28 rounded-lg"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={customAmounts[p.userId] ?? ''}
                        onChange={(e) =>
                          setCustomAmounts((s) => ({ ...s, [p.userId]: e.target.value }))
                        }
                        disabled={saving}
                      />
                    )}
                    {mode === 'equal' && (
                      <span className="text-sm font-semibold tabular-nums text-stone-800">
                        {formatCurrency(alloc, currency)}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          <p className="text-xs text-stone-500">
            Applying {formatCurrency(result.allocatedTotal, currency)}
            {result.unallocated > 0.005 &&
              ` · ${formatCurrency(result.unallocated, currency)} can't be applied (would overpay)`}
          </p>

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
              onClick={handleSubmit}
              disabled={saving || result.allocations.length === 0}
            >
              {saving ? 'Saving...' : 'Record payment'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
