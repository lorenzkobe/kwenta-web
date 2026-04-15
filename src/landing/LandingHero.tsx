import { Link } from 'react-router-dom'
import { ArrowRight, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'

const trustPoints = [
  'Split one total or itemized lines with clarity',
  'Flexible split types for real-world shared spending',
  'Designed for personal ledgers and group collaboration',
  'Sign in to save history, sync devices, and manage groups',
] as const

export function LandingHero() {
  return (
    <section className="relative overflow-hidden border-b border-stone-200/60">
      <div className="pointer-events-none absolute -right-24 top-0 h-96 w-96 rounded-full bg-teal-700/8 blur-3xl" />
      <div className="pointer-events-none absolute -left-32 bottom-0 h-80 w-80 rounded-full bg-amber-200/25 blur-3xl" />

      <div className="relative mx-auto max-w-7xl px-4 py-14 sm:px-6 sm:py-20 lg:px-8 lg:py-24">
        <div className="max-w-3xl">
          <p className="inline-flex items-center rounded-full border border-stone-200 bg-white/80 px-4 py-1.5 text-sm font-medium text-stone-700 shadow-sm">
            Fair, flexible expense splitting
          </p>

          <h1 className="font-display mt-6 text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl lg:text-[3.25rem] lg:leading-[1.1]">
            Split shared expenses with confidence, from quick personal spend to full group tracking.
          </h1>

          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-stone-600">
            Kwenta keeps every bill clear: set titles, currencies, split styles, and participants in seconds.
            Stay lightweight for quick splits, then unlock saved history and collaboration when you sign in.
          </p>

          <p className="mt-4 max-w-2xl text-base leading-relaxed text-stone-700">
            <span className="font-semibold text-stone-900">Personal bills</span> are your ledger—expenses{' '}
            <span className="font-semibold text-stone-900">you</span> paid for.{' '}
            <span className="font-semibold text-stone-900">Group bills</span> are shared: anyone in the group can add
            what they fronted; if someone else paid in real life, they record it on their account.
          </p>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button
              asChild
              size="lg"
              className="rounded-full bg-teal-800 px-7 text-base hover:bg-teal-900"
            >
              <a href="#demo">
                Explore the experience
                <ArrowRight className="size-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="rounded-full border-stone-300 px-7 text-base">
              <Link to="/login">Sign in to save and use groups</Link>
            </Button>
          </div>

          <div className="mt-10 grid gap-3 sm:grid-cols-2">
            {trustPoints.map((point) => (
              <div
                key={point}
                className="flex items-start gap-3 rounded-2xl border border-stone-200/80 bg-white/70 px-4 py-3 text-sm text-stone-700 shadow-sm"
              >
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-teal-800/12 text-teal-900">
                  <Check className="size-3.5" strokeWidth={2.5} />
                </span>
                <span>{point}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
