import { describe, expect, it } from 'vitest'
import {
  inactiveNoticeFromFlag,
  LEGACY_INACTIVE_NOTICE,
  messageForAccountNotActive,
} from '@/lib/account-gate-messages'

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

/**
 * The sign-out flag now carries the status the server reported (076: the background gate and the
 * fetch wrapper both store it), so the login page can tell an unconfirmed email from a deactivated
 * account. A flag written by an older build ('1') keeps the old generic notice.
 */
describe('inactiveNoticeFromFlag', () => {
  it('unconfirmed asks to confirm the email', () => {
    expect(inactiveNoticeFromFlag('unconfirmed')).toBe(messageForAccountNotActive('unconfirmed'))
    expect(inactiveNoticeFromFlag('unconfirmed')).toMatch(/confirm your email/i)
  })

  it('inactive points to an administrator', () => {
    expect(inactiveNoticeFromFlag('inactive')).toBe(messageForAccountNotActive('inactive'))
  })

  it('the legacy flag and an unknown status keep the generic notice', () => {
    expect(inactiveNoticeFromFlag('1')).toBe(LEGACY_INACTIVE_NOTICE)
    expect(inactiveNoticeFromFlag('unknown')).toBe(LEGACY_INACTIVE_NOTICE)
  })
})
