import { beforeEach, describe, expect, it } from 'vitest'
import {
  cn,
  formatCurrency,
  generateId,
  getDeviceId,
  isEffectivelyZero,
  MONEY_EPSILON,
  now,
  roundMoney,
  timeAgo,
} from '@/lib/utils'

describe('cn', () => {
  it('joins truthy class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values', () => {
    expect(cn('a', false && 'b', undefined, 'c')).toBe('a c')
  })

  it('resolves conflicting tailwind utilities, last one wins', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4')
  })
})

describe('generateId', () => {
  it('returns a v4-style uuid', () => {
    expect(generateId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  it('returns a unique value each call', () => {
    expect(generateId()).not.toBe(generateId())
  })
})

describe('getDeviceId', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('generates and persists a device id on first call', () => {
    const id = getDeviceId()
    expect(id).toBeTruthy()
    expect(localStorage.getItem('kwenta_device_id')).toBe(id)
  })

  it('returns the same id on subsequent calls', () => {
    expect(getDeviceId()).toBe(getDeviceId())
  })
})

describe('now', () => {
  it('returns a valid ISO timestamp', () => {
    const value = now()
    expect(new Date(value).toISOString()).toBe(value)
  })
})

describe('formatCurrency', () => {
  it('formats whole numbers with thousands grouping and no decimals', () => {
    expect(formatCurrency(1000)).toContain('1,000')
  })

  it('keeps up to two decimal places', () => {
    expect(formatCurrency(1234.56)).toContain('1,234.56')
  })

  it('respects an explicit currency code', () => {
    const result = formatCurrency(99, 'USD')
    expect(result).toContain('99')
    expect(result).toContain('$')
  })
})

describe('roundMoney', () => {
  it('rounds to two decimal places', () => {
    expect(roundMoney(1.005)).toBe(1)
    expect(roundMoney(1.006)).toBe(1.01)
    expect(roundMoney(1.234)).toBe(1.23)
    expect(roundMoney(1.235)).toBe(1.24)
  })

  it('collapses floating-point residue to clean cents', () => {
    expect(roundMoney(0.1 + 0.2)).toBe(0.3)
    expect(roundMoney(49.995 + 0.001)).toBe(50)
  })

  it('preserves sign for negatives', () => {
    expect(roundMoney(-2.345)).toBe(-2.35)
    expect(roundMoney(-0.004)).toBe(-0)
  })
})

describe('isEffectivelyZero', () => {
  it('treats exact zero as zero', () => {
    expect(isEffectivelyZero(0)).toBe(true)
  })

  it('treats amounts within MONEY_EPSILON of zero as zero', () => {
    expect(isEffectivelyZero(MONEY_EPSILON)).toBe(true)
    expect(isEffectivelyZero(-MONEY_EPSILON)).toBe(true)
    expect(isEffectivelyZero(0.004)).toBe(true)
  })

  it('treats amounts beyond MONEY_EPSILON as non-zero', () => {
    expect(isEffectivelyZero(0.006)).toBe(false)
    expect(isEffectivelyZero(-0.01)).toBe(false)
    expect(isEffectivelyZero(0.5)).toBe(false)
  })
})

describe('timeAgo', () => {
  const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString()

  it('reports "Just now" within the last minute', () => {
    expect(timeAgo(isoAgo(10 * 1000))).toBe('Just now')
  })

  it('reports minutes', () => {
    expect(timeAgo(isoAgo(5 * 60 * 1000))).toBe('5m ago')
  })

  it('reports hours', () => {
    expect(timeAgo(isoAgo(2 * 60 * 60 * 1000))).toBe('2h ago')
  })

  it('reports days', () => {
    expect(timeAgo(isoAgo(3 * 24 * 60 * 60 * 1000))).toBe('3d ago')
  })
})
