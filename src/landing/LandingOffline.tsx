import { RefreshCcw, ShieldCheck } from 'lucide-react'

export function LandingOffline() {
  return (
    <section id="offline" className="scroll-mt-24 py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid gap-10 lg:grid-cols-[1fr_1.05fr] lg:items-center">
          <div>
            <p className="text-sm font-semibold tracking-wide text-teal-800">Offline & sync</p>
            <h2 className="font-display mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl lg:text-5xl">
              Save on the device first. Sync when the network is back.
            </h2>
            <p className="mt-4 text-base leading-relaxed text-stone-600">
              Mobile browsers refresh, tabs close, and connections drop. Kwenta keeps your work in
              IndexedDB first; when you’re signed in and online, changes flow to your account.
            </p>

            <ul className="mt-8 space-y-5">
              <li className="flex gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-teal-800/10 text-teal-900">
                  <ShieldCheck className="size-5" />
                </span>
                <div>
                  <p className="font-semibold text-stone-900">Local by default</p>
                  <p className="mt-1 text-sm leading-relaxed text-stone-600">
                    Log expenses and adjust splits without waiting on the network.
                  </p>
                </div>
              </li>
              <li className="flex gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-2xl bg-teal-800/10 text-teal-900">
                  <RefreshCcw className="size-5" />
                </span>
                <div>
                  <p className="font-semibold text-stone-900">Account sync</p>
                  <p className="mt-1 text-sm leading-relaxed text-stone-600">
                    Signed-in sessions push and pull so you can pick up on another device when you need to.
                  </p>
                </div>
              </li>
            </ul>
          </div>

          <div className="rounded-[1.75rem] border border-stone-200 bg-white p-6 shadow-[0_20px_60px_rgba(28,25,23,0.06)] lg:p-8">
            <div className="rounded-2xl border border-stone-100 bg-stone-50 p-6">
              <p className="text-sm font-medium text-stone-500">Why it matters</p>
              <h3 className="font-display mt-2 text-2xl font-semibold text-stone-900">
                Browsers are flaky. Your bill history shouldn’t be.
              </h3>
              <p className="mt-3 text-sm leading-relaxed text-stone-600">
                Offline-first storage is core to the product—especially when people reach for their phone
                at the table or on the road.
              </p>
              <div className="mt-6 space-y-3">
                <div className="rounded-2xl border border-stone-200 bg-white p-4">
                  <p className="text-sm font-semibold text-stone-900">Session ended?</p>
                  <p className="mt-1 text-xs leading-relaxed text-stone-600">
                    Your edits stay on this device until you sign in again—nothing silently disappears
                    just because a token expired.
                  </p>
                </div>
                <div className="rounded-2xl border border-stone-200 bg-white p-4">
                  <p className="text-sm font-semibold text-stone-900">Sign out</p>
                  <p className="mt-1 text-xs leading-relaxed text-stone-600">
                    Signing out clears Kwenta from this browser; your account data remains on the server.
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
