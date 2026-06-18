import { beforeEach, describe, expect, it } from 'vitest'
import { consumeVoluntarySignOut, markVoluntarySignOut } from '@/lib/auth-session-flags'

describe('voluntary sign-out flag', () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it('returns false when never marked', () => {
    expect(consumeVoluntarySignOut()).toBe(false)
  })

  it('returns true once after marking, then clears', () => {
    markVoluntarySignOut()
    expect(consumeVoluntarySignOut()).toBe(true)
    // consumed — the flag is one-shot
    expect(consumeVoluntarySignOut()).toBe(false)
  })
})
