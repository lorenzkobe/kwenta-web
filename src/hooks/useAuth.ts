import { useCallback, useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { db } from '@/db/db'
import { useAppStore } from '@/store/app-store'
import { generateId, getDeviceId, now } from '@/lib/utils'

const LOCAL_USER_KEY = 'kwenta_local_user_id'

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
  }
}

async function bootstrapLocalUser(
  setCurrentUserId: (id: string | null) => void,
) {
  let userId = localStorage.getItem(LOCAL_USER_KEY)
  if (userId) {
    const existing = await db.profiles.get(userId)
    if (existing) {
      setCurrentUserId(userId)
      return
    }
  }
  userId = generateId()
  const timestamp = now()
  await db.profiles.add({
    id: userId,
    email: '',
    display_name: 'You',
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
  localStorage.setItem(LOCAL_USER_KEY, userId)
  setCurrentUserId(userId)
}

export function useAuth() {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const setCurrentUserId = useAppStore((s) => s.setCurrentUserId)

  const handleBootstrap = useCallback(() => {
    return bootstrapLocalUser(setCurrentUserId)
  }, [setCurrentUserId])

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) {
        ensureProfile(u.id, u.email ?? '')
        setCurrentUserId(u.id)
      } else {
        handleBootstrap()
      }
      setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      const u = session?.user ?? null
      setUser(u)
      if (u) {
        ensureProfile(u.id, u.email ?? '')
        setCurrentUserId(u.id)
      }
    })

    return () => subscription.unsubscribe()
  }, [setCurrentUserId, handleBootstrap])

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

  const signOutFn = useCallback(async () => {
    await supabase.auth.signOut()
    setUser(null)
    setCurrentUserId(null)
    await handleBootstrap()
  }, [setCurrentUserId, handleBootstrap])

  const updateDisplayName = useCallback(async (displayName: string) => {
    const userId = useAppStore.getState().currentUserId
    if (!userId) return
    await db.profiles.update(userId, {
      display_name: displayName,
      updated_at: now(),
    })
  }, [])

  return {
    user,
    loading,
    isAuthenticated: !!user,
    signIn,
    signUp,
    resetPassword,
    signOut: signOutFn,
    updateDisplayName,
  }
}
