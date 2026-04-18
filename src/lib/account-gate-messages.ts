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
