import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchExchangeRate, readCachedExchangeRate } from '@/lib/exchange-rates'

// The online rate prefill (C9, C22). Shape of the provider's answer comes from the live probe in
// the brief: GET https://open.er-api.com/v6/latest/PHP -> { result: 'success', base_code: 'PHP',
// rates: { VND: 405.868219, ... } }, and an unsupported base -> { result: 'error',
// 'error-type': 'unsupported-code' }. The BASE is the balance currency (6+ significant digits)
// and the rate is inverted, because the direct VND quote carries only 4.
//
// fetchExchangeRate never throws: a rate is a convenience for the form, and nothing about saving a
// bill may depend on it (C21).

const NOW = Date.parse('2026-10-23T00:00:00.000Z')
const HOUR = 60 * 60 * 1000
const KEY = 'kwenta_fx_v1:VND:PHP'
const VND_PER_PHP = 405.868219

function okResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

const SUCCESS = { result: 'success', base_code: 'PHP', rates: { PHP: 1, VND: VND_PER_PHP, USD: 0.017761989 } }

function seedCache(rate: number, ageMs: number, key = KEY) {
  localStorage.setItem(key, JSON.stringify({ rate, fetchedAt: new Date(NOW - ageMs).toISOString() }))
}

const now = () => NOW

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('fetchExchangeRate', () => {
  it('C9: asks for base = the balance currency and returns 1 / rates[from]', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS))

    const live = await fetchExchangeRate('VND', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit | undefined]
    expect(String(url)).toBe('https://open.er-api.com/v6/latest/PHP')
    // The 8 s timeout is an AbortSignal handed to fetch.
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(live).not.toBeNull()
    expect(live!.rate).toBe(1 / VND_PER_PHP)
    expect(live!.fromCache).toBe(false)
    expect(live!.fetchedAt).toBe(new Date(NOW).toISOString())
  })

  it('C9: a fetched rate is cached under kwenta_fx_v1:{from}:{to}', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS))
    await fetchExchangeRate('VND', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch })

    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { rate: number; fetchedAt: string }
    expect(stored.rate).toBe(1 / VND_PER_PHP)
    expect(stored.fetchedAt).toBe(new Date(NOW).toISOString())

    const cached = readCachedExchangeRate('VND', 'PHP')
    expect(cached).toEqual({ rate: 1 / VND_PER_PHP, fetchedAt: new Date(NOW).toISOString(), fromCache: true })
  })

  it('C9/C22: a fresh cache (< 12 h) is returned without any network call', async () => {
    seedCache(0.0025, 11 * HOUR + 59 * 60 * 1000)
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS))

    const live = await fetchExchangeRate('VND', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(live).toEqual({
      rate: 0.0025,
      fetchedAt: new Date(NOW - (11 * HOUR + 59 * 60 * 1000)).toISOString(),
      fromCache: true,
    })
  })

  it('C22: at most one GET per currency pair per 12 h', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS))
    const f = fetchImpl as unknown as typeof fetch
    let t = NOW

    await fetchExchangeRate('VND', 'PHP', { now: () => t, fetchImpl: f })
    t = NOW + 6 * HOUR
    await fetchExchangeRate('VND', 'PHP', { now: () => t, fetchImpl: f })
    t = NOW + 12 * HOUR - 1
    await fetchExchangeRate('VND', 'PHP', { now: () => t, fetchImpl: f })
    expect(fetchImpl).toHaveBeenCalledTimes(1)

    // Past the window the rate is refreshed once more.
    t = NOW + 12 * HOUR + 1
    await fetchExchangeRate('VND', 'PHP', { now: () => t, fetchImpl: f })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('C9: the cache is per pair — a cached VND:PHP rate does not answer THB:PHP', async () => {
    seedCache(0.0025, HOUR)
    const fetchImpl = vi.fn(async () =>
      okResponse({ result: 'success', base_code: 'PHP', rates: { PHP: 1, THB: 0.58 } }),
    )

    const live = await fetchExchangeRate('THB', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(live!.rate).toBe(1 / 0.58)
    expect(live!.fromCache).toBe(false)
  })

  it('C9: a stale cache (12 h or more) is refetched', async () => {
    seedCache(0.0025, 12 * HOUR + 1)
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS))

    const live = await fetchExchangeRate('VND', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(live!.rate).toBe(1 / VND_PER_PHP)
    expect(live!.fromCache).toBe(false)
  })

  it('force: a fresh cache does not answer; one GET returns and caches the live rate', async () => {
    seedCache(0.0025, HOUR)
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS))

    const live = await fetchExchangeRate('VND', 'PHP', {
      now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      force: true,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(live).toEqual({ rate: 1 / VND_PER_PHP, fetchedAt: new Date(NOW).toISOString(), fromCache: false })
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({
      rate: 1 / VND_PER_PHP,
      fetchedAt: new Date(NOW).toISOString(),
    })
  })

  it('force: a failed fetch still falls back to the cache and leaves it as it was', async () => {
    seedCache(0.0025, HOUR)
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })

    const live = await fetchExchangeRate('VND', 'PHP', {
      now,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      force: true,
    })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(live).toEqual({ rate: 0.0025, fetchedAt: new Date(NOW - HOUR).toISOString(), fromCache: true })
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({
      rate: 0.0025,
      fetchedAt: new Date(NOW - HOUR).toISOString(),
    })
  })

  const failures: [string, () => Promise<Response>][] = [
    ['offline (fetch rejects)', async () => { throw new TypeError('Failed to fetch') }],
    ['a timeout (AbortSignal.timeout fires)', async () => { throw new DOMException('signal timed out', 'TimeoutError') }],
    ['a non-2xx answer', async () => okResponse({ result: 'error' }, 503)],
    ['a body that is not JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <') } }) as unknown as Response],
    ['unsupported-code', async () => okResponse({ result: 'error', 'error-type': 'unsupported-code' })],
    ['success without the requested currency', async () => okResponse({ result: 'success', rates: { PHP: 1 } })],
    ['a zero rate', async () => okResponse({ result: 'success', rates: { PHP: 1, VND: 0 } })],
    ['a negative rate', async () => okResponse({ result: 'success', rates: { PHP: 1, VND: -405.87 } })],
    ['a string rate', async () => okResponse({ result: 'success', rates: { PHP: 1, VND: '405.87' } })],
    ['rates missing entirely', async () => okResponse({ result: 'success' })],
    ['a null body', async () => okResponse(null)],
  ]

  for (const [label, impl] of failures) {
    it(`C9: ${label} with a stale cache returns the stale cache`, async () => {
      seedCache(0.0025, 30 * HOUR)
      const fetchImpl = vi.fn(impl)

      const live = await fetchExchangeRate('VND', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch })

      expect(fetchImpl).toHaveBeenCalledTimes(1)
      expect(live).toEqual({ rate: 0.0025, fetchedAt: new Date(NOW - 30 * HOUR).toISOString(), fromCache: true })
      // A failure never overwrites the last good rate.
      expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({
        rate: 0.0025,
        fetchedAt: new Date(NOW - 30 * HOUR).toISOString(),
      })
    })

    it(`C9: ${label} with no cache returns null and never throws`, async () => {
      const fetchImpl = vi.fn(impl)

      await expect(
        fetchExchangeRate('VND', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch }),
      ).resolves.toBeNull()
      expect(localStorage.getItem(KEY)).toBeNull()
    })
  }

  it('C9: a corrupt cache entry is treated as no cache', async () => {
    localStorage.setItem(KEY, '{not json')
    const fetchImpl = vi.fn(async () => { throw new TypeError('Failed to fetch') })

    await expect(
      fetchExchangeRate('VND', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).resolves.toBeNull()
    expect(readCachedExchangeRate('VND', 'PHP')).toBeNull()
  })

  it('C9: a cached entry with an invalid rate is not served', async () => {
    localStorage.setItem(KEY, JSON.stringify({ rate: 0, fetchedAt: new Date(NOW - HOUR).toISOString() }))
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS))

    const live = await fetchExchangeRate('VND', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(live!.rate).toBe(1 / VND_PER_PHP)
  })

  it('C9: from === to is rate 1 with no network call', async () => {
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS))

    const live = await fetchExchangeRate('PHP', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(fetchImpl).not.toHaveBeenCalled()
    expect(live?.rate).toBe(1)
  })

  it('C9: localStorage throwing on read and write is tolerated', async () => {
    // Stubbed as a whole: after an earlier test's restoreAllMocks, happy-dom's Storage no longer
    // routes getItem through a Storage.prototype spy, so a spy would not throw here.
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError: storage disabled')
      },
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    })
    const fetchImpl = vi.fn(async () => okResponse(SUCCESS))

    const live = await fetchExchangeRate('VND', 'PHP', { now, fetchImpl: fetchImpl as unknown as typeof fetch })

    expect(live!.rate).toBe(1 / VND_PER_PHP)
    expect(live!.fromCache).toBe(false)
    expect(() => readCachedExchangeRate('VND', 'PHP')).not.toThrow()
    expect(readCachedExchangeRate('VND', 'PHP')).toBeNull()
  })

  it('C9: without fetchImpl it uses the global fetch', async () => {
    const globalFetch = vi.fn(async () => okResponse(SUCCESS))
    vi.stubGlobal('fetch', globalFetch)

    const live = await fetchExchangeRate('VND', 'PHP', { now })

    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(live!.rate).toBe(1 / VND_PER_PHP)
  })
})

describe('readCachedExchangeRate', () => {
  it('C9: returns null when nothing is cached', () => {
    expect(readCachedExchangeRate('VND', 'PHP')).toBeNull()
  })

  it('C9: returns a stale entry too, marked fromCache (the caller decides freshness)', () => {
    seedCache(0.0025, 48 * HOUR)
    expect(readCachedExchangeRate('VND', 'PHP')).toEqual({
      rate: 0.0025,
      fetchedAt: new Date(NOW - 48 * HOUR).toISOString(),
      fromCache: true,
    })
  })
})
