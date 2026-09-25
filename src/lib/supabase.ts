import { createClient } from '@supabase/supabase-js'
import { INACTIVE_ACCOUNT_MESSAGE_KEY } from '@/lib/auth-session-flags'
import { ACCOUNT_INACTIVE_MARKER } from '@/sync/write-errors'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string
const supabaseKey = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_DEFAULT_KEY ||
  import.meta.env.VITE_SUPABASE_ANON_KEY) as string
const appOriginFromEnv = (import.meta.env.VITE_APP_ORIGIN as string | undefined)?.trim()

function getAppOrigin(): string {
  if (appOriginFromEnv && appOriginFromEnv.length > 0) {
    return appOriginFromEnv.replace(/\/+$/, '')
  }
  if (typeof window !== 'undefined' && window.location.origin) {
    return window.location.origin
  }
  return ''
}

export function authRedirectUrl(path: string): string {
  const origin = getAppOrigin()
  const normalized = path.startsWith('/') ? path : `/${path}`
  return `${origin}${normalized}`
}

const INACTIVE_PREFIX = `${ACCOUNT_INACTIVE_MARKER}:`

/** The status from a PostgREST 42501 error whose message IS 076's marker; null for anything else. */
function inactiveStatusFrom(body: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const { code, message } = parsed as { code?: unknown; message?: unknown }
  if (code !== '42501' || typeof message !== 'string' || !message.startsWith(INACTIVE_PREFIX)) return null
  return message.slice(INACTIVE_PREFIX.length) || 'unknown'
}

let inactiveSignOutInFlight = false

/**
 * Migration 076 answers every request of a signed-in caller whose account is not active with a 403
 * PostgREST error: code 42501, message `kwenta_account_inactive:<status>`. Whichever request sees
 * it first signs this device out, so a deactivation takes effect on the next call rather than at
 * the next app open. Only that exact shape counts — a substring anywhere in a 403 body could be
 * echoed text — and the sign-out is LOCAL: a response must never revoke the account's other
 * devices. The caller always gets the original response.
 */
async function signOutOnInactive(res: Response): Promise<void> {
  if (res.status !== 403 || inactiveSignOutInFlight) return
  let body: string
  try {
    body = await res.clone().text()
  } catch {
    return
  }
  const status = inactiveStatusFrom(body)
  if (!status || inactiveSignOutInFlight) return
  inactiveSignOutInFlight = true
  try {
    // The login page reads this flag; the status keeps 'unconfirmed' distinct from 'inactive'.
    sessionStorage.setItem(INACTIVE_ACCOUNT_MESSAGE_KEY, status)
  } catch {
    /* best effort */
  }
  try {
    await supabase.auth.signOut({ scope: 'local' })
  } catch (e) {
    console.warn('[auth] sign-out after an inactive-account refusal failed', e)
  } finally {
    inactiveSignOutInFlight = false
  }
}

const fetchWithAccountGate: typeof fetch = async (input, init) => {
  const res = await globalThis.fetch(input, init)
  void signOutOnInactive(res)
  return res
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  global: { fetch: fetchWithAccountGate },
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: true,
    persistSession: true,
  },
})
