import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

/**
 * The Person page statement pages from the server (086): the page halves of C12, C13, C15, C17-C20.
 * Written from the contract, blind to the new page code:
 *  - the first 20 events come from fetchPersonStatementPage(userId, personId), newest first, each
 *    carrying the server's runningNet / prevRunning; data also carries matching and
 *    latestPersonalCurrency;
 *  - "Show older" (no count) loads the next 20 older via fetchPersonStatementPageMore(userId,
 *    personId, { limit: 20, kind, before: { createdAt, id } of the oldest held row }) and
 *    disappears when nothing older remains;
 *  - "Payments only" refetches from the server (kind 'payments'); each payment shows the runningNet
 *    the server sent, which counts the bills between payments;
 *  - a data bump with older rows loaded reloads and keeps them (useKeysetMore);
 *  - Record a payment defaults to latestPersonalCurrency, falling back as today when null;
 *  - the export's personal-bill list, image card and PDF/CSV fetch the full statement via
 *    fetchPersonStatement on tap; the card shows loading, then failed, never a partial list.
 *
 * The real useServerData drives the reads; the server is a fake over one literal dataset that
 * honours kind, limit and a real (createdAt DESC, id DESC) keyset `before`, and computes each
 * event's runningNet over ALL events, the way 086 does. RecordPaymentDialog is replaced by a stub
 * that prints the currency the page hands it (the dialog's own behaviour is not under test).
 *
 * Hand-made rows: every statement event below (shape = StatementEvent in src/api/balances.ts plus
 * runningNet/prevRunning), the person summary (PersonSummary), the profiles (tests/helpers/db
 * makeProfile: a local contact with email '' as the app writes it), the Dexie bills the export card
 * reads (makeBill), and OLD_SHAPE_COPY (the pre-086 cached StatementEvent[] under statement:<id>).
 *
 * Dataset: 90 events, e-001 newest, one minute apart. Every 4th (e-004, e-008, ... e-088: 22) is a
 * payment from Ana (delta -50); the rest are personal bills (delta +100), all PHP.
 */

type Ev = {
  id: string
  type: 'personal_bill' | 'group_bill' | 'payment'
  createdAt: string
  currency: string
  groupId: string | null
  bundleId: string | null
  contextLabel: string
  title: string
  rawAmount: number
  delta: number
  category: string | null
  runningNet: number
  prevRunning: number
}
type Before = { createdAt: string; id: string }
type MoreQuery = { limit: number; kind?: 'all' | 'payments'; before?: Before }
type Gate = { match: (fn: string, q?: MoreQuery) => boolean; release: Array<() => void> }

const server = vi.hoisted(() => ({
  events: [] as Ev[],
  /** Another person's events, by id; anyone not listed gets `events`. */
  otherEvents: {} as Record<string, Ev[]>,
  pageFromCache: false,
  fullFromCache: false,
  latestPersonalCurrency: 'PHP' as string | null,
  pageFail: null as Error | null,
  fullFail: null as Error | null,
  gate: null as Gate | null,
  inFlight: 0,
  generation: 0,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: null, error: null })),
    auth: { getSession: vi.fn(async () => ({ data: { session: null }, error: null })) },
  },
}))

