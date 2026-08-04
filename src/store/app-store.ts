import { create } from 'zustand'
import { readLastRefreshAt } from '@/lib/kwenta-storage-keys'

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

  setOnline: (online: boolean) => void
  setSyncStatus: (status: SyncStatus) => void
  setSyncRetryAt: (retryAt: number | null) => void
  setCurrentUserId: (id: string | null) => void
  setRealtimeNotice: (message: string | null) => void
  setRuntimeFlag: (key: RuntimeFlagKey, enabled: boolean) => void
  setInitialCloudHydration: (state: InitialCloudHydration) => void
  setPullStale: (stale: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  isOnline: navigator.onLine,
  syncStatus: 'idle',
  syncRetryAt: null,
  currentUserId: null,
  realtimeNotice: null,
  initialCloudHydration: initialCloudHydrationFromStorage(),
  pullStale: false,
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
}))
