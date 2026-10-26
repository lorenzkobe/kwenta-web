import { create } from 'zustand'
import { readLastRefreshAt, writeLastCheckedAt } from '@/lib/kwenta-storage-keys'
import { endpointFamily } from '@/api/read-scope'

type SyncStatus = 'idle' | 'syncing' | 'error'

/** First cloud refresh after sign-in (no refresh marker) — gate shell until success or offline/error escape hatch. */
export type InitialCloudHydration = 'pending' | 'ready' | 'failed'

function initialCloudHydrationFromStorage(): InitialCloudHydration {
  if (typeof localStorage === 'undefined') return 'pending'
  // readLastRefreshAt() migrates the legacy cursor key, so an upgraded install counts as
  // hydrated instead of re-gating the shell behind a fresh refresh.
  return readLastRefreshAt() ? 'ready' : 'pending'
}
type RuntimeFlagKey =
  | 'dedupeSyncEnabled'
  | 'realtimeCatchupSingleRun'
  | 'notificationPushOnlyMode'
  | 'targetedRealtimeReconcile'
  | 'coalesceRealtimeBatch'

type RuntimeFlags = Record<RuntimeFlagKey, boolean>

interface AppState {
  isOnline: boolean
  syncStatus: SyncStatus
  syncRetryAt: number | null
  currentUserId: string | null
  realtimeNotice: { message: string; at: number } | null
  runtimeFlags: RuntimeFlags
  initialCloudHydration: InitialCloudHydration
  pullStale: boolean
  /**
   * Bumped whenever server-held data may have changed — a manual refresh, a completed sync, a
   * realtime event, or a local write. Server-backed screens re-fetch when it changes.
   *
   * With reads moving to scoped endpoints, `useLiveQuery` no longer sees a change: nothing wrote
   * to Dexie. This counter is the invalidation signal that replaces it.
   */
  dataVersion: number
  /**
   * Per endpoint family, how many bumps named it as unaffected (`bumpDataVersion(skip)`). A screen
   * watches `dataVersion - skippedBumps[family]` (`relevantDataVersion`): counting rather than
   * flagging "the last bump skipped me" means a skipped and a full bump coalesced into one render
   * still move the screen.
   */
  skippedBumps: Record<string, number>
  /**
   * Screen fetches in flight while online: each `useServerData` holds one begin/end pair. Only the
   * header's loading bar and Refresh button subscribe, so moving it re-renders no page.
   */
  screenLoadCount: number
  /**
   * The last check stamped in this tab: the header's re-render signal. The stored marker
   * (`readLastUpToDateAt`) stays the value it reads, so a wipe that removes it wins.
   */
  lastCheckedAt: string | null

  setOnline: (online: boolean) => void
  setSyncStatus: (status: SyncStatus) => void
  setSyncRetryAt: (retryAt: number | null) => void
  setCurrentUserId: (id: string | null) => void
  setRealtimeNotice: (message: string | null) => void
  setRuntimeFlag: (key: RuntimeFlagKey, enabled: boolean) => void
  setInitialCloudHydration: (state: InitialCloudHydration) => void
  setPullStale: (stale: boolean) => void
  bumpDataVersion: (skipFamilies?: readonly string[]) => void
  beginScreenLoad: () => void
  endScreenLoad: () => void
  /** The server just confirmed this device's copy is current without a full refresh. */
  markServerChecked: () => void
}

export const useAppStore = create<AppState>((set) => ({
  isOnline: navigator.onLine,
  syncStatus: 'idle',
  syncRetryAt: null,
  currentUserId: null,
  realtimeNotice: null,
  initialCloudHydration: initialCloudHydrationFromStorage(),
  pullStale: false,
  dataVersion: 0,
  skippedBumps: {},
  screenLoadCount: 0,
  lastCheckedAt: null,
  runtimeFlags: {
    dedupeSyncEnabled: true,
    realtimeCatchupSingleRun: true,
    notificationPushOnlyMode: true,
    targetedRealtimeReconcile: true,
    coalesceRealtimeBatch: true,
  },

  setOnline: (online) => set({ isOnline: online }),
  setSyncStatus: (syncStatus) => set({ syncStatus }),
  setSyncRetryAt: (syncRetryAt) => set({ syncRetryAt }),
  setCurrentUserId: (currentUserId) => set({ currentUserId }),
  setRealtimeNotice: (message) =>
    set({ realtimeNotice: message ? { message, at: Date.now() } : null }),
  setRuntimeFlag: (key, enabled) =>
    set((state) => ({ runtimeFlags: { ...state.runtimeFlags, [key]: enabled } })),
  setInitialCloudHydration: (initialCloudHydration) => set({ initialCloudHydration }),
  setPullStale: (pullStale) => set({ pullStale }),
  bumpDataVersion: (skipFamilies) =>
    set((state) => {
      if (!skipFamilies || skipFamilies.length === 0) return { dataVersion: state.dataVersion + 1 }
      const skippedBumps = { ...state.skippedBumps }
      for (const family of new Set(skipFamilies)) skippedBumps[family] = (skippedBumps[family] ?? 0) + 1
      return { dataVersion: state.dataVersion + 1, skippedBumps }
    }),
  beginScreenLoad: () => set((state) => ({ screenLoadCount: state.screenLoadCount + 1 })),
  // Floored: a negative balance would swallow the next load and hide the bar for it.
  endScreenLoad: () =>
    set((state) => ({ screenLoadCount: Math.max(0, state.screenLoadCount - 1) })),
  markServerChecked: () => {
    const at = new Date().toISOString()
    writeLastCheckedAt(at)
    set({ lastCheckedAt: at })
  },
}))

/** The version a screen refetches on: every bump except the ones that named its family unaffected. */
export function relevantDataVersion(
  state: Pick<AppState, 'dataVersion' | 'skippedBumps'>,
  endpointKey?: string,
): number {
  if (!endpointKey) return state.dataVersion
  return state.dataVersion - (state.skippedBumps[endpointFamily(endpointKey)] ?? 0)
}
