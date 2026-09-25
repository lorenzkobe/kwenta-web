import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/app-store'
import { KWENTA_LAST_REFRESH_STORAGE_KEY, realtimeCursorKey } from '@/lib/kwenta-storage-keys'
import {
  clearRealtimeProcessingFailed,
  markRealtimeProcessingFailed,
  realtimeProcessingFailed,
} from '@/sync/realtime-health'
import * as syncManager from '@/sync/sync-manager'
import {
  requestSyncNow,
  startSyncManager,
  __resetActivationRefreshThrottleForTests,
} from '@/sync/sync-manager'
import { bumpSessionEpoch } from '@/sync/session-epoch'

function registerCatchUpMock() {
  const m = syncManager as unknown as Record<string, unknown>
  for (const name of ['registerRealtimeCatchUp', 'setRealtimeCatchUpHandler', 'registerRealtimeCatchUpHandler']) {
    const fn = m[name]
    if (typeof fn === 'function') (fn as (cb: () => void) => void)(() => mocks.requestRealtimeCatchUp())
  }
}

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
  requestRealtimeCatchUp: vi.fn(() => {}),
  drainWriteQueue: vi.fn<(userId: string, options?: { ignoreBackoff?: boolean }) => Promise<{ applied: number; refused: number } | null>>(
    async () => ({ applied: 0, refused: 0 }),
  ),
}))

// The real syncRoundTrip bumps `dataVersion` itself when it changed rows (H1.1: one place for every
// caller), so the stand-ins do the same; the manager adds only the push / Refresh bump.
vi.mock('@/sync/sync-service', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { useAppStore } = await import('@/store/app-store')
  type Result = { pushed: number; pulled: number; changed: number; errors: string[] }
  const bumpingIfChanged = (fn: (userId: string) => Promise<Result>) => async (userId: string) => {
    const result = await fn(userId)
    if (result.changed > 0) useAppStore.getState().bumpDataVersion()
    return result
  }
  return {
    ...actual,
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
vi.mock('@/lib/kwenta-notifications', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  flushQueuedKwentaNotifications: vi.fn(async () => {}),
  hasQueuedKwentaNotifications: () => mocks.hasQueuedKwentaNotifications(),
}))
vi.mock('@/sync/cloud-first-mutations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markPendingMutationsApplied: vi.fn(async () => {}),
}))
// A newer server event found by the probe is handed to realtime's per-entity catch-up rather than
// answered with a full bundle. Whether the manager imports it or realtime registers it, both
// routes reach this one mock (see `registerCatchUpMock`).
vi.mock('@/sync/realtime-events', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestRealtimeCatchUp: () => mocks.requestRealtimeCatchUp(),
}))

// The queue's own behaviour (order, backoff, ignoreBackoff sending a backed-off head) is pinned in
// write-queue.test.ts; here only WHEN the manager drains it, and in which order with the sync.
vi.mock('@/sync/write-queue', () => ({
  drainWriteQueue: (userId: string, options?: { ignoreBackoff?: boolean }) =>
    options === undefined ? mocks.drainWriteQueue(userId) : mocks.drainWriteQueue(userId, options),
}))

const ACTIVATION_REFRESH_MIN_INTERVAL_MS = 5_000

/** Let the fire-and-forget runSync chain settle. */
async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

let stopSyncManager: (() => void) | null = null

/**
 * Start the manager and swallow the initial refresh it runs, so counts below start from zero. The
 * start now goes through the same gate as a focus (sync-realign), so its probe and gate checks are
 * swallowed too — not just its sync. `mockClear` keeps each case's configured answers.
 */
