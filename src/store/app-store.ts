import { create } from 'zustand'

type SyncStatus = 'idle' | 'syncing' | 'error'
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

  setOnline: (online: boolean) => void
  setSyncStatus: (status: SyncStatus) => void
  setSyncRetryAt: (retryAt: number | null) => void
  setCurrentUserId: (id: string | null) => void
  setRealtimeNotice: (message: string | null) => void
  setRuntimeFlag: (key: RuntimeFlagKey, enabled: boolean) => void
}

export const useAppStore = create<AppState>((set) => ({
  isOnline: navigator.onLine,
  syncStatus: 'idle',
  syncRetryAt: null,
  currentUserId: null,
  realtimeNotice: null,
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
}))
