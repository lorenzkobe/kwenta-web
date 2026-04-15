const howItWorks = [
  {
    title: 'Create the bill',
    description:
      'Start with a title and currency, then choose simple total or detailed line items.',
  },
  {
    title: 'Set splits your way',
    description:
      'Pick who is included and choose equal, percentage, or custom split types per bill or per item.',
  },
  {
    title: 'Track what happens next',
    description:
      'Review balances, record settlements, and keep your shared spending history organized over time.',
  },
] as const

export function LandingHowItWorks() {
  return (
    <section id="how-it-works" className="scroll-mt-24 border-t border-stone-200/70 bg-[#f7f4ef]/80 py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl text-center">
          <p className="text-sm font-semibold tracking-wide text-teal-800">How it works</p>
          <h2 className="font-display mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">
            Built for the full bill-splitting journey.
          </h2>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {howItWorks.map((step, index) => (
            <div
              key={step.title}
              className="rounded-3xl border border-stone-200 bg-white p-6 shadow-[0_8px_30px_rgba(28,25,23,0.04)]"
            >
              <div className="flex size-10 items-center justify-center rounded-full bg-teal-800 text-sm font-semibold text-white">
                {index + 1}
              </div>
              <h3 className="mt-5 text-lg font-semibold text-stone-900">{step.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-stone-600">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
