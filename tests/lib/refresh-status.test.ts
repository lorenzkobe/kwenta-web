import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isRefreshDisabled,
  lastUpdatedLabel,
  refreshAriaLabel,
  refreshStatusLabel,
  refreshTitle,
  resolveRefreshState,
  STALE_AFTER_MS,
  type RefreshStateInput,
} from '@/lib/refresh-status'

/** All-clear baseline; each test overrides only the field under examination. */
function input(overrides: Partial<RefreshStateInput> = {}): RefreshStateInput {
  return {
    isOnline: true,
    syncStatus: 'idle',
    hasPendingUpload: false,
    hasNotApplied: false,
    pullStale: false,
    msSinceLastRefresh: 0,
    screenLoading: false,
    ...overrides,
  }
}

describe('resolveRefreshState', () => {
  it('returns idle when everything is current', () => {
    expect(resolveRefreshState(input())).toBe('idle')
  })

  // One case per rung of the precedence ladder. Each asserts the higher state wins while EVERY
  // lower condition is also true, so a reordering of the checks fails here rather than in the UI.
  it('offline outranks every other state', () => {
    expect(
      resolveRefreshState(
        input({
          isOnline: false,
          syncStatus: 'error',
          hasPendingUpload: true,
          pullStale: true,
          msSinceLastRefresh: Number.POSITIVE_INFINITY,
        }),
      ),
    ).toBe('offline')
  })

  it('syncing outranks error, pending upload and staleness', () => {
    expect(
      resolveRefreshState(
        input({
          syncStatus: 'syncing',
          hasPendingUpload: true,
          pullStale: true,
          msSinceLastRefresh: Number.POSITIVE_INFINITY,
        }),
      ),
    ).toBe('syncing')
  })

  it('error outranks pending upload and staleness', () => {
    expect(
      resolveRefreshState(
        input({ syncStatus: 'error', hasPendingUpload: true, pullStale: true }),
      ),
    ).toBe('error')
  })

  it('pending upload outranks staleness', () => {
    expect(resolveRefreshState(input({ hasPendingUpload: true, pullStale: true }))).toBe(
      'pending-upload',
    )
  })

  it('reports stale from the in-memory pullStale flag', () => {
    expect(resolveRefreshState(input({ pullStale: true }))).toBe('stale')
  })

  // The cold-start bug: pullStale resets to false on every launch, so elapsed time is the only
  // staleness signal that survives a reload.
  it('reports stale from elapsed time even when pullStale is false', () => {
    expect(resolveRefreshState(input({ msSinceLastRefresh: STALE_AFTER_MS }))).toBe('stale')
  })

  it('stays idle just under the staleness threshold', () => {
    expect(resolveRefreshState(input({ msSinceLastRefresh: STALE_AFTER_MS - 1 }))).toBe('idle')
  })

  it('treats a device that has never refreshed as stale', () => {
    expect(resolveRefreshState(input({ msSinceLastRefresh: Number.POSITIVE_INFINITY }))).toBe(
      'stale',
    )
  })
})

/**
 * sync-realign C32: a queued write the server refused reads "Changes not applied" — never as
 * pending forever. It sits below error (a failing sync may be why nothing drains) and above
 * pending-upload and stale (it will not resolve on its own).
 */
describe('resolveRefreshState — not applied (a refused queued write)', () => {
  it('C32: reports not-applied when a refused write is queued and nothing else is going on', () => {
    expect(resolveRefreshState(input({ hasNotApplied: true }))).toBe('not-applied')
  })

  it('C32: not-applied outranks pending upload and staleness at once', () => {
    expect(
      resolveRefreshState(
        input({
          hasNotApplied: true,
          hasPendingUpload: true,
          pullStale: true,
          msSinceLastRefresh: Number.POSITIVE_INFINITY,
        }),
      ),
    ).toBe('not-applied')
  })

  it('C32: offline, syncing, updating and error outrank not-applied', () => {
    expect(resolveRefreshState(input({ hasNotApplied: true, isOnline: false }))).toBe('offline')
    expect(resolveRefreshState(input({ hasNotApplied: true, syncStatus: 'syncing' }))).toBe('syncing')
    expect(resolveRefreshState(input({ hasNotApplied: true, screenLoading: true }))).toBe('updating')
    expect(resolveRefreshState(input({ hasNotApplied: true, syncStatus: 'error' }))).toBe('error')
  })

  it('C32: stays pressable, and labels, titles and names the state', () => {
    expect(isRefreshDisabled('not-applied')).toBe(false)
    expect(refreshStatusLabel('not-applied', null)).toBe('Changes not applied')
    expect(refreshTitle('not-applied', null)).toContain('Settings')
    expect(refreshAriaLabel('not-applied', 'Updated 4m ago')).toBe('Changes not applied. Updated 4m ago')
  })
})

/**
 * loading-bar-refresh-landing C6: a screen fetch in flight reads "Updating…" on the header button.
 * The rung sits after offline and syncing (those are facts about the whole app / nothing can be
 * done) and before error, pending-upload and stale (a fetch in flight may be the recovery).
 */
