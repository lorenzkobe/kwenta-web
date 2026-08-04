import {
  BookUser,
  Home,
  Layers3,
  ReceiptText,
  Search,
  UserRound,
  Users,
  Wallet,
} from 'lucide-react'
import { useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn } from '@/lib/utils'
import { NotificationsBell } from '@/components/notifications/NotificationsBell'
import { GlobalSearchSheet } from '@/components/common/GlobalSearchSheet'
import { RefreshButton } from '@/components/common/RefreshButton'
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
  const { userId } = useCurrentUser()
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
          <RefreshButton showLastUpdated />
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
