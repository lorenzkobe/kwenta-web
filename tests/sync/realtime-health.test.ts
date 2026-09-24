import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearRealtimeProcessingFailed,
  markRealtimeProcessingFailed,
  realtimeHealthToken,
  realtimeProcessingFailed,
} from '@/sync/realtime-health'

/**
 * The realtime cursor advances past an event even when applying it failed (the fallback pull can
 * fail too). The full sync that used to run on every tab focus healed that silently; with the focus
 * probe, this flag is what makes the next focus sync instead of trusting the cursor.
 */
beforeEach(() => clearRealtimeProcessingFailed())

describe('realtime health', () => {
  it('starts healthy, is marked by a failure and cleared by a successful sync', () => {
    expect(realtimeProcessingFailed()).toBe(false)
    markRealtimeProcessingFailed()
    expect(realtimeProcessingFailed()).toBe(true)
    clearRealtimeProcessingFailed()
    expect(realtimeProcessingFailed()).toBe(false)
  })
  it('a sync clears only the failures marked before it started', () => {
    const token = realtimeHealthToken() // a sync starts
    markRealtimeProcessingFailed() // an event fails while it runs
    clearRealtimeProcessingFailed(token) // the sync succeeds
    expect(realtimeProcessingFailed()).toBe(true)
    clearRealtimeProcessingFailed(realtimeHealthToken())
    expect(realtimeProcessingFailed()).toBe(false)
  })
})
