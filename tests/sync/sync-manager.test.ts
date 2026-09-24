import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app-store'
import { KWENTA_LAST_REFRESH_STORAGE_KEY, realtimeCursorKey } from '@/lib/kwenta-storage-keys'
import {
  clearRealtimeProcessingFailed,
  markRealtimeProcessingFailed,
  realtimeProcessingFailed,
} from '@/sync/realtime-health'
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
  newestUserEventSince: vi.fn<(userId: string, since: string) => Promise<{ newer: boolean; newest: string | null }>>(
    async () => ({ newer: false, newest: null }),
  ),
  mayHaveStagedRows: vi.fn(async () => false),
  isFullSyncInFlight: vi.fn<(userId: string) => boolean>(() => false),
  hasQueuedKwentaNotifications: vi.fn(async () => false),
}))

// The real syncRoundTrip bumps `dataVersion` itself when it changed rows (H1.1: one place for every
// caller), so the stand-ins do the same; the manager adds only the push / Refresh bump.
vi.mock('@/sync/sync-service', async () => {
  const { useAppStore } = await import('@/store/app-store')
  type Result = { pushed: number; pulled: number; changed: number; errors: string[] }
  const bumpingIfChanged = (fn: (userId: string) => Promise<Result>) => async (userId: string) => {
    const result = await fn(userId)
    if (result.changed > 0) useAppStore.getState().bumpDataVersion()
    return result
  }
  return {
    ...mocks,
    fullSync: bumpingIfChanged((id) => mocks.fullSync(id)),
    syncRoundTrip: bumpingIfChanged((id) => mocks.syncRoundTrip(id)),
  }
})
vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'me' } } } }) },
  },
}))
vi.mock('@/lib/people', () => ({ hydrateLinkedRemoteProfilesForActor: vi.fn(async () => {}) }))
vi.mock('@/lib/kwenta-data-repair', () => ({ maybeAutoRepairData: vi.fn(async () => {}) }))
vi.mock('@/lib/kwenta-notifications', () => ({
  flushQueuedKwentaNotifications: vi.fn(async () => {}),
  hasQueuedKwentaNotifications: () => mocks.hasQueuedKwentaNotifications(),
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
  mocks.newestUserEventSince.mockResolvedValue({ newer: false, newest: null })
  mocks.mayHaveStagedRows.mockResolvedValue(false)
  mocks.isFullSyncInFlight.mockReturnValue(false)
  mocks.hasQueuedKwentaNotifications.mockResolvedValue(false)
  clearRealtimeProcessingFailed()
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

  it('bumps exactly once when the round trip both pushed and changed rows', async () => {
    // syncRoundTrip already bumped for the changed rows; a second bump for the push would make
    // every mounted screen fetch twice for one sync.
    mocks.fullSync.mockResolvedValue({ pushed: 2, pulled: 4213, changed: 3, errors: [] })
    await startManager()
    const before = useAppStore.getState().dataVersion

    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(useAppStore.getState().dataVersion).toBe(before + 1)
  })

  it('bumps exactly once for Refresh when the sync also changed rows', async () => {
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 4213, changed: 2, errors: [] })
    await startManager()
    const before = useAppStore.getState().dataVersion

    requestSyncNow()
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

/**
 * Item 3 of perf pass 2: a tab focus no longer downloads the complete bundle by default. It runs a
 * full sync only when something says one is needed — a staged write to push, a queued
 * notification, a failed realtime apply, a refresh older than the 5-minute backup interval, no
 * server cursor to ask from — or when the one-row probe finds an event newer than the cursor.
 */
describe('returning to the tab: probe before syncing', () => {
  const CURSOR = '2026-09-24T01:00:00+00:00'

  function withCursor() {
    localStorage.setItem(realtimeCursorKey('me'), CURSOR)
  }

  async function focus() {
    window.dispatchEvent(new Event('focus'))
    await settle()
  }

  it('C1: with a cursor and nothing newer, makes ONE probe and NO sync', async () => {
    withCursor()
    await startManager()
    await focus()
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(1)
    expect(mocks.newestUserEventSince).toHaveBeenCalledWith('me', CURSOR)
    expect(mocks.fullSync).not.toHaveBeenCalled()
  })

  it('C2: a newer event means one full sync', async () => {
    withCursor()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-24T02:00:00+00:00' })
    await startManager()
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('C3: staged local rows sync without probing — the push must happen', async () => {
    withCursor()
    await startManager()
    mocks.mayHaveStagedRows.mockResolvedValue(true)
    mocks.hasUnsyncedLocalDataForUser.mockResolvedValue(true)
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
  })

  it('C4: queued notifications sync without probing', async () => {
    withCursor()
    await startManager()
    mocks.hasQueuedKwentaNotifications.mockResolvedValue(true)
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
  })

  it('C5: no realtime cursor means a full sync, as before', async () => {
    await startManager()
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
  })

  it('C6: a device that never completed a refresh syncs', async () => {
    withCursor()
    await startManager()
    localStorage.removeItem(KWENTA_LAST_REFRESH_STORAGE_KEY)
    mocks.syncRoundTrip.mockClear()
    await focus()
    expect(mocks.syncRoundTrip.mock.calls.length + mocks.fullSync.mock.calls.length).toBe(1)
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
  })

  it('C7/C14: a refresh at least 5 minutes old syncs even with no event (event-less changes)', async () => {
    withCursor()
    await startManager()
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(5 * 60 * 1000)
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
  })

  it('C7/C14: a refresh just under 5 minutes old only probes', async () => {
    withCursor()
    await startManager()
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(5 * 60 * 1000 - 1)
    await focus()
    expect(mocks.fullSync).not.toHaveBeenCalled()
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(1)
  })

  it('C9: a probe-only activation claims the throttle window; focus + visibilitychange probe once', async () => {
    withCursor()
    await startManager()
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('visibilitychange'))
    await settle()
    await focus()
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(ACTIVATION_REFRESH_MIN_INTERVAL_MS + 1)
    await focus()
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(2)
    expect(mocks.fullSync).not.toHaveBeenCalled()
  })

  it('C10: offline makes no probe and gives the window back', async () => {
    withCursor()
    await startManager()
    useAppStore.setState({ isOnline: false })
    await focus()
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
    useAppStore.setState({ isOnline: true })
    await focus()
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(1)
  })

  it('C13: a failed realtime apply forces the next focus to sync; a successful sync clears it', async () => {
    withCursor()
    await startManager()
    markRealtimeProcessingFailed()
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()

    vi.advanceTimersByTime(ACTIVATION_REFRESH_MIN_INTERVAL_MS + 1)
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(1)
  })

  it('C13: a failed sync does NOT clear the failure', async () => {
    withCursor()
    await startManager()
    markRealtimeProcessingFailed()
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, changed: 0, errors: ['boom'] })
    await focus()
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, changed: 0, errors: [] })
    vi.advanceTimersByTime(ACTIVATION_REFRESH_MIN_INTERVAL_MS + 1)
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(2)
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
  })

  it('C16: the cheap checks run before the local scan, and the scan before the network probe', async () => {
    withCursor()
    await startManager()
    mocks.hasUnsyncedLocalDataForUser.mockClear()
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(10 * 60 * 1000)
    await focus()
    expect(mocks.hasUnsyncedLocalDataForUser).not.toHaveBeenCalled()
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
  })
  it('C16: with no never-pushed rows, the full unsynced scan does not run', async () => {
    withCursor()
    await startManager()
    mocks.hasUnsyncedLocalDataForUser.mockClear()
    await focus()
    expect(mocks.mayHaveStagedRows).toHaveBeenCalledTimes(1)
    expect(mocks.hasUnsyncedLocalDataForUser).not.toHaveBeenCalled()
  })

  it('a probe-triggered sync that succeeds moves the cursor to the newest server event', async () => {
    withCursor()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-24T02:00:00+00:00' })
    await startManager()
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(realtimeCursorKey('me'))).toBe('2026-09-24T02:00:00+00:00')
  })

  it('a probe-triggered sync that fails leaves the cursor alone', async () => {
    withCursor()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-24T02:00:00+00:00' })
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, changed: 0, errors: ['boom'] })
    await startManager()
    await focus()
    expect(localStorage.getItem(realtimeCursorKey('me'))).toBe(CURSOR)
  })

  it('the cursor never moves backwards', async () => {
    withCursor()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-23T00:00:00+00:00' })
    await startManager()
    await focus()
    expect(localStorage.getItem(realtimeCursorKey('me'))).toBe(CURSOR)
  })

  it('a check that throws falls back to the full sync', async () => {
    withCursor()
    await startManager()
    mocks.hasQueuedKwentaNotifications.mockRejectedValue(new Error('DatabaseClosedError'))
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('a failure marked while a sync is running survives that sync', async () => {
    withCursor()
    await startManager()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: null })
    mocks.fullSync.mockImplementation(async () => {
      markRealtimeProcessingFailed()
      return { pushed: 0, pulled: 0, changed: 0, errors: [] }
    })
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(realtimeProcessingFailed()).toBe(true)
  })
  it('the same holds for the first hydration round trip', async () => {
    withCursor()
    await startManager()
    localStorage.removeItem(KWENTA_LAST_REFRESH_STORAGE_KEY)
    mocks.syncRoundTrip.mockImplementation(async () => {
      markRealtimeProcessingFailed()
      return { pushed: 0, pulled: 0, changed: 0, errors: [] }
    })
    await focus()
    expect(mocks.syncRoundTrip).toHaveBeenCalledTimes(1)
    expect(realtimeProcessingFailed()).toBe(true)
  })
  it('a sync that joins one already running does not advance the cursor past the probed event', async () => {
    withCursor()
    await startManager()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-24T02:00:00+00:00' })
    mocks.isFullSyncInFlight.mockReturnValue(true)
    await focus()
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(1)
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(realtimeCursorKey('me'))).toBe(CURSOR)
  })

  it('a sync that joins one already running does not clear a realtime failure', async () => {
    withCursor()
    await startManager()
    markRealtimeProcessingFailed()
    mocks.isFullSyncInFlight.mockReturnValue(true)
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(realtimeProcessingFailed()).toBe(true)
  })
})
