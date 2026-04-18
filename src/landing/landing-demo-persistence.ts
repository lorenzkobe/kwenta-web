import type { SplitType } from '@/types'
import type { PinnedSplits } from '@/lib/bill-split-form'

export const LANDING_DEMO_STORAGE_KEY = 'kwenta_landing_demo_v1'

export type DemoMode = 'simple' | 'itemized'

type SimpleBillJson = {
  id: string
  currency: string
  amount: number
  splitType: SplitType
  splitWith: string[]
  splitValues: Record<string, number>
}

type ItemizedLineJson = {
  id: string
  name: string
  amount: number
  splitType: SplitType
  splitWith: string[]
  splitValues: Record<string, number>
}

type ItemizedBillJson = {
  id: string
  currency: string
  items: ItemizedLineJson[]
}

/** Full serializable demo state (v1). */
export type LandingDemoStateV1 = {
  v: 1
  mode: DemoMode
  people: string[]
  newPersonName: string
  simpleCurrency: string
  simpleAmount: string
  simpleSplitType: SplitType
  simpleSplitWith: string[]
  simpleSplitValues: Record<string, string>
  simplePinnedSplits: PinnedSplits
  simpleBills: SimpleBillJson[]
  simpleSelectedId: string
  itemizedCurrency: string
  itemizedBills: ItemizedBillJson[]
  itemizedSelectedId: string
  lineName: string
  lineAmount: string
  lineSplitType: SplitType
  lineSplitWith: string[]
  lineSplitValues: Record<string, string>
  linePinnedSplits: PinnedSplits
}

export const LANDING_DEMO_DEFAULTS: Omit<LandingDemoStateV1, 'v'> = {
  mode: 'simple',
  people: [],
  newPersonName: '',
  simpleCurrency: 'PHP',
  simpleAmount: '',
  simpleSplitType: 'equal',
  simpleSplitWith: [],
  simpleSplitValues: {},
  simplePinnedSplits: {},
  simpleBills: [],
  simpleSelectedId: '',
  itemizedCurrency: 'PHP',
  itemizedBills: [],
  itemizedSelectedId: '',
  lineName: '',
  lineAmount: '',
  lineSplitType: 'equal',
  lineSplitWith: [],
  lineSplitValues: {},
  linePinnedSplits: {},
}

function isSplitType(x: unknown): x is SplitType {
  return x === 'equal' || x === 'percentage' || x === 'custom'
}

function parsePinnedSplits(x: unknown): PinnedSplits {
  if (!x || typeof x !== 'object') return {}
  const out: PinnedSplits = {}
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === 'boolean' && v) out[k] = true
  }
  return out
}

function parseStringRecord(x: unknown): Record<string, string> {
  if (!x || typeof x !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

function parseNumberRecord(x: unknown): Record<string, number> {
  if (!x || typeof x !== 'object') return {}
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(x)) {
    if (typeof v === 'number' && !Number.isNaN(v)) out[k] = v
  }
  return out
}

function parseSimpleBill(x: unknown): SimpleBillJson | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string') return null
  if (typeof o.currency !== 'string') return null
  if (typeof o.amount !== 'number') return null
  if (!isSplitType(o.splitType)) return null
  if (!Array.isArray(o.splitWith) || !o.splitWith.every((s) => typeof s === 'string')) return null
  const splitValues = parseNumberRecord(o.splitValues)
  return {
    id: o.id,
    currency: o.currency,
    amount: o.amount,
    splitType: o.splitType,
    splitWith: o.splitWith as string[],
    splitValues,
  }
}

function parseItemizedLine(x: unknown): ItemizedLineJson | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string') return null
  if (typeof o.name !== 'string') return null
  if (typeof o.amount !== 'number') return null
  if (!isSplitType(o.splitType)) return null
  if (!Array.isArray(o.splitWith) || !o.splitWith.every((s) => typeof s === 'string')) return null
  return {
    id: o.id,
    name: o.name,
    amount: o.amount,
    splitType: o.splitType,
    splitWith: o.splitWith as string[],
    splitValues: parseNumberRecord(o.splitValues),
  }
}