vi.mock('@/api/balances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/balances')>()
  const fetchedAt = '2026-10-20T00:00:00.000Z'
  // Newest first: (createdAt DESC, id DESC).
  const desc = (rows: Ev[]) =>
    [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const olderThan = (e: Ev, b: Before) => e.createdAt < b.createdAt || (e.createdAt === b.createdAt && e.id < b.id)
  async function tracked<T>(fn: string, q: MoreQuery | undefined, answer: () => T): Promise<T> {
    const gen = server.generation
    const track = (delta: number) => {
      if (gen === server.generation) server.inFlight += delta
    }
    track(1)
    try {
      // The answer is computed at call time and delivered when the gate opens.
      let result: T | Error
      try {
        result = answer()
      } catch (err) {
        result = err as Error
      }
      if (server.gate?.match(fn, q)) {
        const gate = server.gate
        track(-1)
        await new Promise<void>((resolve) => gate.release.push(resolve))
        track(1)
      }
      if (result instanceof Error) throw result
      return result
    } finally {
      track(-1)
    }
  }
  const eventsOf = (person: string) => server.otherEvents[person] ?? server.events
  const total = (person: string) => {
    const out: Record<string, number> = {}
    for (const e of eventsOf(person)) out[e.currency] = (out[e.currency] ?? 0) + e.delta
    return out
  }
  return {
    ...actual,
    fetchPersonStatementPage: vi.fn(async (_u: string, person: string, opts?: { limit?: number }) =>
      tracked('page', undefined, () => {
        if (server.pageFail) throw server.pageFail
        const limit = opts?.limit ?? 20
        return {
          data: {
            events: desc(eventsOf(person)).slice(0, limit),
            matching: eventsOf(person).length,
            latestPersonalCurrency: server.latestPersonalCurrency,
          },
          fromCache: server.pageFromCache,
          fetchedAt,
        }
      }),
    ),
    fetchPersonStatementPageMore: vi.fn(async (_u: string, person: string, q: MoreQuery) =>
      tracked('more', q, () => {
        let rows = desc(eventsOf(person))
        if (q.kind === 'payments') rows = rows.filter((e) => e.type === 'payment')
        const matching = rows.length
        if (q.before) rows = rows.filter((e) => olderThan(e, q.before!))
        return {
          data: { events: rows.slice(0, q.limit), matching, latestPersonalCurrency: server.latestPersonalCurrency },
          fromCache: false,
          fetchedAt,
        }
      }),
    ),
    // The full, old endpoint: ascending, no running numbers.
    fetchPersonStatement: vi.fn(async (_u: string, person: string) =>
      tracked('full', undefined, () => {
        if (server.fullFail) throw server.fullFail
        const asc = [...desc(eventsOf(person))].reverse()
        return {
          data: asc.map((e) => {
            const old: Record<string, unknown> = { ...e }
            delete old.runningNet
            delete old.prevRunning
            return old
          }),
          fromCache: server.fullFromCache,
          fetchedAt,
        }
      }),
    ),
    fetchPersonSummary: vi.fn(async (_u: string, person: string) =>
      tracked('summary', undefined, () => ({
        data: { personal: total(person), groups: [], total: total(person) },
        fromCache: false,
        fetchedAt,
      })),
    ),
    // Since 087 the page asks for the full history only when an export opens, and for the items
    // behind the loaded payment rows through the lookup (tests/pages/PersonDetailPage.payments.test.tsx).
    fetchPersonSettlementHistory: vi.fn(async () =>
      tracked('payments', undefined, () => ({ data: [], fromCache: false, fetchedAt })),
    ),
    fetchPersonPaymentItems: vi.fn(async () =>
      tracked('items', undefined, () => ({ data: [], fromCache: false, fetchedAt })),
    ),
  }
})
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ userId: 'me', profile: undefined }) }))
vi.mock('@/lib/people', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchRemoteProfileIntoDexie: vi.fn(async () => 'present'),
  loadProfilesIntoMirror: vi.fn(async () => {}),
}))
vi.mock('@/db/operations', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  addProfilePeerLink: vi.fn(),
  deletePerson: vi.fn(),
  linkProfileToRemote: vi.fn(),
  removeProfilePeerLink: vi.fn(),
}))
vi.mock('@/components/common/RecordPaymentDialog', () => ({
  RecordPaymentDialog: ({ currency }: { currency: string }) => <div data-testid="pay-dialog">PAY-CURRENCY:{currency}</div>,
}))
vi.mock('@/lib/export-splits', () => ({ loadBillExportItems: vi.fn(async () => new Map()) }))
vi.mock('@/lib/export-csv', () => ({ exportPersonToCSV: vi.fn(async () => {}) }))
vi.mock('@/lib/export-pdf', () => ({ generatePersonPDF: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn(), loading: vi.fn(() => 'toast-id') },
}))

