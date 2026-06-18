import { describe, expect, it } from 'vitest'
import {
  BILL_BACK_QUERY,
  billDetailBackPath,
  parseSafeAppPath,
  withBillBackQuery,
} from '@/lib/bill-navigation'

describe('parseSafeAppPath', () => {
  it('accepts an in-app path', () => {
    expect(parseSafeAppPath('/app/groups/abc')).toBe('/app/groups/abc')
  })

  it('decodes URL-encoded values', () => {
    expect(parseSafeAppPath('%2Fapp%2Fbills%2F123')).toBe('/app/bills/123')
  })

  it('rejects null/empty', () => {
    expect(parseSafeAppPath(null)).toBeNull()
    expect(parseSafeAppPath(undefined)).toBeNull()
    expect(parseSafeAppPath('')).toBeNull()
  })

  it('rejects paths outside /app/', () => {
    expect(parseSafeAppPath('/login')).toBeNull()
    expect(parseSafeAppPath('/app')).toBeNull()
  })

  it('rejects open-redirect style values', () => {
    expect(parseSafeAppPath('//evil.com')).toBeNull()
    expect(parseSafeAppPath('https://evil.com')).toBeNull()
    expect(parseSafeAppPath('/app//evil.com')).toBeNull()
    expect(parseSafeAppPath('/app/x:y')).toBeNull()
  })

  it('returns null on malformed encoding', () => {
    expect(parseSafeAppPath('%')).toBeNull()
  })
})

describe('billDetailBackPath', () => {
  it('prefers the back query param', () => {
    expect(
      billDetailBackPath({ backSearchParam: '/app/groups/g1', locationState: null }),
    ).toBe('/app/groups/g1')
  })

  it('falls back to location state backTo', () => {
    expect(
      billDetailBackPath({
        backSearchParam: null,
        locationState: { backTo: '/app/people/p1' },
      }),
    ).toBe('/app/people/p1')
  })

  it('ignores an unsafe location state backTo', () => {
    expect(
      billDetailBackPath({
        backSearchParam: null,
        locationState: { backTo: 'https://evil.com' },
      }),
    ).toBe('/app/bills')
  })

  it('defaults to the bills list', () => {
    expect(billDetailBackPath({ backSearchParam: null, locationState: null })).toBe(
      '/app/bills',
    )
  })
})

describe('withBillBackQuery', () => {
  it('appends the back query when target is safe and not the default list', () => {
    expect(withBillBackQuery('/app/bills/1', '/app/groups/g1')).toBe(
      `/app/bills/1?${BILL_BACK_QUERY}=${encodeURIComponent('/app/groups/g1')}`,
    )
  })

  it('uses & when the path already has a query', () => {
    const result = withBillBackQuery('/app/bills/1?x=1', '/app/groups/g1')
    expect(result).toContain('?x=1&')
    expect(result).toContain(`${BILL_BACK_QUERY}=`)
  })

  it('does not append for the default bills list target', () => {
    expect(withBillBackQuery('/app/bills/1', '/app/bills')).toBe('/app/bills/1')
  })

  it('does not append for an unsafe target', () => {
    expect(withBillBackQuery('/app/bills/1', 'https://evil.com')).toBe('/app/bills/1')
  })
})
