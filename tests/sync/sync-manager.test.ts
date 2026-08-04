import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app-store'
import { KWENTA_LAST_REFRESH_STORAGE_KEY } from '@/lib/kwenta-storage-keys'
import {
  requestSyncNow,
  startSyncManager,
  __resetActivationRefreshThrottleForTests,
} from '@/sync/sync-manager'

/**
 * Two things this file pins, both cost measured in whole pull bundles.
 *
 * 1. Returning to the tab fires `focus` AND `visibilitychange`. Each ran a sync; the second landed
 *    while the first was in flight, set `rerunRequested`, and ran again after it — so one tab
 *    switch cost two complete round trips.
 * 2. A sync that changed nothing must not invalidate the screens. Bumping `dataVersion` after every
 *    sync made each mounted screen fetch on mount and then again the moment the sync resolved,
 *    which is the duplicated request pairs seen in the network panel. `pulled` cannot gate it:
 *    every bundle is complete, so it is large even when nothing moved.
 *
 * The navigation-refresh cases this file used to hold are gone with the behaviour: opening a screen
 * now fetches that screen's own scoped endpoint, which IS server truth (CLAUDE.md rule 7), so
 * pulling the whole bundle per route change bought nothing.
 */

const mocks = vi.hoisted(() => ({
  fullSync: vi.fn(async () => ({ pushed: 0, pulled: 0, changed: 0, errors: [] as string[] })),
  syncRoundTrip: vi.fn(async () => ({ pushed: 0, pulled: 0, changed: 0, errors: [] as string[] })),
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

const ACTIVATION_REFRESH_MIN_INTERVAL_MS = 5_000

/** Let the fire-and-forget runSync chain settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

let stopSyncManager: (() => void) | null = null

/** Start the manager and swallow the initial sync it runs, so counts below start from zero. */
async function startManager() {
  stopSyncManager = startSyncManager()
  await settle()
  mocks.fullSync.mockClear()
  __resetActivationRefreshThrottleForTests()
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  __resetActivationRefreshThrottleForTests()
  // Reset EVERY mock, not just fullSync: call history and queued implementations otherwise leak
  // into the next case and a failure-path test would poison every case that follows it.
  for (const m of Object.values(mocks)) m.mockReset()
  mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, changed: 0, errors: [] })
  mocks.syncRoundTrip.mockResolvedValue({ pushed: 0, pulled: 0, changed: 0, errors: [] })
  mocks.hasUnsyncedLocalDataForUser.mockResolvedValue(false)
  mocks.getMillisecondsSinceLastRefresh.mockReturnValue(0)
  localStorage.clear()
  useAppStore.setState({
    isOnline: true,
    syncStatus: 'idle',
    syncRetryAt: null,
    pullStale: false,
    initialCloudHydration: 'ready',
    dataVersion: 0,
  })
  // Already hydrated, so runSync takes the normal fullSync path rather than initial hydration.
  localStorage.setItem(KWENTA_LAST_REFRESH_STORAGE_KEY, new Date().toISOString())
})

afterEach(() => {
  stopSyncManager?.()
  stopSyncManager = null
  vi.useRealTimers()
})

describe('returning to the tab', () => {
  it('refreshes once', async () => {
    await startManager()
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('runs ONE sync when focus and visibilitychange both fire', async () => {
    // The whole point of the throttle. Both events fire on a single tab activation, and before the
    // throttle the second one queued a re-run behind the first: two complete bundles per switch.
    await startManager()
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('visibilitychange'))
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('refreshes again once the throttle window has passed', async () => {
    // Without advancing the clock this suite could not tell a working throttle from one that is
    // stuck shut — a regression that never released it would leave every case green while the
    // refresh silently stopped after the first activation of the session.
    await startManager()
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(ACTIVATION_REFRESH_MIN_INTERVAL_MS + 1)
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(2)
  })

  it('keeps working when the wall clock jumps backwards', async () => {
    // NTP correcting a fast clock, a manual date change, a phone re-syncing after travel. Timing
    // the throttle off Date.now() made `now - last` negative — always under the interval — so the
    // refresh silently switched off for the whole duration of the skew. Same device-clock
    // dependency the pull cursor was removed to escape.
    await startManager()
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)

    const realNow = Date.now()
    const dateSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - 60 * 60 * 1000)
    try {
      vi.advanceTimersByTime(ACTIVATION_REFRESH_MIN_INTERVAL_MS + 1)
      window.dispatchEvent(new Event('focus'))
      await settle()
      expect(mocks.fullSync).toHaveBeenCalledTimes(2)
    } finally {
      dateSpy.mockRestore()
    }
  })

  it('does nothing while offline, and gives the throttle window back', async () => {
    // runSync returns early when offline, without a session, or with one already running. Claiming
    // the window anyway would swallow the next real activation.
    await startManager()
    useAppStore.setState({ isOnline: false })
    window.dispatchEvent(new Event('focus'))
    await settle()
    expect(mocks.fullSync).not.toHaveBeenCalled()

    useAppStore.setState({ isOnline: true })
    window.dispatchEvent(new Event('focus')) // immediately, no clock advance
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })
})

describe('dataVersion invalidation', () => {
  it('does NOT bump when the sync changed nothing', async () => {
    // The duplicate-request bug: every mounted screen re-fetches on a bump, so a sync that moved no
    // data made each screen fetch twice — once on mount, once when the concurrent sync resolved.
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 4213, changed: 0, errors: [] })
    await startManager()
    const before = useAppStore.getState().dataVersion

    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().dataVersion).toBe(before)
  })

  it('bumps when the pull applied changed rows', async () => {
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 4213, changed: 1, errors: [] })
    await startManager()
    const before = useAppStore.getState().dataVersion

    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(useAppStore.getState().dataVersion).toBe(before + 1)
  })

  it('bumps when the round trip pushed rows', async () => {
    // A queued offline write replaying on reconnect changes server state, so the screens must
    // re-read even if the echo brought nothing new back.
    mocks.fullSync.mockResolvedValue({ pushed: 2, pulled: 4213, changed: 0, errors: [] })
    await startManager()
    const before = useAppStore.getState().dataVersion

    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(useAppStore.getState().dataVersion).toBe(before + 1)
  })

  it('ALWAYS bumps when the user pressed Refresh, even if nothing moved', async () => {
    // Pressing Refresh is an explicit request for fresh data. A server-side change that alters no
    // row this device holds — a counterparty renaming their own account, whose profile is outside
    // this user's pull scope by design — would otherwise never reach the screen at all.
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 4213, changed: 0, errors: [] })
    await startManager()
    const before = useAppStore.getState().dataVersion

    requestSyncNow()
    await settle()

    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().dataVersion).toBe(before + 1)
  })

  it('does not bump when the sync failed', async () => {
    mocks.fullSync.mockResolvedValue({ pushed: 1, pulled: 0, changed: 0, errors: ['boom'] })
    await startManager()
    const before = useAppStore.getState().dataVersion

    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(useAppStore.getState().syncStatus).toBe('error')
    expect(useAppStore.getState().dataVersion).toBe(before)
  })
})
