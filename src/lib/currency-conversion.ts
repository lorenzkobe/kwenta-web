import { computeSplits, type SplitInput } from '@/lib/splits'
import { formatCurrency, roundMoney } from '@/lib/utils'

export type RateSource = 'online' | 'manual'

/** `rate` is balance-currency units per ONE `fromCurrency` unit. */
export interface BillConversion {
  fromCurrency: string
  rate: number
  source: RateSource
}

export function isValidRate(rate: unknown): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0
}

export function convertAmount(amount: number, rate: number): number {
  return roundMoney(amount * rate)
}

/**
 * Re-allocates `targetTotal` over shares proportional to `originalShares`, in integer cents with
 * the largest remainder (ties to the earliest index), so the result sums EXACTLY to the target.
 * BigInt keeps the cents products exact for amounts like 1,000,000,000 VND.
 */
export function allocateConvertedShares(originalShares: number[], targetTotal: number): number[] {
  if (originalShares.length === 0) return []
  const original = originalShares.map((s) => BigInt(Math.round(s * 100)))
  const target = BigInt(Math.round(targetTotal * 100))
  const originalTotal = original.reduce((sum, c) => sum + c, 0n)
  if (originalTotal <= 0n) return originalShares.map((_, i) => Number(i === 0 ? target : 0n) / 100)

  const floors = original.map((c) => (c * target) / originalTotal)
  const remainders = original.map((c) => (c * target) % originalTotal)
  let leftover = target - floors.reduce((sum, c) => sum + c, 0n)
  const byRemainder = remainders
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1))
  for (const { i } of byRemainder) {
    if (leftover <= 0n) break
    floors[i] += 1n
    leftover -= 1n
  }
  return floors.map((c) => Number(c) / 100)
}

export function convertLine(
  line: { amount: number; splits: SplitInput[] },
  rate: number,
): {
  amount: number
  originalAmount: number
  splits: { splitValue: number; computedAmount: number; originalAmount: number }[]
} {
  const originalShares = computeSplits(line.amount, line.splits).map((s) => roundMoney(s.computedAmount))
  const converted = allocateConvertedShares(
    originalShares,
    convertAmount(roundMoney(originalShares.reduce((sum, s) => sum + s, 0)), rate),
  )
  return {
    amount: convertAmount(line.amount, rate),
    originalAmount: line.amount,
    splits: line.splits.map((s, i) => ({
      // A custom split_value is a money amount; 0 means "auto" and stays 0.
      splitValue: s.splitType === 'custom' && s.splitValue > 0 ? converted[i] : s.splitValue,
      computedAmount: converted[i],
      originalAmount: originalShares[i],
    })),
  }
}

/** A stored or fetched currency value that is not a 3-letter code reads as absent, never as a code to format. */
export function toCurrencyCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : null
}

/**
 * A bill is converted only when the bill row names a valid paid-in currency AND every live item
 * and every live split under it carries its paid-in amount. An older build re-saving a converted
 * bill sends the stale bill columns beside rows without `original_amount`; reading that bill as
 * converted would multiply its balance amounts by the rate a second time on the next save.
 */
export function isConvertedBill(
  bill: { original_currency: string | null },
  items: {
    original_amount: number | null
    is_deleted?: boolean
    splits?: { original_amount: number | null; is_deleted?: boolean }[]
  }[],
): boolean {
  return (
    toCurrencyCode(bill.original_currency) !== null &&
    items.every(
      (i) =>
        i.is_deleted ||
        (i.original_amount != null && (i.splits ?? []).every((s) => s.is_deleted || s.original_amount != null)),
    )
  )
}

/** "1 PHP = 405.87 VND" when a paid-in unit is worth less than one balance unit, else "1 USD = 56.3 PHP". */
export function describeRate(
  rate: number,
  fromCurrency: string,
  toCurrency: string,
): { base: string; quote: string; value: number } {
  return rate < 1
    ? { base: toCurrency, quote: fromCurrency, value: 1 / rate }
    : { base: fromCurrency, quote: toCurrency, value: rate }
}

export function rateFromDisplay(value: number, displayBase: string, fromCurrency: string): number {
  return displayBase === fromCurrency ? value : 1 / value
}

/** "1 PHP = 405.87 VND" — the rate as people say it. */
export function formatLockedRate(rate: number, fromCurrency: string, toCurrency: string): string {
  const shown = describeRate(rate, fromCurrency, toCurrency)
  const value = shown.value.toLocaleString('en-US', { maximumFractionDigits: shown.value >= 100 ? 2 : 4 })
  return `1 ${shown.base} = ${value} ${shown.quote}`
}

/** "Paid in ₫500,000 · 1 PHP = 405.87 VND (locked)" for a converted bill; null when unconverted or unreadable. */
export function paidInNote(bill: {
  originalCurrency: string | null
  originalTotal: number | null
  exchangeRate: number | null
  currency: string
}): string | null {
  const paidIn = toCurrencyCode(bill.originalCurrency)
  if (paidIn === null || bill.originalTotal === null || !isValidRate(bill.exchangeRate)) return null
  return `Paid in ${formatCurrency(bill.originalTotal, paidIn)} · ${formatLockedRate(bill.exchangeRate, paidIn, bill.currency)} (locked)`
}

/**
 * What a bill form hands to createBill/updateBill: null when it is entered in the balance
 * currency, 'invalid' when it is entered in another currency without a usable rate.
 */
export function conversionForSave(input: {
  paidInCurrency: string | null
  targetCurrency: string
  rate: number | null
  source: RateSource
}): BillConversion | null | 'invalid' {
  if (input.paidInCurrency === null || input.paidInCurrency === input.targetCurrency) return null
  if (!isValidRate(input.rate)) return 'invalid'
  return { fromCurrency: input.paidInCurrency, rate: input.rate, source: input.source }
}

/** Editing keeps the bill's stored currency (the group's may have changed since); a new bill uses the group's. */
export function editTargetCurrency(input: {
  editingBillCurrency: string | null | undefined
  groupCurrency: string
}): string {
  return input.editingBillCurrency || input.groupCurrency
}
