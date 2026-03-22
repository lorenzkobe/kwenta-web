import {
  BellRing,
  BookUser,
  CloudUpload,
  Home,
  Layers3,
  ReceiptText,
  Scale,
  UserRound,
  Wallet,
  WifiOff,
  Wifi,
} from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, NavLink } from 'react-router-dom'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { hasUnsyncedLocalDataForUser } from '@/sync/sync-service'
import { useAppStore } from '@/store/app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const navItems = [
  { to: '/app', icon: Home, label: 'Home', end: true },
  { to: '/app/bills', icon: ReceiptText, label: 'Bills', end: false },
  { to: '/app/groups', icon: Layers3, label: 'Groups', end: false },
  { to: '/app/people', icon: BookUser, label: 'People', end: false },
  { to: '/app/balances', icon: Scale, label: 'Balances', end: false },
] as const

export function AppHeader() {
  const isOnline = useAppStore((s) => s.isOnline)
  const syncStatus = useAppStore((s) => s.syncStatus)
  const { userId } = useCurrentUser()
  const waitingToSync = useLiveQuery(
    async () => (userId ? hasUnsyncedLocalDataForUser(userId) : false),
    [userId],
  )

  return (
    <header className="sticky top-0 z-30 border-b border-stone-200/80 bg-white/92 backdrop-blur">
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
          <Badge variant="ghost" className="px-3 py-2 text-xs font-medium">
            {!isOnline ? (
              <>
                <WifiOff className="mr-1 size-3" />
                Offline
              </>
            ) : syncStatus === 'syncing' ? (
              <>
                <Wifi className="mr-1 size-3" />
                Syncing…
              </>
            ) : syncStatus === 'error' ? (
              <>
                <Wifi className="mr-1 size-3 text-amber-600" />
                Sync issue
              </>
            ) : waitingToSync === true ? (
              <>
                <CloudUpload className="mr-1 size-3 text-amber-700" />
                Waiting to sync
              </>
            ) : (
              <>
                <Wifi className="mr-1 size-3" />
                Online
              </>
            )}
          </Badge>
          <Button variant="ghost" size="icon-sm" className="rounded-full">
            <BellRing className="size-4" />
          </Button>
          <Button asChild size="icon-sm" className="rounded-full">
            <Link to="/app/settings">
              <UserRound className="size-4" />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  )
}
