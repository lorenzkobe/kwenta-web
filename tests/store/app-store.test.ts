import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store/app-store'

describe('pullStale store flag', () => {
  it('defaults to false and toggles via setter', () => {
    expect(useAppStore.getState().pullStale).toBe(false)
    useAppStore.getState().setPullStale(true)
    expect(useAppStore.getState().pullStale).toBe(true)
    useAppStore.getState().setPullStale(false)
    expect(useAppStore.getState().pullStale).toBe(false)
  })
})
