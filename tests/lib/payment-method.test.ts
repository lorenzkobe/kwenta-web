import { describe, expect, it } from 'vitest'
import {
  normalizePaymentMethod,
  PAYMENT_METHOD_MAX_LENGTH,
  PAYMENT_METHOD_PRESETS,
} from '@/lib/payment-method'

describe('normalizePaymentMethod', () => {
  it('keeps a real method, trimmed', () => {
    expect(normalizePaymentMethod('GCash')).toBe('GCash')
    expect(normalizePaymentMethod('  GoTyme  ')).toBe('GoTyme')
  })

  it('preserves the case the user typed', () => {
    // The presets are suggestions, not an enum — a bank the app has never heard of has to survive
    // exactly as entered.
    expect(normalizePaymentMethod('gcash')).toBe('gcash')
    expect(normalizePaymentMethod('Security Bank')).toBe('Security Bank')
  })

  it('collapses every empty form to null', () => {
    // Blank must not be distinguishable from absent: `''` would paint an empty tag on the payment
    // row, and it would make `method IS NULL` an unreliable test server-side.
    for (const value of ['', '   ', '\t\n', null, undefined]) {
      expect(normalizePaymentMethod(value)).toBeNull()
    }
  })

  it('caps at the column width so a paste cannot overflow the field', () => {
    const long = 'x'.repeat(PAYMENT_METHOD_MAX_LENGTH + 20)
    expect(normalizePaymentMethod(long)).toHaveLength(PAYMENT_METHOD_MAX_LENGTH)
  })

  it('leaves every preset unchanged, so a chip round-trips exactly', () => {
    for (const preset of PAYMENT_METHOD_PRESETS) {
      expect(normalizePaymentMethod(preset)).toBe(preset)
    }
  })
})
