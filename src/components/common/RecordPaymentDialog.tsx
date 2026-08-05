import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, Lock, X } from 'lucide-react'
import { toast } from 'sonner'
import { recordPersonPayment } from '@/db/operations'
import { normalizeAmountInput, stripLeadingZerosAmount } from '@/lib/amount-input'
import {
  allocatePersonPayment,
  clampPercentageEntry,
  rebalanceCustomAmounts,
  redistributePercentages,
  type PaymentBucket,
  type PersonSplitMode,
} from '@/lib/payment-allocation'
import { normalizePaymentMethod } from '@/lib/payment-method'
import { formatCurrency, isEffectivelyZero, MONEY_EPSILON, roundMoney } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PaymentMethodField } from '@/components/common/PaymentMethodField'

export type PaymentDirection = 'they_paid_me' | 'i_paid_them'

/** One context (personal or a shared group) with its signed pairwise net (+ they owe me). */
export interface PaymentContext {
  /** 'personal' or a groupId. */
  key: string
  label: string
  net: number
}

const MODES: { id: PersonSplitMode; label: string }[] = [
  { id: 'sequential', label: 'Auto' },
  { id: 'percentage', label: '%' },
  { id: 'custom', label: 'Custom' },
]

function parseAmount(s: string): number {
  const n = parseFloat(s.replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

const numeric = (s: string | undefined): number => {
  const n = parseAmount(s ?? '')
  return Number.isFinite(n) ? n : 0
}

/**
 * Keep at most `keys.length - 1` percentage fields pinned, dropping the oldest, so one field is
 * always free to absorb the remainder. Without this the user can pin every field and strand the
 * difference between their entries and the amount they typed, which is the state this dialog must
 * never reach — the typed amount is authoritative. The peso boxes get the same guarantee from
 * `rebalanceCustomAmounts`, which owns their pin order.
 */
function pinNewestPercentage(order: string[], key: string, keys: string[]): string[] {
  const next = order.filter((k) => keys.includes(k) && k !== key)
  next.push(key)
  return next.length === keys.length && keys.length > 1 ? next.slice(1) : next
}

export function RecordPaymentDialog({
  open,
  onOpenChange,
  meId,
  otherId,
  meName,
  otherName,
  currency,
  markedBy,
  contexts,
  defaultDirection,
  defaultAmount,
  title = 'Record a payment',
  onRecorded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  meId: string
  otherId: string
  meName: string
  otherName: string
  currency: string
  markedBy: string
  /** All contexts with a non-zero pairwise net (+ they owe me). */
  contexts: PaymentContext[]
  defaultDirection?: PaymentDirection
  /** Prefill amount (e.g. the full balance for "Settle up"). */
  defaultAmount?: number
  title?: string
  onRecorded: () => void
}) {
  const overallNet = useMemo(() => contexts.reduce((s, c) => s + c.net, 0), [contexts])
  const initialDirection: PaymentDirection =
    defaultDirection ?? (overallNet >= 0 ? 'they_paid_me' : 'i_paid_them')

  const [direction, setDirection] = useState<PaymentDirection>(initialDirection)
  const [amountStr, setAmountStr] = useState('')
  const [method, setMethod] = useState('')
  const [note, setNote] = useState('')
  const [mode, setMode] = useState<PersonSplitMode>('sequential')
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({})
  const [customPins, setCustomPins] = useState<string[]>([])
  const [percentages, setPercentages] = useState<Record<string, string>>({})
  const [pctPins, setPctPins] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  // True once the user manually taps a direction, so a late-loading `contexts` doesn't override it.
  const userPickedDirection = useRef(false)
  // True once we've seeded direction from a real (non-zero) net, so later background net changes
  // (e.g. a realtime update mid-edit) never silently flip the direction under the user.
  const directionSeeded = useRef(false)

  // Contexts owed in the chosen direction (they_paid_me → they owe me → net > 0).
  //
  // Ordered Personal first, then groups by name. In `sequential` mode the ORDER decides which
  // context clears first and where an overpayment lands, and the server's group list carries no
  // ORDER BY (`kwenta_pairwise_breakdown`, migration 053), so an unsorted list would move a user's
  // money to a different context between two loads of the same screen.
  const eligible = useMemo(() => {
    const owedInDirection = contexts
      .filter((c) => (direction === 'they_paid_me' ? c.net > MONEY_EPSILON : c.net < -MONEY_EPSILON))
      .map((c) => ({ key: c.key, label: c.label, owed: roundMoney(Math.abs(c.net)) }))
    return owedInDirection.sort((a, b) => {
      if (a.key === 'personal') return -1
      if (b.key === 'personal') return 1
      return a.label.localeCompare(b.label)
    })
  }, [contexts, direction])

  const buckets = useMemo<PaymentBucket[]>(
    () => eligible.map((c) => ({ key: c.key, owed: c.owed })),
    [eligible],
  )
  const bucketKeys = useMemo(() => buckets.map((b) => b.key), [buckets])
  // Stable identity for effects that must re-seed only when the SET of contexts changes.
  const bucketSignature = bucketKeys.join('|')

  const owedTotal = useMemo(() => roundMoney(eligible.reduce((s, c) => s + c.owed, 0)), [eligible])

  const typedAmount = parseAmount(amountStr)
  const totalAmount = Number.isFinite(typedAmount) && typedAmount > 0 ? roundMoney(typedAmount) : 0

  // Reset the form whenever the dialog (re)opens or the counterparty changes.
  useEffect(() => {
    if (!open) return
    userPickedDirection.current = false
    directionSeeded.current = false
    setDirection(defaultDirection ?? (overallNet >= 0 ? 'they_paid_me' : 'i_paid_them'))
    setAmountStr(defaultAmount && defaultAmount > MONEY_EPSILON ? String(roundMoney(defaultAmount)) : '')
    setMethod('')
    setNote('')
    setMode('sequential')
    setCustomAmounts({})
    setCustomPins([])
    setPercentages({})
    setPctPins([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, otherId, defaultAmount, defaultDirection])

  // If `contexts` load AFTER the dialog opened (overallNet was 0 at mount), re-seed the default
  // direction from the now-known net — but exactly ONCE, and only from a real non-zero net, so a
  // later background net change never flips the direction under the user. Never overrides an
  // explicit prop or the user's own pick.
  useEffect(() => {
    if (!open || defaultDirection || userPickedDirection.current || directionSeeded.current) return
    if (Math.abs(overallNet) <= MONEY_EPSILON) return
    directionSeeded.current = true
    setDirection(overallNet >= 0 ? 'they_paid_me' : 'i_paid_them')
  }, [open, overallNet, defaultDirection])

  // Seed the custom boxes from the auto spread on entering custom mode, and RE-seed whenever the
  // total changes. Editing the amount after hand-splitting therefore starts the split over from a
  // sensible default rather than leaving stale entries that no longer add up.
  useEffect(() => {
    if (!open || mode !== 'custom') return
    const seeded = allocatePersonPayment({ mode: 'sequential', total: totalAmount, buckets })
    const byKey = Object.fromEntries(seeded.allocations.map((a) => [a.key, a.amount]))
    setCustomAmounts(Object.fromEntries(bucketKeys.map((k) => [k, String(byKey[k] ?? 0)])))
    setCustomPins([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, totalAmount, bucketSignature])

  // Default the percentage fields to an equal split when entering percentage mode.
  useEffect(() => {
    if (!open || mode !== 'percentage' || bucketKeys.length === 0) return
    const next = redistributePercentages(bucketKeys, {})
    setPercentages(Object.fromEntries(bucketKeys.map((k) => [k, String(next[k])])))
    setPctPins([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, mode, bucketSignature])

  const customNumbers = useMemo(
    () => Object.fromEntries(bucketKeys.map((k) => [k, numeric(customAmounts[k])])),
    [bucketKeys, customAmounts],
  )
  const pctNumbers = useMemo(
    () => Object.fromEntries(bucketKeys.map((k) => [k, numeric(percentages[k])])),
    [bucketKeys, percentages],
  )

  const result = useMemo(
    () =>
      allocatePersonPayment({
        mode,
        total: totalAmount,
        buckets,
        percentages: pctNumbers,
        customAmounts: customNumbers,
      }),
    [mode, totalAmount, buckets, pctNumbers, customNumbers],
  )

  const allocatedByKey = useMemo(
    () => Object.fromEntries(result.allocations.map((a) => [a.key, a.amount])),
    [result],
  )

  if (!open) return null

  // With nothing owed in this direction there is no split to get wrong: the payment is still legal
  // (it puts the other person ahead) and `recordPersonPayment` files it as a single personal leg.
  const invalid =
    isEffectivelyZero(totalAmount) || (eligible.length > 0 && result.unassigned > MONEY_EPSILON)

  function handleCustomChange(key: string, raw: string) {
    const normalized = normalizeAmountInput(raw)
    const { amounts, pinnedOrder } = rebalanceCustomAmounts({
      total: totalAmount,
      buckets,
      pinnedOrder: customPins,
      current: customNumbers,
      editedKey: key,
      editedValue: numeric(normalized),
    })
    setCustomPins(pinnedOrder)
    setCustomAmounts((prev) => {
      const next = { ...prev }
      for (const k of bucketKeys) {
        // Keep the edited field's raw text so a half-typed "10." isn't rewritten mid-keystroke —
        // unless it was clamped, where showing the untouched entry would contradict the boxes.
        next[k] =
          k === key && Math.abs(amounts[k] - numeric(normalized)) <= MONEY_EPSILON
            ? normalized
            : String(amounts[k] ?? 0)
      }
      return next
    })
  }

  function handlePercentageChange(key: string, raw: string) {
    const nextPins = pinNewestPercentage(pctPins, key, bucketKeys)
    const otherPinnedSum = nextPins
      .filter((k) => k !== key)
      .reduce((s, k) => s + numeric(percentages[k]), 0)
    const clamped = clampPercentageEntry(parseAmount(raw) || 0, otherPinnedSum)
    const lockedValues: Record<string, number> = {}
    for (const k of nextPins) lockedValues[k] = k === key ? clamped : numeric(percentages[k])
    const next = redistributePercentages(bucketKeys, lockedValues)
    setPctPins(nextPins)
    setPercentages(Object.fromEntries(bucketKeys.map((k) => [k, String(next[k])])))
  }

  function handleUnlockPercentage(key: string) {
    const nextPins = pctPins.filter((k) => k !== key)
    const lockedValues: Record<string, number> = {}
    for (const k of nextPins) lockedValues[k] = numeric(percentages[k])
    const next = redistributePercentages(bucketKeys, lockedValues)
    setPctPins(nextPins)
    setPercentages(Object.fromEntries(bucketKeys.map((k) => [k, String(next[k])])))
  }

  async function handleSubmit() {
    if (invalid) return
    setSaving(true)
    try {
      await recordPersonPayment({
        meId,
        otherId,
        direction,
        totalAmount,
        allocations: result.allocations.map((a) => ({
          context: a.key === 'personal' ? ('personal' as const) : { groupId: a.key },
          amount: a.amount,
        })),
        currency,
        markedBy,
        method: normalizePaymentMethod(method),
        note: note.trim() || undefined,
      })
      onRecorded()
      onOpenChange(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not record the payment.')
    } finally {
      setSaving(false)
    }
  }

  const fromName = direction === 'they_paid_me' ? otherName : meName
  const toName = direction === 'they_paid_me' ? meName : otherName

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

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4">
          {/* Direction */}
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-stone-200 bg-white p-1">
            <button
              type="button"
              className={`rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
                direction === 'they_paid_me' ? 'bg-teal-800/10 text-teal-900' : 'text-stone-500 hover:text-stone-800'
              }`}
              onClick={() => {
                userPickedDirection.current = true
                setDirection('they_paid_me')
              }}
              disabled={saving}
            >
              {otherName} paid you
            </button>
            <button
              type="button"
              className={`rounded-lg px-2 py-2 text-xs font-medium transition-colors ${
                direction === 'i_paid_them' ? 'bg-teal-800/10 text-teal-900' : 'text-stone-500 hover:text-stone-800'
              }`}
              onClick={() => {
                userPickedDirection.current = true
                setDirection('i_paid_them')
              }}
              disabled={saving}
            >
              You paid {otherName}
            </button>
          </div>

          <div className="flex items-center justify-center gap-2 text-xs text-stone-500">
            <span className="truncate font-medium text-stone-700">{fromName}</span>
            <ArrowRight className="size-3.5 shrink-0 text-stone-400" />
            <span className="truncate font-medium text-stone-700">{toName}</span>
          </div>

          {/* Amount — authoritative in every mode; the split below always adds up to it. */}
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
            <label htmlFor="pay-amt" className="text-xs font-medium text-stone-500">
              Amount
            </label>
            <Input
              id="pay-amt"
              type="text"
              inputMode="decimal"
              autoFocus
              placeholder="0.00"
              value={amountStr}
              onChange={(e) => setAmountStr(normalizeAmountInput(e.target.value))}
              onBlur={() =>
                setAmountStr((s) => {
                  const next = stripLeadingZerosAmount(s)
                  return next === s ? s : next
                })
              }
              className="mt-1 rounded-lg text-lg font-semibold"
            />
            {owedTotal > MONEY_EPSILON && (
              <button
                type="button"
                className="mt-2 text-xs font-medium text-teal-800 hover:underline"
                onClick={() => setAmountStr(String(owedTotal))}
                disabled={saving}
              >
                Settle up · {formatCurrency(owedTotal, currency)}
              </button>
            )}
          </div>

          {/* Apply to */}
          {eligible.length > 0 ? (
            <div className="rounded-xl border border-stone-200 bg-white px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Apply to</p>
                {eligible.length > 1 && (
                  <div className="flex gap-0.5 rounded-lg bg-stone-100 p-0.5">
                    {MODES.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${
                          mode === m.id ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500 hover:text-stone-800'
                        }`}
                        onClick={() => setMode(m.id)}
                        disabled={saving}
                      >
                        {m.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ul className="mt-2 space-y-2">
                {eligible.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-800">{c.label}</p>
                      <p className="text-[11px] text-stone-400">owed {formatCurrency(c.owed, currency)}</p>
                    </div>
                    {mode === 'custom' && eligible.length > 1 ? (
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={customAmounts[c.key] ?? ''}
                        onChange={(e) => handleCustomChange(c.key, e.target.value)}
                        disabled={saving}
                        className="h-8 w-24 rounded-lg text-right text-sm"
                      />
                    ) : mode === 'percentage' && eligible.length > 1 ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-xs tabular-nums text-stone-500">
                          {formatCurrency(allocatedByKey[c.key] ?? 0, currency)}
                        </span>
                        {pctPins.includes(c.key) && (
                          <button
                            type="button"
                            onClick={() => handleUnlockPercentage(c.key)}
                            disabled={saving}
                            className="text-stone-400 transition-colors hover:text-stone-600"
                            title="Locked — tap to let this adjust automatically"
                          >
                            <Lock className="size-3.5" />
                          </button>
                        )}
                        <Input
                          type="text"
                          inputMode="decimal"
                          placeholder="%"
                          value={percentages[c.key] ?? ''}
                          onChange={(e) => handlePercentageChange(c.key, e.target.value)}
                          disabled={saving}
                          className="h-8 w-16 rounded-lg text-right text-sm"
                        />
                      </div>
                    ) : (
                      <span className="text-sm font-semibold text-stone-700">
                        {formatCurrency(allocatedByKey[c.key] ?? 0, currency)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {result.overBy > MONEY_EPSILON && (
                <p className="mt-2 text-[11px] text-amber-700">
                  {formatCurrency(result.overBy, currency)} more than owed — the extra flips the balance
                  the other way.
                </p>
              )}
              {result.unassigned > MONEY_EPSILON && (
                <p className="mt-2 text-[11px] text-amber-700">
                  {formatCurrency(result.unassigned, currency)} not assigned yet.
                </p>
              )}
            </div>
          ) : (
            <p className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-xs text-stone-500">
              Nothing is owed in this direction — this payment will put {toName} ahead (the balance flips).
            </p>
          )}

          {/* Method + note. Stacked rather than side-by-side now that the method carries chips. */}
          <div className="flex flex-col gap-3">
            <PaymentMethodField id="pay-method" value={method} onChange={setMethod} />
            <div className="flex flex-col gap-1">
              <label htmlFor="pay-note" className="text-xs font-medium text-stone-500">
                Note
              </label>
              <Input
                id="pay-note"
                type="text"
                placeholder="optional"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={120}
                className="rounded-lg"
              />
            </div>
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="outline" className="rounded-xl" disabled={saving} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="button" className="rounded-xl" disabled={saving || invalid} onClick={handleSubmit}>
              {saving ? 'Saving…' : `Record ${formatCurrency(totalAmount, currency)}`}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
