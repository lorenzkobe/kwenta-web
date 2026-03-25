import { createClient } from '@supabase/supabase-js'

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

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    flowType: 'pkce',
    detectSessionInUrl: true,
    persistSession: true,
  },
})
