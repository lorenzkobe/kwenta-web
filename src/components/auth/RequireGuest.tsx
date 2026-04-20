import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

/**
 * Guest-only routes should wait for auth bootstrap so signed-in users redirect
 * before the child page mounts and paints.
 */
export function RequireGuest() {
  const { isAuthenticated, loading } = useAuth()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/app'

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[linear-gradient(180deg,#faf8f5_0%,#f0ebe3_55%,#ebe4da_100%)]">
        <Loader2 className="size-6 animate-spin text-teal-800" />
      </div>
    )
  }

  if (isAuthenticated) {
    return <Navigate to={from.startsWith('/') ? from : `/${from}`} replace />
  }

  return <Outlet />
}
