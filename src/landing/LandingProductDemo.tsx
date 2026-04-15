import { useMemo, useState, type FormEvent } from 'react'
import { LayoutList, Plus, ReceiptText, SplitSquareHorizontal, Trash2, UserPlus, Users, X } from 'lucide-react'
import type { SplitType } from '@/types'
import { normalizeAmountInput, stripLeadingZerosAmount } from '@/lib/amount-input'
import {
  equalCustomMap,
  equalPercentMap,
  redistributeWithPinned,
  splitTotalEvenly,
  type PinnedSplits,
} from '@/lib/bill-split-form'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const CURRENCIES = ['PHP', 'USD', 'EUR', 'JPY', 'KRW', 'GBP'] as const
const SPLIT_TYPES: SplitType[] = ['equal', 'percentage', 'custom']

type DemoMode = 'simple' | 'itemized'

type SimpleBill = {
  id: string
  currency: string
  amount: number
  splitType: SplitType
  splitWith: string[]
  splitValues: Record<string, number>
}

type ItemizedLine = {
  id: string
  name: string
  amount: number
  splitType: SplitType
  splitWith: string[]
  splitValues: Record<string, number>
}

type ItemizedBill = {
  id: string
  currency: string
  items: ItemizedLine[]
}

function splitTypeLabel(splitType: SplitType): string {
  if (splitType === 'equal') return 'Equal'
  if (splitType === 'percentage') return 'By percentage'
  return 'Custom amounts'
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100
}

function splitInputMax(splitType: SplitType, amount: number): number {
  if (splitType === 'percentage') return 100
  if (splitType === 'custom') return Math.max(roundToTwo(amount), 0)
  return 0
}

function clampSplitInput(raw: string, splitType: SplitType, amount: number): string {
  const normalized = normalizeAmountInput(raw)
  if (normalized.trim() === '') return ''
  const parsed = Number.parseFloat(normalized.replace(/,/g, ''))
  if (Number.isNaN(parsed)) return ''
  const max = splitInputMax(splitType, amount)
  const clamped = Math.min(Math.max(parsed, 0), max)
  return String(roundToTwo(clamped))
}

function computePerUserAmounts(
  amount: number,
  splitType: SplitType,
  splitWith: string[],
  splitValues: Record<string, number>,
): Record<string, number> {
  if (splitWith.length === 0 || amount <= 0) return {}
  if (splitType === 'equal') {
    const amounts = splitTotalEvenly(amount, splitWith.length)
    return Object.fromEntries(splitWith.map((name, index) => [name, amounts[index] ?? 0]))
  }
  if (splitType === 'percentage') {
    return Object.fromEntries(
      splitWith.map((name) => [name, roundToTwo((amount * (splitValues[name] ?? 0)) / 100)]),
    )
  }
  return Object.fromEntries(splitWith.map((name) => [name, roundToTwo(splitValues[name] ?? 0)]))
}

function computeItemizedUserTotals(bill: ItemizedBill): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const item of bill.items) {
    const perUser = computePerUserAmounts(item.amount, item.splitType, item.splitWith, item.splitValues)
    for (const person of item.splitWith) {
      totals[person] = roundToTwo((totals[person] ?? 0) + (perUser[person] ?? 0))
    }
  }
  return totals
}

function togglePerson(list: string[], person: string): string[] {
  const set = new Set(list)
  if (set.has(person)) {
    if (set.size <= 1) return list
    set.delete(person)
  } else {
    set.add(person)
  }
  return [...set]
}

function sanitizePeopleSelection(selection: string[], people: string[]): string[] {
  const next = selection.filter((name) => people.includes(name))
  if (next.length > 0) return next
  return people.length > 0 ? [people[0]] : []
}

function sanitizeSplitValueMap(values: Record<string, string>, selected: string[]): Record<string, string> {
  const allowed = new Set(selected)
  return Object.fromEntries(Object.entries(values).filter(([name]) => allowed.has(name)))
}

function sanitizeNumericSplitMap(values: Record<string, number>, selected: string[]): Record<string, number> {
  const allowed = new Set(selected)
  return Object.fromEntries(Object.entries(values).filter(([name]) => allowed.has(name)))
}

function sanitizePinnedMap(pinned: PinnedSplits, selected: string[]): PinnedSplits {
  const allowed = new Set(selected)
  return Object.fromEntries(Object.entries(pinned).filter(([name]) => allowed.has(name) && Boolean(pinned[name])))
}

function parseSplitValueMap(values: Record<string, string>, selected: string[]): Record<string, number> {
  return Object.fromEntries(
    selected.map((name) => {
      const parsed = Number.parseFloat((values[name] ?? '').replace(/,/g, ''))
      return [name, Number.isNaN(parsed) ? 0 : parsed]
    }),
  )
}

