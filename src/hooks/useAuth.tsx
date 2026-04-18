/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { authRedirectUrl, supabase } from '@/lib/supabase'
import {
  consumeVoluntarySignOut,
  INACTIVE_ACCOUNT_MESSAGE_KEY,
  SESSION_EXPIRED_MESSAGE_KEY,
} from '@/lib/auth-session-flags'
import { withMetric } from '@/lib/client-metrics'
import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'
import { triggerSync } from '@/sync/sync-manager'
import type { Profile, ProfileUserType } from '@/types'
import { getDeviceId, now } from '@/lib/utils'

/**
 * Seed Dexie with the server profile when possible. Avoid inserting a local stub before the first
 * sync: kwenta_sync applies pushes before pulls, and a stub would overwrite Postgres display_name.
 * Uses put() so parallel callers don't race on add().
 */
async function ensureProfile(userId: string, email: string) {
  const cacheKey = `${userId}:${email}`
  if (ensureProfileInFlight.has(cacheKey)) {
    await ensureProfileInFlight.get(cacheKey)
    return
  }

  const task = (async () => {
  const existing = await db.profiles.get(userId)
  if (existing) return

  const { data: remote, error } = await withMetric(
    'auth.ensureProfile.fetch',
    () => supabase.from('profiles').select('*').eq('id', userId).maybeSingle(),
  )

  if (error) {
    console.warn('[auth] could not load profile from cloud', error)
  }

  if (remote) {
    const r = remote as Profile
    await db.profiles.put({
      ...r,
      synced_at: r.updated_at,
    })
    return
  }

  const timestamp = now()
  await db.profiles.put({
    id: userId,
    email,
    display_name: email.split('@')[0] || 'User',
    avatar_url: null,
    user_type: 'user',
    account_status: 'active',
    is_local: false,
    linked_profile_id: null,
    owner_id: null,
    created_at: timestamp,
    updated_at: timestamp,
    synced_at: null,
    is_deleted: false,
    device_id: getDeviceId(),
  })
  triggerSync()
  })()

  ensureProfileInFlight.set(cacheKey, task)
  try {
    await task
  } finally {
    ensureProfileInFlight.delete(cacheKey)
  }
}

const ensureProfileInFlight = new Map<string, Promise<void>>()

type AuthContextValue = {
  user: User | null
  /**
   * Mirrors `profiles.user_type` for the signed-in user. `null` only when logged out — never “unknown role”;
   * the database column defaults to `user` and is NOT NULL.
   */
  userType: ProfileUserType | null
  loading: boolean
  isAuthenticated: boolean
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>
  signUp: (
    email: string,
    password: string,
  ) => Promise<{ error: Error | null; requiresEmailConfirmation: boolean }>
  resetPassword: (email: string) => Promise<{ error: Error | null }>
  updateDisplayName: (displayName: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * Single source of truth for session + profile bootstrap. Must wrap any tree that calls `useAuth`.
 * (Previously each `useAuth()` call had its own state, so AppShell re-entered `loading: true` after
 * RequireAuth and could spin forever if `ensureProfile` threw.)
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [userType, setUserType] = useState<ProfileUserType | null>(null)
  const [loading, setLoading] = useState(true)
  const setCurrentUserId = useAppStore((s) => s.setCurrentUserId)
  const prevAuthUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function applySession(session: Session | null) {
      if (!session?.user) {
        setUser(null)
        setUserType(null)
        setCurrentUserId(null)
        return
      }

      const u = session.user
      const { data: prof, error } = await withMetric('auth.accountGate', () =>
        supabase.from('profiles').select('account_status, user_type').eq('id', u.id).maybeSingle(),
      )

      if (error) {
        console.warn('[auth] account gate failed', error)
        sessionStorage.setItem(INACTIVE_ACCOUNT_MESSAGE_KEY, '1')
        await supabase.auth.signOut()
        setUser(null)
        setUserType(null)
        setCurrentUserId(null)
        return
      }

      if (!prof || prof.account_status !== 'active') {
        sessionStorage.setItem(INACTIVE_ACCOUNT_MESSAGE_KEY, '1')
        await supabase.auth.signOut()
        setUser(null)
        setUserType(null)
        setCurrentUserId(null)
        return
      }

      setUser(u)
      setUserType(prof.user_type === 'admin' ? 'admin' : 'user')
      setCurrentUserId(u.id)
      try {
        await ensureProfile(u.id, u.email ?? '')
      } catch (e) {
        console.warn('[auth] ensureProfile failed', e)
      }
    }

    void (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()
        if (cancelled) return
        await applySession(session)
      } catch (e) {
        console.warn('[auth] session bootstrap failed', e)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user ?? null
      const nextId = u?.id ?? null
      const prevId = prevAuthUserIdRef.current
      prevAuthUserIdRef.current = nextId

      if (!nextId && prevId && event === 'SIGNED_OUT') {
        if (
          !sessionStorage.getItem(INACTIVE_ACCOUNT_MESSAGE_KEY) &&
          !consumeVoluntarySignOut()
        ) {
          sessionStorage.setItem(SESSION_EXPIRED_MESSAGE_KEY, '1')
        }
      }

      void applySession(session).then(() => {
        if (!cancelled) setLoading(false)
      })
    })

    return () => {
      cancelled = true
      subscription.unsubscribe()
    }
  }, [setCurrentUserId])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }, [])

  const signUp = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Must match an entry under Supabase → Authentication → URL Configuration → Redirect URLs
        emailRedirectTo: authRedirectUrl('/login'),
      },
    })
    return { error, requiresEmailConfirmation: !data.session }
  }, [])

  const resetPassword = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: authRedirectUrl('/app/settings'),
    })
    return { error }
  }, [])

  const updateDisplayName = useCallback(async (displayName: string) => {
    const userId = useAppStore.getState().currentUserId
    if (!userId) return

    const trimmed = displayName.trim()
    const timestamp = now()

    const existing = await db.profiles.get(userId)
    if (!existing) return

    await db.profiles.update(userId, {
      display_name: trimmed,
      updated_at: timestamp,
      synced_at: null,
    })

    const memberships = await db.group_members.where('user_id').equals(userId).toArray()
    for (const m of memberships) {
      if (m.is_deleted) continue
      await db.group_members.update(m.id, {
        display_name: trimmed,
        updated_at: timestamp,
        synced_at: null,
      })
    }

    const {
      data: { session },
    } = await supabase.auth.getSession()
    if (!session?.user) {
      triggerSync()
      return
    }

    const row = await db.profiles.get(userId)
    if (!row) return

    const { error } = await supabase.from('profiles').upsert(
      {
        id: row.id,
        email: row.email,
        display_name: row.display_name,
        avatar_url: row.avatar_url,
        created_at: row.created_at,
        updated_at: timestamp,
        synced_at: timestamp,
        is_deleted: row.is_deleted,
        device_id: row.device_id,
        is_local: row.is_local,
        linked_profile_id: row.linked_profile_id,
        owner_id: row.owner_id,
      },
      { onConflict: 'id' },
    )

    if (error) {
      console.warn('[profile] cloud display_name update failed', error)
      triggerSync()
      return
    }

    await db.profiles.update(userId, { synced_at: timestamp })
    void supabase.auth.updateUser({ data: { display_name: trimmed } }).catch(() => {
      /* optional metadata; ignore */
    })
    triggerSync()
  }, [])

  const value: AuthContextValue = {
    user,
    userType,
    loading,
    isAuthenticated: !!user,
    signIn,
    signUp,
    resetPassword,
    updateDisplayName,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}
