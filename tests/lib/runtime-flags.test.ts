import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isRuntimeFlagEnabled, setRuntimeFlagOverride } from '@/lib/runtime-flags'
import { useAppStore } from '@/store/app-store'

describe('runtime flags', () => {
  beforeEach(() => {
    localStorage.clear()
    // Reset store defaults (all true).
    useAppStore.getState().setRuntimeFlag('dedupeSyncEnabled', true)
  })

  afterEach(() => {
    localStorage.clear()
  })

  it('falls back to the store default when no override is set', () => {
    expect(isRuntimeFlagEnabled('dedupeSyncEnabled')).toBe(true)
  })

  it('honors a "0" / "false" localStorage override', () => {
    localStorage.setItem('kwenta_flag:dedupeSyncEnabled', '0')
    expect(isRuntimeFlagEnabled('dedupeSyncEnabled')).toBe(false)
    localStorage.setItem('kwenta_flag:dedupeSyncEnabled', 'false')
    expect(isRuntimeFlagEnabled('dedupeSyncEnabled')).toBe(false)
  })

  it('honors a "1" / "true" localStorage override over a false store value', () => {
    useAppStore.getState().setRuntimeFlag('dedupeSyncEnabled', false)
    localStorage.setItem('kwenta_flag:dedupeSyncEnabled', '1')
    expect(isRuntimeFlagEnabled('dedupeSyncEnabled')).toBe(true)
  })

  it('setRuntimeFlagOverride persists to both localStorage and the store', () => {
    setRuntimeFlagOverride('dedupeSyncEnabled', false)
    expect(localStorage.getItem('kwenta_flag:dedupeSyncEnabled')).toBe('0')
    expect(useAppStore.getState().runtimeFlags.dedupeSyncEnabled).toBe(false)
    expect(isRuntimeFlagEnabled('dedupeSyncEnabled')).toBe(false)
  })
})
