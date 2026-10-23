import { describe, expect, it } from 'vitest'
import { CURRENCIES, currencyLabel } from '@/lib/currencies'

// The one currency list both bill forms and the group form pick from (it replaces the two copies
// in AddBillPage and GroupDetailPage). The user asked for "not only VND": the trip currencies a
// PHP household meets in the region and the majors must all be there.

describe('CURRENCIES', () => {
  it('C23: PHP is the first option (the app\'s home currency)', () => {
    expect(CURRENCIES[0].code).toBe('PHP')
  })

  it('C23: includes VND and every regional and major currency in the agreed list', () => {
    const codes = new Set(CURRENCIES.map((c) => c.code))
    for (const code of [
      'PHP', 'VND', 'THB', 'JPY', 'KRW', 'SGD', 'MYR', 'IDR', 'TWD', 'HKD', 'CNY', 'USD', 'EUR',
      'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'INR', 'AED', 'SAR', 'QAR', 'KWD', 'BHD', 'TRY',
    ]) {
      expect(codes.has(code), code).toBe(true)
    }
  })

  it('C23: every code is a unique three-letter ISO code with a name', () => {
    const codes = CURRENCIES.map((c) => c.code)
    expect(new Set(codes).size).toBe(codes.length)
    for (const c of CURRENCIES) {
      expect(c.code).toMatch(/^[A-Z]{3}$/)
      expect(c.name.trim().length).toBeGreaterThan(0)
    }
  })
})

describe('currencyLabel', () => {
  it('C23: reads "CODE — Name"', () => {
    expect(currencyLabel('VND')).toBe('VND — Vietnamese Dong')
  })

  it('C23: an unknown code falls back to the code itself', () => {
    expect(currencyLabel('XYZ')).toBe('XYZ')
  })
})
