import { CreditCard, ReceiptText, SplitSquareHorizontal, Users } from 'lucide-react'

const items = [
  { icon: ReceiptText, label: 'Simple and itemized bills' },
  { icon: SplitSquareHorizontal, label: 'Equal, percentage, or custom splits' },
  { icon: Users, label: 'Personal tracking and group collaboration' },
  { icon: CreditCard, label: 'Balances and settlement tracking' },
] as const

export function LandingTrustStrip() {
  return (
    <section className="border-b border-stone-200/60 bg-white/60 py-5">
      <div className="mx-auto grid max-w-7xl gap-3 px-4 sm:grid-cols-2 sm:px-6 lg:grid-cols-4 lg:px-8">
        {items.map(({ icon: Icon, label }) => (
          <div
            key={label}
            className="flex items-center gap-3 rounded-2xl border border-stone-100 bg-stone-50/80 px-4 py-3 text-sm font-medium text-stone-700"
          >
            <Icon className="size-4 shrink-0 text-teal-800" aria-hidden />
            {label}
          </div>
        ))}
      </div>
    </section>
  )
}
