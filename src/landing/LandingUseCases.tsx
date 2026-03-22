const useCases = [
  {
    title: 'Restaurant outings',
    description:
      'Some dishes personal, some shared—track who ate what without a spreadsheet after dessert.',
  },
  {
    title: 'Roommate expenses',
    description:
      'Utilities, groceries, subscriptions, and household purchases across the same set of people.',
  },
  {
    title: 'Trips & events',
    description:
      'Travel, tickets, and group purchases from start to finish in one place.',
  },
] as const

export function LandingUseCases() {
  return (
    <section className="border-t border-stone-200/70 bg-[#f7f4ef]/50 py-16 lg:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-3xl">
          <p className="text-sm font-semibold tracking-wide text-teal-800">Use cases</p>
          <h2 className="font-display mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl">
            For everyday groups—not only one-off splits.
          </h2>
        </div>

        <div className="mt-10 grid gap-5 lg:grid-cols-3">
          {useCases.map((useCase) => (
            <article
              key={useCase.title}
              className="rounded-3xl border border-stone-200 bg-white p-6 shadow-sm"
            >
              <h3 className="text-lg font-semibold text-stone-900">{useCase.title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-stone-600">{useCase.description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}
