import { Outlet } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { BottomNav } from './BottomNav'
import { AppHeader } from './AppHeader'
import { AccountBanner } from '@/components/common/AccountBanner'
import { InstallPrompt } from '@/components/common/InstallPrompt'
import { OfflineBanner } from '@/components/common/OfflineBanner'
import { useOnlineStatus } from '@/hooks/useOnlineStatus'
import { useAuth } from '@/hooks/useAuth'
import { useSync } from '@/hooks/useSync'

export function AppShell() {
  useOnlineStatus()
  const { loading } = useAuth()
  useSync()

  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-[linear-gradient(180deg,#f7fbff_0%,#eef6fb_100%)]">
        <Loader2 className="size-6 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col bg-[linear-gradient(180deg,#f7fbff_0%,#eef6fb_100%)] text-slate-800">
      <OfflineBanner />
      <AppHeader />

      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-24 pt-4 sm:px-6 lg:px-8 lg:pb-8">
        <Outlet />
      </main>

      <BottomNav />
      <AccountBanner />
      <InstallPrompt />
    </div>
  )
}
