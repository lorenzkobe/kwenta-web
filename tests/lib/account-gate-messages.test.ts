import { describe, expect, it } from 'vitest'
import { messageForAccountNotActive } from '@/lib/account-gate-messages'

describe('messageForAccountNotActive', () => {
  it('asks to confirm email when unconfirmed', () => {
    expect(messageForAccountNotActive('unconfirmed')).toMatch(/confirm your email/i)
  })

  it('explains inactive accounts need an admin', () => {
    const msg = messageForAccountNotActive('inactive')
    expect(msg).toMatch(/inactive/i)
    expect(msg).toMatch(/administrator/i)
  })

  it('falls back to a generic message for unknown/undefined status', () => {
    expect(messageForAccountNotActive(undefined)).toMatch(/not ready to sign in/i)
  })
})
