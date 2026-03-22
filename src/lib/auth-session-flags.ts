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
