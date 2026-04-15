import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LandingProductDemo } from './LandingProductDemo'

export function LandingHero() {
  return (
    <section className="relative overflow-hidden border-b border-stone-200/60 bg-[linear-gradient(180deg,#f7f4ee_0%,#f6f2eb_55%,#f3efe8_100%)]">
      <div className="pointer-events-none absolute -right-20 top-0 h-104 w-104 rounded-full bg-teal-700/15 blur-3xl" />
      <div className="pointer-events-none absolute -left-28 bottom-0 h-96 w-96 rounded-full bg-amber-300/35 blur-3xl" />

      <div className="relative mx-auto max-w-7xl px-4 py-12 sm:px-6 sm:py-16 lg:px-8 lg:pt-12 lg:pb-16">
        <div className="mx-auto max-w-3xl text-center">
          <p className="inline-flex items-center rounded-full border border-stone-200 bg-white/80 px-4 py-1.5 text-sm font-medium text-stone-700 shadow-sm">
            Fair, flexible expense splitting
          </p>
          <h1 className="font-display mt-5 text-4xl font-semibold tracking-tight text-stone-900 sm:text-5xl lg:text-[3.15rem] lg:leading-[1.08]">
            Split shared expenses with confidence.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-stone-600 sm:text-lg">
            Kwenta keeps every bill clear: set titles, currencies, split styles, and participants in seconds.
            Stay lightweight for quick splits, then unlock saved history and collaboration when you sign in.
          </p>

          <p className="mx-auto mt-4 max-w-2xl text-sm font-medium text-stone-700 sm:text-base">
            Want to split some bills? Try the free demo below. It is open for everyone.
          </p>

          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Button
              asChild
              size="lg"
              className="rounded-full bg-teal-800 px-7 text-base hover:bg-teal-900"
            >
              <a href="#demo">
                Try it out
                <ArrowRight className="size-4" />
              </a>
            </Button>
            <Button asChild size="lg" variant="outline" className="rounded-full border-stone-300 px-7 text-base">
              <Link to="/login">Sign in for saved history and groups</Link>
            </Button>
          </div>
        </div>

        <div className="mx-auto mt-10 w-full max-w-5xl">
          <LandingProductDemo variant="embedded" />
        </div>
      </div>
    </section>
  )
}