function parseItemizedBill(x: unknown): ItemizedBillJson | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (typeof o.id !== 'string') return null
  if (typeof o.currency !== 'string') return null
  if (!Array.isArray(o.items)) return null
  const items: ItemizedLineJson[] = []
  for (const it of o.items) {
    const parsed = parseItemizedLine(it)
    if (parsed) items.push(parsed)
  }
  return { id: o.id, currency: o.currency, items }
}

/** Merge persisted snapshot with defaults; returns safe initial state for the demo. */
export function readLandingDemoInitialState(): Omit<LandingDemoStateV1, 'v'> {
  if (typeof window === 'undefined') {
    return { ...LANDING_DEMO_DEFAULTS }
  }
  try {
    const raw = localStorage.getItem(LANDING_DEMO_STORAGE_KEY)
    if (!raw) return { ...LANDING_DEMO_DEFAULTS }
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return { ...LANDING_DEMO_DEFAULTS }
    const o = parsed as Record<string, unknown>
    if (o.v !== 1) return { ...LANDING_DEMO_DEFAULTS }

    const simpleBillsRaw = Array.isArray(o.simpleBills) ? o.simpleBills.map(parseSimpleBill).filter(Boolean) : []
    const itemizedBillsRaw = Array.isArray(o.itemizedBills)
      ? o.itemizedBills.map(parseItemizedBill).filter(Boolean)
      : []

    return {
      mode: o.mode === 'itemized' ? 'itemized' : 'simple',
      people: Array.isArray(o.people) && o.people.every((p) => typeof p === 'string') ? o.people : [],
      newPersonName: typeof o.newPersonName === 'string' ? o.newPersonName : '',
      simpleCurrency: typeof o.simpleCurrency === 'string' ? o.simpleCurrency : LANDING_DEMO_DEFAULTS.simpleCurrency,
      simpleAmount: typeof o.simpleAmount === 'string' ? o.simpleAmount : '',
      simpleSplitType: isSplitType(o.simpleSplitType) ? o.simpleSplitType : 'equal',
      simpleSplitWith:
        Array.isArray(o.simpleSplitWith) && o.simpleSplitWith.every((s) => typeof s === 'string')
          ? o.simpleSplitWith
          : [],
      simpleSplitValues: parseStringRecord(o.simpleSplitValues),
      simplePinnedSplits: parsePinnedSplits(o.simplePinnedSplits),
      simpleBills: simpleBillsRaw as SimpleBillJson[],
      simpleSelectedId: typeof o.simpleSelectedId === 'string' ? o.simpleSelectedId : '',
      itemizedCurrency:
        typeof o.itemizedCurrency === 'string' ? o.itemizedCurrency : LANDING_DEMO_DEFAULTS.itemizedCurrency,
      itemizedBills: itemizedBillsRaw as ItemizedBillJson[],
      itemizedSelectedId: typeof o.itemizedSelectedId === 'string' ? o.itemizedSelectedId : '',
      lineName: typeof o.lineName === 'string' ? o.lineName : '',
      lineAmount: typeof o.lineAmount === 'string' ? o.lineAmount : '',
      lineSplitType: isSplitType(o.lineSplitType) ? o.lineSplitType : 'equal',
      lineSplitWith:
        Array.isArray(o.lineSplitWith) && o.lineSplitWith.every((s) => typeof s === 'string')
          ? o.lineSplitWith
          : [],
      lineSplitValues: parseStringRecord(o.lineSplitValues),
      linePinnedSplits: parsePinnedSplits(o.linePinnedSplits),
    }
  } catch {
    return { ...LANDING_DEMO_DEFAULTS }
  }
}

export function buildLandingDemoPayload(state: Omit<LandingDemoStateV1, 'v'>): LandingDemoStateV1 {
  return { v: 1, ...state }
}
