import { Link } from 'react-router-dom'
import { Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'

const nav = [
  { href: '#demo', label: 'Experience' },
  { href: '#features', label: 'Features' },
  { href: '#how-it-works', label: 'How it works' },
  { href: '#benefits', label: 'Why sign in' },
] as const

export function LandingHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-stone-200/70 bg-[#faf8f5]/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <Link to="/" className="flex items-center gap-2.5 text-stone-900">
          <span className="flex size-10 items-center justify-center rounded-2xl bg-teal-800/12 text-teal-900">
            <Wallet className="size-5" />
          </span>
          <span className="font-display text-lg font-semibold tracking-tight">Kwenta</span>
        </Link>

        <nav className="hidden items-center gap-1 md:flex" aria-label="Page sections">
          {nav.map((item) => (
            <a
              key={item.href}
              href={item.href}
              className="rounded-full px-3 py-2 text-sm font-medium text-stone-600 transition-colors hover:bg-stone-200/60 hover:text-stone-900"
            >
              {item.label}
            </a>
          ))}
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" className="rounded-full text-stone-700 md:hidden" asChild>
            <a href="#demo">Explore</a>
          </Button>
          <Button size="sm" className="rounded-full bg-teal-800 px-4 hover:bg-teal-900" asChild>
            <Link to="/login">Sign in</Link>
          </Button>
        </div>
      </div>
    </header>
  )
}
