import { BookUser, Home, Layers3, ReceiptText, Scale, UserRound } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/app', icon: Home, label: 'Home', end: true },
  { to: '/app/bills', icon: ReceiptText, label: 'Bills', end: false },
  { to: '/app/groups', icon: Layers3, label: 'Groups', end: false },
  { to: '/app/people', icon: BookUser, label: 'People', end: false },
  { to: '/app/balances', icon: Scale, label: 'Balances', end: false },
  { to: '/app/settings', icon: UserRound, label: 'Profile', end: false },
] as const

export function BottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200/80 bg-white/95 backdrop-blur lg:hidden">
      <div className="mx-auto grid max-w-104 grid-cols-6 gap-0 px-1 py-1">
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
