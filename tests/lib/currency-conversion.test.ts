import { describe, expect, it } from 'vitest'
import {
  allocateConvertedShares,
  convertAmount,
  convertLine,
  conversionForSave,
  describeRate,
  editTargetCurrency,
  formatLockedRate,
  isConvertedBill,
  isValidRate,
  paidInNote,
  rateFromDisplay,
  toCurrencyCode,
} from '@/lib/currency-conversion'

// Foreign-currency bills (079): a bill typed in VND/USD/... is stored in its BALANCE currency
// (PHP, or the group's) with the rate locked at save. Every expected number below is derived by
// hand from the agreed rule, not from the implementation:
//   item amount   = round2(A x rate)
//   shares        = computeSplits(A) in the paid-in currency, then re-allocated in integer cents
//                   proportionally to sum exactly to round2(sum(original shares) x rate),
//                   largest remainder, ties to the earliest index.
// The VND rate 0.00246385 is 1 / 405.868219 (open.er-api.com /v6/latest/PHP, rates.VND) to 6
// significant digits — the probe recorded in the brief.

const VND_PHP = 0.00246385
const USD_PHP = 56.3

const cents = (xs: number[]) => Math.round(xs.reduce((s, x) => s + x, 0) * 100)
const isWholeCents = (x: number) => Math.round(x * 100) / 100 === x

