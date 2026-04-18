/** User chose Sign out in Settings (not session expiry / tab close). */
let voluntarySignOut = false

export function markVoluntarySignOut() {
  voluntarySignOut = true
}

export function consumeVoluntarySignOut(): boolean {
  const v = voluntarySignOut
  voluntarySignOut = false
  return v
}

export const SESSION_EXPIRED_MESSAGE_KEY = 'kwenta_show_session_expired_on_login'

/** Shown on login after sign-out because account_status is not active. */
export const INACTIVE_ACCOUNT_MESSAGE_KEY = 'kwenta_show_inactive_account_on_login'
