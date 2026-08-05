import { useEffect, useMemo, useRef, useState } from 'react'
import { Lock, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  allocateLumpSum,
  clampPercentageEntry,
  clampToOwed,
  owedPartiesFromBreakdown,
  redistributePercentages,
  type LumpSumMode,
  type OwedParty,
} from '@/lib/payment-allocation'
import { createBundledGroupSettlement } from '@/db/operations'
import { loadGroupMemberBreakdownFresh } from '@/api/balances'
import { describeError, formatCurrency } from '@/lib/utils'

export interface PayIntoGroupMember {
  userId: string
  name: string
  isCurrentUser: boolean
}

export function PayIntoGroupDialog({
  open,
  onOpenChange,
  groupId,
  currency,
  currentUserId,
  members,
  onRecorded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  groupId: string
  currency: string
  /** The signed-in user — defaults as payer and is always recorded as `markedBy`. */
  currentUserId: string
  members: PayIntoGroupMember[]
  onRecorded: () => void
}) {
  const [payerId, setPayerId] = useState(currentUserId)
  const [owed, setOwed] = useState<OwedParty[]>([])
  const [loadingOwed, setLoadingOwed] = useState(false)
  const [mode, setMode] = useState<LumpSumMode>('equal')
  const [total, setTotal] = useState('')
  const [note, setNote] = useState('')
  const [percentages, setPercentages] = useState<Record<string, string>>({})
  // Percentage fields the user has explicitly edited — held fixed while unlocked fields absorb changes.
  const [lockedPct, setLockedPct] = useState<Set<string>>(new Set())
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const recomputeToken = useRef(0)

  // Payer picker: current user pinned first (with a "You" marker), then everyone else.
  const payerOptions = useMemo(() => {
    const me = members.filter((m) => m.isCurrentUser)
    const others = members.filter((m) => !m.isCurrentUser)
    return [...me, ...others]
  }, [members])
  const payerName = members.find((m) => m.userId === payerId)?.name ?? 'this member'
  const isPayerMe = payerId === currentUserId

  // Reset the payer to the signed-in user each time the dialog opens.
  useEffect(() => {
    if (open) setPayerId(currentUserId)
  }, [open, currentUserId])

  // Recompute who the selected payer owes whenever the payer (or dialog visibility) changes.
  // The owed list is the payer's pairwise "pays" slice; switching payers clears stale inputs.
  useEffect(() => {
    if (!open) return
    const token = ++recomputeToken.current
    setLoadingOwed(true)
    setMode('equal')
    setTotal('')
    setNote('')
    setPercentages({})
    setLockedPct(new Set())
    setCustomAmounts({})
    void (async () => {
      try {
        // Uncached on purpose, and the same loader the write guard uses. These amounts are not
        // a display: they seed the payment inputs and the per-recipient overpayment clamps, so a
        // cached copy would let the user pay against a balance that has already been settled —
        // and `createBundledGroupSettlement` skips its cap when it cannot reach the server, so
        // nothing downstream would catch it.
        const data = await loadGroupMemberBreakdownFresh(groupId, payerId)
        if (token !== recomputeToken.current) return
        setOwed(owedPartiesFromBreakdown(data))
      } catch (err) {
        if (token !== recomputeToken.current) return
        // An empty owed list disables the whole form, so the user must be told why rather than
        // being shown a dialog that silently claims they owe no one.
        setOwed([])
        toast.error(describeError(err, 'Could not load who you owe in this group.'))
      } finally {
        if (token === recomputeToken.current) setLoadingOwed(false)
      }
    })()
  }, [open, payerId, groupId, currentUserId])

  const owedIds = useMemo(() => owed.map((p) => p.userId), [owed])

  // Default the percentage fields to an equal split (and clear locks) when entering percentage mode.
  useEffect(() => {
    if (mode !== 'percentage' || owedIds.length === 0) return
    const next = redistributePercentages(owedIds, {})
    setPercentages(Object.fromEntries(owedIds.map((id) => [id, String(next[id])])))
    setLockedPct(new Set())
  }, [mode, owedIds])

  // Editing a percentage locks that field; the remaining percent is redistributed across the
  // still-unlocked fields. The edit is clamped so the locked fields can never sum past 100.
  function handlePercentageChange(id: string, raw: string) {
    const parsed = parseFloat(raw.replace(',', '.')) || 0
    const otherLockedSum = [...lockedPct]
      .filter((x) => x !== id)
      .reduce((s, x) => s + (parseFloat(percentages[x] ?? '') || 0), 0)
    const clamped = clampPercentageEntry(parsed, otherLockedSum)
    const nextLocked = new Set(lockedPct).add(id)
    const lockedValues: Record<string, number> = {}
    nextLocked.forEach((lid) => {
      lockedValues[lid] = lid === id ? clamped : parseFloat(percentages[lid] ?? '') || 0
    })
    const next = redistributePercentages(owedIds, lockedValues)
    setPercentages(Object.fromEntries(owedIds.map((pid) => [pid, String(next[pid])])))
    setLockedPct(nextLocked)
  }

  // Unlock a field so it rejoins the auto-distributed pool.
  function handleUnlockPercentage(id: string) {
    const nextLocked = new Set(lockedPct)
    nextLocked.delete(id)
    const lockedValues: Record<string, number> = {}
    nextLocked.forEach((lid) => {
      lockedValues[lid] = parseFloat(percentages[lid] ?? '') || 0
    })
    const next = redistributePercentages(owedIds, lockedValues)
    setPercentages(Object.fromEntries(owedIds.map((pid) => [pid, String(next[pid])])))
    setLockedPct(nextLocked)
  }

  // Custom amounts are clamped to what the payer owes that person, so they can't overpay.
  function handleCustomChange(id: string, raw: string) {
    const parsed = parseFloat(raw.replace(',', '.'))
    if (Number.isNaN(parsed)) {
      setCustomAmounts((s) => ({ ...s, [id]: raw }))
      return
    }
    const owedAmt = owed.find((p) => p.userId === id)?.owed ?? 0
    const clamped = clampToOwed(parsed, owedAmt)
    setCustomAmounts((s) => ({ ...s, [id]: clamped < parsed ? String(clamped) : raw }))
  }

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
        fromUserId: payerId,
        recipients: result.allocations.map((a) => ({ toUserId: a.userId, amount: a.amount })),
        currency,
        markedBy: currentUserId,
        label: note.trim(),
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
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-stone-500">Who&apos;s paying?</label>
            <Select value={payerId} onValueChange={setPayerId} disabled={saving}>
              <SelectTrigger className="rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="z-70">
                {payerOptions.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {m.name}
                    {m.isCurrentUser ? ' (You)' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {loadingOwed ? (
            <div className="space-y-2 py-2">
              <div className="h-9 animate-pulse rounded-lg bg-stone-100" />
              <div className="h-9 animate-pulse rounded-lg bg-stone-100" />
            </div>
          ) : owed.length === 0 ? (
            <p className="py-4 text-center text-sm text-stone-400">
              {isPayerMe ? 'You don’t' : `${payerName} doesn’t`} owe anyone in this group.
            </p>
          ) : (
            <>
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

          <ul className="space-y-2">
              {owed.map((p) => {
                const alloc = result.allocations.find((a) => a.userId === p.userId)?.amount ?? 0
                return (
                  <li key={p.userId} className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-800">{p.name}</p>
                      <p className="text-xs text-stone-500">
                        {isPayerMe ? 'You owe' : 'Owes'} {formatCurrency(p.owed, currency)}
                      </p>
                    </div>
                    {mode === 'percentage' && (
                      <div className="flex items-center gap-1">
                        {lockedPct.has(p.userId) && (
                          <button
                            type="button"
                            onClick={() => handleUnlockPercentage(p.userId)}
                            disabled={saving}
                            className="text-stone-400 transition-colors hover:text-stone-600"
                            title="Locked — tap to let this adjust automatically"
                          >
                            <Lock className="size-3.5" />
                          </button>
                        )}
                        <Input
                          className="w-20 rounded-lg"
                          inputMode="decimal"
                          placeholder="%"
                          value={percentages[p.userId] ?? ''}
                          onChange={(e) => handlePercentageChange(p.userId, e.target.value)}
                          disabled={saving}
                        />
                      </div>
                    )}
                    {mode === 'custom' && (
                      <Input
                        className="w-28 rounded-lg"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={customAmounts[p.userId] ?? ''}
                        onChange={(e) => handleCustomChange(p.userId, e.target.value)}
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

          <p className="text-xs text-stone-500">
            Applying {formatCurrency(result.allocatedTotal, currency)}
            {result.unallocated > 0.005 &&
              ` · ${formatCurrency(result.unallocated, currency)} can't be applied (would overpay)`}
          </p>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-stone-500">Note (optional)</label>
            <Input
              placeholder="e.g. GCash reference, what it's for"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="rounded-lg"
              disabled={saving}
              maxLength={140}
            />
          </div>
            </>
          )}

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