import { SAVED_COPY_FALLBACK_MS } from '@/hooks/useServerData'
import * as balances from '@/api/balances'
import { ApiError } from '@/api/balances'
import { writeCache } from '@/api/cache'
import { db } from '@/db/db'
import { exportPersonToCSV } from '@/lib/export-csv'
import { generatePersonPDF } from '@/lib/export-pdf'
import { formatCurrency } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import { PersonDetailPage } from '@/pages/PersonDetailPage'
import { makeBill, makeProfile, resetDb } from '../helpers/db'

type AnyMock = ReturnType<typeof vi.fn>
const api = balances as unknown as Record<string, AnyMock>
const firstPage = () => vi.mocked(api.fetchPersonStatementPage)
const morePage = () => vi.mocked(api.fetchPersonStatementPageMore)
const fullStatement = () => vi.mocked(api.fetchPersonStatement)

const P = 'p-ana'
const B = 'p-ben'
const pad = (i: number) => String(i).padStart(3, '0')
const createdAtOf = (i: number) => new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString()
const titleOf = (i: number) => (i % 4 === 0 ? `Payment #${pad(i)}` : `Bill #${pad(i)}`)

/** 90 events, running numbers computed over ALL events oldest-first (what 086 returns). */
function dataset(n = 90): Ev[] {
  const out: Ev[] = []
  let running = 0
  for (let i = n; i >= 1; i--) {
    const isPayment = i % 4 === 0
    const delta = isPayment ? -50 : 100
    const prevRunning = running
    running += delta
    out.push({
      id: `e-${pad(i)}`,
      type: isPayment ? 'payment' : 'personal_bill',
      createdAt: createdAtOf(i),
      currency: 'PHP',
      groupId: null,
      bundleId: null,
      contextLabel: 'Personal',
      title: titleOf(i),
      rawAmount: Math.abs(delta),
      delta,
      category: null,
      runningNet: running,
      prevRunning,
    })
  }
  return out
}
const eventOf = (i: number) => server.events.find((e) => e.id === `e-${pad(i)}`)!

const OLD_SHAPE_COPY = [
  {
    id: 'old-1',
    type: 'personal_bill',
    createdAt: '2026-01-01T00:00:00.000Z',
    currency: 'PHP',
    groupId: null,
    bundleId: null,
    contextLabel: 'Personal',
    title: 'Old cached bill',
    category: null,
    rawAmount: 10,
    delta: 10,
  },
]

let container: HTMLDivElement
let root: Root
/** Moves the mounted router to another route without remounting the page. */
let goTo: (to: string) => void = () => {}
function CaptureNavigate() {
  const navigate = useNavigate()
  useEffect(() => {
    goTo = navigate
  }, [navigate])
  return null
}

vi.setConfig({ testTimeout: 15_000 })