function splitsAreValid(
  splitType: SplitType,
  amount: number,
  selected: string[],
  values: Record<string, string>,
): boolean {
  if (selected.length === 0) return false
  if (splitType === 'equal') return true
  if (amount <= 0) return false

  const numericValues = selected.map((name) => Number.parseFloat((values[name] ?? '').replace(/,/g, '')))
  if (numericValues.some((value) => Number.isNaN(value) || value < 0)) return false

  const sum = numericValues.reduce((total, value) => total + value, 0)
  if (splitType === 'percentage') return Math.abs(sum - 100) < 0.01
  return Math.abs(sum - amount) < 0.01
}

function rebalanceSplitValues(
  splitType: SplitType,
  selected: string[],
  values: Record<string, string>,
  pinned: PinnedSplits,
  amount: number,
): { values: Record<string, string>; pinned: PinnedSplits } {
  if (splitType === 'equal' || selected.length === 0) {
    return { values: {}, pinned: {} }
  }

  const cleanedValues = sanitizeSplitValueMap(values, selected)
  const cleanedPinned = sanitizePinnedMap(pinned, selected)
  const hasAnyValue = selected.some((name) => (cleanedValues[name] ?? '').trim() !== '')

  const targetTotal = splitType === 'percentage' ? 100 : amount
  if (targetTotal <= 0 && splitType === 'custom') {
    return { values: cleanedValues, pinned: cleanedPinned }
  }

  if (!hasAnyValue) {
    return {
      values:
        splitType === 'percentage'
          ? equalPercentMap(selected)
          : equalCustomMap(selected, targetTotal),
      pinned: {},
    }
  }

  return {
    values: redistributeWithPinned(selected, cleanedValues, cleanedPinned, targetTotal),
    pinned: cleanedPinned,
  }
}

function PersonChipGroup({
  people,
  selected,
  onToggle,
}: {
  people: string[]
  selected: string[]
  onToggle: (person: string) => void
}) {
  if (people.length === 0) {
    return <p className="text-xs text-stone-500">Add at least one person to continue.</p>
  }

  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label="Split with">
      {people.map((person) => {
        const active = selected.includes(person)
        return (
          <button
            key={person}
            type="button"
            onClick={() => onToggle(person)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors',
              active
                ? 'bg-teal-800 text-white shadow-sm'
                : 'border border-stone-200 bg-white text-stone-600 hover:border-stone-300 hover:bg-stone-50',
            )}
          >
            <Users className="size-3 shrink-0 opacity-90" aria-hidden />
            {person}
          </button>
        )
      })}
    </div>
  )
}

function SplitTypeButtons({
  value,
  onChange,
}: {
  value: SplitType
  onChange: (splitType: SplitType) => void
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="group" aria-label="Split type">
      {SPLIT_TYPES.map((splitType) => (
        <button
          key={splitType}
          type="button"
          onClick={() => onChange(splitType)}
          className={cn(
            'rounded-lg border px-3 py-2 text-xs font-medium transition-colors',
            value === splitType
              ? 'border-teal-800/35 bg-[#f0f7f5] text-stone-900'
              : 'border-stone-200 bg-white text-stone-600 hover:border-stone-300',
          )}
        >
          {splitTypeLabel(splitType)}
        </button>
      ))}
    </div>
  )
}

function SplitValuesEditor({
  splitType,
  selected,
  values,
  amount,
  currency,
  onChange,
}: {
  splitType: SplitType
  selected: string[]
  values: Record<string, string>
  amount: number
  currency: string
  onChange: (name: string, value: string) => void
}) {
  if (splitType === 'equal' || selected.length === 0) return null

  const helperText =
    splitType === 'percentage'
      ? 'Enter each person percentage. Total must equal 100.'
      : `Enter each person amount. Total must equal ${formatCurrency(amount || 0, currency)}.`
  const maxValue = splitInputMax(splitType, amount)

  return (
    <div className="space-y-2 rounded-lg border border-stone-200 bg-white p-3">
      <p className="text-xs font-medium text-stone-600">Split values</p>
      <p className="text-[0.7rem] text-stone-500">{helperText}</p>
      <p className="text-[0.7rem] text-stone-500">
        Max per person: {splitType === 'percentage' ? '100' : formatCurrency(maxValue, currency)}
      </p>
      {selected.map((name) => (
        <div key={name} className="grid grid-cols-[1fr_8rem] items-center gap-2">
          <span className="text-xs font-medium text-stone-700">{name}</span>
          <Input
            type="text"
            inputMode="decimal"
            pattern="[0-9.]*"
            value={values[name] ?? ''}
            onChange={(e) => onChange(name, clampSplitInput(e.target.value, splitType, amount))}
            onBlur={() =>
              onChange(
                name,
                (values[name] ?? '').trim() === ''
                  ? '0'
                  : clampSplitInput(stripLeadingZerosAmount(values[name] ?? ''), splitType, amount),
              )
            }
            placeholder={splitType === 'percentage' ? '0' : '0.00'}
            className="h-9 rounded-md border-stone-200 bg-white text-sm tabular-nums"
            autoComplete="off"
          />
        </div>
      ))}
    </div>
  )
}

