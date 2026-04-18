import { BookUser, Home, Layers3, ReceiptText, Scale, UserRound, Users } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

const baseNavItems = [
  { to: '/app', icon: Home, label: 'Home', end: true },
  { to: '/app/bills', icon: ReceiptText, label: 'Bills', end: false },
  { to: '/app/groups', icon: Layers3, label: 'Groups', end: false },
  { to: '/app/people', icon: BookUser, label: 'People', end: false },
  { to: '/app/balances', icon: Scale, label: 'Balances', end: false },
] as const

const adminNavItem = { to: '/app/users', icon: Users, label: 'Users', end: false }
const profileNavItem = { to: '/app/settings', icon: UserRound, label: 'Profile', end: false }

export function BottomNav() {
  const { userType } = useAuth()
  const navItems =
    userType === 'admin' ? [...baseNavItems, adminNavItem, profileNavItem] : [...baseNavItems, profileNavItem]

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200/80 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
      <div
        className={cn(
          'mx-auto grid max-w-136 gap-0 px-1 py-1',
          userType === 'admin' ? 'grid-cols-7' : 'grid-cols-6',
        )}
      >
        {navItems.map(({ to, icon: Icon, label, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              cn(
                'flex flex-col items-center gap-0.5 py-2 text-[0.58rem] font-medium transition-colors',
                isActive
                  ? 'text-teal-800'
                  : 'text-stone-400 hover:text-stone-600',
              )
            }
          >
            <Icon className="size-5" />
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  )
}