// Waits until no fake call is in flight and the page has stopped changing for three ticks.
async function settle() {
  let mutations = 0
  const observer = new MutationObserver((records) => {
    mutations += records.length
  })
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true })
  let seen = -1
  let stable = 0
  try {
    await vi.waitFor(
      async () => {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 0))
        })
        stable = server.inFlight === 0 && mutations === seen ? stable + 1 : 0
        seen = mutations
        if (stable < 3) throw new Error('page still settling')
      },
      { timeout: 4000, interval: 0 },
    )
  } finally {
    observer.disconnect()
  }
}

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/app/people/${P}`]}>
        <CaptureNavigate />
        <Routes>
          <Route path="/app/people/:personId" element={<PersonDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await settle()
  return text()
}

const text = () => document.body.textContent ?? ''
const moreCalls = () => morePage().mock.calls.map((c) => c[2] as MoreQuery)
const lastMoreCall = () => moreCalls()[moreCalls().length - 1]

function button(match: RegExp): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) => match.test((b.textContent ?? '').trim())) as
    | HTMLButtonElement
    | undefined
}
const byLabel = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as
    | HTMLButtonElement
    | undefined
/** The statement row (li) showing this title. */
const rowOf = (title: string) => statementRows().find((li) => (li.textContent ?? '').includes(title))
/**
 * The statement's rows only. The page has other lists (the hero's "Right now" per-context lines),
 * so every `li` is not a statement row; a row is the one that shows a running balance.
 */
function statementRows(): Element[] {
  return [...container.querySelectorAll('li')].filter((li) => (li.textContent ?? '').includes('Bal '))
}
const balOf = (i: number) => `Bal ${formatCurrency(eventOf(i).runningNet, 'PHP')}`

async function click(el: Element | undefined) {
  expect(el).toBeDefined()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

async function bump() {
  await act(async () => useAppStore.getState().bumpDataVersion())
  await settle()
}

const SHOW_OLDER = /^Show older$/

beforeEach(async () => {
  await resetDb()
  await db.profiles.bulkAdd([
    makeProfile({ id: 'me', display_name: 'Me', email: 'me@example.com' }),
    makeProfile({ id: P, display_name: 'Ana', email: '', is_local: true, owner_id: 'me' }),
    makeProfile({ id: B, display_name: 'Ben', email: '', is_local: true, owner_id: 'me' }),
  ])
  server.events = dataset()
  server.otherEvents = {}
  server.pageFromCache = false
  server.fullFromCache = false
  server.latestPersonalCurrency = 'PHP'
  server.pageFail = null
  server.fullFail = null
  server.gate = null
  server.inFlight = 0
  server.generation++
  firstPage().mockClear()
  morePage().mockClear()
  fullStatement().mockClear()
  vi.mocked(generatePersonPDF).mockClear()
  vi.mocked(exportPersonToCSV).mockClear()
  localStorage.clear()
  Object.defineProperty(navigator, 'onLine', { value: true, configurable: true })
  useAppStore.setState({ currentUserId: 'me', isOnline: true, dataVersion: 0, skippedBumps: {} })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  server.gate?.release.forEach((release) => release())
  server.gate = null
  await act(async () => root.unmount())
  await settle()
  container.remove()
})

describe('PersonDetailPage statement, server-paged', () => {
  it('C12: opening the person reads the first page and shows exactly its 20 newest events, no full statement', async () => {
    const t = await render()
    expect(firstPage()).toHaveBeenCalled()
    expect(firstPage().mock.calls[0].slice(0, 2)).toEqual(['me', P])
    expect(morePage()).not.toHaveBeenCalled()
    expect(fullStatement()).not.toHaveBeenCalled()
    expect(t).toContain('Bill #001')
    expect(t).toContain('Payment #020')
    expect(t).not.toContain('Bill #021')
  })

  it('C12/C15: each row shows the runningNet the server sent; the newest equals the summary total', async () => {
    await render()
    expect(rowOf('Bill #001')?.textContent).toContain(balOf(1))
    expect(rowOf('Payment #012')?.textContent).toContain(balOf(12))
    expect(rowOf('Bill #019')?.textContent).toContain(balOf(19))
    // Newest running number = the hero's total (68 bills x 100 - 22 payments x 50 = 5700).
    expect(eventOf(1).runningNet).toBe(5700)
    expect(rowOf('Bill #001')?.textContent).toContain(`Bal ${formatCurrency(5700, 'PHP')}`)
  })

  it('C12: rows are newest first', async () => {
    await render()
    const t = text()
    expect(t.indexOf('Bill #001')).toBeLessThan(t.indexOf('Bill #002'))
    expect(t.indexOf('Bill #002')).toBeLessThan(t.indexOf('Bill #019'))
  })

  it('C19: the button reads "Show older" with no count', async () => {
    await render()
    expect(button(SHOW_OLDER)).toBeDefined()
    expect(button(/^Show more/)).toBeUndefined()
    expect(text()).not.toMatch(/remaining/i)
  })

  it('C12: Show older asks only for the 20 events before the oldest one held', async () => {
    await render()
    await click(button(SHOW_OLDER))

    expect(moreCalls()).toHaveLength(1)
    expect(morePage().mock.calls[0].slice(0, 2)).toEqual(['me', P])
    const q = moreCalls()[0]
    expect(q).toMatchObject({ limit: 20, before: { createdAt: createdAtOf(20), id: 'e-020' } })
    expect(q.kind ?? 'all').toBe('all')
    expect(text()).toContain('Bill #001')
    expect(text()).toContain('Bill #039')
    expect(text()).toContain('Payment #040')
    expect(text()).not.toContain('Bill #041')
    // Older rows keep the running number the server sent for them.
    expect(rowOf('Bill #033')?.textContent).toContain(balOf(33))
  })

  it('C12/C19: walking to the oldest event shows every event once, then the button disappears', async () => {
    await render()
    for (let n = 0; n < 4; n++) await click(button(SHOW_OLDER))

    expect(lastMoreCall()).toMatchObject({ limit: 20, before: { createdAt: createdAtOf(80), id: 'e-080' } })
    expect(text()).toContain('Bill #090')
    expect(text().match(/Bill #090/g)).toHaveLength(1)
    expect(statementRows()).toHaveLength(90)
    expect(button(SHOW_OLDER)).toBeUndefined()
  })

  it('C19: Show older is not offered when the statement has exactly 20 events', async () => {
    server.events = dataset(20)
    const t = await render()
    expect(t).toContain('Bill #019')
    expect(button(SHOW_OLDER)).toBeUndefined()
  })

  it('C12: an empty statement shows the empty copy and no Show older', async () => {
    server.events = []
    await render()
    expect(text()).toContain('No bills or payments between you yet.')
    expect(button(SHOW_OLDER)).toBeUndefined()
  })
})

describe('PersonDetailPage statement, Payments filter on the server', () => {
  it('C12: Payments only fetches the payments first page from the server, no cursor', async () => {
    await render()
    await click(button(/^Payments only$/))

    expect(moreCalls()).toHaveLength(1)
    const q = moreCalls()[0]
    expect(q).toMatchObject({ limit: 20, kind: 'payments' })
    expect(q.before).toBeUndefined()
    expect(text()).toContain('Payment #004')
    expect(text()).toContain('Payment #080')
    expect(text()).not.toContain('Payment #084')
    expect(text()).not.toContain('Bill #001')
  })

  it('C5/C12: each payment shows the runningNet the server sent, which counts the bills between them', async () => {
    await render()
    await click(button(/^Payments only$/))
    // Payment #060 was never on the all-kinds first page; its number comes from the server.
    expect(rowOf('Payment #060')?.textContent).toContain(balOf(60))
    expect(rowOf('Payment #004')?.textContent).toContain(balOf(4))
    // Not a payments-only walk (that would read -50 x the payments so far).
    expect(rowOf('Payment #004')?.textContent).not.toContain(`Bal ${formatCurrency(-1100, 'PHP')}`)
  })

  it('C12/C19: Show older under Payments asks for older payments only, then disappears', async () => {
    await render()
    await click(button(/^Payments only$/))
    expect(button(SHOW_OLDER)).toBeDefined()

    await click(button(SHOW_OLDER))
    expect(lastMoreCall()).toMatchObject({
      limit: 20,
      kind: 'payments',
      before: { createdAt: createdAtOf(80), id: 'e-080' },
    })
    expect(text()).toContain('Payment #088')
    expect(statementRows()).toHaveLength(22)
    expect(button(SHOW_OLDER)).toBeUndefined()
  })

  it('C12: Payments only with no payments shows the payments empty copy', async () => {
    server.events = dataset(3)
    await render()
    await click(button(/^Payments only$/))
    expect(text()).toContain('No payments recorded yet.')
    expect(text()).not.toContain('Bill #001')
  })

  it('C12: back to Everything shows the all-kinds first page again, not the loaded payments', async () => {
    await render()
    await click(button(/^Payments only$/))
    await click(button(SHOW_OLDER))
    await click(button(/^Everything$/))
    expect(text()).toContain('Bill #001')
    expect(text()).not.toContain('Payment #088')
    expect(statementRows()).toHaveLength(20)
  })
})

describe('PersonDetailPage statement, reload after a write', () => {
  it('C12: a data bump with only the first page loaded re-reads it and makes no cursor call', async () => {
    await render()
    const before = firstPage().mock.calls.length
    await bump()
    expect(firstPage().mock.calls.length).toBeGreaterThan(before)
    expect(morePage()).not.toHaveBeenCalled()
  })

  it('C12: a bump with 40 events loaded reloads the older rows and keeps them on screen', async () => {
    await render()
    await click(button(SHOW_OLDER))
    expect(text()).toContain('Bill #039')
    server.events = server.events.map((e) => (e.id === 'e-035' ? { ...e, title: 'Renamed 035' } : e))
    const calls = moreCalls().length

    await bump()

    const reloads = moreCalls().slice(calls)
    expect(reloads.length).toBeGreaterThan(0)
    expect(reloads[0]).toMatchObject({ before: { createdAt: createdAtOf(20), id: 'e-020' } })
    expect(reloads[0].kind ?? 'all').toBe('all')
    expect(text()).toContain('Renamed 035')
    expect(text()).toContain('Payment #040')
    expect(text()).not.toContain('Bill #041')
    expect(statementRows()).toHaveLength(40)
  })
})

describe('PersonDetailPage statement, saved copies (C17)', () => {
  it('C17: an old-shape copy under statement:<id> never seeds the view or crashes it', async () => {
    writeCache(`statement:${P}`, 'me', OLD_SHAPE_COPY, '2026-10-01T00:00:00.000Z')
    server.gate = { match: (fn) => fn === 'page', release: [] }

    await render()
    expect(text()).toContain('Statement')
    expect(text()).not.toContain('Old cached bill')

    const gate = server.gate
    server.gate = null
    await act(async () => gate.release.forEach((r) => r()))
    await settle()
    expect(text()).toContain('Bill #001')
    expect(text()).not.toContain('Old cached bill')
  })
})

describe('PersonDetailPage statement, refusal (C14)', () => {
  it('C14: a refused first page is an error, never the empty statement', async () => {
    server.pageFail = new ApiError('You no longer have access to this statement.')
    await render()
    expect(text()).toContain('You no longer have access to this statement.')
    expect(text()).not.toContain('No bills or payments between you yet.')
    expect(statementRows()).toHaveLength(0)
  })
})

describe('PersonDetailPage payment dialog currency (C18)', () => {
  it('C18: defaults to latestPersonalCurrency from the server, not the loaded page', async () => {
    // Every loaded event is PHP; the newest personal bill over the whole history is USD.
    server.latestPersonalCurrency = 'USD'
    await render()
    await click(button(/^Record a payment$/))
    expect(text()).toContain('PAY-CURRENCY:USD')
  })

  it('C18: null (no personal bill ever) falls back to the NEWEST event currency, as today', async () => {
    server.latestPersonalCurrency = null
    server.events = dataset(30).map((e) => ({
      ...e,
      type: e.type === 'payment' ? 'payment' : 'group_bill',
      groupId: 'g-1',
      contextLabel: 'Siquijor',
      currency: e.id === 'e-001' ? 'JPY' : 'EUR',
    }))
    await render()
    await click(button(/^Record a payment$/))
    expect(text()).toContain('PAY-CURRENCY:JPY')
  })
})

describe('PersonDetailPage export uses the full statement on tap (C13/C20)', () => {
  async function seedPersonalBillsInMirror() {
    await db.bills.bulkAdd(
      server.events
        .filter((e) => e.type === 'personal_bill')
        .map((e) => makeBill({ id: e.id, title: e.title, created_by: 'me', total_amount: 200 })),
    )
  }

  /**
   * The card's bill rows come from a Dexie live query that resolves after the DOM goes quiet, so
   * `settle()` alone can return before it does; wait on the card itself.
   */
  async function cardShowsOpenBills() {
    await vi.waitFor(() => expect(text()).toContain('Open Personal Bills'), { timeout: 4000 })
  }

  it('C13: opening the export fetches the full statement, and PDF/CSV get every event', async () => {
    await render()
    expect(fullStatement()).not.toHaveBeenCalled()

    await click(byLabel('Share person summary'))
    expect(fullStatement()).toHaveBeenCalled()
    expect(fullStatement().mock.calls[0].slice(0, 2)).toEqual(['me', P])

    await click(button(/^Export PDF$/))
    expect(generatePersonPDF).toHaveBeenCalledTimes(1)
    const [pdfPerson, pdfEvents, pdfPayments] = vi.mocked(generatePersonPDF).mock.calls[0] as unknown as [string, { id: string }[], unknown[]]
    expect(pdfPerson).toBe(P)
    expect(pdfEvents).toHaveLength(90)
    expect(pdfEvents.map((e) => e.id)).toContain('e-090')
    expect(pdfPayments).toEqual([])

    await click(button(/^Export CSV$/))
    expect(exportPersonToCSV).toHaveBeenCalledTimes(1)
    const [csvPerson, csvUser, csvEvents] = vi.mocked(exportPersonToCSV).mock.calls[0] as unknown as [string, string, { id: string }[]]
    expect(csvPerson).toBe(P)
    expect(csvUser).toBe('me')
    expect(csvEvents).toHaveLength(90)
  })

  it('C13: when the full statement fails, PDF and CSV export nothing', async () => {
    server.fullFail = new ApiError('Could not load this statement.')
    await render()
    await click(byLabel('Share person summary'))
    expect(fullStatement()).toHaveBeenCalled()

    const pdf = button(/^Export PDF$/)
    if (pdf && !pdf.disabled) await click(pdf)
    const csv = button(/^Export CSV$/)
    if (csv && !csv.disabled) await click(csv)
    expect(generatePersonPDF).not.toHaveBeenCalled()
    expect(exportPersonToCSV).not.toHaveBeenCalled()
  })

  it('C20: the card lists open personal bills from the FULL statement, including ones off the loaded page', async () => {
    await seedPersonalBillsInMirror()
    await render()
    await click(byLabel('Share person summary'))
    await cardShowsOpenBills()
    // e-089 is 69 events past the first page: only the full statement has it.
    expect(text()).toContain('Bill #089')
    expect(button(/^Save PNG$/)?.disabled).toBe(false)
  })

  it('C20: while the full statement loads, the card shows a loading state and cannot be saved', async () => {
    await seedPersonalBillsInMirror()
    await render()
    server.gate = { match: (fn) => fn === 'full', release: [] }
    await click(byLabel('Share person summary'))

    expect(button(/^Save PNG$/)?.disabled).toBe(true)
    expect(text()).not.toContain('Open Personal Bills')
    expect(text()).toMatch(/loading/i)

    const gate = server.gate
    server.gate = null
    await act(async () => gate.release.forEach((r) => r()))
    await settle()
    await cardShowsOpenBills()
    expect(text()).toContain('Bill #089')
    expect(button(/^Save PNG$/)?.disabled).toBe(false)
  })

  it('C20: when the full statement fails, the card shows a failed state and cannot be saved', async () => {
    await seedPersonalBillsInMirror()
    server.fullFail = new ApiError('Could not load this statement.')
    await render()
    await click(byLabel('Share person summary'))

    expect(button(/^Save PNG$/)?.disabled).toBe(true)
    expect(text()).not.toContain('Open Personal Bills')
    expect(text()).toMatch(/couldn.t|could not|failed|unavailable/i)
  })
})

describe('PersonDetailPage statement, in-place person navigation (H9.1)', () => {
  const benEvents = () =>
    dataset(30).map((e) => ({
      ...e,
      id: e.id.replace('e-', 'b-'),
      title: `Ben item ${e.id.slice(2)}`,
    }))

  it('H9.1: a filter, a pending Show older and an open export of A do not reach B', async () => {
    server.otherEvents = { [B]: benEvents() }
    await render()
    await click(button(/^Payments only$/))
    expect(text()).not.toContain('Bill #001')

    // A's Show older is held in flight while the export opens and the route moves to B.
    server.gate = { match: (fn, q) => fn === 'more' && q?.before !== undefined, release: [] }
    await click(button(SHOW_OLDER))
    await click(byLabel('Share person summary'))
    expect(button(/^Save PNG$/)).toBeDefined()
    const pending = server.gate
    server.gate = null
    const moreBefore = moreCalls().length
    const fullBefore = fullStatement().mock.calls.length

    await act(async () => goTo(`/app/people/${B}`))
    await settle()

    expect(firstPage().mock.calls.some((c) => c[1] === B)).toBe(true)
    expect(text()).toContain('Ben item 001')
    expect(text()).toContain('Ben item 019')
    expect(text()).not.toContain('Ben item 021')
    expect(text()).not.toContain('Bill #')
    expect(text()).not.toContain('Payment #')
    expect(statementRows()).toHaveLength(20)
    // B opens under Everything: not one payments-only request was made for it.
    expect(moreCalls()).toHaveLength(moreBefore)
    expect(button(/^Save PNG$/)).toBeUndefined()

    // A's late answer arrives after the switch.
    await act(async () => pending.release.forEach((r) => r()))
    await settle()

    expect(moreCalls()).toHaveLength(moreBefore)
    expect(fullStatement().mock.calls.length).toBe(fullBefore)
    expect(statementRows()).toHaveLength(20)
    expect(text()).not.toContain('Payment #088')
    expect(text()).not.toContain('Bill #')
    expect(button(/^Save PNG$/)).toBeUndefined()
  })
})

describe('PersonDetailPage export errors and saved copies (items 3, 4)', () => {
  it('item 3: a refused full statement says access was lost, not that the connection failed', async () => {
    server.fullFail = new ApiError('You no longer have access to this statement.')
    await render()
    await click(byLabel('Share person summary'))
    expect(text()).toContain('You no longer have access to this statement.')
    expect(text()).not.toMatch(/check your connection/i)
    expect(button(/^Save PNG$/)?.disabled).toBe(true)
  })

  it('item 4: a saved full list is refused while the screen is a saved copy that is still revalidating', async () => {
    const copy = [...server.events].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 20)
    writeCache(
      `statement-page:${P}`,
      'me',
      { events: copy, matching: server.events.length, latestPersonalCurrency: 'PHP' },
      '2026-10-01T00:00:00.000Z',
    )
    server.fullFromCache = true
    server.gate = { match: (fn) => fn === 'page', release: [] }
    // Online the saved copy waits behind the skeleton until the fallback; this rule is about the
    // copy once it is on screen and still revalidating.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await render()
      expect(text()).not.toContain('Bill #001')
      await act(async () => {
        vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS)
      })
      await settle()
    } finally {
      vi.useRealTimers()
    }
    expect(text()).toContain('Bill #001')

    await click(byLabel('Share person summary'))
    expect(text()).toContain("Couldn't load every bill")
    expect(button(/^Save PNG$/)?.disabled).toBe(true)
    await click(button(/^Export PDF$/))
    expect(generatePersonPDF).not.toHaveBeenCalled()

    const gate = server.gate
    server.gate = null
    await act(async () => gate.release.forEach((r) => r()))
    await settle()
  })

  it('item 4: a saved full list matches a screen whose final answer is also a saved copy', async () => {
    server.pageFromCache = true
    server.fullFromCache = true
    await render()
    await click(byLabel('Share person summary'))
    await click(button(/^Export PDF$/))
    expect(generatePersonPDF).toHaveBeenCalledTimes(1)
  })
})
