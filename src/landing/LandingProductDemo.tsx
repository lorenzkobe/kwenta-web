import { useMemo, useState } from 'react'
import {
  LayoutList,
  ListOrdered,
  Plus,
  ReceiptText,
  SplitSquareHorizontal,
  UserPlus,
  Users,
} from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const DEMO_PEOPLE = ['You', 'Alex', 'Sam'] as const
type DemoPerson = (typeof DEMO_PEOPLE)[number]
const N = DEMO_PEOPLE.length

type DemoMode = 'simple' | 'itemized'

type DemoLineItem = {
  id: string
  name: string
  amount: number
  splitAmong?: readonly DemoPerson[]
}

type DemoBill = {
  id: string
  title: string
  currency: string
  items: DemoLineItem[]
}

function billTotal(bill: DemoBill): number {
  return bill.items.reduce((sum, line) => sum + line.amount, 0)
}

function lineParticipants(line: DemoLineItem): readonly DemoPerson[] {
  const s = line.splitAmong
  if (s && s.length > 0) return s
  return DEMO_PEOPLE
}

/** Shown only in the itemized preview (not in the bill list). */
const ITEMIZED_EXAMPLE_BILLS: DemoBill[] = [
  {
    id: 'ex-1',
    title: 'Saturday dinner',
    currency: 'PHP',
    items: [
      { id: 's1-a', name: 'Shared plates', amount: 1280, splitAmong: ['You', 'Alex', 'Sam'] },
      { id: 's1-b', name: 'Drinks (you & Sam)', amount: 720, splitAmong: ['You', 'Sam'] },
      { id: 's1-c', name: 'Service & tip', amount: 840, splitAmong: ['You', 'Alex', 'Sam'] },
    ],
  },
  {
    id: 'ex-2',
    title: 'Groceries run',
    currency: 'PHP',
    items: [
      { id: 's2-a', name: 'Produce & dairy', amount: 890, splitAmong: ['You', 'Alex'] },
      { id: 's2-b', name: 'Pantry staples', amount: 485.5, splitAmong: ['You', 'Alex', 'Sam'] },
      { id: 's2-c', name: 'Household (Sam only)', amount: 250, splitAmong: ['Sam'] },
    ],
  },
]

const SIMPLE_SEED_BILLS: DemoBill[] = [
  {
    id: 'simp-1',
    title: 'Coffee run',
    currency: 'PHP',
    items: [{ id: 'simp-1a', name: 'Total', amount: 450 }],
  },
  {
    id: 'simp-2',
    title: 'Parking',
    currency: 'PHP',
    items: [{ id: 'simp-2a', name: 'Total', amount: 200 }],
  },
]

function ItemizedItemCard({
  index,
  line,
  currency,
}: {
  index: number
  line: DemoLineItem
  currency: string
}) {
  const group = lineParticipants(line)
  const amt = line.amount
  const each = group.length > 0 ? amt / group.length : 0

  return (
    <div className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm shadow-stone-900/4">
      <div className="flex items-center gap-3">
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-teal-800 text-[0.65rem] font-semibold leading-none text-white"
          aria-hidden
        >
          {index + 1}
        </span>
        <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
          <p className="min-w-0 truncate text-sm font-semibold text-stone-900">{line.name}</p>
          <p className="shrink-0 text-sm font-semibold tabular-nums tracking-tight text-stone-900">
            {formatCurrency(amt, currency)}
          </p>
        </div>
      </div>

      <div className="mt-4 border-t border-stone-200 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-stone-500">
            <UserPlus className="size-3.5 shrink-0 text-stone-400" aria-hidden />
            <span>Split with</span>
          </div>
          <span className="inline-flex h-7 shrink-0 items-center rounded-md border border-stone-200 bg-white px-2.5 text-xs font-medium text-stone-700 shadow-sm">
            Equal
          </span>
        </div>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {group.map((name) => (
            <span
              key={name}
              className="inline-flex items-center gap-1.5 rounded-full bg-teal-800 px-2.5 py-1.5 text-xs font-medium text-white"
            >
              <Users className="size-3 shrink-0 opacity-95" aria-hidden />
              {name}
            </span>
          ))}
        </div>

        {group.length > 0 && amt > 0 && (
          <p className="mt-2 text-xs text-stone-400">
            {group.length === 1
              ? `${group[0]} pays ${formatCurrency(amt, currency)}`
              : `${formatCurrency(each, currency)} each`}
          </p>
        )}
      </div>
    </div>
  )
}