async function startManager() {
  stopSyncManager = startSyncManager()
  await settle()
  for (const m of Object.values(mocks)) m.mockClear()
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
  mocks.drainWriteQueue.mockResolvedValue({ applied: 0, refused: 0 })
  registerCatchUpMock()
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

  it('C2: a newer event hands off to the realtime catch-up, not a full sync', async () => {
    withCursor()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-24T02:00:00+00:00' })
    await startManager()
    mocks.requestRealtimeCatchUp.mockClear()
    await focus()
    expect(mocks.requestRealtimeCatchUp).toHaveBeenCalledTimes(1)
    expect(mocks.fullSync).not.toHaveBeenCalled()
    expect(mocks.syncRoundTrip).not.toHaveBeenCalled()
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

  it('C4: a refresh 60 minutes old syncs even with no event (event-less changes)', async () => {
    withCursor()
    await startManager()
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(60 * 60 * 1000)
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
  })

  it('C4: a refresh 59 minutes old only probes', async () => {
    withCursor()
    await startManager()
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(59 * 60 * 1000)
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
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(60 * 60 * 1000)
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

  it('a probed newer event is left to the catch-up: the manager itself does not move the cursor', async () => {
    // The cursor now moves only through realtime's catch-up (per-entity batch, or >50 → one full
    // sync with the cursor read before it; pinned in realtime-echo.test.ts).
    withCursor()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-24T02:00:00+00:00' })
    await startManager()
    await focus()
    expect(mocks.fullSync).not.toHaveBeenCalled()
    expect(localStorage.getItem(realtimeCursorKey('me'))).toBe(CURSOR)
  })

  it('a stale-refresh sync that fails leaves the cursor alone', async () => {
    withCursor()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-24T02:00:00+00:00' })
    mocks.fullSync.mockResolvedValue({ pushed: 0, pulled: 0, changed: 0, errors: ['boom'] })
    await startManager()
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(60 * 60 * 1000)
    await focus()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(realtimeCursorKey('me'))).toBe(CURSOR)
  })

  it('the cursor never moves backwards', async () => {
    withCursor()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-23T00:00:00+00:00' })
    await startManager()
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(60 * 60 * 1000)
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
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(60 * 60 * 1000)
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
  it('a probed event while a full sync is already running does not advance the cursor', async () => {
    withCursor()
    await startManager()
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-24T02:00:00+00:00' })
    mocks.isFullSyncInFlight.mockReturnValue(true)
    await focus()
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(1)
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

/**
 * sync-realign: app start goes through the same gate as a tab activation. A returning user used to
 * download the complete bundle on every open (sometimes twice: a focus during that sync queued a
 * re-run). The safety refresh for event-less changes is relaxed from 5/15 minutes to 60, because
 * contacts, renames and peer links now emit events (077).
 */
describe('sync-realign: startup gate, 60-minute safety refresh, no duplicate', () => {
  const CURSOR = '2026-09-24T01:00:00+00:00'
  const MIN = 60 * 1000

  /** Real (unfaked) macrotask turns, so Dexie/fake-indexeddb work inside the gate can finish. */
  async function drain() {
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => setImmediate(r))
      await settle()
    }
  }

  function fullSyncCount() {
    return mocks.fullSync.mock.calls.length + mocks.syncRoundTrip.mock.calls.length
  }

  it('C1: a returning user with a fresh marker, a cursor and nothing newer makes ZERO full syncs on start, one probe', async () => {
    localStorage.setItem(realtimeCursorKey('me'), CURSOR)
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(2 * MIN)
    stopSyncManager = startSyncManager()
    await drain()
    expect(fullSyncCount()).toBe(0)
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(1)
    expect(mocks.newestUserEventSince).toHaveBeenCalledWith('me', CURSOR)
  })

  it('C1: a returning user whose probe finds a newer event on start asks for the catch-up, still no full sync', async () => {
    localStorage.setItem(realtimeCursorKey('me'), CURSOR)
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(2 * MIN)
    mocks.newestUserEventSince.mockResolvedValue({ newer: true, newest: '2026-09-24T02:00:00+00:00' })
    stopSyncManager = startSyncManager()
    await drain()
    expect(fullSyncCount()).toBe(0)
    expect(mocks.requestRealtimeCatchUp).toHaveBeenCalledTimes(1)
  })

  it('C2: first sign-in (no refresh marker) still runs exactly one syncRoundTrip on start, without probing', async () => {
    localStorage.removeItem(KWENTA_LAST_REFRESH_STORAGE_KEY)
    localStorage.setItem(realtimeCursorKey('me'), CURSOR)
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(Number.POSITIVE_INFINITY)
    stopSyncManager = startSyncManager()
    await drain()
    expect(mocks.syncRoundTrip).toHaveBeenCalledTimes(1)
    expect(mocks.fullSync).not.toHaveBeenCalled()
    expect(mocks.newestUserEventSince).not.toHaveBeenCalled()
  })

  it('C3: a tab focus while the startup sync is in flight does not queue a second full sync', async () => {
    // No cursor: the start gate must sync. The sync is held open while the tab gains focus.
    let release!: () => void
    // Once: a regression that re-runs must not leave a second, never-settling sync holding the
    // manager's in-flight flag for the cases after this one.
    mocks.fullSync.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ pushed: 0, pulled: 10, changed: 0, errors: [] }))),
    )
    stopSyncManager = startSyncManager()
    await vi.waitFor(() => expect(mocks.fullSync).toHaveBeenCalledTimes(1))
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('visibilitychange'))
    await drain()
    release()
    await drain()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(mocks.syncRoundTrip).not.toHaveBeenCalled()
  })

  it('C4: on start, a marker 59 minutes old only probes', async () => {
    localStorage.setItem(realtimeCursorKey('me'), CURSOR)
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(59 * MIN)
    stopSyncManager = startSyncManager()
    await drain()
    expect(fullSyncCount()).toBe(0)
    expect(mocks.newestUserEventSince).toHaveBeenCalledTimes(1)
  })

  it('C4: on start, a marker 60 minutes old runs one full sync', async () => {
    localStorage.setItem(realtimeCursorKey('me'), CURSOR)
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(60 * MIN)
    stopSyncManager = startSyncManager()
    await drain()
    expect(fullSyncCount()).toBe(1)
  })

  it('C4: the backup tick does not full-sync at 59 minutes with nothing staged, and does at 60', async () => {
    localStorage.setItem(realtimeCursorKey('me'), CURSOR)
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(2 * MIN)
    stopSyncManager = startSyncManager()
    await drain()
    mocks.fullSync.mockClear()
    mocks.syncRoundTrip.mockClear()

    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(59 * MIN)
    vi.advanceTimersByTime(5 * MIN)
    await drain()
    expect(fullSyncCount()).toBe(0)

    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(60 * MIN)
    vi.advanceTimersByTime(5 * MIN)
    await drain()
    expect(fullSyncCount()).toBe(1)
  })

  it('the browser online event no longer starts a sync of its own (reconnect restarts the manager)', async () => {
    localStorage.setItem(realtimeCursorKey('me'), CURSOR)
    mocks.getMillisecondsSinceLastRefresh.mockReturnValue(2 * MIN)
    stopSyncManager = startSyncManager()
    await drain()
    const probes = mocks.newestUserEventSince.mock.calls.length
    const syncs = fullSyncCount()
    window.dispatchEvent(new Event('online'))
    await drain()
    expect(fullSyncCount()).toBe(syncs)
    expect(mocks.newestUserEventSince.mock.calls.length).toBe(probes)
  })
})

