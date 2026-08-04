import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app-store'
import { KWENTA_LAST_REFRESH_STORAGE_KEY } from '@/lib/kwenta-storage-keys'
import {
  requestRefreshOnNavigation,
  __resetNavigationRefreshThrottleForTests,
} from '@/sync/sync-manager'

/**
 * Navigation-driven refresh: opening a screen should show server truth, but every refresh now
 * pulls the complete bundle, so the trigger has to be rate-limited or tapping through the app
 * fires one full RPC per route change.
 *
 * It is also a PASSIVE refresh — a read caused by the user looking at a screen, with no local
 * write to deliver. It must therefore stay out of the error/backoff state machine entirely: it
 * neither queues a re-run nor reschedules the retry timer.
 */

const mocks = vi.hoisted(() => ({
  fullSync: vi.fn(async () => ({ pushed: 0, pulled: 0, errors: [] as string[] })),
  syncRoundTrip: vi.fn(async () => ({ pushed: 0, pulled: 0, errors: [] as string[] })),
  hasUnsyncedLocalDataForUser: vi.fn(async () => false),
  getMillisecondsSinceLastRefresh: vi.fn(() => 0),
}))

vi.mock('@/sync/sync-service', () => mocks)
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }) },
  },
}))
vi.mock('@/lib/people', () => ({ hydrateLinkedRemoteProfilesForActor: vi.fn(async () => {}) }))
vi.mock('@/lib/kwenta-data-repair', () => ({ maybeAutoRepairData: vi.fn(async () => {}) }))
vi.mock('@/lib/kwenta-notifications', () => ({
  flushQueuedKwentaNotifications: vi.fn(async () => {}),
  hasQueuedKwentaNotifications: vi.fn(async () => false),
}))
vi.mock('@/sync/cloud-first-mutations', () => ({
  markPendingMutationsApplied: vi.fn(async () => {}),
  markPendingMutationsConflict: vi.fn(async () => {}),
}))

const NAVIGATION_REFRESH_MIN_INTERVAL_MS = 5_000

/** Let the fire-and-forget runSync chain settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  __resetNavigationRefreshThrottleForTests()
  // Reset EVERY mock, not just fullSync: call history and queued implementations otherwise leak
  // into the next case and a failure-path test would poison every case that follows it.
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, errors: [] })
  mocks.syncRoundTrip.mockResolvedValue({ pushed: 0, pulled: 0, errors: [] })
  mocks.hasUnsyncedLocalDataForUser.mockResolvedValue(false)
  mocks.getMillisecondsSinceLastRefresh.mockReturnValue(0)
  localStorage.clear()
  useAppStore.setState({
    isOnline: true,
    syncStatus: 'idle',
    syncRetryAt: null,
    pullStale: false,
    initialCloudHydration: 'ready',
  })
  // Already hydrated, so runSync takes the normal fullSync path rather than initial hydration.
  localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, new Date().toISOString())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('requestRefreshOnNavigation', () => {
  it('refreshes when the user opens a screen', async () => {
    requestRefreshOnNavigation()
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('collapses a burst of navigations into one refresh', async () => {
    requestRefreshOnNavigation()
    requestRefreshOnNavigation()
    requestRefreshOnNavigation()
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('refreshes again once the throttle window has passed', async () => {
    requestRefreshOnNavigation()
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)

    // Without advancing the clock this suite could not tell a working throttle from one that is
    // stuck shut — a regression that never released it would leave every case green while
    // navigation refresh silently stopped after the first route change of the session.
    vi.advanceTimersByTime(NAVIGATION_REFRESH_MIN_INTERVAL_MS + 1)
    requestRefreshOnNavigation()
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(2)
  })

  it('keeps working when the wall clock jumps backwards', async () => {
    // NTP correcting a fast clock, a manual date change, a phone re-syncing after travel. Timing
    // the throttle off Date.now() made `now - last` negative — always under the interval — so
    // navigation refresh silently switched off for the whole duration of the skew and every screen
    // rendered stale cache. Same device-clock dependency the pull cursor was removed to escape.
    requestRefreshOnNavigation()
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)

    const realNow = Date.now()
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - 60 * 60 * 1000)
    try {
      vi.advanceTimersByTime(NAVIGATION_REFRESH_MIN_INTERVAL_MS + 1)
      requestRefreshOnNavigation()
      await settle()
      expect(mocks.fullSync).toHaveBeenCalledTimes(2)
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('does nothing while offline', async () => {
    useAppStore.setState({ isOnline: false })
    requestRefreshOnNavigation()
    await settle()
    expect(mocks.fullSync).not.toHaveBeenCalled()
  })

  it('gives the throttle window back when the run bailed out without syncing', async () => {
    // runSync returns early when offline, when a sync is already running, or — right after
    // sign-in, exactly when this hook first fires — when the session has not resolved yet.
    // Claiming the window anyway swallowed the NEXT screen change, which then rendered whatever
    // the cache held: the staleness the hook exists to remove.
    useAppStore.setState({ isOnline: false })
    requestRefreshOnNavigation()
    await settle()
    expect(mocks.fullSync).not.toHaveBeenCalled()

    useAppStore.setState({ isOnline: true })
    requestRefreshOnNavigation() // immediately, no clock advance
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('does not reschedule the retry timer when the refresh fails', async () => {
    // Every route change used to re-enter scheduleRetry(), which doubles the backoff and restarts
    // the pending countdown — so browsing during an outage pushed automatic recovery further and
    // further away, and republished a jumping retry time on every screen.
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, errors: ['kwenta_sync: boom'] })

    requestRefreshOnNavigation()
    await settle()

    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().syncStatus).toBe('error')
    expect(useAppStore.getState().pullStale).toBe(true)
    // The failure is reported, but no retry was scheduled by this passive read.
    expect(useAppStore.getState().syncRetryAt).toBeNull()
  })

  it('leaves an already-scheduled retry countdown alone when it also fails', async () => {
    // The passive path does not own the retry schedule, so a failing refresh must not blank the
    // countdown a real sync put there — the timer is still running, and hiding it makes recovery
    // look stalled. (On SUCCESS resetBackoff clears it, which is correct: the server is back.)
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, errors: ['kwenta_sync: boom'] })
    const retryAt = Date.now() + 30_000
    useAppStore.setState({ syncRetryAt: retryAt })

    requestRefreshOnNavigation()
    await settle()

    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().syncRetryAt).toBe(retryAt)
  })

  it('does not queue a re-run behind an in-flight sync', async () => {
    // rerunRequested exists so a mutation made mid-sync still gets pushed. A navigation refresh
    // has nothing to deliver, so queueing one chained back-to-back full-bundle round trips behind
    // every tap on a slow connection.
    let release: () => void = () => {}
    mocks.fullSync.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ pushed: 0, pulled: 0, errors: [] })
        }),
    )

    requestRefreshOnNavigation()
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(NAVIGATION_REFRESH_MIN_INTERVAL_MS + 1)
    requestRefreshOnNavigation() // lands while the first is still in flight
    await settle()

    release()
    await settle()

    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })
})
