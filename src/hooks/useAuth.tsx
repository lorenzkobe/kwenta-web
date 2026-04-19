import { useContext } from 'react'
import type { AuthContextValue } from '@/hooks/auth-context'
import { AuthContext } from '@/hooks/auth-context'

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return ctx
}
