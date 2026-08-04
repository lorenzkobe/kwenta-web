import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  KWENTA_LAST_REFRESH_STORAGE_KEY,
  KWENTA_LEGACY_LAST_PULL_STORAGE_KEY,
  readLastRefreshAt,
} from '@/lib/kwenta-storage-keys'

/**
 * `readLastRefreshAt` is a read with a write in it (the one-time migration of the legacy
 * incremental-pull cursor key). It runs at module scope while the app store is constructed, so a
 * throwing write there takes the whole app down instead of degrading.
 */

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('readLastRefreshAt', () => {
  it('returns null when this device has never completed a refresh', () => {
    expect(readLastRefreshAt()).toBeNull()
  })

  it('returns the current marker without touching the legacy key', () => {
    localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, '2026-08-01T00:00:00.000Z')
    localStorage.setItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY, '2020-01-01T00:00:00.000Z')

    expect(readLastRefreshAt()).toBe('2026-08-01T00:00:00.000Z')
    expect(localStorage.getItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY)).toBe('2020-01-01T00:00:00.000Z')
  })

  it('migrates the legacy cursor key once', () => {
    localStorage.setItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY, '2026-07-01T00:00:00.000Z')

    expect(readLastRefreshAt()).toBe('2026-07-01T00:00:00.000Z')
    expect(localStorage.getItem(KWENTA_LAST_REFRESH_STORAGE_KEY)).toBe('2026-07-01T00:00:00.000Z')
    expect(localStorage.getItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY)).toBeNull()
  })

  it('still returns the value when the storage write fails', () => {
    // Safari private browsing / exhausted quota / partitioned storage: reads work, writes throw.
    // An unguarded setItem here escaped during import of the app store — a blank screen.
    localStorage.setItem(KWENTA_LEGACY_LAST_PULL_STORAGE_KEY, '2026-07-01T00:00:00.000Z')
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError')
    })

    expect(() => readLastRefreshAt()).not.toThrow()
    expect(readLastRefreshAt()).toBe('2026-07-01T00:00:00.000Z')
  })

  it('returns null rather than throwing when storage reads fail', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError')
    })

    expect(readLastRefreshAt()).toBeNull()
  })
})