const INITIAL_PEOPLE: string[] = []

function totalItemizedBill(bill: ItemizedBill): number {
  return bill.items.reduce((sum, item) => sum + item.amount, 0)
}

export function LandingProductDemo() {
  const [mode, setMode] = useState<DemoMode>('simple')
  const [people, setPeople] = useState<string[]>(INITIAL_PEOPLE)
  const [newPersonName, setNewPersonName] = useState('')

  const [simpleCurrency, setSimpleCurrency] = useState<string>('PHP')
  const [simpleAmount, setSimpleAmount] = useState('')
  const [simpleSplitType, setSimpleSplitType] = useState<SplitType>('equal')
  const [simpleSplitWith, setSimpleSplitWith] = useState<string[]>(INITIAL_PEOPLE)
  const [simpleSplitValues, setSimpleSplitValues] = useState<Record<string, string>>({})
  const [simplePinnedSplits, setSimplePinnedSplits] = useState<PinnedSplits>({})
  const [simpleBills, setSimpleBills] = useState<SimpleBill[]>([])
  const [simpleSelectedId, setSimpleSelectedId] = useState<string>('')

  const [itemizedCurrency, setItemizedCurrency] = useState<string>('PHP')
  const [itemizedBills, setItemizedBills] = useState<ItemizedBill[]>([])
  const [itemizedSelectedId, setItemizedSelectedId] = useState<string>('')

  const [lineName, setLineName] = useState('')
  const [lineAmount, setLineAmount] = useState('')
  const [lineSplitType, setLineSplitType] = useState<SplitType>('equal')
  const [lineSplitWith, setLineSplitWith] = useState<string[]>(INITIAL_PEOPLE)
  const [lineSplitValues, setLineSplitValues] = useState<Record<string, string>>({})
  const [linePinnedSplits, setLinePinnedSplits] = useState<PinnedSplits>({})

  const simpleSelected = useMemo(
    () => simpleBills.find((bill) => bill.id === simpleSelectedId) ?? simpleBills[0] ?? null,
    [simpleBills, simpleSelectedId],
  )
  const itemizedSelected = useMemo(
    () => itemizedBills.find((bill) => bill.id === itemizedSelectedId) ?? itemizedBills[0] ?? null,
    [itemizedBills, itemizedSelectedId],
  )

  function addPerson() {
    const name = newPersonName.trim()
    if (!name) return
    const exists = people.some((person) => person.toLowerCase() === name.toLowerCase())
    if (exists) return
    const nextPeople = [...people, name]
    const nextSimpleSplitWith = simpleSplitWith.length === 0 ? [name] : [...simpleSplitWith, name]
    const nextLineSplitWith = lineSplitWith.length === 0 ? [name] : [...lineSplitWith, name]

    setPeople(nextPeople)
    setSimpleSplitWith(nextSimpleSplitWith)
    setLineSplitWith(nextLineSplitWith)

    const simpleAmountNum = Number.parseFloat(simpleAmount.replace(/,/g, '')) || 0
    const nextSimple = rebalanceSplitValues(
      simpleSplitType,
      nextSimpleSplitWith,
      simpleSplitValues,
      simplePinnedSplits,
      simpleAmountNum,
    )
    setSimpleSplitValues(nextSimple.values)
    setSimplePinnedSplits(nextSimple.pinned)

    const lineAmountNum = Number.parseFloat(lineAmount.replace(/,/g, '')) || 0
    const nextLine = rebalanceSplitValues(
      lineSplitType,
      nextLineSplitWith,
      lineSplitValues,
      linePinnedSplits,
      lineAmountNum,
    )
    setLineSplitValues(nextLine.values)
    setLinePinnedSplits(nextLine.pinned)
    setNewPersonName('')
  }

  function removePerson(name: string) {
    if (people.length <= 1) return
    const nextPeople = people.filter((person) => person !== name)
    setPeople(nextPeople)
    const nextSimpleSelection = sanitizePeopleSelection(simpleSplitWith, nextPeople)
    const nextSimple = rebalanceSplitValues(
      simpleSplitType,
      nextSimpleSelection,
      sanitizeSplitValueMap(simpleSplitValues, nextPeople),
      sanitizePinnedMap(simplePinnedSplits, nextPeople),
      Number.parseFloat(simpleAmount.replace(/,/g, '')) || 0,
    )
    setSimpleSplitWith(nextSimpleSelection)
    setSimpleSplitValues(nextSimple.values)
    setSimplePinnedSplits(nextSimple.pinned)

    const nextLineSelection = sanitizePeopleSelection(lineSplitWith, nextPeople)
    const nextLine = rebalanceSplitValues(
      lineSplitType,
      nextLineSelection,
      sanitizeSplitValueMap(lineSplitValues, nextPeople),
      sanitizePinnedMap(linePinnedSplits, nextPeople),
      Number.parseFloat(lineAmount.replace(/,/g, '')) || 0,
    )
    setLineSplitWith(nextLineSelection)
    setLineSplitValues(nextLine.values)
    setLinePinnedSplits(nextLine.pinned)
    setSimpleBills((prev) =>
      prev.map((bill) => ({
        ...bill,
        splitWith: sanitizePeopleSelection(bill.splitWith, nextPeople),
        splitValues: sanitizeNumericSplitMap(
          bill.splitValues,
          sanitizePeopleSelection(bill.splitWith, nextPeople),
        ),
      })),
    )
    setItemizedBills((prev) =>
      prev.map((bill) => ({
        ...bill,
        items: bill.items.map((item) => ({
          ...item,
          splitWith: sanitizePeopleSelection(item.splitWith, nextPeople),
          splitValues: sanitizeNumericSplitMap(
            item.splitValues,
            sanitizePeopleSelection(item.splitWith, nextPeople),
          ),
        })),
      })),
    )
  }

  function toggleSimpleSplitPerson(person: string) {
    const nextSelection = togglePerson(simpleSplitWith, person)
    setSimpleSplitWith(nextSelection)
    const next = rebalanceSplitValues(
      simpleSplitType,
      nextSelection,
      simpleSplitValues,
      simplePinnedSplits,
      Number.parseFloat(simpleAmount.replace(/,/g, '')) || 0,
    )
    setSimpleSplitValues(next.values)
    setSimplePinnedSplits(next.pinned)
  }

  function toggleLineSplitPerson(person: string) {
    const nextSelection = togglePerson(lineSplitWith, person)
    setLineSplitWith(nextSelection)
    const next = rebalanceSplitValues(
      lineSplitType,
      nextSelection,
      lineSplitValues,
      linePinnedSplits,
      Number.parseFloat(lineAmount.replace(/,/g, '')) || 0,
    )
    setLineSplitValues(next.values)
    setLinePinnedSplits(next.pinned)
  }

  function handleSimpleSplitTypeChange(splitType: SplitType) {
    setSimpleSplitType(splitType)
    const next = rebalanceSplitValues(
      splitType,
      simpleSplitWith,
      simpleSplitValues,
      simplePinnedSplits,
      Number.parseFloat(simpleAmount.replace(/,/g, '')) || 0,
    )
    setSimpleSplitValues(next.values)
    setSimplePinnedSplits(next.pinned)
  }

  function handleLineSplitTypeChange(splitType: SplitType) {
    setLineSplitType(splitType)
    const next = rebalanceSplitValues(
      splitType,
      lineSplitWith,
      lineSplitValues,
      linePinnedSplits,
      Number.parseFloat(lineAmount.replace(/,/g, '')) || 0,
    )
    setLineSplitValues(next.values)
    setLinePinnedSplits(next.pinned)
  }

  function handleSimpleSplitValueChange(name: string, value: string) {
    const nextValues = { ...simpleSplitValues, [name]: value }
    const nextPinned = { ...simplePinnedSplits }
    if (value === '') {
      delete nextPinned[name]
      setSimpleSplitValues(nextValues)
      setSimplePinnedSplits(nextPinned)
      return
    }
    nextPinned[name] = true
    const next = rebalanceSplitValues(
      simpleSplitType,
      simpleSplitWith,
      nextValues,
      nextPinned,
      Number.parseFloat(simpleAmount.replace(/,/g, '')) || 0,
    )
    setSimpleSplitValues(next.values)
    setSimplePinnedSplits(next.pinned)
  }

  function handleLineSplitValueChange(name: string, value: string) {
    const nextValues = { ...lineSplitValues, [name]: value }
    const nextPinned = { ...linePinnedSplits }
    if (value === '') {
      delete nextPinned[name]
      setLineSplitValues(nextValues)
      setLinePinnedSplits(nextPinned)
      return
    }
    nextPinned[name] = true
    const next = rebalanceSplitValues(
      lineSplitType,
      lineSplitWith,
      nextValues,
      nextPinned,
      Number.parseFloat(lineAmount.replace(/,/g, '')) || 0,
    )
    setLineSplitValues(next.values)
    setLinePinnedSplits(next.pinned)
  }

  function addSimpleBill(e: FormEvent) {
    e.preventDefault()
    const amount = Number.parseFloat(simpleAmount.replace(/,/g, ''))
    if (Number.isNaN(amount) || amount <= 0 || simpleSplitWith.length === 0) return
    if (!splitsAreValid(simpleSplitType, amount, simpleSplitWith, simpleSplitValues)) return

    const bill: SimpleBill = {
      id: crypto.randomUUID(),
      currency: simpleCurrency,
      amount,
      splitType: simpleSplitType,
      splitWith: [...simpleSplitWith],
      splitValues: parseSplitValueMap(simpleSplitValues, simpleSplitWith),
    }
    setSimpleBills((prev) => [bill, ...prev])
    setSimpleSelectedId(bill.id)
    setSimpleAmount('')
    setSimpleSplitValues({})
    setSimplePinnedSplits({})
  }

  function addItemizedBill(e: FormEvent) {
    e.preventDefault()
    const bill: ItemizedBill = {
      id: crypto.randomUUID(),
      currency: itemizedCurrency,
      items: [],
    }
    setItemizedBills((prev) => [bill, ...prev])
    setItemizedSelectedId(bill.id)
  }

  function addLineToBill(e: FormEvent) {
    e.preventDefault()
    if (!itemizedSelected) return
    const name = lineName.trim()
    const amount = Number.parseFloat(lineAmount.replace(/,/g, ''))
    if (!name || Number.isNaN(amount) || amount <= 0 || lineSplitWith.length === 0) return
    if (!splitsAreValid(lineSplitType, amount, lineSplitWith, lineSplitValues)) return

    const line: ItemizedLine = {
      id: crypto.randomUUID(),
      name,
      amount,
      splitType: lineSplitType,
      splitWith: [...lineSplitWith],
      splitValues: parseSplitValueMap(lineSplitValues, lineSplitWith),
    }

    setItemizedBills((prev) =>
      prev.map((bill) => (bill.id === itemizedSelected.id ? { ...bill, items: [...bill.items, line] } : bill)),
    )
    setLineName('')
    setLineAmount('')
    setLineSplitValues({})
    setLinePinnedSplits({})
  }

  function removeLineFromBill(lineId: string) {
    if (!itemizedSelected) return
    setItemizedBills((prev) =>
      prev.map((bill) =>
        bill.id === itemizedSelected.id
          ? { ...bill, items: bill.items.filter((item) => item.id !== lineId) }
          : bill,
      ),
    )
  }

  return (
    <section
      id="demo"
      className="scroll-mt-24 border-y border-stone-200/80 bg-[#f3efe8]/90 py-14 lg:py-20"
      aria-labelledby="demo-heading"
    >
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="max-w-2xl">
          <p className="text-sm font-semibold tracking-wide text-teal-800">Live experience</p>
          <h2
            id="demo-heading"
            className="font-display mt-2 text-3xl font-semibold tracking-tight text-stone-900 sm:text-4xl"
          >
            Use Kwenta without signing in.
          </h2>
          <p className="mt-3 text-base leading-relaxed text-stone-600">
            See how Kwenta handles both simple totals and itemized bills with flexible split controls.
            Sign in when you want long-term history and collaborative group tracking.
          </p>
        </div>

        <div className="mt-10 overflow-hidden rounded-[1.125rem] border border-stone-300/90 bg-[#faf7f2] shadow-[0_20px_70px_rgba(28,25,23,0.07)] ring-1 ring-stone-900/3">
          <div className="border-b border-stone-200/90 bg-stone-200/50 px-4 py-2.5">
            <span className="font-mono text-[0.65rem] font-medium tracking-wide text-stone-500">
              kwenta.app / guest-preview
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
          </div>

          <div className="grid gap-0 bg-white lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="border-b border-stone-200 p-5 lg:border-b-0 lg:border-r lg:border-stone-200">
              <div className="rounded-xl border border-stone-200 bg-stone-50/60 p-3">
                <p className="text-xs font-medium text-stone-600">People in this demo</p>
                <div className="mt-2 flex gap-2">
                  <Input
                    value={newPersonName}
                    onChange={(e) => setNewPersonName(e.target.value)}
                    placeholder="Add a person"
                    className="rounded-lg border-stone-200 bg-white text-sm"
                    autoComplete="off"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        addPerson()
                      }
                    }}
                  />
                  <Button type="button" variant="outline" className="rounded-lg border-stone-300" onClick={addPerson}>
                    <UserPlus className="size-4" />
                    Add
                  </Button>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {people.map((person) => (
                    <span
                      key={person}
                      className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-2.5 py-1 text-xs font-medium text-stone-700"
                    >
                      {person}
                      {people.length > 1 && (
                        <button
                          type="button"
                          onClick={() => removePerson(person)}
                          className="rounded p-0.5 text-stone-400 hover:bg-stone-100 hover:text-stone-600"
                          aria-label={`Remove ${person}`}
                        >
                          <X className="size-3" />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              </div>

              {mode === 'simple' ? (
                <>
                  <form
                    onSubmit={addSimpleBill}
                    className="mt-4 space-y-3 rounded-xl border border-dashed border-stone-200 bg-stone-50/60 p-3"
                  >
                    <p className="text-xs font-medium text-stone-600">New simple bill</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label htmlFor="demo-simple-currency" className="text-xs font-medium text-stone-600">
                          Currency
                        </label>
                        <select
                          id="demo-simple-currency"
                          value={simpleCurrency}
                          onChange={(e) => setSimpleCurrency(e.target.value)}
                          className="h-10 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm"
                        >
                          {CURRENCIES.map((currency) => (
                            <option key={currency} value={currency}>
                              {currency}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-1">
                        <label htmlFor="demo-simple-amount" className="text-xs font-medium text-stone-600">
                          Amount
                        </label>
                        <Input
                          id="demo-simple-amount"
                          type="text"
                          inputMode="decimal"
                          pattern="[0-9.]*"
                          value={simpleAmount}
                          onChange={(e) => {
                            const nextAmount = normalizeAmountInput(e.target.value)
                            setSimpleAmount(nextAmount)
                            const next = rebalanceSplitValues(
                              simpleSplitType,
                              simpleSplitWith,
                              simpleSplitValues,
                              simplePinnedSplits,
                              Number.parseFloat(nextAmount.replace(/,/g, '')) || 0,
                            )
                            setSimpleSplitValues(next.values)
                            setSimplePinnedSplits(next.pinned)
                          }}
                          onBlur={() => {
                            const nextAmount = stripLeadingZerosAmount(simpleAmount)
                            setSimpleAmount(nextAmount)
                            const next = rebalanceSplitValues(
                              simpleSplitType,
                              simpleSplitWith,
                              simpleSplitValues,
                              simplePinnedSplits,
                              Number.parseFloat(nextAmount.replace(/,/g, '')) || 0,
                            )
                            setSimpleSplitValues(next.values)
                            setSimplePinnedSplits(next.pinned)
                          }}
                          placeholder="0.00"
                          className="rounded-lg border-stone-200 bg-white text-sm tabular-nums"
                          autoComplete="off"
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-stone-600">Split type</p>
                      <SplitTypeButtons value={simpleSplitType} onChange={handleSimpleSplitTypeChange} />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-stone-600">Split with</p>
                      <PersonChipGroup
                        people={people}
                        selected={simpleSplitWith}
                        onToggle={toggleSimpleSplitPerson}
                      />
                    </div>
                    <SplitValuesEditor
                      splitType={simpleSplitType}
                      selected={simpleSplitWith}
                      values={simpleSplitValues}
                      amount={Number.parseFloat(simpleAmount.replace(/,/g, '')) || 0}
                      currency={simpleCurrency}
                      onChange={handleSimpleSplitValueChange}
                    />
                    <Button type="submit" className="h-10 w-full rounded-lg">
                      <Plus className="size-4" />
                      Add bill
                    </Button>
                  </form>

                  <ul
                    className="mt-5 max-h-[min(42vh,320px)] space-y-2 overflow-y-auto pr-1"
                    aria-live="polite"
                    aria-label="Simple bill list"
                  >
                    {simpleBills.length === 0 ? (
                      <li className="rounded-xl border border-stone-200 bg-stone-50/50 px-3 py-3 text-sm text-stone-500">
                        No bills yet. Add your first simple bill.
                      </li>
                    ) : (
                      simpleBills.map((bill) => (
                        <li key={bill.id}>
                          <button
                            type="button"
                            onClick={() => setSimpleSelectedId(bill.id)}
                            className={cn(
                              'w-full rounded-xl border px-3 py-3 text-left text-sm transition-colors',
                              bill.id === simpleSelectedId
                                ? 'border-teal-800/35 bg-[#f0f7f5] text-stone-900'
                                : 'border-stone-200 bg-stone-50/40 text-stone-800 hover:border-stone-300',
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="font-medium">Simple bill</span>
                              <span className="shrink-0 tabular-nums text-stone-600">
                                {formatCurrency(bill.amount, bill.currency)}
                              </span>
                            </div>
                            <p className="mt-1 text-xs text-stone-500">
                              {splitTypeLabel(bill.splitType)} · {bill.splitWith.length}{' '}
                              {bill.splitWith.length === 1 ? 'person' : 'people'}
                            </p>
                          </button>
                        </li>
                      ))
                    )}
                  </ul>
                </>
              ) : (
                <>
                  <form
                    onSubmit={addItemizedBill}
                    className="mt-4 space-y-3 rounded-xl border border-dashed border-stone-200 bg-stone-50/60 p-3"
                  >
                    <p className="text-xs font-medium text-stone-600">New itemized bill</p>
                    <div className="space-y-1">
                      <label htmlFor="demo-itemized-currency" className="text-xs font-medium text-stone-600">
                        Currency
                      </label>
                      <select
                        id="demo-itemized-currency"
                        value={itemizedCurrency}
                        onChange={(e) => setItemizedCurrency(e.target.value)}
                        className="h-10 w-full rounded-lg border border-stone-200 bg-white px-3 text-sm"
                      >
                        {CURRENCIES.map((currency) => (
                          <option key={currency} value={currency}>
                            {currency}
                          </option>
                        ))}
                      </select>
                    </div>
                    <Button type="submit" className="h-10 w-full rounded-lg">
                      <Plus className="size-4" />
                      Start itemized bill
                    </Button>
                  </form>

                  {itemizedSelected && (
                    <form onSubmit={addLineToBill} className="mt-5 space-y-3 rounded-xl border border-stone-200 bg-stone-50/50 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-sm font-medium text-stone-600">Add item</p>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-[1fr_7rem] sm:items-end">
                        <div className="space-y-1">
                          <label htmlFor="demo-item-name" className="text-xs font-medium text-stone-600">
                            Item
                          </label>
                          <Input
                            id="demo-item-name"
                            value={lineName}
                            onChange={(e) => setLineName(e.target.value)}
                            placeholder="Noodles"
                            className="rounded-lg border-stone-200 bg-white text-sm"
                            autoComplete="off"
                          />
                        </div>
                        <div className="space-y-1">
                          <label htmlFor="demo-item-amount" className="text-xs font-medium text-stone-600">
                            Amount
                          </label>
                          <Input
                            id="demo-item-amount"
                            type="text"
                            inputMode="decimal"
                            pattern="[0-9.]*"
                            value={lineAmount}
                            onChange={(e) => {
                              const nextAmount = normalizeAmountInput(e.target.value)
                              setLineAmount(nextAmount)
                              const next = rebalanceSplitValues(
                                lineSplitType,
                                lineSplitWith,
                                lineSplitValues,
                                linePinnedSplits,
                                Number.parseFloat(nextAmount.replace(/,/g, '')) || 0,
                              )
                              setLineSplitValues(next.values)
                              setLinePinnedSplits(next.pinned)
                            }}
                            onBlur={() => {
                              const nextAmount = stripLeadingZerosAmount(lineAmount)
                              setLineAmount(nextAmount)
                              const next = rebalanceSplitValues(
                                lineSplitType,
                                lineSplitWith,
                                lineSplitValues,
                                linePinnedSplits,
                                Number.parseFloat(nextAmount.replace(/,/g, '')) || 0,
                              )
                              setLineSplitValues(next.values)
                              setLinePinnedSplits(next.pinned)
                            }}
                            placeholder="0.00"
                            className="rounded-lg border-stone-200 bg-white text-sm tabular-nums"
                            autoComplete="off"
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-stone-600">Item split type</p>
                        <SplitTypeButtons value={lineSplitType} onChange={handleLineSplitTypeChange} />
                      </div>
                      <div className="space-y-1">
                        <p className="text-xs font-medium text-stone-600">Split with</p>
                        <PersonChipGroup
                          people={people}
                          selected={lineSplitWith}
                          onToggle={toggleLineSplitPerson}
                        />
                      </div>
                      <SplitValuesEditor
                        splitType={lineSplitType}
                        selected={lineSplitWith}
                        values={lineSplitValues}
                        amount={Number.parseFloat(lineAmount.replace(/,/g, '')) || 0}
                        currency={itemizedSelected.currency}
                        onChange={handleLineSplitValueChange}
                      />
                      <Button type="submit" className="h-10 w-full rounded-lg">
                        <Plus className="size-4" />
                        Add item
                      </Button>
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
                    <h3 className="text-sm font-semibold">Simple bill preview</h3>
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    Matches app model: currency, amount, split type, split values, and split with.
                  </p>

                  {simpleSelected ? (
                    <div className="mt-4 space-y-4">
                      <div className="rounded-xl border border-stone-200 bg-stone-50/70 p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Amount</p>
                        <p className="mt-0.5 font-display text-2xl font-semibold tabular-nums text-stone-900">
                          {formatCurrency(simpleSelected.amount, simpleSelected.currency)}
                        </p>
                      </div>
                      <div className="rounded-xl border border-stone-200 bg-white p-3">
                        <p className="text-xs font-medium text-stone-600">Split details</p>
                        <p className="mt-1 text-sm text-stone-800">
                          <span className="font-medium">Type:</span> {splitTypeLabel(simpleSelected.splitType)}
                        </p>
                        <div className="mt-3">
                          <p className="text-xs font-medium text-stone-600">Split with</p>
                          <ul className="mt-2 space-y-1 text-sm text-stone-700">
                            {simpleSelected.splitWith.map((person) => (
                              <li key={`simple-split-${person}`} className="flex items-center justify-between">
                                <span className="inline-flex items-center gap-1.5">
                                  <Users className="size-3 shrink-0 text-stone-500" aria-hidden />
                                  {person}
                                </span>
                                <span className="tabular-nums font-medium">
                                  {simpleSelected.splitType === 'equal'
                                    ? 'Included'
                                    : simpleSelected.splitType === 'percentage'
                                      ? `${simpleSelected.splitValues[person] ?? 0}%`
                                      : formatCurrency(simpleSelected.splitValues[person] ?? 0, simpleSelected.currency)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                      {(() => {
                        const perUser = computePerUserAmounts(
                          simpleSelected.amount,
                          simpleSelected.splitType,
                          simpleSelected.splitWith,
                          simpleSelected.splitValues,
                        )
                        return (
                          <div className="rounded-xl border border-teal-800/20 bg-teal-800/6 p-3">
                            <p className="text-xs font-medium uppercase tracking-wide text-teal-900">
                              Per-user split amount
                            </p>
                            <ul className="mt-2 space-y-1">
                              {simpleSelected.splitWith.map((person) => (
                                <li
                                  key={`simple-amount-${person}`}
                                  className="flex items-center justify-between text-sm text-stone-800"
                                >
                                  <span>{person}</span>
                                  <span className="tabular-nums font-semibold text-stone-900">
                                    {formatCurrency(perUser[person] ?? 0, simpleSelected.currency)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )
                      })()}
                    </div>
                  ) : (
                    <p className="mt-6 text-sm text-stone-500">Add a simple bill to preview it.</p>
                  )}
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-stone-800">
                    <ReceiptText className="size-4 text-teal-800" aria-hidden />
                    <h3 className="text-sm font-semibold">Itemized bill preview</h3>
                  </div>
                  <p className="mt-1 text-xs text-stone-500">
                    Each line keeps its own split type and split-with, like in the app flow.
                  </p>

                  {itemizedSelected ? (
                    <div className="mt-4 space-y-4">
                      <div className="rounded-xl border border-stone-200 bg-stone-50/70 p-3">
                        <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Running total</p>
                        <p className="mt-0.5 font-display text-2xl font-semibold tabular-nums text-stone-900">
                          {formatCurrency(totalItemizedBill(itemizedSelected), itemizedSelected.currency)}
                        </p>
                      </div>
                      {(() => {
                        const totals = computeItemizedUserTotals(itemizedSelected)
                        const names = Object.keys(totals)
                        if (names.length === 0) return null
                        return (
                          <div className="rounded-xl border border-teal-800/20 bg-teal-800/6 p-3">
                            <p className="text-xs font-medium uppercase tracking-wide text-teal-900">
                              Total per user
                            </p>
                            <ul className="mt-2 space-y-1">
                              {names.map((person) => (
                                <li
                                  key={`itemized-total-${person}`}
                                  className="flex items-center justify-between text-sm text-stone-800"
                                >
                                  <span>{person}</span>
                                  <span className="tabular-nums font-semibold text-stone-900">
                                    {formatCurrency(totals[person] ?? 0, itemizedSelected.currency)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )
                      })()}
                      <div className="space-y-3">
                        {itemizedSelected.items.length === 0 ? (
                          <p className="text-sm text-stone-500">No items yet. Add your first line from the left panel.</p>
                        ) : (
                          itemizedSelected.items.map((item, index) => (
                            <div
                              key={item.id}
                              className="rounded-2xl border border-stone-200/90 bg-white p-4 shadow-sm shadow-stone-900/4"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                  <p className="text-sm font-semibold text-stone-900">
                                    {index + 1}. {item.name}
                                  </p>
                                  <p className="mt-1 text-sm font-semibold tabular-nums text-stone-900">
                                    {formatCurrency(item.amount, itemizedSelected.currency)}
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  className="h-8 rounded-full px-2.5 text-stone-500 hover:bg-stone-100 hover:text-stone-800"
                                  onClick={() => removeLineFromBill(item.id)}
                                  aria-label={`Delete ${item.name}`}
                                >
                                  <Trash2 className="size-3.5" />
                                  Delete
                                </Button>
                              </div>
                              <div className="mt-2 rounded-lg border border-stone-200 bg-stone-50/60 p-2.5">
                                <p className="text-xs font-medium text-stone-600">Split details</p>
                                <p className="mt-1 text-xs text-stone-700">
                                  <span className="font-medium">Type:</span> {splitTypeLabel(item.splitType)}
                                </p>
                                <ul className="mt-2 space-y-1 text-xs text-stone-600">
                                  {item.splitWith.map((person) => (
                                    <li key={`${item.id}-${person}-value`} className="flex items-center justify-between">
                                      <span className="inline-flex items-center gap-1.5">
                                        <Users className="size-3 shrink-0 text-stone-500" aria-hidden />
                                        {person}
                                      </span>
                                      <span className="tabular-nums font-medium">
                                        {item.splitType === 'equal'
                                          ? 'Included'
                                          : item.splitType === 'percentage'
                                            ? `${item.splitValues[person] ?? 0}%`
                                            : formatCurrency(item.splitValues[person] ?? 0, itemizedSelected.currency)}
                                      </span>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                              {(() => {
                                const perUser = computePerUserAmounts(
                                  item.amount,
                                  item.splitType,
                                  item.splitWith,
                                  item.splitValues,
                                )
                                return (
                                  <div className="mt-2 rounded-lg border border-teal-800/20 bg-teal-800/6 p-2.5">
                                    <p className="text-[0.65rem] font-medium uppercase tracking-wide text-teal-900">
                                      Per-user split amount
                                    </p>
                                    <ul className="mt-1 space-y-0.5 text-xs text-stone-700">
                                      {item.splitWith.map((person) => (
                                        <li
                                          key={`${item.id}-${person}-amount`}
                                          className="flex items-center justify-between"
                                        >
                                          <span>{person}</span>
                                          <span className="tabular-nums font-medium">
                                            {formatCurrency(perUser[person] ?? 0, itemizedSelected.currency)}
                                          </span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )
                              })()}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-6 text-sm text-stone-500">Start an itemized bill to preview it here.</p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
