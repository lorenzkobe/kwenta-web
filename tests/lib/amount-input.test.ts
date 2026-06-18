import { describe, expect, it } from 'vitest'
import {
  filterDecimalInput,
  normalizeAmountInput,
  stripLeadingZerosAmount,
} from '@/lib/amount-input'

describe('filterDecimalInput', () => {
  it('keeps digits only', () => {
    expect(filterDecimalInput('12a3b')).toBe('123')
  })

  it('normalizes a comma to a dot', () => {
    expect(filterDecimalInput('12,5')).toBe('12.5')
  })

  it('keeps only the first decimal separator', () => {
    expect(filterDecimalInput('1.2.3')).toBe('1.23')
    expect(filterDecimalInput('1,2,3')).toBe('1.23')
    expect(filterDecimalInput('1.2,3')).toBe('1.23')
  })

  it('strips currency symbols and spaces', () => {
    expect(filterDecimalInput('$ 1 234.50')).toBe('1234.50')
  })

  it('returns empty string for non-numeric input', () => {
    expect(filterDecimalInput('abc')).toBe('')
  })
})

describe('stripLeadingZerosAmount', () => {
  it('returns empty for blank or lone dot', () => {
    expect(stripLeadingZerosAmount('')).toBe('')
    expect(stripLeadingZerosAmount('  ')).toBe('')
    expect(stripLeadingZerosAmount('.')).toBe('')
  })

  it('strips leading zeros from an integer', () => {
    expect(stripLeadingZerosAmount('0250')).toBe('250')
  })

  it('preserves a single zero', () => {
    expect(stripLeadingZerosAmount('0')).toBe('0')
  })

  it('keeps "0." meaningful while typing', () => {
    expect(stripLeadingZerosAmount('0.')).toBe('0.')
  })

  it('keeps a leading zero before a fraction', () => {
    expect(stripLeadingZerosAmount('0.5')).toBe('0.5')
    expect(stripLeadingZerosAmount('00.5')).toBe('0.5')
  })

  it('keeps the fractional part intact', () => {
    expect(stripLeadingZerosAmount('012.340')).toBe('12.340')
  })
})

describe('normalizeAmountInput', () => {
  it('filters then strips leading zeros', () => {
    expect(normalizeAmountInput('0a2,5')).toBe('2.5')
  })

  it('prevents values like "0250"', () => {
    expect(normalizeAmountInput('0250')).toBe('250')
  })

  it('produces a clean fractional value from messy input', () => {
    expect(normalizeAmountInput('00,75')).toBe('0.75')
  })
})