describe('resolveRefreshState — updating (screen fetch in flight)', () => {
  it('C2: reports updating when a screen fetch is in flight and nothing else is going on', () => {
    expect(resolveRefreshState(input({ screenLoading: true }))).toBe('updating')
  })

  it('C6: offline outranks updating', () => {
    expect(resolveRefreshState(input({ isOnline: false, screenLoading: true }))).toBe('offline')
  })

  it('C6: syncing outranks updating', () => {
    expect(resolveRefreshState(input({ syncStatus: 'syncing', screenLoading: true }))).toBe(
      'syncing',
    )
  })

  it('C6: updating outranks error, pending upload and staleness all at once', () => {
    expect(
      resolveRefreshState(
        input({
          screenLoading: true,
          syncStatus: 'error',
          hasPendingUpload: true,
          pullStale: true,
          msSinceLastRefresh: Number.POSITIVE_INFINITY,
        }),
      ),
    ).toBe('updating')
  })

  it('C6: updating outranks each lower state on its own', () => {
    expect(resolveRefreshState(input({ screenLoading: true, syncStatus: 'error' }))).toBe('updating')
    expect(resolveRefreshState(input({ screenLoading: true, hasPendingUpload: true }))).toBe(
      'updating',
    )
    expect(resolveRefreshState(input({ screenLoading: true, pullStale: true }))).toBe('updating')
    expect(
      resolveRefreshState(input({ screenLoading: true, msSinceLastRefresh: STALE_AFTER_MS })),
    ).toBe('updating')
  })

  it('C6: with no screen fetch in flight the lower states are unchanged', () => {
    expect(resolveRefreshState(input({ screenLoading: false, syncStatus: 'error' }))).toBe('error')
    expect(resolveRefreshState(input({ screenLoading: false }))).toBe('idle')
  })

  it('C6: updating does not disable the button', () => {
    expect(isRefreshDisabled('updating')).toBe(false)
  })

  it('C2: labels the updating state "Updating…"', () => {
    expect(refreshStatusLabel('updating', null)).toBe('Updating…')
  })
})

describe('isRefreshDisabled', () => {
  it('blocks only offline and in-flight', () => {
    expect(isRefreshDisabled('offline')).toBe(true)
    expect(isRefreshDisabled('syncing')).toBe(true)
  })

  // Guards the recovery path: if these were disabled, a failed sync could only be retried by
  // waiting out the backoff timer, which is the opposite of what the button is for.
  it('keeps error, stale and pending-upload pressable', () => {
    expect(isRefreshDisabled('error')).toBe(false)
    expect(isRefreshDisabled('stale')).toBe(false)
    expect(isRefreshDisabled('pending-upload')).toBe(false)
    expect(isRefreshDisabled('idle')).toBe(false)
  })
})

describe('refreshStatusLabel', () => {
  it('shows a countdown while a retry is scheduled', () => {
    expect(refreshStatusLabel('error', 12)).toBe('Retry in ~12s')
  })

  it('falls back to a plain failure label with no countdown', () => {
    expect(refreshStatusLabel('error', null)).toBe("Couldn't sync")
  })

  it('labels the resting state as an action, not a connectivity report', () => {
    expect(refreshStatusLabel('idle', null)).toBe('Refresh')
  })

  it('covers the remaining states', () => {
    expect(refreshStatusLabel('offline', null)).toBe('Offline')
    expect(refreshStatusLabel('syncing', null)).toBe('Refreshing…')
    expect(refreshStatusLabel('pending-upload', null)).toBe('Waiting to sync')
    expect(refreshStatusLabel('stale', null)).toBe('Data may be behind')
  })
})

describe('lastUpdatedLabel', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reports a device that has never refreshed', () => {
    expect(lastUpdatedLabel(null)).toBe('Not synced yet')
  })

  it('formats an elapsed duration', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T12:00:00.000Z'))
    expect(lastUpdatedLabel('2026-08-04T11:55:00.000Z')).toBe('Updated 5m ago')
  })

  it('avoids the "Updated Just now" double-capital reading', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T12:00:00.000Z'))
    expect(lastUpdatedLabel('2026-08-04T11:59:50.000Z')).toBe('Updated just now')
  })

  it('formats hours and days', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-04T12:00:00.000Z'))
    expect(lastUpdatedLabel('2026-08-04T09:00:00.000Z')).toBe('Updated 3h ago')
    expect(lastUpdatedLabel('2026-08-01T12:00:00.000Z')).toBe('Updated 3d ago')
  })
})

describe('refreshTitle', () => {
  it('explains what a press will do in each recoverable state', () => {
    expect(refreshTitle('error', 5)).toContain('tap to retry now')
    expect(refreshTitle('error', null)).toContain('tap to retry')
    expect(refreshTitle('stale', null)).toContain('tap to refresh')
    expect(refreshTitle('pending-upload', null)).toContain('tap to sync now')
    expect(refreshTitle('idle', null)).toBe('Tap to refresh')
    expect(refreshTitle('offline', null)).toContain('offline')
    expect(refreshTitle('syncing', null)).toBe('Refreshing…')
  })
})

describe('refreshAriaLabel', () => {
  // The visible label drops the freshness text on small screens, so the accessible name is the
  // only place a screen-reader user can learn how old the data is.
  it('carries the freshness text in the resting state', () => {
    expect(refreshAriaLabel('idle', 'Updated 4m ago')).toBe('Refresh data. Updated 4m ago')
    expect(refreshAriaLabel('stale', 'Updated 2h ago')).toBe('Refresh data. Updated 2h ago')
  })

  it('omits freshness where it would be misleading', () => {
    expect(refreshAriaLabel('syncing', 'Updated 4m ago')).toBe('Refreshing')
    expect(refreshAriaLabel('offline', 'Updated 4m ago')).toBe('Offline — cannot refresh')
    expect(refreshAriaLabel('error', 'Updated 4m ago')).toBe('Refresh data. Last sync failed')
  })
})
