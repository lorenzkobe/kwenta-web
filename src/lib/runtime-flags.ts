import { useAppStore } from '@/store/app-store'

export type RuntimeFlagKey =
  | 'dedupeSyncEnabled'
  | 'realtimeCatchupSingleRun'
  | 'notificationPushOnlyMode'
  | 'targetedRealtimeReconcile'

const STORAGE_PREFIX = 'kwenta_flag:'

function storageKey(key: RuntimeFlagKey): string {
  return `${STORAGE_PREFIX}${key}`
}

export function isRuntimeFlagEnabled(key: RuntimeFlagKey): boolean {
  const override = localStorage.getItem(storageKey(key))
  if (override === '0' || override === 'false') return false
  if (override === '1' || override === 'true') return true
  return useAppStore.getState().runtimeFlags[key]
}

export function setRuntimeFlagOverride(key: RuntimeFlagKey, enabled: boolean) {
  localStorage.setItem(storageKey(key), enabled ? '1' : '0')
  useAppStore.getState().setRuntimeFlag(key, enabled)
}

