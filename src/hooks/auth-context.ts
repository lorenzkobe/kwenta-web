import { createContext } from 'react'
import type { User } from '@supabase/supabase-js'
import type { ProfileUserType } from '@/types'

export type AuthContextValue = {
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

export const AuthContext = createContext<AuthContextValue | null>(null)
