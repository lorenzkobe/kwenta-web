import { Navigate, Outlet } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

/**
 * Child routes are only rendered when the signed-in user has `user_type === 'admin'` on their profile.
 * Authorization is enforced again by Supabase RPCs / RLS.
 */
export function RequireAdmin() {
  const { loading, isAuthenticated, userType } = useAuth()

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[linear-gradient(180deg,#faf8f5_0%,#f0ebe3_55%,#ebe4da_100%)]">
        <Loader2 className="size-6 animate-spin text-teal-800" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: '/app/users' }} />
  }

  if (userType !== 'admin') {
    return <Navigate to="/app" replace />
  }

  return <Outlet />
}
