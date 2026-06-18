/** User chose Sign out in Settings (not session expiry / tab close). */
const VOLUNTARY_SIGN_OUT_KEY = 'kwenta_voluntary_sign_out'

export function markVoluntarySignOut() {
  try {
    sessionStorage.setItem(VOLUNTARY_SIGN_OUT_KEY, '1')
  } catch {
    /* sessionStorage unavailable; best effort */
  }
}

export function consumeVoluntarySignOut(): boolean {
  try {
    const v = sessionStorage.getItem(VOLUNTARY_SIGN_OUT_KEY) === '1'
    sessionStorage.removeItem(VOLUNTARY_SIGN_OUT_KEY)
    return v
  } catch {
    return false
  }
}

export const SESSION_EXPIRED_MESSAGE_KEY = 'kwenta_show_session_expired_on_login'

/** Shown on login after sign-out because account_status is not active. */
export const INACTIVE_ACCOUNT_MESSAGE_KEY = 'kwenta_show_inactive_account_on_login'
