import { create } from 'zustand'

type SyncStatus = 'idle' | 'syncing' | 'error'

interface AppState {
  isOnline: boolean
  syncStatus: SyncStatus
  currentUserId: string | null
  realtimeNotice: { message: string; at: number } | null

  setOnline: (online: boolean) => void
  setSyncStatus: (status: SyncStatus) => void
  setCurrentUserId: (id: string | null) => void
  setRealtimeNotice: (message: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  isOnline: navigator.onLine,
  syncStatus: 'idle',
  currentUserId: null,
  realtimeNotice: null,

  setOnline: (online) => set({ isOnline: online }),
  setSyncStatus: (syncStatus) => set({ syncStatus }),
  setCurrentUserId: (currentUserId) => set({ currentUserId }),
  setRealtimeNotice: (message) =>
    set({ realtimeNotice: message ? { message, at: Date.now() } : null }),
}))