function ItemizedBillAppPreview({
  bill,
  editableTitle,
  onTitleChange,
}: {
  bill: DemoBill
  editableTitle?: boolean
  onTitleChange?: (title: string) => void
}) {
  const total = billTotal(bill)
  const titleInputId = `demo-itemized-title-${bill.id}`

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2">
        {editableTitle && onTitleChange ? (
          <>
            <label htmlFor={titleInputId} className="text-sm font-medium text-stone-800">
              Title
            </label>
            <Input
              id={titleInputId}
              value={bill.title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="Bill name"
              className="rounded-xl border-stone-200 bg-white text-sm"
              autoComplete="off"
            />
          </>
        ) : (
          <>
            <span className="text-sm font-medium text-stone-800">Title</span>
            <div className="rounded-xl border border-stone-200 bg-white px-3 py-2.5 text-sm font-medium text-stone-900">
              {bill.title}
            </div>
          </>
        )}
      </div>

      <div className="space-y-3">
        <p className="text-sm font-medium text-stone-600">Items</p>
        {bill.items.length === 0 ? (
          <p className="text-sm text-stone-500">No items yet.</p>
        ) : (
          <div className="space-y-3">
            {bill.items.map((line, index) => (
              <ItemizedItemCard key={line.id} index={index} line={line} currency={bill.currency} />
            ))}
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between rounded-2xl border border-stone-200 bg-white px-4 py-3">
          <span className="text-sm font-medium text-stone-600">Running total</span>
          <span className="text-lg font-semibold tabular-nums text-stone-900">
            {formatCurrency(total, bill.currency)}
          </span>
        </div>
      )}
    </div>
  )
}