describe('isValidRate', () => {
  it('C6: accepts a finite positive number only', () => {
    expect(isValidRate(VND_PHP)).toBe(true)
    expect(isValidRate(USD_PHP)).toBe(true)
    expect(isValidRate(1e-9)).toBe(true)
  })

  it('C6: refuses zero, negatives, NaN, Infinity and non-numbers', () => {
    for (const bad of [0, -0, -1, -VND_PHP, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(isValidRate(bad), String(bad)).toBe(false)
    }
    for (const bad of ['0.5', '56.3', null, undefined, {}, [], true]) {
      expect(isValidRate(bad), JSON.stringify(bad)).toBe(false)
    }
  })
})

describe('convertAmount', () => {
  it('C1: 500000 VND at 0.00246385 is 1231.93 PHP (1231.925 rounds half up to the cent)', () => {
    expect(convertAmount(500000, VND_PHP)).toBe(1231.93)
  })

  it('C1: 250000 VND at 0.00246385 is 615.96 PHP (615.9625)', () => {
    expect(convertAmount(250000, VND_PHP)).toBe(615.96)
  })

  it('C4: 100 VND at 0.0123 is 1.23', () => {
    expect(convertAmount(100, 0.0123)).toBe(1.23)
  })

  it('C4: zero converts to zero and a rate of 1 is the identity', () => {
    expect(convertAmount(0, VND_PHP)).toBe(0)
    expect(convertAmount(123.45, 1)).toBe(123.45)
  })

  it('C5: 10 USD at 56.3 is 563 PHP, 2.5 USD is 140.75 PHP', () => {
    expect(convertAmount(10, USD_PHP)).toBe(563)
    expect(convertAmount(2.5, USD_PHP)).toBe(140.75)
  })
})

describe('allocateConvertedShares', () => {
  it('C4: three equal shares of 100 VND (33.34/33.33/33.33) at 0.0123 sum exactly to 1.23', () => {
    // cents: 123 x 33.34/100 = 41.008, 123 x 33.33/100 = 40.996 (x2) -> floors 41/40/40 = 121,
    // the two cents left go to the two largest remainders (index 1 and 2).
    const out = allocateConvertedShares([33.34, 33.33, 33.33], convertAmount(100, 0.0123))
    expect(out).toEqual([0.41, 0.41, 0.41])
    expect(cents(out)).toBe(123)
  })

  it('C4: a remainder tie goes to the earliest index', () => {
    // 10 cents over three equal shares: 3/3/3 and one cent left, tied -> index 0.
    expect(allocateConvertedShares([1, 1, 1], 0.1)).toEqual([0.04, 0.03, 0.03])
    expect(allocateConvertedShares([1, 1], 0.01)).toEqual([0.01, 0])
  })

  it('C4: a zero original share stays exactly 0 and the tie among the rest goes to the earliest', () => {
    // 101 cents over 0/50/50: 0, 50.5, 50.5 -> 0/50/50 and one cent to index 1.
    expect(allocateConvertedShares([0, 50, 50], 1.01)).toEqual([0, 0.51, 0.5])
  })

  it('C4: empty input returns []', () => {
    expect(allocateConvertedShares([], 0)).toEqual([])
    expect(allocateConvertedShares([], 12.34)).toEqual([])
  })

  it('C4: all-zero originals with a nonzero target put the whole target on index 0', () => {
    expect(allocateConvertedShares([0, 0, 0], 5)).toEqual([5, 0, 0])
  })

  it('C4: the target 1231.93 over two 250000 VND shares splits 615.97 / 615.96', () => {
    // 123193 cents / 2 = 61596.5 each -> 61596 + 61596, the cent left goes to index 0 (tie).
    expect(allocateConvertedShares([250000, 250000], 1231.93)).toEqual([615.97, 615.96])
  })

  it('C4: many uneven shares still sum EXACTLY to the target in whole cents', () => {
    // 1,000,000 VND over 7 people -> 142857.16 + 142857.14 x 6 (computeSplits equal rule).
    const originals = [142857.16, 142857.14, 142857.14, 142857.14, 142857.14, 142857.14, 142857.14]
    const target = convertAmount(1000000, VND_PHP)
    expect(target).toBe(2463.85)
    const out = allocateConvertedShares(originals, target)
    expect(out).toHaveLength(7)
    expect(cents(out)).toBe(246385)
    for (const x of out) expect(isWholeCents(x), String(x)).toBe(true)
    // Proportional: no share may stray more than a cent from its exact proportional value.
    const total = originals.reduce((s, x) => s + x, 0)
    originals.forEach((o, i) => {
      expect(Math.abs(out[i] - (o / total) * target)).toBeLessThanOrEqual(0.01)
    })
  })
})

describe('convertLine', () => {
  it('C1: an equal VND line converts the amount and the shares, keeping the original shares', () => {
    const out = convertLine(
      {
        amount: 500000,
        splits: [
          { userId: 'ME', splitType: 'equal', splitValue: 1 },
          { userId: 'FR', splitType: 'equal', splitValue: 1 },
        ],
      },
      VND_PHP,
    )
    expect(out.amount).toBe(1231.93)
    expect(out.originalAmount).toBe(500000)
    expect(out.splits).toEqual([
      { splitValue: 1, computedAmount: 615.97, originalAmount: 250000 },
      { splitValue: 1, computedAmount: 615.96, originalAmount: 250000 },
    ])
  })

  it('C5: a percentage line keeps split_value as the percentage', () => {
    const out = convertLine(
      {
        amount: 10,
        splits: [
          { userId: 'ME', splitType: 'percentage', splitValue: 60 },
          { userId: 'FR', splitType: 'percentage', splitValue: 40 },
        ],
      },
      USD_PHP,
    )
    expect(out.amount).toBe(563)
    expect(out.originalAmount).toBe(10)
    expect(out.splits).toEqual([
      { splitValue: 60, computedAmount: 337.8, originalAmount: 6 },
      { splitValue: 40, computedAmount: 225.2, originalAmount: 4 },
    ])
  })

  it('C5: a quantity line converts the UNIT price and keeps the quantities', () => {
    // 2.5 USD each, 3 + 1 -> shares 7.5 / 2.5 USD = 10 USD -> 563 PHP: 422.25 / 140.75.
    const out = convertLine(
      {
        amount: 2.5,
        splits: [
          { userId: 'ME', splitType: 'quantity', splitValue: 3 },
          { userId: 'FR', splitType: 'quantity', splitValue: 1 },
        ],
      },
      USD_PHP,
    )
    expect(out.amount).toBe(140.75)
    expect(out.originalAmount).toBe(2.5)
    expect(out.splits).toEqual([
      { splitValue: 3, computedAmount: 422.25, originalAmount: 7.5 },
      { splitValue: 1, computedAmount: 140.75, originalAmount: 2.5 },
    ])
  })

  it('C5: a custom line stores the converted share as split_value, and 0 ("auto") stays 0', () => {
    // 10 USD, ME typed 7, FR left on auto -> computeSplits gives 7 / 3 USD -> 394.10 / 168.90 PHP.
    const out = convertLine(
      {
        amount: 10,
        splits: [
          { userId: 'ME', splitType: 'custom', splitValue: 7 },
          { userId: 'FR', splitType: 'custom', splitValue: 0 },
        ],
      },
      USD_PHP,
    )
    expect(out.amount).toBe(563)
    expect(out.originalAmount).toBe(10)
    expect(out.splits).toEqual([
      { splitValue: 394.1, computedAmount: 394.1, originalAmount: 7 },
      { splitValue: 0, computedAmount: 168.9, originalAmount: 3 },
    ])
  })

  it('C4: a line with no splits converts its amount and returns no shares', () => {
    const out = convertLine({ amount: 500000, splits: [] }, VND_PHP)
    expect(out.amount).toBe(1231.93)
    expect(out.originalAmount).toBe(500000)
    expect(out.splits).toEqual([])
  })

  it('C4: converted shares of every line sum exactly to the converted line total', () => {
    const out = convertLine(
      {
        amount: 100,
        splits: [
          { userId: 'A', splitType: 'equal', splitValue: 1 },
          { userId: 'B', splitType: 'equal', splitValue: 1 },
          { userId: 'C', splitType: 'equal', splitValue: 1 },
        ],
      },
      0.0123,
    )
    expect(out.amount).toBe(1.23)
    expect(cents(out.splits.map((s) => s.computedAmount))).toBe(123)
    expect(out.splits.map((s) => s.originalAmount)).toEqual([33.34, 33.33, 33.33])
  })
})

describe('isConvertedBill', () => {
  // "Converted means converted everywhere": a bill is converted only when the bill row says so AND
  // every LIVE item carries its paid-in amount. An older build re-saving a converted bill sends the
  // stale bill columns beside fresh items without original_amount; that bill must read as plain, or
  // a re-save would multiply its balance amounts by the rate a second time.
  const bill = { original_currency: 'VND' as string | null }
  const item = (original_amount: number | null, is_deleted = false) => ({ original_amount, is_deleted })

  it('C29: original_currency set and every live item has original_amount -> converted', () => {
    expect(isConvertedBill(bill, [item(500000), item(120000)])).toBe(true)
  })

  it('C29: one live item without original_amount -> not converted', () => {
    expect(isConvertedBill(bill, [item(500000), item(null)])).toBe(false)
  })

  it('C29: only live items count — a retired item without original_amount does not unconvert', () => {
    expect(isConvertedBill(bill, [item(500000), item(null, true)])).toBe(true)
  })

  it('C29: no original_currency -> not converted, whatever the items say', () => {
    expect(isConvertedBill({ original_currency: null }, [item(500000)])).toBe(false)
    expect(isConvertedBill({ original_currency: null }, [item(null)])).toBe(false)
  })
})

describe('isConvertedBill with splits and currency codes (H8.2)', () => {
  const bill = { original_currency: 'VND' as string | null }
  const split = (original_amount: number | null, is_deleted = false) => ({ original_amount, is_deleted })

  it('every live split of a live item must carry original_amount', () => {
    expect(isConvertedBill(bill, [{ original_amount: 500000, splits: [split(250000), split(250000)] }])).toBe(true)
    expect(isConvertedBill(bill, [{ original_amount: 500000, splits: [split(250000), split(null)] }])).toBe(false)
  })

  it('a retired split, or the splits of a retired item, do not unconvert', () => {
    expect(isConvertedBill(bill, [{ original_amount: 500000, splits: [split(250000), split(null, true)] }])).toBe(true)
    expect(
      isConvertedBill(bill, [
        { original_amount: 500000, splits: [split(250000)] },
        { original_amount: null, is_deleted: true, splits: [split(null)] },
      ]),
    ).toBe(true)
  })

  it('an original_currency that is not a 3-letter upper-case code reads as unconverted', () => {
    for (const bad of ['', 'vnd', 'VN', 'VNDX', 'V$D', '<img src=x>']) {
      expect(isConvertedBill({ original_currency: bad }, [{ original_amount: 1 }]), bad).toBe(false)
    }
  })
})

describe('toCurrencyCode', () => {
  it('passes a 3-letter upper-case code and maps everything else to null', () => {
    expect(toCurrencyCode('VND')).toBe('VND')
    for (const bad of ['vnd', 'VN', 'VNDD', '', null, undefined, 5, {}]) {
      expect(toCurrencyCode(bad), String(bad)).toBeNull()
    }
  })
})

describe('formatLockedRate', () => {
  it('reads "1 PHP = 405.87 VND" for a cheap paid-in unit and "1 USD = 56.3 PHP" otherwise', () => {
    expect(formatLockedRate(VND_PHP, 'VND', 'PHP')).toBe('1 PHP = 405.87 VND')
    expect(formatLockedRate(USD_PHP, 'USD', 'PHP')).toBe('1 USD = 56.3 PHP')
  })

  it('keeps four decimals under 100 so a close-to-one rate is not rounded away', () => {
    expect(formatLockedRate(1.0123, 'EUR', 'USD')).toBe('1 EUR = 1.0123 USD')
  })
})

describe('paidInNote', () => {
  const converted = { originalCurrency: 'VND', originalTotal: 500000, exchangeRate: VND_PHP, currency: 'PHP' }

  it('reads "Paid in ₫500,000 · 1 PHP = 405.87 VND (locked)"', () => {
    expect(paidInNote(converted)).toBe('Paid in ₫500,000 · 1 PHP = 405.87 VND (locked)')
  })

  it('is null for an unconverted or unreadable bill', () => {
    expect(paidInNote({ ...converted, originalCurrency: null })).toBeNull()
    expect(paidInNote({ ...converted, originalTotal: null })).toBeNull()
    expect(paidInNote({ ...converted, exchangeRate: null })).toBeNull()
    expect(paidInNote({ ...converted, exchangeRate: 0 })).toBeNull()
    expect(paidInNote({ ...converted, originalCurrency: 'vnd' })).toBeNull()
  })
})

describe('conversionForSave', () => {
  it('no paid-in currency, or the balance currency itself, is not a conversion', () => {
    expect(conversionForSave({ paidInCurrency: null, targetCurrency: 'PHP', rate: null, source: 'manual' })).toBeNull()
    expect(conversionForSave({ paidInCurrency: 'PHP', targetCurrency: 'PHP', rate: 3, source: 'online' })).toBeNull()
  })

  it('a foreign currency with a usable rate returns the conversion, source kept', () => {
    expect(conversionForSave({ paidInCurrency: 'VND', targetCurrency: 'PHP', rate: VND_PHP, source: 'online' })).toEqual({
      fromCurrency: 'VND',
      rate: VND_PHP,
      source: 'online',
    })
  })

  it('a foreign currency without a usable rate is invalid', () => {
    for (const rate of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(conversionForSave({ paidInCurrency: 'VND', targetCurrency: 'PHP', rate, source: 'manual' }), String(rate)).toBe('invalid')
    }
  })
})

describe('editTargetCurrency', () => {
  it('C30: editing keeps the bill\'s stored currency even after the group currency changed', () => {
    expect(editTargetCurrency({ editingBillCurrency: 'PHP', groupCurrency: 'USD' })).toBe('PHP')
  })

  it('C30: a new bill (nothing being edited) uses the group currency', () => {
    expect(editTargetCurrency({ editingBillCurrency: null, groupCurrency: 'USD' })).toBe('USD')
    expect(editTargetCurrency({ editingBillCurrency: undefined, groupCurrency: 'USD' })).toBe('USD')
    expect(editTargetCurrency({ editingBillCurrency: '', groupCurrency: 'USD' })).toBe('USD')
  })
})

describe('describeRate / rateFromDisplay', () => {
  it('C10: VND->PHP reads "1 PHP = 405.87 VND" (a paid-in unit is worth less than one balance unit)', () => {
    const d = describeRate(VND_PHP, 'VND', 'PHP')
    expect(d.base).toBe('PHP')
    expect(d.quote).toBe('VND')
    expect(d.value).toBeCloseTo(405.87, 2)
  })

  it('C10: USD->PHP reads "1 USD = 56.3 PHP"', () => {
    expect(describeRate(USD_PHP, 'USD', 'PHP')).toEqual({ base: 'USD', quote: 'PHP', value: 56.3 })
  })

  it('C10: a rate of exactly 1 is not "worth less", so it reads in the paid-in direction', () => {
    expect(describeRate(1, 'USD', 'PHP')).toEqual({ base: 'USD', quote: 'PHP', value: 1 })
  })

  it('C10: rateFromDisplay inverts a value typed in the balance-currency direction', () => {
    expect(rateFromDisplay(405.87, 'PHP', 'VND')).toBe(1 / 405.87)
  })

  it('C10: rateFromDisplay keeps a value typed in the paid-in direction as is', () => {
    expect(rateFromDisplay(56.3, 'USD', 'USD')).toBe(56.3)
  })

  it('C10: display -> rate -> display round-trips to the typed value', () => {
    const stored = rateFromDisplay(405.87, 'PHP', 'VND')
    const back = describeRate(stored, 'VND', 'PHP')
    expect(back.base).toBe('PHP')
    expect(back.value).toBeCloseTo(405.87, 9)

    const usd = rateFromDisplay(56.3, 'USD', 'USD')
    expect(describeRate(usd, 'USD', 'PHP').value).toBeCloseTo(56.3, 9)
  })
})
