import {
  ArrowUpRight,
  BellRing,
  ChevronRight,
  CreditCard,
  Home,
  Layers3,
  Plus,
  ReceiptText,
  RefreshCcw,
  Sparkles,
  UserRound,
  Users,
  Wallet,
  WifiOff,
} from 'lucide-react'
import {
  activities,
  balanceSnapshot,
  groupSummaries,
  ledgerRows,
  quickActions,
  settlementQueue,
} from './mockData'

const activityIcons = [ReceiptText, Wallet, CreditCard] as const

function amountTone(amount: string) {
  return amount.startsWith('+') ? 'text-success' : 'text-warning'
}

function AvatarStack({ initials }: { initials: string[] }) {
  return (
    <div className="avatar-group -space-x-3 rtl:space-x-reverse">
      {initials.map((initial, index) => (
        <div key={`${initial}-${index}`} className="avatar placeholder">
          <div className="w-10 rounded-full bg-primary text-primary-content">
            <span className="text-xs">{initial}</span>
          </div>
        </div>
      ))}
    </div>
  )
}

function ActivityFeed() {
  return (
    <div className="space-y-3">
      {activities.map((item, index) => {
        const Icon = activityIcons[index % activityIcons.length]

        return (
          <div
            key={item.title}
            className="flex items-center gap-3 rounded-3xl border border-base-content/8 bg-base-200/70 px-4 py-4"
          >
            <div className="rounded-2xl bg-base-100 p-2 text-primary shadow-sm">
              <Icon className="size-4" />
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-base-content">{item.title}</p>
              <p className="truncate text-sm text-base-content/75">{item.subtitle}</p>
            </div>

            <p className={`text-sm font-semibold ${amountTone(item.amount)}`}>{item.amount}</p>
          </div>
        )
      })}
    </div>
  )
}