/**
 * sync-realign C27: a sign-out or account switch wipes the mirror while a sync is in flight. That
 * sync's outcome belongs to no session: it must not flag an error, schedule a retry or fail the
 * next user's hydration — and since it held the in-flight flag, the next session's own start sync
 * may have been turned away, so it runs once more.
 */
describe('a sync that outlives its session', () => {
  it('sets no error or retry and runs once more for whoever is signed in now', async () => {
    await startManager()
    mocks.fullSync.mockImplementationOnce(async () => {
      bumpSessionEpoch()
      return { pushed: 0, pulled: 0, changed: 0, errors: ['Sync abandoned: the session ended'] }
    })

    requestSyncNow()
    await settle()
    await settle()

    expect(mocks.fullSync).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().syncStatus).toBe('idle')
    expect(useAppStore.getState().syncRetryAt).toBeNull()
  })
})

/**
 * Review H1.2: a full sync never sends a row the write queue owns, so a path that exists to get
 * changes out must drain the queue as well — or a queued write sits behind its backoff until a
 * focus or the backup tick, while the Refresh button the header points at does nothing for it.
 */
describe('the queue is drained by every path that sends changes', () => {
  it('Refresh drains the queue ignoring its backoff, BEFORE its full sync', async () => {
    await startManager()

    requestSyncNow()
    await settle()

    expect(mocks.drainWriteQueue).toHaveBeenCalledWith('me', { ignoreBackoff: true })
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
    expect(mocks.drainWriteQueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.fullSync.mock.invocationCallOrder[0])
  })

  it('Refresh waits for the drain: the full sync starts only once the queue has been sent', async () => {
    await startManager()
    let release!: () => void
    mocks.drainWriteQueue.mockImplementationOnce(
      () => new Promise((r) => (release = () => r({ applied: 1, refused: 0 }))),
    )

    requestSyncNow()
    await settle()
    expect(mocks.fullSync).not.toHaveBeenCalled()

    release()
    await settle()
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('a drain that throws does not stop the Refresh sync', async () => {
    await startManager()
    mocks.drainWriteQueue.mockRejectedValueOnce(new Error('boom'))

    requestSyncNow()
    await settle()

    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('the sync retry timer drains the queue (keeping its backoff) along with its sync', async () => {
    await startManager()
    mocks.fullSync.mockResolvedValueOnce({ pushed: 0, pulled: 0, changed: 0, errors: ['boom'] })
    requestSyncNow()
    await settle()
    expect(useAppStore.getState().syncStatus).toBe('error')
    mocks.drainWriteQueue.mockClear()

    vi.advanceTimersByTime(30_000)
    await settle()

    expect(mocks.drainWriteQueue).toHaveBeenCalledWith('me')
    expect(mocks.fullSync).toHaveBeenCalledTimes(2)
  })

  it('a local change (triggerSync) drains the queue in the background, keeping its backoff', async () => {
    await startManager()

    syncManager.triggerSync()
    vi.advanceTimersByTime(400)
    await settle()

    expect(mocks.drainWriteQueue).toHaveBeenCalledWith('me')
    expect(mocks.fullSync).toHaveBeenCalledTimes(1)
  })

  it('a refresh through the gate drains in the background too', async () => {
    localStorage.setItem(realtimeCursorKey('me'), '2026-09-24T01:00:00+00:00')
    await startManager()

    window.dispatchEvent(new Event('focus'))
    await settle()

    expect(mocks.drainWriteQueue).toHaveBeenCalledWith('me')
    expect(mocks.fullSync).not.toHaveBeenCalled()
  })
})
