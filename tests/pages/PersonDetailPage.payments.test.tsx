import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { SettlementHistoryItem } from '@/api/balances'

/**
 * The Person page stops downloading the full payment history on open (087), the page halves of
 * C10, C11, C12, C13, C15. Written from the contract, blind to the new page code:
 *  - opening the page makes NO fetchPersonSettlementHistory call;
 *  - statement payment rows show their note (the item's label) and method and are editable using
 *    fetchPersonPaymentItems(userId, personId, settlementIds), called ONCE for the whole loaded set
 *    of payment leg ids (after Show older: one call covering every loaded leg, not one per page);
 *  - exports and the export card fetch the full history (fetchPersonSettlementHistory) on tap;
 *  - Record a payment's currency: latestPersonalCurrency, then the loaded statement, then the first
 *    shared group, then PHP — none of it needs the full history.
 *
 * The real useServerData drives the reads; the server is a fake over one literal dataset (the
 * statement keyset is the one tests/pages/PersonDetailPage.statement.test.tsx uses: createdAt DESC,
 * id DESC). A statement payment row's settlementIds are its event ids (src/lib/money-flow.ts:196),
 * so the leg ids the lookup receives are the payment events' ids. RecordPaymentDialog and
 * EditSettlementDialog are stubs that print what the page hands them.
 *
 * The lookup fake answers a bare array that also carries { data, fromCache, fetchedAt }: the
 * contract does not say which of the two the fetcher resolves to.
 *
 * Hand-made rows: every statement event (StatementEvent plus runningNet/prevRunning), the person
 * summary (PersonSummary), the payment history items (SettlementHistoryItem, one per payment
 * event: id item-e-NNN, settlementIds [e-NNN], label "Note NNN", method GCash), and the profiles
 * (tests/helpers/db makeProfile: a local contact with email '' as the app writes it).
 *
 * Dataset: 90 events, e-001 newest, one minute apart. Every 4th (e-004 ... e-088: 22) is a payment
 * from Ana; the rest are personal bills. All PHP unless a test says otherwise.
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
type Item = SettlementHistoryItem
type Before = { createdAt: string; id: string }
type MoreQuery = { limit: number; kind?: 'all' | 'payments'; before?: Before }
type Gate = { match: (fn: string) => boolean; release: Array<() => void> }

const server = vi.hoisted(() => ({
  events: [] as Ev[],
  items: [] as Item[],
  latestPersonalCurrency: 'PHP' as string | null,
  summaryGroups: [] as { groupId: string; groupName: string; currency: string; net: number; theirNet: number }[],
  lookupFail: null as Error | null,
  /** The first statement page answers as a primed read does: an already-resolved promise, no tracking. */
  primedFirstPage: false,
  historyFail: null as Error | null,
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
  const desc = (rows: Ev[]) =>
    [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
  const olderThan = (e: Ev, b: Before) => e.createdAt < b.createdAt || (e.createdAt === b.createdAt && e.id < b.id)
  async function tracked<T>(fn: string, answer: () => T): Promise<T> {
    const gen = server.generation
    const track = (delta: number) => {
      if (gen === server.generation) server.inFlight += delta
    }
    track(1)
    try {
      let result: T | Error
      try {
        result = answer()
      } catch (err) {
        result = err as Error
      }
      if (server.gate?.match(fn)) {
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
  const total = () => {
    const out: Record<string, number> = {}
    for (const e of server.events) out[e.currency] = (out[e.currency] ?? 0) + e.delta
    return out
  }
  return {
    ...actual,
    fetchPersonStatementPage: vi.fn((_u: string, _p: string, opts?: { limit?: number }) => {
      const answer = () => ({
        data: {
          events: desc(server.events).slice(0, opts?.limit ?? 20),
          matching: server.events.length,
          latestPersonalCurrency: server.latestPersonalCurrency,
        },
        fromCache: false,
        fetchedAt,
      })
      return server.primedFirstPage ? Promise.resolve(answer()) : tracked('page', answer)
    }),
    fetchPersonStatementPageMore: vi.fn(async (_u: string, _p: string, q: MoreQuery) =>
      tracked('more', () => {
        let rows = desc(server.events)
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
    fetchPersonStatement: vi.fn(async () =>
      tracked('full', () => ({
        data: [...desc(server.events)].reverse().map((e) => {
          const old: Record<string, unknown> = { ...e }
          delete old.runningNet
          delete old.prevRunning
          return old
        }),
        fromCache: false,
        fetchedAt,
      })),
    ),
    fetchPersonSummary: vi.fn(async () =>
      tracked('summary', () => ({
        data: { personal: total(), groups: server.summaryGroups, total: total() },
        fromCache: false,
        fetchedAt,
      })),
    ),
    fetchPersonSettlementHistory: vi.fn(async () =>
      tracked('history', () => {
        if (server.historyFail) throw server.historyFail
        return { data: server.items, fromCache: false, fetchedAt }
      }),
    ),
    fetchPersonPaymentItems: vi.fn(async (_u: string, _p: string, ids: string[]) =>
      tracked('lookup', () => {
        if (server.lookupFail) throw server.lookupFail
        const wanted = new Set(ids)
        const rows = server.items.filter((it) => it.settlementIds.some((id) => wanted.has(id)))
        return Object.assign([...rows], { data: rows, fromCache: false, fetchedAt })
      }),
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
vi.mock('@/components/common/EditSettlementDialog', () => ({
  EditSettlementDialog: ({ item }: { item: { id: string } }) => <div data-testid="edit-dialog">EDITING:{item.id}</div>,
}))
vi.mock('@/lib/export-splits', () => ({ loadBillExportItems: vi.fn(async () => new Map()) }))
vi.mock('@/lib/export-csv', () => ({ exportPersonToCSV: vi.fn(async () => {}) }))
vi.mock('@/lib/export-pdf', () => ({ generatePersonPDF: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(() => 'toast-id') },
}))

import * as balances from '@/api/balances'
import { ApiError } from '@/api/balances'
import { db } from '@/db/db'
import { supabase } from '@/lib/supabase'
import { exportPersonToCSV } from '@/lib/export-csv'
import { generatePersonPDF } from '@/lib/export-pdf'
import { useAppStore } from '@/store/app-store'
import { PersonDetailPage } from '@/pages/PersonDetailPage'
import { makeProfile, resetDb } from '../helpers/db'

type AnyMock = ReturnType<typeof vi.fn>
const api = balances as unknown as Record<string, AnyMock>
const history = () => vi.mocked(api.fetchPersonSettlementHistory)
const lookup = () => vi.mocked(api.fetchPersonPaymentItems)

const P = 'p-ana'
const pad = (i: number) => String(i).padStart(3, '0')
const createdAtOf = (i: number) => new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString()

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
      title: isPayment ? `Payment #${pad(i)}` : `Bill #${pad(i)}`,
      rawAmount: Math.abs(delta),
      delta,
      category: null,
      runningNet: running,
      prevRunning,
    })
  }
  return out
}

function itemFor(e: Ev): Item {
  const n = e.id.slice(2)
  return {
    id: `item-${e.id}`,
    settlementIds: [e.id],
    bundleId: null,
    isBundled: false,
    groupId: null,
    billId: null,
    billTitle: null,
    fromUserId: P,
    toUserId: 'me',
    fromName: 'Ana',
    toName: 'Me',
    amount: 50,
    currency: e.currency,
    label: `Note ${n}`,
    method: 'GCash',
    createdAt: e.createdAt,
    recipients: [{ toUserId: 'me', toName: 'Me', amount: 50 }],
    legs: [{ fromUserId: P, fromName: 'Ana', toUserId: 'me', toName: 'Me', amount: 50 }],
    recordedByUserId: P,
    recordedByName: 'Ana',
  }
}
const itemsFor = (events: Ev[]) => events.filter((e) => e.type === 'payment').map(itemFor)

/** Payment leg ids of the events numbered 1..n (every 4th). */
const legsUpTo = (n: number) =>
  Array.from({ length: Math.floor(n / 4) }, (_, k) => `e-${pad((k + 1) * 4)}`).sort()

let container: HTMLDivElement
let root: Root

vi.setConfig({ testTimeout: 15_000 })

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
        <Routes>
          <Route path="/app/people/:personId" element={<PersonDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await settle()
}

const text = () => document.body.textContent ?? ''
function button(match: RegExp): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll('button')].find((b) => match.test((b.textContent ?? '').trim())) as
    | HTMLButtonElement
    | undefined
}
const byLabel = (label: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as
    | HTMLButtonElement
    | undefined
function statementRows(): Element[] {
  return [...container.querySelectorAll('li')].filter((li) => (li.textContent ?? '').includes('Bal '))
}
const rowOf = (title: string) => statementRows().find((li) => (li.textContent ?? '').includes(title))
const editIn = (row: Element | undefined) =>
  row?.querySelector('button[aria-label="Edit payment"]') as HTMLButtonElement | null | undefined

async function click(el: Element | null | undefined) {
  expect(el).toBeTruthy()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

async function bump() {
  await act(async () => useAppStore.getState().bumpDataVersion())
  await settle()
}

/** Lookup calls that asked for something (an empty set is no request by contract). */
const lookupCalls = () =>
  lookup()
    .mock.calls.map((c) => ({ args: c.slice(0, 2), ids: [...(c[2] as string[])].sort() }))
    .filter((c) => c.ids.length > 0)

const SHOW_OLDER = /^Show older$/

beforeEach(async () => {
  await resetDb()
  await db.profiles.bulkAdd([
    makeProfile({ id: 'me', display_name: 'Me', email: 'me@example.com' }),
    makeProfile({ id: P, display_name: 'Ana', email: '', is_local: true, owner_id: 'me' }),
  ])
  server.events = dataset()
  server.items = itemsFor(server.events)
  server.latestPersonalCurrency = 'PHP'
  server.summaryGroups = []
  server.lookupFail = null
  server.primedFirstPage = false
  server.historyFail = null
  server.gate = null
  server.inFlight = 0
  server.generation++
  history().mockClear()
  lookup().mockClear()
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
  // The offline cases swap in the real lookup and a fake rpc; reset puts the factory fakes back.
  lookup().mockReset()
  vi.mocked(supabase.rpc).mockReset()
})

describe('PersonDetailPage statement payment rows without the full history (C10)', () => {
  it('C10: opening the page never downloads the full payment history', async () => {
    await render()
    expect(text()).toContain('Payment #020')
    expect(history()).not.toHaveBeenCalled()
  })

  it('C10/C15: one lookup for the loaded page, asking for exactly its payment legs', async () => {
    await render()
    const calls = lookupCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].args).toEqual(['me', P])
    expect(calls[0].ids).toEqual(['e-004', 'e-008', 'e-012', 'e-016', 'e-020'])
  })

  it('C10: a payment row shows its note and method from the looked-up item, and Edit opens that item', async () => {
    await render()
    const row = rowOf('Payment #004')
    expect(row?.textContent).toContain('Note 004')
    expect(row?.textContent).toContain('GCash')
    expect(editIn(row)).toBeTruthy()

    await click(editIn(row))

    expect(text()).toContain('EDITING:item-e-004')
  })

  it('C10 refused side: a payment leg with no item gets no Edit and no note; bill rows never get Edit', async () => {
    server.items = server.items.filter((it) => it.id !== 'item-e-008')
    await render()
    const row = rowOf('Payment #008')
    expect(row).toBeDefined()
    expect(editIn(row)).toBeFalsy()
    expect(row?.textContent).not.toContain('Note 008')
    expect(editIn(rowOf('Bill #001'))).toBeFalsy()
    expect(editIn(rowOf('Payment #012'))).toBeTruthy()
  })

  it('C13: a declined lookup leaves the statement on screen, with no payment row editable', async () => {
    server.lookupFail = new ApiError("You no longer have access to this person's payments.")
    await render()
    expect(text()).toContain('Bill #001')
    expect(text()).not.toContain('No bills or payments between you yet.')
    expect(rowOf('Payment #004')).toBeDefined()
    expect(editIn(rowOf('Payment #004'))).toBeFalsy()
    expect(history()).not.toHaveBeenCalled()
  })
})

describe('PersonDetailPage payment lookup cost (C15)', () => {
  it('C15: Show older costs ONE lookup, covering every loaded leg, not one per page', async () => {
    await render()
    const before = lookupCalls().length

    await click(button(SHOW_OLDER))

    const added = lookupCalls().slice(before)
    expect(added).toHaveLength(1)
    expect(added[0].args).toEqual(['me', P])
    expect(added[0].ids).toEqual(legsUpTo(40))
    expect(rowOf('Payment #036')?.textContent).toContain('Note 036')
    expect(editIn(rowOf('Payment #036'))).toBeTruthy()
    // The first page's rows keep their items.
    expect(rowOf('Payment #004')?.textContent).toContain('Note 004')
    expect(history()).not.toHaveBeenCalled()
  })

  it('C15: each Show older is one lookup over the whole loaded set, to the last page', async () => {
    await render()
    for (let n = 1; n <= 4; n++) {
      const before = lookupCalls().length
      await click(button(SHOW_OLDER))
      const added = lookupCalls().slice(before)
      expect(added).toHaveLength(1)
      expect(added[0].ids).toEqual(legsUpTo(Math.min(20 * (n + 1), 90)))
    }
    expect(button(SHOW_OLDER)).toBeUndefined()
    expect(lookupCalls()[lookupCalls().length - 1].ids).toHaveLength(22)
    expect(rowOf('Payment #088')?.textContent).toContain('Note 088')
  })

  it('C15: a write (data bump) with 40 rows loaded costs exactly one lookup, and shows the edited note', async () => {
    await render()
    await click(button(SHOW_OLDER))
    server.items = server.items.map((it) => (it.id === 'item-e-036' ? { ...it, label: 'Edited 036' } : it))
    const before = lookupCalls().length

    await bump()

    const added = lookupCalls().slice(before)
    expect(added).toHaveLength(1)
    expect(added[0].ids).toEqual(legsUpTo(40))
    expect(rowOf('Payment #036')?.textContent).toContain('Edited 036')
    expect(history()).not.toHaveBeenCalled()
  })
})

describe('PersonDetailPage lookup after a write: one call per settled statement (review round 1)', () => {
  it('a write that ADDS a payment leg, with 40 rows loaded, costs exactly one lookup over the new loaded set', async () => {
    await render()
    await click(button(SHOW_OLDER))
    const newest = { ...server.events[server.events.length - 1] }
    const added: Ev = { ...newest, id: 'e-000', type: 'payment', title: 'Payment #000', createdAt: createdAtOf(0), delta: -50, rawAmount: 50 }
    server.events = [...server.events, added]
    server.items = itemsFor(server.events)
    const before = lookupCalls().length

    await bump()

    const asked = lookupCalls().slice(before)
    expect(asked).toHaveLength(1)
    // The new payment pushes the 40th event (e-040) out of the loaded set.
    expect(asked[0].ids).toEqual([...legsUpTo(39), 'e-000'].sort())
    expect(rowOf('Payment #000')?.textContent).toContain('Note 000')
    expect(editIn(rowOf('Payment #000'))).toBeTruthy()
    expect(history()).not.toHaveBeenCalled()
  })

  it('a write that REMOVES a payment leg costs exactly one lookup and its row loses the item', async () => {
    await render()
    await click(button(SHOW_OLDER))
    server.events = server.events.filter((e) => e.id !== 'e-008')
    server.items = itemsFor(server.events)
    const before = lookupCalls().length

    await bump()

    const asked = lookupCalls().slice(before)
    expect(asked).toHaveLength(1)
    expect(asked[0].ids).not.toContain('e-008')
    expect(rowOf('Payment #008')).toBeUndefined()
  })

  it('a statement refresh that changes no leg and bumps no lookup version asks for nothing', async () => {
    await render()
    const before = lookupCalls().length
    // What a new bill write does: the statement refetches, `person-payment-items` is skipped.
    await act(async () =>
      useAppStore.getState().bumpDataVersion(['person-payment-items']),
    )
    await settle()
    expect(lookupCalls().length).toBe(before)
  })

  it('a transport failure keeps the edit, note and method already shown', async () => {
    await render()
    expect(editIn(rowOf('Payment #004'))).toBeTruthy()
    server.lookupFail = new ApiError('Could not load this person\'s payments.')

    await bump()

    expect(lookupCalls().length).toBeGreaterThan(1)
    expect(rowOf('Payment #004')?.textContent).toContain('Note 004')
    expect(editIn(rowOf('Payment #004'))).toBeTruthy()
  })

  it('an access error clears what was shown', async () => {
    await render()
    expect(editIn(rowOf('Payment #004'))).toBeTruthy()
    server.lookupFail = new ApiError("You no longer have access to this person's payments.")

    await bump()

    expect(editIn(rowOf('Payment #004'))).toBeFalsy()
    expect(rowOf('Payment #004')?.textContent).not.toContain('Note 004')
  })
})

describe('PersonDetailPage same-leg edit answered as a primed read (round 2, H8.1)', () => {
  // After an online edit the statement answer is served from the write's own response, so it lands
  // without a visible loading state; the lookup must still run once and show the new note.
  async function editNoteOnce(loadedRows: 20 | 40) {
    await render()
    if (loadedRows === 40) await click(button(SHOW_OLDER))
    const stale = rowOf('Payment #004')
    expect(stale?.textContent).toContain('Note 004')
    server.primedFirstPage = true
    server.items = server.items.map((it) => (it.id === 'item-e-004' ? { ...it, label: 'Edited 004', method: 'Cash' } : it))
    const before = lookupCalls().length

    await bump()

    const asked = lookupCalls().slice(before)
    expect(asked).toHaveLength(1)
    expect(asked[0].ids).toEqual(legsUpTo(loadedRows))
    const row = rowOf('Payment #004')
    expect(row?.textContent).toContain('Edited 004')
    expect(row?.textContent).toContain('Cash')
    await click(editIn(row))
    expect(text()).toContain('EDITING:item-e-004')
    expect(history()).not.toHaveBeenCalled()
  }

  it('a primed same-leg note edit with 20 rows loaded makes exactly one lookup and shows the new note', async () => {
    await editNoteOnce(20)
  })

  it('a primed same-leg note edit with 40 rows loaded makes exactly one lookup and shows the new note', async () => {
    await editNoteOnce(40)
  })

  it('a primed write that ADDS a payment leg with 40 rows loaded still makes exactly one lookup', async () => {
    await render()
    await click(button(SHOW_OLDER))
    server.primedFirstPage = true
    const newest = server.events[server.events.length - 1]
    server.events = [
      ...server.events,
      { ...newest, id: 'e-000', type: 'payment', title: 'Payment #000', createdAt: createdAtOf(0), delta: -50, rawAmount: 50 },
    ]
    server.items = itemsFor(server.events)
    const before = lookupCalls().length

    await bump()

    const asked = lookupCalls().slice(before)
    expect(asked).toHaveLength(1)
    expect(asked[0].ids).toEqual([...legsUpTo(39), 'e-000'].sort())
    expect(rowOf('Payment #000')?.textContent).toContain('Note 000')
  })
})

describe('PersonDetailPage exports fetch the full payment history on tap (C11)', () => {
  it('C11: PDF and CSV get every payment item, including ones the statement never loaded', async () => {
    await render()
    expect(history()).not.toHaveBeenCalled()

    await click(byLabel('Share person summary'))
    expect(history()).toHaveBeenCalled()
    expect(history().mock.calls[0].slice(0, 2)).toEqual(['me', P])

    await click(button(/^Export PDF$/))
    expect(generatePersonPDF).toHaveBeenCalledTimes(1)
    const [, , pdfPayments] = vi.mocked(generatePersonPDF).mock.calls[0] as unknown as [string, unknown[], Item[]]
    expect(pdfPayments).toHaveLength(22)
    expect(pdfPayments.map((p) => p.id)).toContain('item-e-088')

    await click(button(/^Export CSV$/))
    expect(exportPersonToCSV).toHaveBeenCalledTimes(1)
    const [, , , csvPayments] = vi.mocked(exportPersonToCSV).mock.calls[0] as unknown as [string, string, unknown[], Item[]]
    expect(csvPayments).toHaveLength(22)
    expect(csvPayments.map((p) => p.id)).toContain('item-e-088')
  })

  it('C11: the export card lists payments from the full history (a note the page never loaded)', async () => {
    await render()
    expect(text()).not.toContain('Note 088')

    await click(byLabel('Share person summary'))

    await vi.waitFor(() => expect(text()).toContain('Note 088'), { timeout: 4000 })
  })

  it('C11: while the full history loads, the card cannot be saved', async () => {
    await render()
    server.gate = { match: (fn) => fn === 'history', release: [] }

    await click(byLabel('Share person summary'))

    expect(button(/^Save PNG$/)?.disabled).toBe(true)
    expect(text()).not.toContain('Note 088')

    const gate = server.gate
    server.gate = null
    await act(async () => gate.release.forEach((r) => r()))
    await settle()
    await vi.waitFor(() => expect(text()).toContain('Note 088'), { timeout: 4000 })
  })

  it('C11: a failed full history exports no PDF or CSV and the card shows a failed state, never "no payments"', async () => {
    server.historyFail = new ApiError("Could not load this person's payments.")
    await render()
    await click(byLabel('Share person summary'))
    expect(history()).toHaveBeenCalled()

    expect(button(/^Save PNG$/)?.disabled).toBe(true)
    expect(text()).toMatch(/couldn.t|could not|failed|unavailable/i)
    const pdf = button(/^Export PDF$/)
    if (pdf && !pdf.disabled) await click(pdf)
    const csv = button(/^Export CSV$/)
    if (csv && !csv.disabled) await click(csv)
    expect(generatePersonPDF).not.toHaveBeenCalled()
    expect(exportPersonToCSV).not.toHaveBeenCalled()
  })
})

describe('PersonDetailPage payment dialog currency without the full history (C12)', () => {
  it('C12: latestPersonalCurrency wins', async () => {
    server.latestPersonalCurrency = 'USD'
    server.summaryGroups = [{ groupId: 'g-1', groupName: 'Siquijor', currency: 'EUR', net: 0, theirNet: 0 }]
    await render()
    await click(button(/^Record a payment$/))
    expect(text()).toContain('PAY-CURRENCY:USD')
    expect(history()).not.toHaveBeenCalled()
  })

  it("C12: no personal bill: the loaded statement's newest payment currency, before the group's", async () => {
    server.latestPersonalCurrency = null
    server.events = dataset(12)
      .filter((e) => e.type === 'payment')
      .map((e) => ({ ...e, currency: e.id === 'e-004' ? 'JPY' : 'USD' }))
    server.items = itemsFor(server.events)
    server.summaryGroups = [{ groupId: 'g-1', groupName: 'Siquijor', currency: 'EUR', net: 0, theirNet: 0 }]
    await render()
    await click(button(/^Record a payment$/))
    expect(text()).toContain('PAY-CURRENCY:JPY')
    expect(history()).not.toHaveBeenCalled()
  })

  it('C12: an empty statement falls back to the first shared group currency', async () => {
    server.latestPersonalCurrency = null
    server.events = []
    server.items = []
    server.summaryGroups = [{ groupId: 'g-1', groupName: 'Siquijor', currency: 'EUR', net: 0, theirNet: 0 }]
    await render()
    await click(button(/^Record a payment$/))
    expect(text()).toContain('PAY-CURRENCY:EUR')
    expect(history()).not.toHaveBeenCalled()
  })

  it('C12: nothing at all falls back to PHP', async () => {
    server.latestPersonalCurrency = null
    server.events = []
    server.items = []
    await render()
    await click(button(/^Record a payment$/))
    expect(text()).toContain('PAY-CURRENCY:PHP')
    expect(history()).not.toHaveBeenCalled()
  })
})

describe('PersonDetailPage payment rows offline (saved payment lookup)', () => {
  // The real lookup runs here (not the fake above) against a fake server, so what the page shows
  // offline is what the saved set actually holds.
  async function useRealLookup() {
    const real = await vi.importActual<typeof import('@/api/balances')>('@/api/balances')
    lookup().mockImplementation(real.fetchPersonPaymentItems as never)
    vi.mocked(supabase.rpc).mockImplementation((async (fn: string, args: { p_settlement_ids?: string[] }) => ({
      data:
        fn === 'kwenta_person_payment_items'
          ? server.items.filter((it) => it.settlementIds.some((id) => args.p_settlement_ids?.includes(id)))
          : null,
      error: null,
    })) as never)
  }
  async function reopenOffline() {
    await act(async () => root.unmount())
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
    useAppStore.setState({ isOnline: false })
    root = createRoot(container)
    await render()
  }

  it('a row stays editable with its note and method offline when its lookup was saved', async () => {
    await useRealLookup()
    await render()
    expect(rowOf('Payment #004')?.textContent).toContain('Note 004')

    await reopenOffline()

    const row = rowOf('Payment #004')
    expect(row?.textContent).toContain('Note 004')
    expect(row?.textContent).toContain('GCash')
    expect(editIn(row)).toBeTruthy()
    await click(editIn(row))
    expect(text()).toContain('EDITING:item-e-004')
  })

  it('offline with no saved lookup the statement shows and no payment row is editable', async () => {
    await useRealLookup()
    await reopenOffline()

    expect(rowOf('Payment #004')).toBeDefined()
    expect(editIn(rowOf('Payment #004'))).toBeFalsy()
    expect(rowOf('Payment #004')?.textContent).not.toContain('Note 004')
  })

  it('a declined lookup empties the saved set: offline afterwards no row is editable', async () => {
    await useRealLookup()
    await render()
    expect(editIn(rowOf('Payment #004'))).toBeTruthy()
    vi.mocked(supabase.rpc).mockImplementation((async () => ({ data: null, error: null })) as never)

    await bump()
    expect(editIn(rowOf('Payment #004'))).toBeFalsy()

    await reopenOffline()
    expect(editIn(rowOf('Payment #004'))).toBeFalsy()
  })
})
