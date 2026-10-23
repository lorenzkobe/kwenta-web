import { useEffect, useId, useRef, useState } from 'react'
import { RotateCw } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useExchangeRate } from '@/hooks/useExchangeRate'
import { CURRENCIES, currencyLabel } from '@/lib/currencies'
import {
  convertAmount,
  describeRate,
  formatLockedRate,
  isValidRate,
  paidInNote,
  rateFromDisplay,
  toCurrencyCode,
  type RateSource,
} from '@/lib/currency-conversion'
import { filterDecimalInput } from '@/lib/amount-input'
import { cn, formatCurrency } from '@/lib/utils'

/** What the bill forms keep for "paid in": the currency amounts are typed in and its locked-at-save rate. */
export interface ConversionValue {
  currency: string
  rate: number | null
  source: RateSource
}

interface CurrencyConversionFieldProps {
  /** The bill's balance currency (a group's currency, or the personal bill's). */
  targetCurrency: string
  value: ConversionValue
  onChange: (value: ConversionValue) => void
  /** The bill total as typed, in `value.currency`, for the preview. */
  total: number
  /** The rate a bill being edited was saved with. */
  saved?: (ConversionValue & { rate: number }) | null
}

// A displayed rate is rounded; an external change smaller than this reads as the same rate.
const SAME_RATE_TOLERANCE = 1e-4

function sameRate(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= Math.abs(b) * SAME_RATE_TOLERANCE
}

function rateText(displayValue: number): string {
  return String(Number(displayValue.toPrecision(6)))
}

// A typed rate this many times above or below today's is almost always the direction typed backwards.
const FAR_FROM_TODAY_RATIO = 5

