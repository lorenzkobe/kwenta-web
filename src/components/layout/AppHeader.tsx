import { BellRing, Home, Layers3, ReceiptText, Scale, UserRound, Wallet, WifiOff, Wifi } from 'lucide-react'
import { Link, NavLink } from 'react-router-dom'
import { useAppStore } from '@/store/app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

const navItems = [
  { to: '/app', icon: Home, label: 'Home', end: true },
  { to: '/app/bills', icon: ReceiptText, label: 'Bills', end: false },
  { to: '/app/groups', icon: Layers3, label: 'Groups', end: false },
  { to: '/app/balances', icon: Scale, label: 'Balances', end: false },
] as const

export function AppHeader() {
  const isOnline = useAppStore((s) => s.isOnline)
  const syncStatus = useAppStore((s) => s.syncStatus)

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200/80 bg-white/92 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex items-center gap-6">
          <Link to="/app" className="flex items-center gap-2.5">
            <div className="rounded-xl bg-blue-600/15 p-2 text-blue-600">
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
                      ? 'bg-blue-600/10 text-blue-600'
                      : 'text-slate-500 hover:bg-slate-100/60 hover:text-slate-800',
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
            {isOnline ? (
              <>
                <Wifi className="mr-1 size-3" />
                {syncStatus === 'syncing' ? 'Syncing…' : 'Online'}
              </>
            ) : (
              <>
                <WifiOff className="mr-1 size-3" />
                Offline
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
