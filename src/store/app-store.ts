import { create } from 'zustand'

type SyncStatus = 'idle' | 'syncing' | 'error'

interface AppState {
  isOnline: boolean
  syncStatus: SyncStatus
  currentUserId: string | null

  setOnline: (online: boolean) => void
  setSyncStatus: (status: SyncStatus) => void
  setCurrentUserId: (id: string | null) => void
}

export const useAppStore = create<AppState>((set) => ({
  isOnline: navigator.onLine,
  syncStatus: 'idle',
  currentUserId: null,

  setOnline: (online) => set({ isOnline: online }),
  setSyncStatus: (syncStatus) => set({ syncStatus }),
  setCurrentUserId: (currentUserId) => set({ currentUserId }),
}))