export function DashboardPage() {
  return (
    <main
      data-theme="winter"
      className="min-h-screen bg-[linear-gradient(180deg,#f7fbff_0%,#eef6fb_100%)] text-base-content"
    >
      <div className="mx-auto max-w-7xl px-4 py-4 sm:px-6 lg:px-8 lg:py-6">
        <header className="rounded-4xl border border-base-content/10 bg-base-100/90 p-4 shadow-sm backdrop-blur lg:p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-3xl bg-primary/14 p-3 text-primary">
                <Wallet className="size-5" />
              </div>

              <div>
                <div className="badge badge-soft badge-primary border-none">Kwenta</div>
                <h1 className="mt-2 text-2xl font-semibold tracking-tight lg:text-3xl">
                  Good evening, Kobe
                </h1>
                <p className="mt-1 text-sm text-base-content/75 lg:text-base">
                  Here&apos;s your live overview of balances, groups, and pending settlements.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <div className="badge border-none bg-success/15 px-4 py-3 font-medium text-success">
                Synced 2 min ago
              </div>
              <div className="badge border border-base-content/10 bg-base-200 px-4 py-3 font-medium text-base-content">
                <WifiOff className="mr-1 size-4" />
                Offline ready
              </div>
              <button className="btn btn-ghost btn-circle">
                <BellRing className="size-4" />
              </button>
              <button className="btn btn-primary btn-circle">
                <UserRound className="size-4" />
              </button>
            </div>
          </div>
        </header>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <div className="rounded-[2.5rem] border border-neutral/5 bg-neutral p-6 text-neutral-content shadow-[0_20px_70px_rgba(15,23,42,0.12)] lg:p-10">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <div className="badge border-none bg-white/12 text-neutral-content">
                  <Sparkles className="mr-1 size-3.5" />
                  Home dashboard
                </div>
                <h2 className="mt-4 max-w-2xl text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
                  Keep shared money simple, calm, and easy to act on.
                </h2>
                <p className="mt-5 max-w-xl text-base leading-7 text-neutral-content/82">
                  Your dashboard surfaces what you need to collect, what you need to settle, and
                  which shared spaces need your attention first.
                </p>
              </div>

              <button className="btn rounded-full border-none bg-white/12 text-neutral-content hover:bg-white/18">
                <RefreshCcw className="size-4" />
                Refresh
              </button>
            </div>

            <div className="mt-8 grid gap-4 md:grid-cols-3">
              <div className="rounded-3xl border border-white/10 bg-white/10 p-5">
                <p className="text-sm font-medium text-neutral-content/70">Net balance</p>
                <p className="mt-2 text-3xl font-semibold text-neutral-content">
                  {balanceSnapshot.net}
                </p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/10 p-5">
                <p className="text-sm font-medium text-neutral-content/70">To collect</p>
                <p className="mt-2 text-3xl font-semibold text-neutral-content">
                  {balanceSnapshot.collect}
                </p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/10 p-5">
                <p className="text-sm font-medium text-neutral-content/70">To settle</p>
                <p className="mt-2 text-3xl font-semibold text-neutral-content">
                  {balanceSnapshot.settle}
                </p>
              </div>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-3">
              <div className="rounded-3xl border border-white/10 bg-white/8 p-5">
                <p className="text-sm font-medium text-neutral-content/70">Open groups</p>
                <p className="mt-2 text-3xl font-semibold text-neutral-content">3</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/8 p-5">
                <p className="text-sm font-medium text-neutral-content/70">Pending items</p>
                <p className="mt-2 text-3xl font-semibold text-neutral-content">9</p>
              </div>
              <div className="rounded-3xl border border-white/10 bg-white/8 p-5">
                <p className="text-sm font-medium text-neutral-content/70">Recovered this week</p>
                <p className="mt-2 text-3xl font-semibold text-neutral-content">P2,260</p>
              </div>
            </div>
          </div>

          <div className="grid gap-4">
            <section className="rounded-4xl border border-base-content/12 bg-base-100 p-6 shadow-md">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-base-content">Quick actions</h3>
                  <p className="text-sm leading-6 text-base-content/80">
                    The main entry points for adding and resolving shared expenses.
                  </p>
                </div>
                <button className="btn btn-primary btn-circle btn-sm">
                  <Plus className="size-4" />
                </button>
              </div>

              <div className="space-y-3">
                {quickActions.map((action, index) => (
                  <button
                    key={action.title}
                    className="btn h-auto min-h-0 w-full items-center justify-between rounded-3xl border border-base-content/8 bg-base-200 px-4 py-4 text-left text-base-content shadow-none hover:bg-base-300"
                  >
                    <div className="flex items-center gap-3">
                      <span className="rounded-2xl bg-primary/14 p-2 text-primary">
                        {index === 0 ? (
                          <ReceiptText className="size-4" />
                        ) : index === 1 ? (
                          <Users className="size-4" />
                        ) : (
                          <CreditCard className="size-4" />
                        )}
                      </span>
                      <span>
                        <span className="block text-sm font-semibold">{action.title}</span>
                        <span className="block text-xs text-base-content/75">{action.detail}</span>
                      </span>
                    </div>
                    <ChevronRight className="size-4 text-base-content/45" />
                  </button>
                ))}
              </div>
            </section>

            <section className="rounded-4xl border border-base-content/12 bg-base-100 p-6 shadow-md">
              <div className="flex items-start gap-3">
                <div className="rounded-2xl bg-primary/14 p-2 text-primary">
                  <WifiOff className="size-4" />
                </div>
                <div>
                  <p className="font-semibold text-base-content">Offline-first status</p>
                  <p className="mt-1 text-sm leading-6 text-base-content/80">
                    Recent changes are stored instantly on this device and will sync automatically
                    when the network is available.
                  </p>
                </div>
              </div>
            </section>
          </div>
        </section>

        <section className="mt-4 grid gap-4 xl:grid-cols-[1.15fr_0.85fr]">
          <section className="rounded-4xl border border-base-content/12 bg-base-100 p-6 shadow-md">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-lg font-semibold text-base-content">Bills and debts</h3>
                <p className="text-sm leading-6 text-base-content/80">
                  Your latest logged entries with clear status and amount visibility.
                </p>
              </div>
              <button className="btn btn-primary rounded-full">Add bill</button>
            </div>

            <div className="mb-3 hidden rounded-3xl bg-base-200 px-4 py-3 text-sm font-medium text-base-content/75 md:grid md:grid-cols-[1.4fr_1fr_100px_120px_120px]">
              <span>Entry</span>
              <span>When</span>
              <span>Items</span>
              <span>Status</span>
              <span>Amount</span>
            </div>

            <div className="space-y-3">
              {ledgerRows.map((row) => (
                <div
                  key={row.title}
                  className="grid gap-3 rounded-3xl border border-base-content/8 bg-base-200/70 px-4 py-4 md:grid-cols-[1.4fr_1fr_100px_120px_120px]"
                >
                  <div>
                    <p className="font-medium text-base-content">{row.title}</p>
                    <p className="text-sm text-base-content/75">{row.group}</p>
                  </div>
                  <p className="text-sm font-medium text-base-content/80">{row.date}</p>
                  <p className="text-sm font-medium text-base-content/80">{row.items} items</p>
                  <p className="text-sm font-semibold text-base-content">{row.state}</p>
                  <p
                    className={`text-sm font-semibold ${
                      row.state === 'To collect' ? 'text-success' : 'text-warning'
                    }`}
                  >
                    {row.amount}
                  </p>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-4xl border border-base-content/12 bg-base-100 p-6 shadow-md">
            <div className="flex items-center gap-2">
              <BellRing className="size-4 text-primary" />
              <h3 className="font-semibold text-base-content">Settlement queue</h3>
            </div>

            <div className="mt-4 space-y-3">
              {settlementQueue.map((item) => (
                <div key={item.person} className="rounded-3xl border border-base-content/8 bg-base-200 p-4">
                  <p className="font-medium text-base-content">{item.person}</p>
                  <p className="mt-1 text-sm leading-6 text-base-content/80">{item.summary}</p>
                  <div className="mt-3 badge border-none bg-base-100 px-3 py-3 font-medium text-base-content shadow-sm">
                    {item.status}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </section>

        <section className="mt-4 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <section className="rounded-4xl border border-base-content/12 bg-base-100 p-6 shadow-md">
            <div className="flex items-center gap-2">
              <Users className="size-4 text-primary" />
              <h3 className="text-lg font-semibold text-base-content">Active groups</h3>
            </div>

            <div className="mt-5 space-y-3">
              {groupSummaries.map((group) => (
                <div key={group.name} className="rounded-3xl border border-base-content/8 bg-base-200/70 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                    <AvatarStack initials={group.initials} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-base-content">{group.name}</p>
                      <p className="text-sm text-base-content/75">
                        {group.members} members · {group.status}
                      </p>
                    </div>
                    <p className={`font-semibold ${amountTone(group.net)}`}>{group.net}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-4xl border border-base-content/12 bg-base-100 p-6 shadow-md">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ArrowUpRight className="size-4 text-primary" />
                <h3 className="text-lg font-semibold text-base-content">Recent activity</h3>
              </div>
              <button className="btn btn-ghost btn-sm rounded-full text-primary">History</button>
            </div>

            <div className="mt-5">
              <ActivityFeed />
            </div>
          </section>
        </section>

        <nav className="sticky bottom-3 mt-4 rounded-[1.75rem] border border-base-content/10 bg-base-100/95 p-2 shadow-lg backdrop-blur lg:hidden">
          <div className="grid grid-cols-4 gap-2 text-xs">
            <button className="btn btn-sm h-14 rounded-2xl border-none bg-primary text-primary-content shadow-none">
              <Home className="size-4" />
              Home
            </button>
            <button className="btn btn-ghost btn-sm h-14 rounded-2xl">
              <ReceiptText className="size-4" />
              Bills
            </button>
            <button className="btn btn-ghost btn-sm h-14 rounded-2xl">
              <Layers3 className="size-4" />
              Groups
            </button>
            <button className="btn btn-ghost btn-sm h-14 rounded-2xl">
              <UserRound className="size-4" />
              Profile
            </button>
          </div>
        </nav>
      </div>
    </main>
  )
}