function ageText(fetchedAt: string, nowMs: number): string {
  const hours = Math.floor((nowMs - Date.parse(fetchedAt)) / 3_600_000)
  if (hours < 1) return 'less than an hour ago'
  if (hours < 24) return `${hours} h ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function clockText(fetchedAt: string): string {
  return new Date(fetchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}

export function CurrencyConversionField({
  targetCurrency,
  value,
  onChange,
  total,
  saved = null,
}: CurrencyConversionFieldProps) {
  const selectId = useId()
  const rateId = useId()
  const converting = value.currency !== targetCurrency
  const { live, loading, refreshing, refreshFailed, refresh } = useExchangeRate(value.currency, targetCurrency)

  // The age of a cached rate is read against when the form opened, so a render never reads the clock.
  const [mountedAt] = useState(() => Date.now())
  const [text, setText] = useState('')
  const [displayBase, setDisplayBase] = useState(value.currency)

  const typedValue = parseFloat(text)
  const typedRate = isValidRate(typedValue) ? rateFromDisplay(typedValue, displayBase, value.currency) : null
  const baseInPair = displayBase === value.currency || displayBase === targetCurrency
  if (!baseInPair || !sameRate(typedRate, value.rate)) {
    // The rate changed from outside (a prefill, "Use this", a loaded bill): show it in the
    // direction people say it, without echoing the user's own keystrokes back at them.
    if (value.rate === null) {
      setText('')
      setDisplayBase(value.currency)
    } else {
      const shown = describeRate(value.rate, value.currency, targetCurrency)
      setText(rateText(shown.value))
      setDisplayBase(shown.base)
    }
  }

  const isSaved = saved !== null && saved.currency === value.currency && sameRate(saved.rate, value.rate)

  // Judged when a new rate lands, not when Refresh is tapped: a rate typed (or a saved one restored)
  // while the request runs must survive it. Only a field still showing the previous live rate follows.
  const previousLiveRate = useRef<number | null>(null)
  useEffect(() => {
    const previous = previousLiveRate.current
    previousLiveRate.current = live?.rate ?? null
    if (!converting || value.source !== 'online' || !live || sameRate(value.rate, live.rate)) return
    if (value.rate === null || (!isSaved && previous !== null && sameRate(value.rate, previous))) {
      onChange({ ...value, rate: live.rate, source: 'online' })
    }
  }, [converting, value, live, isSaved, onChange])

  const quote = displayBase === value.currency ? targetCurrency : value.currency
  const fetching = loading || refreshing
  const showToday = converting && live !== null && !sameRate(live.rate, value.rate)
  const farFromToday =
    converting &&
    live !== null &&
    isValidRate(value.rate) &&
    (value.rate > live.rate * FAR_FROM_TODAY_RATIO || value.rate < live.rate / FAR_FROM_TODAY_RATIO)
  const options = CURRENCIES.some((c) => c.code === value.currency)
    ? CURRENCIES
    : [...CURRENCIES, { code: value.currency, name: '' }]

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={selectId} className="text-sm font-medium">
        Paid in
      </label>
      <Select
        value={value.currency}
        onValueChange={(currency) =>
          // Coming back to the currency the bill was saved in restores its rate: an edit never drifts it.
          onChange(
            saved && saved.currency === currency
              ? { currency, rate: saved.rate, source: saved.source }
              : { currency, rate: null, source: 'online' },
          )
        }
      >
        <SelectTrigger id={selectId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((c) => (
            <SelectItem key={c.code} value={c.code}>
              {currencyLabel(c.code)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {converting && (
        <div className="space-y-2 rounded-xl border border-teal-800/20 bg-teal-800/5 p-3">
          <label htmlFor={rateId} className="text-xs font-medium text-stone-600">
            {isSaved ? 'Saved rate (locked when the bill was saved)' : 'Exchange rate (locked when you save)'}
          </label>
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-sm text-stone-700">1 {displayBase} =</span>
            <Input
              id={rateId}
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={text}
              onChange={(e) => {
                const next = filterDecimalInput(e.target.value)
                setText(next)
                const typed = parseFloat(next)
                onChange({
                  ...value,
                  rate: isValidRate(typed) ? rateFromDisplay(typed, displayBase, value.currency) : null,
                  source: 'manual',
                })
              }}
              className="min-w-0 flex-1"
            />
            <span className="shrink-0 text-sm text-stone-700">{quote}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-10 w-10 shrink-0 disabled:opacity-90"
              aria-label={fetching ? 'Fetching rate…' : 'Refresh rate'}
              aria-busy={fetching}
              title="Refresh rate"
              disabled={fetching}
              onClick={refresh}
            >
              <RotateCw aria-hidden className={cn('size-4', fetching && 'animate-spin motion-reduce:animate-none')} />
            </Button>
          </div>

          {isValidRate(value.rate) && total > 0 && (
            <p className="text-sm text-stone-700">
              ≈{' '}
              <span className="font-semibold text-teal-800">
                {formatCurrency(convertAmount(total, value.rate), targetCurrency)}
              </span>
            </p>
          )}

          {farFromToday && (
            <p className="text-xs text-amber-600">
              This is far from today&apos;s rate — check the direction.
            </p>
          )}

          {!refreshing && live?.fromCache && (
            <p className="text-xs text-amber-600">Rate from {ageText(live.fetchedAt, mountedAt)}</p>
          )}
          {!refreshing && live && !live.fromCache && (
            <p className="text-xs text-stone-500">Rate updated {clockText(live.fetchedAt)}</p>
          )}

          {showToday && live && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-xs text-stone-500">
                Today: {formatLockedRate(live.rate, value.currency, targetCurrency)}
              </p>
              <Button
                type="button"
                variant="outline"
                className="h-11 rounded-lg px-4 text-xs"
                onClick={() => onChange({ ...value, rate: live.rate, source: 'online' })}
              >
                Use this
              </Button>
            </div>
          )}

          {loading && <p className="text-xs text-stone-500">Fetching today&apos;s rate…</p>}
          {!loading && live === null && (
            <p className="text-xs text-stone-500">
              Today&apos;s rate isn&apos;t available right now. Type the rate you want to use.
            </p>
          )}
          {!loading && !isValidRate(value.rate) && (
            <p className="text-xs text-amber-600">Enter an exchange rate to save this bill.</p>
          )}

          {refreshFailed && !refreshing && (
            <p className="text-xs text-amber-600">Couldn&apos;t get a newer rate. Try again in a moment.</p>
          )}
        </div>
      )}
    </div>
  )
}

/** "Paid in ₫500,000 · 1 PHP = 405.87 VND (locked)" for a converted bill; the rate is the one saved with it. */
export function PaidInSummary({
  balanceCurrency,
  originalCurrency,
  originalTotal,
  exchangeRate,
  className,
}: {
  balanceCurrency: string
  originalCurrency: string | null
  originalTotal: number | null
  exchangeRate: number | null
  className?: string
}) {
  const note = paidInNote({ currency: balanceCurrency, originalCurrency, originalTotal, exchangeRate })
  if (note === null) return null
  return <p className={className ?? 'text-xs text-stone-500'}>{note}</p>
}

/** The secondary line a list row shows under a converted bill's balance amount; nothing for a plain bill. */
export function OriginalAmountLine({
  currency,
  amount,
}: {
  currency: string | null
  amount: number | null
}) {
  const code = toCurrencyCode(currency)
  if (code === null || amount === null) return null
  return <p className="text-xs text-stone-400">{formatCurrency(amount, code)}</p>
}
