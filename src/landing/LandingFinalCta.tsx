import { Link } from 'react-router-dom'
import { ArrowRight, CreditCard, ReceiptText, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function LandingFinalCta() {
  return (
    <section className="py-16 lg:py-20">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="overflow-hidden rounded-[1.75rem] border border-stone-800/10 bg-[linear-gradient(145deg,#1c1917_0%,#292524_48%,#1c1917_100%)] p-8 text-white shadow-[0_28px_80px_rgba(28,25,23,0.2)] lg:p-12">
          <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:items-center">
            <div>
              <h2 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
                Ready to make shared spending simpler?
              </h2>
              <p className="mt-4 text-base leading-relaxed text-stone-300">
                Kwenta helps you split with confidence now, then scale into saved history and collaborative
                group tracking when you sign in.
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="rounded-full border-white/40 !bg-transparent px-8 !text-white hover:!bg-white/10"
                >
                  <a href="#demo">Explore the experience</a>
                </Button>
                <Button
                  asChild
                  size="lg"
                  className="rounded-full bg-white px-8 text-stone-900 hover:bg-stone-100"
                >
                <Link to="/login">
                  Sign in to save everything
                  <ArrowRight className="size-4" />
                </Link>
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-1 lg:gap-4">
              <div className="rounded-2xl border border-white/10 bg-white/6 p-4">
                <Users className="size-5 text-teal-300" />
                <p className="mt-3 font-semibold">Personal + groups</p>
                <p className="mt-1 text-sm text-stone-400">
                  Your own bills (you paid) and group spaces where everyone can add what they fronted.
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/6 p-4">
                <ReceiptText className="size-5 text-teal-300" />
                <p className="mt-3 font-semibold">Line-item splits</p>
                <p className="mt-1 text-sm text-stone-400">Equal, custom, or percentage—per line.</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/6 p-4">
                <CreditCard className="size-5 text-teal-300" />
                <p className="mt-3 font-semibold">Settlements</p>
                <p className="mt-1 text-sm text-stone-400">Record who paid whom and close the loop.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
