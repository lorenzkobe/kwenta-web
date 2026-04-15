import { RefreshCcw, ShieldCheck } from 'lucide-react'

export function LandingOffline() {
  return (
    <section id="benefits" className="scroll-mt-24 py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.05fr] lg:items-center">
          <div>
            <p className="text-sm font-semibold tracking-wide text-teal-800">Account benefits</p>
            <h2 className="font-display mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl lg:text-5xl">
              Start fast today. Scale your tracking as life gets more shared.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-stone-600">
              Kwenta works for quick personal splits and grows with you when you sign in for long-term
              history and group collaboration.
            </p>

            <ul className="mt-8 space-y-5">
              <li className="flex gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-teal-800/10 text-teal-900">
                  <ShieldCheck className="size-5" />
                </span>
                <div>
                  <p className="font-semibold text-stone-900">Personal clarity</p>
                  <p className="mt-1 text-sm leading-relaxed text-stone-600">
                    Keep a clean ledger of expenses you paid and what each person owes.
                  </p>
                </div>
              </li>
              <li className="flex gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-teal-800/10 text-teal-900">
                  <RefreshCcw className="size-5" />
                </span>
                <div>
                  <p className="font-semibold text-stone-900">Group collaboration</p>
                  <p className="mt-1 text-sm leading-relaxed text-stone-600">
                    Invite members, let each person add what they paid, and keep everyone on the same page.
                  </p>
                </div>
              </li>
            </ul>
          </div>

          <div className="rounded-[1.75rem] border border-stone-200 bg-white p-6 shadow-[0_20px_60px_rgba(28,25,23,0.06)] lg:p-8">
            <div className="rounded-2xl border border-stone-100 bg-stone-50 p-6">
              <p className="text-sm font-medium text-stone-500">Why it matters</p>
              <h3 className="font-display mt-2 text-2xl font-semibold text-stone-900">
                Shared spending gets messy fast without a clear system.
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-stone-600">
                Kwenta brings structure to who paid, who shares each part, and what still needs to be settled.
              </p>
              <div className="mt-6 space-y-3">
                <div className="rounded-2xl border border-stone-200 bg-white p-4">
                  <p className="text-sm font-semibold text-stone-900">Before sign-in</p>
                  <p className="mt-1 text-xs leading-relaxed text-stone-600">
                    Explore the flow instantly and split bills right away with no account required.
                  </p>
                </div>
                <div className="rounded-2xl border border-stone-200 bg-white p-4">
                  <p className="text-sm font-semibold text-stone-900">After sign-in</p>
                  <p className="mt-1 text-xs leading-relaxed text-stone-600">
                    Keep saved records, manage groups, and build a long-term shared expense history.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
