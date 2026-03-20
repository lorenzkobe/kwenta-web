import {
  ArrowRight,
  Check,
  CreditCard,
  ReceiptText,
  RefreshCcw,
  ShieldCheck,
  Sparkles,
  Users,
  Wallet,
  WifiOff,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'

const featureCards = [
  {
    title: 'Split by item, not just total',
    description:
      'Log each item in a bill and decide exactly who shares it with equal, custom, or percentage-based splits.',
    icon: ReceiptText,
  },
  {
    title: 'Made for real groups',
    description:
      'Track expenses for roommates, barkadas, trips, and recurring household bills without losing context.',
    icon: Users,
  },
  {
    title: 'Offline first by design',
    description:
      'Save changes locally right away so browser refreshes and poor signal do not wipe your bill history.',
    icon: WifiOff,
  },
  {
    title: 'Sync and backup online',
    description:
      'When internet is available, your data syncs to the cloud for backup, multi-device access, and invites.',
    icon: RefreshCcw,
  },
] as const

const trustPoints = [
  'Split by item or by total',
  'Built for groups and shared expenses',
  'Safe even when offline',
  'Cloud sync when connection returns',
] as const

const howItWorks = [
  {
    title: 'Add the bill',
    description:
      'Create a bill with one amount or break it into items so the record matches how people actually ordered or spent.',
  },
  {
    title: 'Assign the shares',
    description:
      'Choose who shares each item and how it should be split so mixed orders and partial sharing stay easy to track.',
  },
  {
    title: 'Review balances',
    description:
      'See who should collect, who should settle, and keep everything available locally and synced when online.',
  },
] as const

const useCases = [
  {
    title: 'Restaurant outings',
    description:
      'Ideal for dinners where some dishes are personal, others are shared, and everyone should only pay their part.',
  },
  {
    title: 'Roommate expenses',
    description:
      'Track utilities, groceries, subscriptions, and household purchases across a fixed set of members.',
  },
  {
    title: 'Trips and events',
    description:
      'Keep travel costs, event spending, and shared group purchases organized in one place from start to finish.',
  },
] as const

export function LandingPage() {
  return (
    <main
      className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(191,219,254,0.75),transparent_28%),linear-gradient(180deg,#f7fbff_0%,#eef6fb_100%)] text-slate-800"
    >
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        <header className="rounded-4xl border border-slate-200 bg-white/92 p-4 shadow-[0_10px_30px_rgba(15,23,42,0.06)] backdrop-blur lg:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="rounded-3xl bg-blue-600/15 p-3 text-blue-600">
                <Wallet className="size-5" />
              </div>

              <div>
                <span className="inline-flex items-center rounded-full bg-blue-600/15 px-2.5 py-0.5 text-xs font-medium text-blue-600">Kwenta</span>
                <p className="mt-1 text-sm text-slate-600">
                  Offline-first bill splitting for real-life groups
                </p>
              </div>
            </div>

            <nav className="flex flex-wrap items-center gap-2">
              <Button variant="ghost" className="rounded-full" asChild>
                <a href="#features">Features</a>
              </Button>
              <Button variant="ghost" className="rounded-full" asChild>
                <a href="#how-it-works">How it works</a>
              </Button>
              <Button variant="ghost" className="rounded-full" asChild>
                <a href="#offline">Offline sync</a>
              </Button>
              <Button className="rounded-full" asChild>
                <Link to="/app">Open app</Link>
              </Button>
            </nav>
          </div>
        </header>

        <section className="mt-8 overflow-hidden rounded-[2.75rem] border border-slate-900/8 bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.22),transparent_28%),linear-gradient(135deg,#171c27_0%,#1f2937_58%,#141821_100%)] px-5 py-8 text-white shadow-[0_30px_100px_rgba(15,17,21,0.18)] lg:mt-12 lg:px-8 lg:py-10">
          <div className="grid gap-10 lg:grid-cols-[1.08fr_0.92fr] lg:items-center">
            <div className="max-w-3xl">
              <span className="inline-flex items-center rounded-full border border-white/10 bg-white/10 px-4 py-3 text-sm font-medium text-white shadow-sm">
                <Sparkles className="mr-1 size-3.5" />
                Bill splitting without the spreadsheet headache
              </span>

              <h1 className="mt-6 text-5xl font-semibold tracking-tight text-white sm:text-6xl lg:text-7xl">
                Split shared bills with clarity, even when you&apos;re offline.
              </h1>

              <p className="mt-6 max-w-2xl text-lg leading-8 text-white/78">
                Kwenta is an offline-first bill splitter for groups, trips, and shared expenses.
                Track totals or individual items, assign who shares what, and let sync happen when
                the connection comes back.
              </p>

              <div className="mt-8 flex flex-wrap gap-3">
                <Button asChild className="rounded-full border-none bg-white px-6 text-slate-800 shadow-lg hover:bg-white/92">
                  <Link to="/app">
                    Start splitting
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
                <Button asChild variant="ghost" className="rounded-full border border-white/18 bg-white/8 px-6 text-white hover:bg-white/14">
                  <a href="#features">
                    Explore features
                  </a>
                </Button>
              </div>

              <div className="mt-8 grid gap-3 sm:grid-cols-2">
                {trustPoints.map((point) => (
                  <div
                    key={point}
                    className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/6 px-3 py-3 text-sm text-white/80"
                  >
                    <span className="flex size-7 items-center justify-center rounded-full bg-white/14 text-white">
                      <Check className="size-4" />
                    </span>
                    <span>{point}</span>
                  </div>
                ))}
              </div>

              <div className="mt-8 grid gap-3 sm:grid-cols-3">
                <div className="rounded-3xl border border-white/12 bg-white/8 p-4 shadow-sm">
                  <p className="text-sm text-white/62">Split types</p>
                  <p className="mt-2 text-2xl font-semibold">Equal, custom, percent</p>
                </div>
                <div className="rounded-3xl border border-white/12 bg-white/8 p-4 shadow-sm">
                  <p className="text-sm text-white/62">Built for</p>
                  <p className="mt-2 text-2xl font-semibold">Groups and shared bills</p>
                </div>
                <div className="rounded-3xl border border-white/12 bg-white/8 p-4 shadow-sm">
                  <p className="text-sm text-white/62">Storage model</p>
                  <p className="mt-2 text-2xl font-semibold">Offline first</p>
                </div>
              </div>
            </div>

            <div className="relative">
              <div className="absolute inset-x-10 top-10 h-48 rounded-full bg-[#60a5fa]/24 blur-3xl" />
              <div className="relative rounded-[2.5rem] border border-white/12 bg-white/7 p-4 backdrop-blur lg:p-5">
                <div className="rounded-4xl border border-slate-900/8 bg-white p-5 text-slate-800 shadow-[0_30px_80px_rgba(15,17,21,0.14)]">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-800/55">Product preview</p>
                      <h2 className="mt-1 text-2xl font-semibold text-slate-800">
                        Works instantly, no account needed
                      </h2>
                    </div>
                    <div className="rounded-2xl bg-blue-600/12 p-3 text-blue-600">
                      <Wallet className="size-5" />
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4">
                    <div className="rounded-4xl bg-[linear-gradient(135deg,#111827_0%,#1f2937_100%)] p-5 text-white shadow-sm">
                      <p className="text-sm text-white/62">Inside Kwenta</p>
                      <p className="mt-2 text-2xl font-semibold">
                        Bills, balances, and settlements in one calm workspace.
                      </p>
                      <p className="mt-3 text-sm leading-7 text-white/78">
                        The website explains the value. The app handles the operational details once
                        users are inside.
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <div className="rounded-3xl border border-slate-800/10 bg-slate-50 p-4 shadow-sm">
                        <ReceiptText className="size-4 text-blue-600" />
                        <p className="mt-3 text-sm font-semibold text-slate-800">Item-level bills</p>
                        <p className="mt-1 text-xs leading-6 text-slate-500">
                          One total or multiple shared items
                        </p>
                      </div>
                      <div className="rounded-3xl border border-slate-800/10 bg-slate-50 p-4 shadow-sm">
                        <Users className="size-4 text-blue-600" />
                        <p className="mt-3 text-sm font-semibold text-slate-800">Shared groups</p>
                        <p className="mt-1 text-xs leading-6 text-slate-500">
                          Trips, roommates, barkadas
                        </p>
                      </div>
                      <div className="rounded-3xl border border-slate-800/10 bg-slate-50 p-4 shadow-sm">
                        <WifiOff className="size-4 text-blue-600" />
                        <p className="mt-3 text-sm font-semibold text-slate-800">Offline-safe storage</p>
                        <p className="mt-1 text-xs leading-6 text-slate-500">
                          Sync later when online
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-8 rounded-4xl border border-slate-200 bg-white px-5 py-4 shadow-[0_10px_30px_rgba(15,23,42,0.05)] lg:mt-12">
          <div className="grid gap-4 text-sm font-medium text-slate-600 md:grid-cols-4">
            <div className="flex items-center gap-3 rounded-2xl bg-slate-50 px-3 py-3">
              <ReceiptText className="size-4 text-blue-600" />
              Split by item or total
            </div>
            <div className="flex items-center gap-3 rounded-2xl bg-slate-50 px-3 py-3">
              <Users className="size-4 text-blue-600" />
              Built for real groups
            </div>
            <div className="flex items-center gap-3 rounded-2xl bg-slate-50 px-3 py-3">
              <WifiOff className="size-4 text-blue-600" />
              Offline-first storage
            </div>
            <div className="flex items-center gap-3 rounded-2xl bg-slate-50 px-3 py-3">
              <RefreshCcw className="size-4 text-blue-600" />
              Cloud sync and backup
            </div>
          </div>
        </section>

        <section id="features" className="mt-10 lg:mt-16">
          <div className="max-w-3xl">
            <p className="text-sm font-medium text-blue-600">Features</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-800 sm:text-4xl lg:text-5xl">
              Everything you need to split expenses without overcomplicating the process.
            </h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              From restaurant orders with mixed sharing to recurring bills inside a group, Kwenta is
              built for the situations where simple split apps start to feel limiting.
            </p>
          </div>

          <div className="mt-8 grid gap-5 md:grid-cols-2 xl:grid-cols-4">
            {featureCards.map((feature) => {
              const Icon = feature.icon

              return (
                <article
                  key={feature.title}
                  className="rounded-4xl border border-slate-200 bg-white p-6 shadow-[0_12px_30px_rgba(15,23,42,0.05)]"
                >
                  <div className="w-fit rounded-2xl bg-blue-600/15 p-3 text-blue-600">
                    <Icon className="size-5" />
                  </div>
                  <h3 className="mt-5 text-xl font-semibold text-slate-800">{feature.title}</h3>
                  <p className="mt-3 text-sm leading-7 text-slate-600">
                    {feature.description}
                  </p>
                </article>
              )
            })}
          </div>
        </section>

        <section id="how-it-works" className="mt-10 lg:mt-16">
          <div className="max-w-3xl">
            <p className="text-sm font-medium text-blue-600">How it works</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-800 sm:text-4xl">
              Simple on the front end, flexible underneath.
            </h2>
          </div>

          <div className="mt-8 grid gap-5 lg:grid-cols-3">
            {howItWorks.map((step, index) => (
              <div
                key={step.title}
                className="rounded-4xl border border-slate-200 bg-white p-6 shadow-[0_12px_30px_rgba(15,23,42,0.05)]"
              >
                <div className="flex size-10 items-center justify-center rounded-full bg-blue-600 text-white text-sm font-semibold">
                  {index + 1}
                </div>
                <h3 className="mt-5 text-xl font-semibold text-slate-800">{step.title}</h3>
                <p className="mt-3 text-sm leading-7 text-slate-600">{step.description}</p>
              </div>
            ))}
          </div>
        </section>

        <section
          id="offline"
          className="mt-10 grid gap-6 lg:mt-16 lg:grid-cols-[0.95fr_1.05fr] lg:items-center"
        >
          <div>
            <p className="text-sm font-medium text-blue-600">Offline-first sync</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-800 sm:text-4xl lg:text-5xl">
              Save first on the device. Sync when the internet comes back.
            </h2>
            <p className="mt-4 text-base leading-8 text-slate-600">
              Kwenta is designed around the reality that mobile browsers refresh, apps get closed,
              and connections drop. Data is stored locally first, then synced online when possible.
            </p>

            <div className="mt-6 space-y-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded-full bg-blue-600/12 p-2 text-blue-600">
                  <ShieldCheck className="size-4" />
                </span>
                <div>
                  <p className="font-semibold text-slate-800">Local persistence by default</p>
                  <p className="mt-1 text-sm leading-7 text-slate-600">
                    Bills, items, and group changes remain available even after refreshes or temporary offline moments.
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span className="mt-0.5 rounded-full bg-blue-600/12 p-2 text-blue-600">
                  <RefreshCcw className="size-4" />
                </span>
                <div>
                  <p className="font-semibold text-slate-800">Cloud sync as the backup layer</p>
                  <p className="mt-1 text-sm leading-7 text-slate-600">
                    When internet is available, changes sync to the cloud for backup, account access, and collaboration.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-[2.5rem] border border-slate-200 bg-white p-6 shadow-[0_14px_40px_rgba(15,23,42,0.06)] lg:p-8">
            <div className="rounded-4xl border border-slate-200 bg-slate-50 p-5">
              <p className="text-sm font-medium text-slate-500">Why this matters</p>
              <h3 className="mt-2 text-2xl font-semibold text-slate-800">
                Browsers are unreliable. Your bill history should not be.
              </h3>
              <p className="mt-3 text-sm leading-7 text-slate-600">
                Offline-first storage is not just a feature here. It is part of the core promise of
                the product, especially on mobile browsers.
              </p>

              <div className="mt-5 space-y-3">
                <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-semibold text-slate-800">Offline-safe logging</p>
                  <p className="mt-1 text-xs leading-6 text-slate-600">
                    Add expenses anytime without depending on network requests.
                  </p>
                </div>
                <div className="rounded-3xl border border-slate-200 bg-white p-4 shadow-sm">
                  <p className="text-sm font-semibold text-slate-800">Automatic sync later</p>
                  <p className="mt-1 text-xs leading-6 text-slate-600">
                    Local updates upload and cloud updates come back down when the app reconnects.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-10 lg:mt-16">
          <div className="max-w-3xl">
            <p className="text-sm font-medium text-blue-600">Use cases</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-800 sm:text-4xl">
              Useful for everyday groups, not just one-off bill splits.
            </h2>
          </div>

          <div className="mt-8 grid gap-5 lg:grid-cols-3">
            {useCases.map((useCase) => (
              <article
                key={useCase.title}
                className="rounded-4xl border border-slate-200 bg-white p-6 shadow-sm"
              >
                <h3 className="text-xl font-semibold text-slate-800">{useCase.title}</h3>
                <p className="mt-3 text-sm leading-7 text-slate-600">{useCase.description}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="mt-10 lg:mt-16">
          <div className="rounded-[2.5rem] border border-slate-900/6 bg-[linear-gradient(135deg,#1b2332_0%,#202938_55%,#18202d_100%)] p-6 text-white shadow-[0_20px_70px_rgba(15,23,42,0.12)] lg:p-10">
            <div className="grid gap-5 md:grid-cols-3">
              <div className="rounded-3xl border border-white/12 bg-white/12 p-5 shadow-sm">
                <Users className="size-5 text-white" />
                <p className="mt-4 text-lg font-semibold">Invite members</p>
                <p className="mt-2 text-sm leading-7 text-white/75">
                  Create groups and add other users when you are ready to collaborate online.
                </p>
              </div>
              <div className="rounded-3xl border border-white/12 bg-white/12 p-5 shadow-sm">
                <ReceiptText className="size-5 text-white" />
                <p className="mt-4 text-lg font-semibold">Track item-level shares</p>
                <p className="mt-2 text-sm leading-7 text-white/75">
                  Handle mixed orders and shared items without forcing everything into equal splits.
                </p>
              </div>
              <div className="rounded-3xl border border-white/12 bg-white/12 p-5 shadow-sm">
                <CreditCard className="size-5 text-white" />
                <p className="mt-4 text-lg font-semibold">Settle with clarity</p>
                <p className="mt-2 text-sm leading-7 text-white/75">
                  See what should be collected and settled before any payment is actually made.
                </p>
              </div>
            </div>
          </div>
        </section>

        <section className="mt-10 pb-8 lg:mt-16">
          <div className="rounded-4xl border border-slate-200 bg-white p-8 shadow-[0_14px_40px_rgba(15,23,42,0.06)] lg:p-10">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
              <div className="max-w-2xl">
                <p className="text-sm font-medium text-blue-600">Get started</p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-800 sm:text-4xl">
                  Stop guessing who owes what. Start splitting with clarity.
                </h2>
                <p className="mt-4 text-base leading-8 text-slate-600">
                  No sign-up required. Start tracking your shared expenses right away.
                  Create an account later if you want cloud sync and multi-device access.
                </p>
              </div>

              <div className="flex flex-wrap gap-3">
                <Button asChild className="rounded-full px-6">
                  <Link to="/app">
                    Start splitting
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
