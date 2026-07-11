import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRight, SlidersHorizontal, X } from 'lucide-react'
import { toast } from 'sonner'
import { recordPersonPayment } from '@/db/operations'
import { normalizeAmountInput, stripLeadingZerosAmount } from '@/lib/amount-input'
import { formatCurrency, isEffectivelyZero, MONEY_EPSILON, roundMoney } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export type PaymentDirection = 'they_paid_me' | 'i_paid_them'

/** One context (personal or a shared group) with its signed pairwise net (+ they owe me). */
export interface PaymentContext {
  /** 'personal' or a groupId. */
  key: string
  label: string
  net: number
}

function parseAmount(s: string): number {
  const n = parseFloat(s.replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}

/** Fill eligible contexts oldest/first up to what's owed; overflow flips the first one. */
function autoSpread(amount: number, eligible: { key: string; owed: number }[]): Record<string, number> {
  const out: Record<string, number> = {}
  let remaining = roundMoney(amount)
  for (const c of eligible) {
    const take = Math.min(remaining, c.owed)
    if (take > MONEY_EPSILON) out[c.key] = roundMoney(take)
    remaining = roundMoney(remaining - Math.max(take, 0))
  }
  if (remaining > MONEY_EPSILON && eligible.length > 0) {
    const k = eligible[0].key
    out[k] = roundMoney((out[k] ?? 0) + remaining)
  }
  return out
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
  const [customOn, setCustomOn] = useState(false)
  const [customAmounts, setCustomAmounts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  // True once the user manually taps a direction, so a late-loading `contexts` doesn't override it.
  const userPickedDirection = useRef(false)
  // True once we've seeded direction from a real (non-zero) net, so later background net changes
  // (e.g. a realtime update mid-edit) never silently flip the direction under the user.
  const directionSeeded = useRef(false)

  // Contexts owed in the chosen direction (they_paid_me → they owe me → net > 0).
  const eligible = useMemo(() => {
    return contexts
      .filter((c) => (direction === 'they_paid_me' ? c.net > MONEY_EPSILON : c.net < -MONEY_EPSILON))
      .map((c) => ({ key: c.key, label: c.label, owed: roundMoney(Math.abs(c.net)) }))
  }, [contexts, direction])

  const owedTotal = useMemo(() => roundMoney(eligible.reduce((s, c) => s + c.owed, 0)), [eligible])

  // Reset the form whenever the dialog (re)opens or the counterparty changes.
  useEffect(() => {
    if (!open) return
    userPickedDirection.current = false
    directionSeeded.current = false
    setDirection(defaultDirection ?? (overallNet >= 0 ? 'they_paid_me' : 'i_paid_them'))
    setAmountStr(defaultAmount && defaultAmount > MONEY_EPSILON ? String(roundMoney(defaultAmount)) : '')
    setMethod('')
    setNote('')
    setCustomOn(false)
    setCustomAmounts({})
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

  if (!open) return null

  const amount = parseAmount(amountStr)
  const autoAlloc = Number.isFinite(amount) && amount > 0 ? autoSpread(amount, eligible) : {}

  const effectiveAlloc: Record<string, number> = customOn
    ? Object.fromEntries(
        eligible.map((c) => {
          const v = parseAmount(customAmounts[c.key] ?? '')
          return [c.key, Number.isFinite(v) && v > 0 ? roundMoney(v) : 0]
        }),
      )
    : autoAlloc

  const totalApplied = roundMoney(
    Object.values(effectiveAlloc).reduce((s, v) => s + (v || 0), 0),
  )
  const totalAmount = customOn ? totalApplied : (Number.isFinite(amount) ? roundMoney(amount) : 0)
  const invalid = isEffectivelyZero(totalAmount)

  function toggleCustom() {
    if (!customOn) {
      // Seed custom inputs from the current auto spread so editing starts where auto left off.
      setCustomAmounts(
        Object.fromEntries(eligible.map((c) => [c.key, String(autoAlloc[c.key] ?? 0)])),
      )
    }
    setCustomOn((v) => !v)
  }

  async function handleSubmit() {
    if (invalid) return
    setSaving(true)
    try {
      const allocations = eligible
        .map((c) => ({
          context: c.key === 'personal' ? ('personal' as const) : { groupId: c.key },
          amount: effectiveAlloc[c.key] ?? 0,
        }))
        .filter((a) => a.amount > MONEY_EPSILON)
      await recordPersonPayment({
        meId,
        otherId,
        direction,
        totalAmount,
        allocations,
        currency,
        markedBy,
        method: method.trim() || null,
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

          {/* Amount */}
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
              value={customOn ? String(totalApplied) : amountStr}
              disabled={customOn}
              onChange={(e) => setAmountStr(normalizeAmountInput(e.target.value))}
              onBlur={() =>
                setAmountStr((s) => {
                  const next = stripLeadingZerosAmount(s)
                  return next === s ? s : next
                })
              }
              className="mt-1 rounded-lg text-lg font-semibold"
            />
            {owedTotal > MONEY_EPSILON && !customOn && (
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
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Apply to</p>
                {eligible.length > 1 && (
                  <button
                    type="button"
                    className={`flex items-center gap-1 text-xs font-medium ${customOn ? 'text-teal-800' : 'text-stone-500 hover:text-stone-800'}`}
                    onClick={toggleCustom}
                    disabled={saving}
                  >
                    <SlidersHorizontal className="size-3.5" />
                    {customOn ? 'Auto' : 'Choose split'}
                  </button>
                )}
              </div>
              <ul className="mt-2 space-y-2">
                {eligible.map((c) => (
                  <li key={c.key} className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-stone-800">{c.label}</p>
                      <p className="text-[11px] text-stone-400">owed {formatCurrency(c.owed, currency)}</p>
                    </div>
                    {customOn ? (
                      <Input
                        type="text"
                        inputMode="decimal"
                        value={customAmounts[c.key] ?? ''}
                        onChange={(e) =>
                          setCustomAmounts((m) => ({ ...m, [c.key]: normalizeAmountInput(e.target.value) }))
                        }
                        className="h-8 w-24 rounded-lg text-right text-sm"
                      />
                    ) : (
                      <span className="text-sm font-semibold text-stone-700">
                        {formatCurrency(effectiveAlloc[c.key] ?? 0, currency)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {!customOn && amount > owedTotal + MONEY_EPSILON && (
                <p className="mt-2 text-[11px] text-amber-700">
                  {formatCurrency(roundMoney(amount - owedTotal), currency)} more than owed — the extra flips
                  the balance the other way.
                </p>
              )}
            </div>
          ) : (
            <p className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 text-xs text-stone-500">
              Nothing is owed in this direction — this payment will put {toName} ahead (the balance flips).
            </p>
          )}

          {/* Method + note */}
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="pay-method" className="text-xs font-medium text-stone-500">
                Method
              </label>
              <Input
                id="pay-method"
                type="text"
                placeholder="Cash, GCash…"
                value={method}
                onChange={(e) => setMethod(e.target.value)}
                maxLength={40}
                className="mt-1 rounded-lg"
              />
            </div>
            <div>
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
                className="mt-1 rounded-lg"
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
