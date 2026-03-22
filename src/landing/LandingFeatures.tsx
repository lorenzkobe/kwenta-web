import { ReceiptText, RefreshCcw, Users, WifiOff } from 'lucide-react'

const featureCards = [
  {
    title: 'Split by item, not just total',
    description:
      'Log each line on a bill and choose who shares it—with equal, custom, or percentage-based splits.',
    icon: ReceiptText,
  },
  {
    title: 'Made for real groups',
    description:
      'Roommates, trips, barkadas, and recurring household spend—without losing who-ordered-what context.',
    icon: Users,
  },
  {
    title: 'Offline first',
    description:
      'Changes save in your browser right away so refreshes and bad signal don’t wipe your history.',
    icon: WifiOff,
  },
  {
    title: 'Sync with your account',
    description:
      'When you’re online, data syncs to the cloud for backup, another device, and sharing with others.',
    icon: RefreshCcw,
  },
] as const

export function LandingFeatures() {
  return (
    <section id="features" className="scroll-mt-24 py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold tracking-wide text-teal-800">Features</p>
          <h2 className="font-display mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl lg:text-5xl">
            Everything you need to split expenses—without overcomplicating it.
          </h2>
          <p className="mt-4 text-base leading-relaxed text-stone-600">
            From mixed restaurant orders to recurring group bills, Kwenta is built for situations where
            “split evenly” isn’t enough.
          </p>
        </div>

        <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
          {featureCards.map((feature) => {
            const Icon = feature.icon
            return (
              <article
                key={feature.title}
                className="rounded-3xl border border-stone-200 bg-white p-6 shadow-[0_8px_30px_rgba(28,25,23,0.04)]"
              >
                <div className="w-fit rounded-2xl bg-teal-800/10 p-3 text-teal-900">
                  <Icon className="size-5" />
                </div>
                <h3 className="mt-5 text-lg font-semibold text-stone-900">{feature.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-stone-600">{feature.description}</p>
              </article>
            )
          })}
        </div>
      </div>
    </section>
  )
}
