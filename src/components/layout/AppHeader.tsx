import {
  BookUser,
  CloudUpload,
  Home,
  Layers3,
  ReceiptText,
  Search,
  UserRound,
  Users,
  Wallet,
  WifiOff,
  Wifi,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, NavLink } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { hasUnsyncedLocalDataForUser } from '@/sync/sync-service'
import { useAppStore } from '@/store/app-store'
import { requestSyncNow } from '@/sync/sync-manager'
import { cn } from '@/lib/utils'
import { NotificationsBell } from '@/components/notifications/NotificationsBell'
import { GlobalSearchSheet } from '@/components/common/GlobalSearchSheet'
import { Button } from '@/components/ui/button'

const baseNavItems = [
  { to: '/app', icon: Home, label: 'Home', end: true },
  { to: '/app/bills', icon: ReceiptText, label: 'Bills', end: false },
  { to: '/app/groups', icon: Layers3, label: 'Groups', end: false },
  { to: '/app/people', icon: BookUser, label: 'People', end: false },
] as const

const adminNavItem = { to: '/app/users', icon: Users, label: 'Users', end: false }

export function AppHeader() {
  const { userType } = useAuth()
  const navItems = userType === 'admin' ? [...baseNavItems, adminNavItem] : [...baseNavItems]
  const isOnline = useAppStore((s) => s.isOnline)
  const syncStatus = useAppStore((s) => s.syncStatus)
  const syncRetryAt = useAppStore((s) => s.syncRetryAt)
  const { userId } = useCurrentUser()
  const [nowMs, setNowMs] = useState(() => Date.now())
  const waitingToSync = useLiveQuery(
    async () => (userId ? hasUnsyncedLocalDataForUser(userId) : false),
    [userId],
  )
  useEffect(() => {
    if (!syncRetryAt) return
    const id = window.setInterval(() => setNowMs(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [syncRetryAt])

  const retrySeconds = syncRetryAt ? Math.max(0, Math.ceil((syncRetryAt - nowMs) / 1000)) : null
  const retryLabel = retrySeconds !== null ? `Retry in ~${retrySeconds}s` : null
  const [searchOpen, setSearchOpen] = useState(false)

  return (
    <>
    {searchOpen && <GlobalSearchSheet onClose={() => setSearchOpen(false)} />}
    <header className="sticky top-0 z-30 border-b border-stone-200/80 bg-white/92 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link to="/app" className="flex items-center gap-2.5">
            <div className="rounded-xl bg-teal-800/12 p-2 text-teal-800">
              <Wallet className="size-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight">Kwenta</span>
          </Link>

          <nav className="hidden items-center gap-1 lg:flex">
            {navItems.map(({ to, icon: Icon, label, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-teal-800/10 text-teal-800'
                      : 'text-stone-500 hover:bg-stone-100/80 hover:text-stone-900',
                  )
                }
              >
                <Icon className="size-3.5" />
                {label}
              </NavLink>
            ))}
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="rounded-full text-stone-500 hover:bg-stone-100 hover:text-stone-800"
            aria-label="Search"
            onClick={() => setSearchOpen(true)}
          >
            <Search className="size-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!isOnline || syncStatus === 'syncing'}
            onClick={() => requestSyncNow()}
            title={
              !isOnline
                ? 'Offline — connect to the internet to sync'
                : syncStatus === 'syncing'
                  ? 'Sync in progress…'
                  : syncStatus === 'error'
                    ? retryLabel
                      ? `${retryLabel} — tap to retry now`
                      : 'Tap to retry sync'
                    : 'Tap to sync now'
            }
            className="h-auto max-w-44 gap-0 rounded-full border-stone-200/80 bg-stone-50 px-3 py-2 text-xs font-medium text-stone-600 hover:bg-stone-100 disabled:opacity-90 sm:max-w-none"
          >
            {!isOnline ? (
              <>
                <WifiOff className="mr-1 size-3 shrink-0" />
                <span className="truncate">Offline</span>
              </>
            ) : syncStatus === 'syncing' ? (
              <>
                <Wifi className="mr-1 size-3 shrink-0" />
                <span className="truncate">Syncing…</span>
              </>
            ) : syncStatus === 'error' ? (
              <>
                <Wifi className="mr-1 size-3 shrink-0 text-amber-600" />
                <span className="truncate">{retryLabel ?? 'Sync issue'}</span>
              </>
            ) : waitingToSync === true ? (
              <>
                <CloudUpload className="mr-1 size-3 shrink-0 text-amber-700" />
                <span className="truncate">Waiting to sync</span>
              </>
            ) : (
              <>
                <Wifi className="mr-1 size-3 shrink-0" />
                <span className="truncate">Online</span>
              </>
            )}
          </Button>
          {userId ? <NotificationsBell userId={userId} /> : null}
          <Button asChild size="icon-sm" className="rounded-full">
            <Link to="/app/settings">
              <UserRound className="size-4" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
    </>
  )
}
