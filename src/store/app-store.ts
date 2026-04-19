import { create } from 'zustand'
import { KWENTA_LAST_PULL_STORAGE_KEY } from '@/lib/kwenta-storage-keys'

type SyncStatus = 'idle' | 'syncing' | 'error'

/** First cloud pull after sign-in (no last-pull cursor) — gate shell until success or offline/error escape hatch. */
export type InitialCloudHydration = 'pending' | 'ready' | 'failed'

function initialCloudHydrationFromStorage(): InitialCloudHydration {
  if (typeof localStorage === 'undefined') return 'pending'
  return localStorage.getItem(KWENTA_LAST_PULL_STORAGE_KEY) ? 'ready' : 'pending'
}
type RuntimeFlagKey =
  | 'dedupeSyncEnabled'
  | 'realtimeCatchupSingleRun'
  | 'notificationPushOnlyMode'
  | 'targetedRealtimeReconcile'

type RuntimeFlags = Record<RuntimeFlagKey, boolean>

interface AppState {
  isOnline: boolean
  syncStatus: SyncStatus
  syncRetryAt: number | null
  currentUserId: string | null
  realtimeNotice: { message: string; at: number } | null
  runtimeFlags: RuntimeFlags
  initialCloudHydration: InitialCloudHydration

  setOnline: (online: boolean) => void
  setSyncStatus: (status: SyncStatus) => void
  setSyncRetryAt: (retryAt: number | null) => void
  setCurrentUserId: (id: string | null) => void
  setRealtimeNotice: (message: string | null) => void
  setRuntimeFlag: (key: RuntimeFlagKey, enabled: boolean) => void
  setInitialCloudHydration: (state: InitialCloudHydration) => void
}

export const useAppStore = create<AppState>((set) => ({
  isOnline: navigator.onLine,
  syncStatus: 'idle',
  syncRetryAt: null,
  currentUserId: null,
  realtimeNotice: null,
  initialCloudHydration: initialCloudHydrationFromStorage(),
  runtimeFlags: {
    dedupeSyncEnabled: true,
    realtimeCatchupSingleRun: true,
    notificationPushOnlyMode: true,
    targetedRealtimeReconcile: true,
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
}))
