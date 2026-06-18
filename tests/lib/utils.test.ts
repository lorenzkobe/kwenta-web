import { beforeEach, describe, expect, it } from 'vitest'
import { cn, formatCurrency, generateId, getDeviceId, now, timeAgo } from '@/lib/utils'

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