export function LandingProductDemo() {
  const [mode, setMode] = useState<DemoMode>('simple')

  const [simpleBills, setSimpleBills] = useState<DemoBill[]>(SIMPLE_SEED_BILLS)
  const [simpleSelectedId, setSimpleSelectedId] = useState<string | null>(SIMPLE_SEED_BILLS[0]?.id ?? null)

  const [itemizedUserBills, setItemizedUserBills] = useState<DemoBill[]>([])
  const [itemizedSelectedId, setItemizedSelectedId] = useState<string | null>(null)

  const [newBillTitle, setNewBillTitle] = useState('')
  const [newSimpleAmount, setNewSimpleAmount] = useState('')

  const [addItemName, setAddItemName] = useState('')
  const [addItemAmount, setAddItemAmount] = useState('')

  const simpleSelected = useMemo(
    () => simpleBills.find((b) => b.id === simpleSelectedId) ?? null,
    [simpleBills, simpleSelectedId],
  )

  const itemizedSelected = useMemo(
    () => itemizedUserBills.find((b) => b.id === itemizedSelectedId) ?? null,
    [itemizedUserBills, itemizedSelectedId],
  )

  const perPersonGrandTotal = useMemo(() => {
    if (!simpleSelected) return 0
    return billTotal(simpleSelected) / N
  }, [simpleSelected])

  function addBill(e: React.FormEvent) {
    e.preventDefault()
    const title = newBillTitle.trim()
    if (!title) return

    if (mode === 'simple') {
      const n = Number.parseFloat(newSimpleAmount.replace(/,/g, ''))
      if (Number.isNaN(n) || n <= 0) return
      const id = crypto.randomUUID()
      const bill: DemoBill = {
        id,
        title,
        currency: 'PHP',
        items: [{ id: crypto.randomUUID(), name: 'Total', amount: n }],
      }
      setSimpleBills((prev) => [bill, ...prev])
      setSimpleSelectedId(id)
      setNewBillTitle('')
      setNewSimpleAmount('')
      return
    }

    const id = crypto.randomUUID()
    const bill: DemoBill = {
      id,
      title,
      currency: 'PHP',
      items: [],
    }
    setItemizedUserBills((prev) => [bill, ...prev])
    setItemizedSelectedId(id)
    setNewBillTitle('')
  }

  function addLineToSelected(e: React.FormEvent) {
    e.preventDefault()
    if (!itemizedSelected) return
    const name = addItemName.trim()
    const n = Number.parseFloat(addItemAmount.replace(/,/g, ''))
    if (!name || Number.isNaN(n) || n <= 0) return
    const line: DemoLineItem = { id: crypto.randomUUID(), name, amount: n }
    setItemizedUserBills((prev) =>
      prev.map((b) => (b.id === itemizedSelected.id ? { ...b, items: [...b.items, line] } : b)),
    )
    setAddItemName('')
    setAddItemAmount('')
  }

  function setItemizedBillTitle(billId: string, title: string) {
    setItemizedUserBills((prev) => prev.map((b) => (b.id === billId ? { ...b, title } : b)))
  }

  return (
    <section
      id="demo"
      className="scroll-mt-24 border-y border-stone-200/80 bg-[#f3efe8]/90 py-14 lg:py-20"
      aria-labelledby="demo-heading"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold tracking-wide text-teal-800">Try it here</p>
          <h2
            id="demo-heading"
            className="font-display mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl"
          >
            Simple total or itemized lines—same fair split.
          </h2>
          <p className="mt-3 text-base leading-relaxed text-stone-600">
            Preview only—no account. Itemized layout matches the app: each item, then split with
            people underneath. Sample bills on the right; use the left to add your own bill and items.
          </p>
        </div>

        <div className="mt-10">
          <div
            className="overflow-hidden rounded-[1.125rem] border border-stone-300/90 bg-[#faf7f2] shadow-[0_20px_70px_rgba(28,25,23,0.07)] ring-1 ring-stone-900/3"
            role="region"
            aria-label="Interactive bill split preview"
          >
            <div className="flex items-center gap-2 border-b border-stone-200/90 bg-stone-200/50 px-4 py-2.5">
              <span className="flex gap-1.5" aria-hidden>
                <span className="size-2.5 rounded-full bg-[#c4b8a8]" />
                <span className="size-2.5 rounded-full bg-[#d4ccc0]" />
                <span className="size-2.5 rounded-full bg-[#e8e2d9]" />
              </span>
              <span className="ml-2 font-mono text-[0.65rem] font-medium tracking-wide text-stone-500">
                kwenta.app / preview
              </span>
            </div>

            <div className="border-b border-stone-200 bg-white px-5 py-4">
              <p className="text-xs font-medium text-stone-500">Bill type</p>
              <div className="mt-2 rounded-2xl border border-stone-200 bg-stone-50 p-1">
                <div className="grid grid-cols-2 gap-1" role="tablist" aria-label="Simple or itemized bill">
                  {(
                    [
                      { id: 'simple' as const, icon: SplitSquareHorizontal, label: 'Simple' },
                      { id: 'itemized' as const, icon: LayoutList, label: 'Itemized' },
                    ] as const
                  ).map(({ id, icon: Icon, label }) => (
                    <button
                      key={id}
                      type="button"
                      role="tab"
                      aria-selected={mode === id}
                      onClick={() => setMode(id)}
                      className={cn(
                        'flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-colors',
                        mode === id
                          ? 'bg-stone-800 text-white shadow-sm'
                          : 'text-stone-500 hover:bg-stone-100 hover:text-stone-800',
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="mt-2 text-xs text-stone-500">
                {mode === 'simple'
                  ? 'One amount for the whole bill; split is even across the group.'
                  : 'Add a bill title, then add items—the same flow as in the app.'}
              </p>
            </div>

            <div className="grid gap-0 bg-white lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="border-b border-stone-200 p-5 lg:border-b-0 lg:border-r lg:border-stone-200">
                <div className="flex items-center gap-2 text-stone-800">
                  <ReceiptText className="size-4 text-teal-800" aria-hidden />
                  <h3 className="text-sm font-semibold">
                    {mode === 'simple' ? 'Bills' : 'Your bill'}
                  </h3>
                </div>

                <form onSubmit={addBill} className="mt-4 space-y-3 rounded-xl border border-dashed border-stone-200 bg-stone-50/60 p-3">
                  <p className="text-xs font-medium text-stone-600">
                    {mode === 'simple' ? 'New bill (simple)' : 'New bill — title only'}
                  </p>
                  {mode === 'simple' ? (
                    <div className="grid gap-2 sm:grid-cols-6 sm:items-end">
                      <div className="min-w-0 space-y-1 sm:col-span-3">
                        <label htmlFor="demo-bill-title" className="text-xs font-medium text-stone-600">
                          Bill name
                        </label>
                        <Input
                          id="demo-bill-title"
                          value={newBillTitle}
                          onChange={(e) => setNewBillTitle(e.target.value)}
                          placeholder="Team lunch"
                          className="rounded-lg border-stone-200 bg-white text-sm"
                          autoComplete="off"
                        />
                      </div>
                      <div className="min-w-0 space-y-1 sm:col-span-2">
                        <label htmlFor="demo-simple-amt" className="text-xs font-medium text-stone-600">
                          Total amount
                        </label>
                        <Input
                          id="demo-simple-amt"
                          inputMode="decimal"
                          value={newSimpleAmount}
                          onChange={(e) => setNewSimpleAmount(e.target.value)}
                          placeholder="0"
                          className="rounded-lg border-stone-200 bg-white text-sm"
                          autoComplete="off"
                        />
                      </div>
                      <div className="flex sm:col-span-1 sm:justify-end">
                        <Button
                          type="submit"
                          className="h-10 w-full shrink-0 rounded-lg sm:w-auto"
                        >
                          <Plus className="size-4" />
                          Add bill
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                      <div className="min-w-0 flex-1 space-y-1">
                        <label htmlFor="demo-bill-title-itemized" className="text-xs font-medium text-stone-600">
                          Title
                        </label>
                        <Input
                          id="demo-bill-title-itemized"
                          value={newBillTitle}
                          onChange={(e) => setNewBillTitle(e.target.value)}
                          placeholder="e.g. Korean BBQ dinner"
                          className="rounded-lg border-stone-200 bg-white text-sm"
                          autoComplete="off"
                        />
                      </div>
                      <Button
                        type="submit"
                        className="h-10 w-full shrink-0 rounded-lg sm:w-auto"
                      >
                        <Plus className="size-4" />
                        Add bill
                      </Button>
                    </div>
                  )}
                </form>

                {mode === 'simple' ? (
                  <ul
                    className="mt-5 max-h-[min(42vh,300px)] space-y-2 overflow-y-auto pr-1"
                    aria-live="polite"
                    aria-label="Bill list"
                  >
                    {simpleBills.map((b) => {
                      const total = billTotal(b)
                      return (
                        <li key={b.id}>
                          <button
                            type="button"
                            onClick={() => setSimpleSelectedId(b.id)}
                            className={cn(
                              'w-full rounded-xl border px-3 py-3 text-left text-sm transition-colors',
                              b.id === simpleSelectedId
                                ? 'border-teal-800/35 bg-[#f0f7f5] text-stone-900'
                                : 'border-stone-200 bg-stone-50/40 text-stone-800 hover:border-stone-300',
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-medium">{b.title}</span>
                              <span className="shrink-0 tabular-nums text-stone-600">
                                {formatCurrency(total, b.currency)}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-stone-500">Even split · 3 people</p>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                  <>
                    <ul
                      className="mt-5 max-h-[min(28vh,220px)] space-y-2 overflow-y-auto pr-1"
                      aria-live="polite"
                      aria-label="Your itemized bills"
                    >
                      {itemizedUserBills.length === 0 ? (
                        <li className="rounded-xl border border-stone-100 bg-stone-50/50 px-3 py-3 text-sm text-stone-500">
                          No bills yet—add a title above, then add items here.
                        </li>
                      ) : (
                        itemizedUserBills.map((b) => {
                          const total = billTotal(b)
                          return (
                            <li key={b.id}>
                              <button
                                type="button"
                                onClick={() => setItemizedSelectedId(b.id)}
                                className={cn(
                                  'w-full rounded-xl border px-3 py-3 text-left text-sm transition-colors',
                                  b.id === itemizedSelectedId
                                    ? 'border-teal-800/35 bg-[#f0f7f5] text-stone-900'
                                    : 'border-stone-200 bg-stone-50/40 text-stone-800 hover:border-stone-300',
                                )}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <span className="font-medium">{b.title}</span>
                                  <span className="shrink-0 tabular-nums text-stone-600">
                                    {formatCurrency(total, b.currency)}
                                  </span>
                                </div>
                                <p className="mt-1 text-xs text-stone-500">
                                  {b.items.length} item{b.items.length === 1 ? '' : 's'}
                                </p>
                              </button>
                            </li>
                          )
                        })
                      )}
                    </ul>

                    {itemizedSelected && (
                      <form
                        onSubmit={addLineToSelected}
                        className="mt-4 space-y-3 rounded-xl border border-stone-200 bg-stone-50/50 p-3"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-sm font-medium text-stone-600">Items</p>
                          <Button type="submit" variant="ghost" size="sm" className="rounded-full">
                            <Plus className="size-3.5" />
                            Add item
                          </Button>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-[1fr_7rem] sm:items-end">
                          <div className="min-w-0 space-y-1">
                            <label htmlFor="demo-add-item-name" className="text-xs font-medium text-stone-600">
                              Item name
                            </label>
                            <Input
                              id="demo-add-item-name"
                              value={addItemName}
                              onChange={(e) => setAddItemName(e.target.value)}
                              placeholder="e.g. Shared plates"
                              className="rounded-lg border-stone-200 bg-white text-sm"
                              autoComplete="off"
                            />
                          </div>
                          <div className="min-w-0 space-y-1">
                            <label htmlFor="demo-add-item-amt" className="text-xs font-medium text-stone-600">
                              Amount
                            </label>
                            <Input
                              id="demo-add-item-amt"
                              inputMode="decimal"
                              value={addItemAmount}
                              onChange={(e) => setAddItemAmount(e.target.value)}
                              placeholder="0.00"
                              className="rounded-lg border-stone-200 bg-white text-sm"
                              autoComplete="off"
                            />
                          </div>
                        </div>
                        <p className="text-xs text-stone-500">Adding to “{itemizedSelected.title}”</p>
                      </form>
                    )}
                  </>
                )}
              </div>

              <div className="p-5">
                {mode === 'simple' ? (
                  <>
                    <div className="flex items-center gap-2 text-stone-800">
                      <SplitSquareHorizontal className="size-4 text-teal-800" aria-hidden />
                      <h3 className="text-sm font-semibold">Equal split</h3>
                    </div>
                    <p className="mt-1 flex flex-wrap items-center gap-x-1 text-xs text-stone-500">
                      <Users className="inline size-3.5 shrink-0 text-stone-400" aria-hidden />
                      <span>Whole bill ÷ {N} — same as the Simple flow in the app.</span>
                    </p>

                    {simpleSelected ? (
                      <div className="mt-4 space-y-4">
                        <div className="rounded-xl border border-stone-200 bg-stone-50/70 p-3">
                          <p className="text-xs font-medium uppercase tracking-wide text-stone-500">
                            Bill total
                          </p>
                          <p className="mt-0.5 font-display text-2xl font-semibold tabular-nums text-stone-900">
                            {formatCurrency(billTotal(simpleSelected), simpleSelected.currency)}
                          </p>
                        </div>

                        <div className="rounded-xl border border-teal-800/20 bg-teal-800/6 p-3">
                          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-teal-900">
                            <Users className="size-3.5" aria-hidden />
                            Each person pays
                          </div>
                          <ul className="mt-2 space-y-1">
                            {DEMO_PEOPLE.map((name) => (
                              <li
                                key={name}
                                className="flex items-center justify-between text-sm text-stone-800"
                              >
                                <span>{name}</span>
                                <span className="tabular-nums font-semibold text-stone-900">
                                  {formatCurrency(perPersonGrandTotal, simpleSelected.currency)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    ) : (
                      <p className="mt-6 text-sm text-stone-500">Select a bill to see the split.</p>
                    )}
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-2 text-stone-800">
                      <ListOrdered className="size-4 text-teal-800" aria-hidden />
                      <h3 className="text-sm font-semibold">Itemized (in-app layout)</h3>
                    </div>
                    <p className="mt-1 text-xs text-stone-500">
                      Sample bills below. Your bill appears above them when you add one and select it.
                    </p>

                    <div className="mt-4 max-h-[min(72vh,640px)] space-y-8 overflow-y-auto pr-1">
                      {itemizedSelected && (
                        <div>
                          <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-teal-900">
                            Your bill
                          </p>
                          <ItemizedBillAppPreview
                            bill={itemizedSelected}
                            editableTitle
                            onTitleChange={(t) => setItemizedBillTitle(itemizedSelected.id, t)}
                          />
                        </div>
                      )}

                      <div>
                        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-stone-500">
                          Examples
                        </p>
                        <div className="space-y-8">
                          {ITEMIZED_EXAMPLE_BILLS.map((bill) => (
                            <ItemizedBillAppPreview key={bill.id} bill={bill} />
                          ))}
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
