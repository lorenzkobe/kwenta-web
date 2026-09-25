import type { ProfileAccountStatus } from '@/types'

/** User-facing copy when `profiles.account_status` is not `active`. */
export function messageForAccountNotActive(status: ProfileAccountStatus | undefined): string {
  if (status === 'unconfirmed') {
    return 'Please confirm your email before signing in.'
  }
  if (status === 'inactive') {
    return 'Your account is inactive. Contact an administrator to activate it before you can sign in.'
  }
  return 'Your account is not ready to sign in yet. Confirm your email or contact an administrator.'
}

/** The login notice before 076 stored no status (the flag was '1'); kept for that legacy value. */
export const LEGACY_INACTIVE_NOTICE =
  'Your account is inactive. Contact the administrator to activate it before you can use the app.'

/**
 * Login-page copy for the stored sign-out flag (`INACTIVE_ACCOUNT_MESSAGE_KEY`), which now holds the
 * `account_status` the server reported. Only the two statuses with their own copy are trusted;
 * anything else — the legacy '1', 'unknown' — keeps the old generic notice.
 */
export function inactiveNoticeFromFlag(flag: string): string {
  if (flag === 'unconfirmed' || flag === 'inactive') return messageForAccountNotActive(flag)
  return LEGACY_INACTIVE_NOTICE
}
