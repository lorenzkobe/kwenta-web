import { useCallback, useEffect, useRef, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { consumeVoluntarySignOut, SESSION_EXPIRED_MESSAGE_KEY } from '@/lib/auth-session-flags'
import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'
import { triggerSync } from '@/sync/sync-manager'
import { getDeviceId, now } from '@/lib/utils'

async function ensureProfile(userId: string, email: string) {
  const existing = await db.profiles.get(userId)
  if (!existing) {
    const timestamp = now()
    await db.profiles.add({
      id: userId,
      email,
      display_name: email.split('@')[0] || 'User',
      avatar_url: null,
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
  }
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const setCurrentUserId = useAppStore((s) => s.setCurrentUserId)
  const prevAuthUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) {
        void ensureProfile(u.id, u.email ?? '')
        setCurrentUserId(u.id)
        prevAuthUserIdRef.current = u.id
      } else {
        setCurrentUserId(null)
        prevAuthUserIdRef.current = null
      }
      setLoading(false)
    })

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      const u = session?.user ?? null
      const nextId = u?.id ?? null

      if (!nextId && prevAuthUserIdRef.current && event === 'SIGNED_OUT') {
        if (!consumeVoluntarySignOut()) {
          sessionStorage.setItem(SESSION_EXPIRED_MESSAGE_KEY, '1')
        }
      }

      prevAuthUserIdRef.current = nextId

      setUser(u)
      if (u) {
        void ensureProfile(u.id, u.email ?? '')
        setCurrentUserId(u.id)
      } else {
        setCurrentUserId(null)
      }
    })

    return () => subscription.unsubscribe()
  }, [setCurrentUserId])

  const signIn = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error }
  }, [])

  const signUp = useCallback(async (email: string, password: string) => {
    const { error } = await supabase.auth.signUp({ email, password })
    return { error }
  }, [])

  const resetPassword = useCallback(async (email: string) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/app/settings`,
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

  return {
    user,
    loading,
    isAuthenticated: !!user,
    signIn,
    signUp,
    resetPassword,
    updateDisplayName,
  }
}
