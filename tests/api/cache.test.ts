import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearApiCache, readCache, writeCache } from '@/api/cache'

/**
 * Replace `localStorage.setItem` for one test.
 *
 * Plain assignment is silently swallowed (happy-dom proxies writes on the Storage object) and
 * `vi.spyOn(Storage.prototype, ...)` is never consulted — either makes a "survives a failing
 * write" test pass without the failure path running at all. `defineProperty` on the instance is
 * what actually takes effect.
 */
function withFailingSetItem(impl: (k: string, v: string) => void, run: () => void) {
  const original = localStorage.setItem.bind(localStorage)
  Object.defineProperty(localStorage, 'setItem', { configurable: true, writable: true, value: impl })
  try {
    run()
  } finally {
    Object.defineProperty(localStorage, 'setItem', {
      configurable: true,
      writable: true,
      value: original,
    })
  }
}

describe('api response cache', () => {
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips a response with its fetch time', () => {
    writeCache('contacts', 'user-1', [{ peerId: 'p1' }], '2026-08-04T00:00:00.000Z')
    expect(readCache('contacts', 'user-1')).toEqual({
      data: [{ peerId: 'p1' }],
      fetchedAt: '2026-08-04T00:00:00.000Z',
    })
  })

  it('returns null for an endpoint that was never cached', () => {
    expect(readCache('overview', 'user-1')).toBeNull()
  })

  // Two users on one device must never see each other's cached balances.
  it('scopes entries per user', () => {
    writeCache('overview', 'user-1', { a: 1 }, '2026-08-04T00:00:00.000Z')
    expect(readCache('overview', 'user-2')).toBeNull()
  })

  it('treats a corrupt entry as absent rather than throwing into a render', () => {
    localStorage.setItem('kwenta_api_cache_v1:user-1:contacts', '{not json')
    expect(readCache('contacts', 'user-1')).toBeNull()
  })

  it('rejects an entry missing its fetch time', () => {
    localStorage.setItem('kwenta_api_cache_v1:user-1:contacts', JSON.stringify({ data: [] }))
    expect(readCache('contacts', 'user-1')).toBeNull()
  })

  // Safari private mode and an exhausted quota both throw on setItem. Losing the offline copy is
  // a degraded experience; letting it escape is a blank screen.
  it('survives a storage write that throws', () => {
    // Spy the localStorage INSTANCE, not Storage.prototype: in happy-dom the prototype spy is
    // never consulted, so a prototype-based mock lets this assertion pass without the failure
    // path ever running. Restore by hand too — `vi.restoreAllMocks()` does not put an instance
    // spy back here, and a leaked one makes every later test in the file throw.
    withFailingSetItem(
      () => {
        throw new Error('QuotaExceededError')
      },
      () => {
        expect(() => writeCache('contacts', 'user-1', [], '2026-08-04T00:00:00.000Z')).not.toThrow()
      },
    )
  })

  it('clears every cached endpoint but leaves unrelated keys alone', () => {
    writeCache('contacts', 'user-1', [1], '2026-08-04T00:00:00.000Z')
    writeCache('overview', 'user-2', [2], '2026-08-04T00:00:00.000Z')
    localStorage.setItem('kwenta_last_refresh', '2026-08-04T00:00:00.000Z')

    clearApiCache()

    expect(readCache('contacts', 'user-1')).toBeNull()
    expect(readCache('overview', 'user-2')).toBeNull()
    expect(localStorage.getItem('kwenta_last_refresh')).toBe('2026-08-04T00:00:00.000Z')
  })
})

describe('api cache eviction', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function at(n: number) {
    return new Date(Date.UTC(2026, 0, n)).toISOString()
  }

  function cacheKeyCount() {
    let n = 0
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith('kwenta_api_cache_v1:')) n++
    }
    return n
  }

  // Per-entity endpoints mint a key per row opened. Without a cap the cache fills storage and
  // every later write silently fails, freezing the offline copy of the screens actually in use.
  it('caps the number of cached responses', () => {
    for (let i = 0; i < 70; i++) {
      writeCache(`bill:${i}`, 'u1', { i }, at((i % 27) + 1))
    }
    expect(cacheKeyCount()).toBeLessThanOrEqual(60)
  })

  /**
   * The cap check runs on EVERY successful write and a screen fires several. Reading the entry
   * count by parsing all ~60 stored payloads — some of them whole group-detail bundles — put
   * roughly 180 `JSON.parse` calls on the main thread per navigation, and again after every
   * mutation's `bumpDataVersion`. Counting keys needs no parse; the sort is only paid on overflow.
   */
  it('does not parse the stored payloads just to check the cap', () => {
    for (let i = 0; i < 40; i++) writeCache(`bill:${i}`, 'u1', { i }, at(10))

    const parse = vi.spyOn(JSON, 'parse')
    writeCache('bill:fresh', 'u1', { v: 1 }, at(11))

    // Under the cap nothing needs reading back at all.
    expect(parse).not.toHaveBeenCalled()
    parse.mockRestore()
  })

  it('evicts the oldest entries first and keeps the newest', () => {
    writeCache('bill:old', 'u1', { v: 'old' }, at(1))
    for (let i = 0; i < 65; i++) writeCache(`bill:${i}`, 'u1', { i }, at(20))
    writeCache('bill:new', 'u1', { v: 'new' }, at(27))

    expect(readCache('bill:old', 'u1')).toBeNull()
    expect(readCache('bill:new', 'u1')).not.toBeNull()
  })

  it('makes room and retries when the quota is hit', () => {
    writeCache('bill:stale', 'u1', { v: 1 }, at(1))
    writeCache('overview', 'u1', { v: 2 }, at(2))

    const real = localStorage.setItem.bind(localStorage)
    let firstCall = true
    withFailingSetItem(
      (k, v) => {
        if (firstCall) {
          firstCall = false
          throw new Error('QuotaExceededError')
        }
        real(k, v)
      },
      () => writeCache('contacts', 'u1', { v: 3 }, at(3)),
    )

    // The entry the user is looking at survived; the oldest was sacrificed for it.
    expect(readCache('contacts', 'u1')).not.toBeNull()
    expect(readCache('bill:stale', 'u1')).toBeNull()
  })

  it('does not throw when storage refuses every write', () => {
    withFailingSetItem(
      () => {
        throw new Error('SecurityError')
      },
      () => {
        expect(() => writeCache('overview', 'u1', { v: 1 }, at(1))).not.toThrow()
      },
    )
  })
})
