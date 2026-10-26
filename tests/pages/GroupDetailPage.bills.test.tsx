import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import type { GroupDetail } from '@/api/balances'

/**
 * The group bills section pages from the server (085), the page halves of C6, C7, C8, C22-C26.
 * Written from the contract, blind to the new page code:
 *  - first 20 bills come from fetchGroupDetailPaged(userId, groupId), whose data carries billCount
 *    and billPayers [{ userId, count }] over ALL live bills;
 *  - Show more appends the next 20 via fetchGroupBillsPage(userId, groupId, { limit: 20, payer,
 *    after: { id, createdAt } of the last loaded row }); "Show more (N remaining)" is
 *    matching - loaded, matching = billCount unfiltered, else the filtered page's `matching`;
 *  - payer chips = billPayers restricted to the current roster, hidden under two; a chip fetches
 *    that payer's first page (no `after`); All and the active chip clear the filter;
 *  - CSV/PDF export and the member share card fetch the FULL list via fetchGroupDetail on tap.
 *
 * The real useServerData drives the reads; the server is a fake over one literal dataset that
 * honours payer, limit and a real (createdAt DESC, id) keyset `after`, so a cursor naming a deleted
 * row still lands in the right place.
 *
 * Hand-made rows: every bill below (shape = GroupDetail['bills'][number] in src/api/balances.ts,
 * as the group-detail mapper produces it), the roster (GroupDetail['members']), the group row,
 * and getBillWithDetails' answer (only `note` and items[].splits[].{user_id, computed_amount},
 * the fields the member share reads).
 *
 * Dataset: 60 bills, b-001 newest. b-001..b-055 odd are Ana's (28), even are mine (27), b-056..b-060
 * are Zed's (5) — Zed has left the group, so Zed is not on the roster. Ben is on the roster and
 * paid nothing.
 */

type Bill = GroupDetail['bills'][number]
type PageQuery = { limit: number; payer?: string | null; after?: { id: string; createdAt: string } }

const server = vi.hoisted(() => ({
  bills: [] as Bill[],
  members: [] as GroupDetail['members'],
  detailFromCache: false,
  pageFromCache: false,
  pageFail: null as Error | null,
  fullFail: null as Error | null,
  /** The second group (g-2), opened in place from the first. */
  other: [] as Bill[],
  /** The full-list answer is a saved copy / carries different money than the screen's payload. */
  fullFromCache: false,
  fullTotal: 0,
  /** Every bills-page call answers no rows and matching 0. */
  noMatch: false,
  /** Calls matching `match` answer only when released: the answer is computed at call time, delivered later. */
  gate: null as null | { match: (q: PageQuery) => boolean; release: Array<() => void> },
  inFlight: 0,
  generation: 0,
}))

vi.mock('@/api/balances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/balances')>()
  const fetchedAt = '2026-10-20T00:00:00.000Z'
  const group = {
    id: 'g-1',
    name: 'Siquijor',
    currency: 'PHP',
    createdBy: 'me',
    inviteCode: 'abc123',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }
  const billsFor = (groupId: string) => (groupId === 'g-2' ? server.other : server.bills)
  const base = (bills: Bill[], groupId = 'g-1') => ({
    group: { ...group, id: groupId },
    members: server.members,
    bills,
    pairwise: [],
    totalToReceive: 0,
    totalToPay: 0,
    memberBalances: [],
    rawDebts: [],
  })
  const payersOf = (bills: Bill[]) => {
    const counts = new Map<string, number>()
    for (const b of bills) counts.set(b.paidBy, (counts.get(b.paidBy) ?? 0) + 1)
    return [...counts].map(([userId, count]) => ({ userId, count }))
  }
  // (createdAt DESC, id ASC): the row is after the cursor when older, or as old with a greater id.
  const isAfter = (b: Bill, after: { id: string; createdAt: string }) =>
    b.createdAt < after.createdAt || (b.createdAt === after.createdAt && b.id > after.id)
  async function tracked<T>(fn: () => Promise<T>): Promise<T> {
    const gen = server.generation
    const track = (delta: number) => {
      if (gen === server.generation) server.inFlight += delta
    }
    track(1)
    try {
      return await fn()
    } finally {
      track(-1)
    }
  }
  return {
    ...actual,
    fetchGroupDetailPaged: vi.fn(async (_userId: string, groupId: string, limit = 20) =>
      tracked(async () => ({
        data: {
          ...base(billsFor(groupId).slice(0, limit), groupId),
          billCount: billsFor(groupId).length,
          billPayers: payersOf(billsFor(groupId)),
        },
        fromCache: server.detailFromCache,
        fetchedAt,
      })),
    ),
    fetchGroupBillsPage: vi.fn(async (_userId: string, groupId: string, q: PageQuery) => {
      const gen = server.generation
      const track = (delta: number) => {
        if (gen === server.generation) server.inFlight += delta
      }
      track(1)
      try {
        if (server.pageFail) throw server.pageFail
        let rows = q.payer ? billsFor(groupId).filter((b) => b.paidBy === q.payer) : billsFor(groupId)
        if (server.noMatch) rows = []
        const matching = rows.length
        if (q.after) rows = rows.filter((b) => isAfter(b, q.after!))
        const answer = {
          data: { rows: rows.slice(0, q.limit), matching },
          fromCache: server.pageFromCache,
          fetchedAt,
        }
        if (server.gate?.match(q)) {
          const gate = server.gate
          track(-1)
          await new Promise<void>((resolve) => gate.release.push(resolve))
          track(1)
        }
        return answer
      } finally {
        track(-1)
      }
    }),
    fetchGroupDetail: vi.fn(async (_userId: string, groupId: string) =>
      tracked(async () => {
        if (server.fullFail) throw server.fullFail
        return {
          data: { ...base(billsFor(groupId), groupId), totalToReceive: server.fullTotal },
          fromCache: server.fullFromCache,
          fetchedAt,
        }
      }),
    ),
    // Payment history is paged since 087 (tests/pages/GroupDetailPage.payments.test.tsx): the screen
    // reads an empty first page here, and the full list is only fetched for an export.
    fetchGroupSettlementHistoryPage: vi.fn(async () =>
      tracked(async () => ({ data: { items: [], matching: 0, totals: [] }, fromCache: false, fetchedAt })),
    ),
    fetchGroupSettlementHistoryPageMore: vi.fn(async () =>
      tracked(async () => ({ data: { items: [], matching: 0, totals: [] }, fromCache: false, fetchedAt })),
    ),
    fetchGroupSettlementHistory: vi.fn(async () => tracked(async () => ({ data: [], fromCache: false, fetchedAt }))),
    fetchGroupSpending: vi.fn(async () => tracked(async () => ({ data: { rows: [] }, fromCache: false, fetchedAt }))),
  }
})
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ userId: 'me', profile: undefined }) }))
vi.mock('@/lib/duplicate-identity', () => ({ findDuplicateIdentityCandidates: vi.fn(async () => []) }))
vi.mock('@/db/operations', () => ({
  addExistingGroupMembers: vi.fn(),
  createSettlement: vi.fn(),
  removeGroupMember: vi.fn(),
  deleteGroup: vi.fn(),
  updateGroup: vi.fn(),
  mergeProfileIdentity: vi.fn(),
  deleteBill: vi.fn(),
  getBillWithDetails: vi.fn(async (billId: string) => ({
    id: billId,
    note: null,
    items: [{ splits: [{ user_id: 'ana', computed_amount: 10 }] }],
  })),
}))
vi.mock('@/lib/export-csv', () => ({ exportGroupToCSV: vi.fn(async () => {}) }))
vi.mock('@/lib/export-pdf', () => ({ generateGroupPDF: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn(), loading: vi.fn(() => 'toast-id') },
}))

import * as balances from '@/api/balances'
import { ApiError } from '@/api/balances'
import { getBillWithDetails } from '@/db/operations'
import { exportGroupToCSV } from '@/lib/export-csv'
import { generateGroupPDF } from '@/lib/export-pdf'
import { toast } from 'sonner'
import { useAppStore } from '@/store/app-store'
import { GroupDetailPage } from '@/pages/GroupDetailPage'

// The page under test may not import these yet; the mock above defines them either way.
type AnyMock = ReturnType<typeof vi.fn>
const api = balances as unknown as Record<string, AnyMock>
const detailPaged = () => vi.mocked(api.fetchGroupDetailPaged)
const billsPage = () => vi.mocked(api.fetchGroupBillsPage)
const fullDetail = () => vi.mocked(api.fetchGroupDetail)

const pad = (i: number) => String(i).padStart(3, '0')
const NAMES: Record<string, string> = { me: 'Me', ana: 'Ana', zed: 'Zed' }
const createdAtOf = (i: number) => new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString()

function bill(i: number, over: Partial<Bill> = {}): Bill {
  const paidBy = i > 55 ? 'zed' : i % 2 === 1 ? 'ana' : 'me'
  return {
    id: `b-${pad(i)}`,
    title: `Bill #${pad(i)}`,
    note: '',
    currency: 'PHP',
    totalAmount: 100,
    createdAt: createdAtOf(i),
    createdBy: paidBy,
    paidBy,
    groupId: 'g-1',
    category: null,
    payorName: NAMES[paidBy],
    originalCurrency: null,
    originalTotal: null,
    exchangeRate: null,
    ...over,
  }
}

const ROSTER: GroupDetail['members'] = [
  { id: 'm-me', userId: 'me', profileName: 'Me', isCurrentUser: true },
  { id: 'm-ana', userId: 'ana', profileName: 'Ana', isCurrentUser: false },
  { id: 'm-ben', userId: 'ben', profileName: 'Ben', isCurrentUser: false },
]

let container: HTMLDivElement
let root: Root
let navigateTo: (to: string) => void = () => {}

function CaptureNavigate({ onReady }: { onReady: (navigate: (to: string) => void) => void }) {
  const navigate = useNavigate()
  useEffect(() => onReady(navigate))
  return null
}

vi.setConfig({ testTimeout: 15_000 })

// Waits until no fake call is in flight and the page has stopped changing for three ticks.
async function settle() {
  let mutations = 0
  const observer = new MutationObserver((records) => {
    mutations += records.length
  })
  observer.observe(container, { childList: true, subtree: true, characterData: true, attributes: true })
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
      { timeout: 3000, interval: 0 },
    )
  } finally {
    observer.disconnect()
  }
}

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/app/groups/g-1']}>
        <CaptureNavigate onReady={(navigate) => { navigateTo = navigate }} />
        <Routes>
          <Route path="/app/groups/:groupId" element={<GroupDetailPage />} />
        </Routes>
      </MemoryRouter>,
    )
  })
  await settle()
  return container.textContent ?? ''
}

const text = () => container.textContent ?? ''
const pageCalls = () => billsPage().mock.calls.map((c) => c[2] as PageQuery)
const lastPageCall = () => pageCalls()[pageCalls().length - 1]

function button(match: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => match.test((b.textContent ?? '').trim())) as
    | HTMLButtonElement
    | undefined
}
const byLabel = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label) as
    | HTMLButtonElement
    | undefined

async function click(el: Element | undefined) {
  expect(el).toBeDefined()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

async function goToGroup(id: string) {
  await act(async () => navigateTo(`/app/groups/${id}`))
  await settle()
}

async function bump() {
  await act(async () => useAppStore.getState().bumpDataVersion())
  await settle()
}

async function goOffline() {
  Object.defineProperty(navigator, 'onLine', { value: false, configurable: true })
  await act(async () => useAppStore.setState({ isOnline: false }))
  await settle()
}

const OFFLINE_ERROR = "You're offline and these bills have not been loaded yet."
const SHARE_FAIL = "Couldn't load this group's bills. Check your connection and try again."
const FULL_STALE = "Couldn't load every bill. Check your connection and try again."

beforeEach(() => {
  server.bills = Array.from({ length: 60 }, (_, i) => bill(i + 1))
  server.members = ROSTER
  server.detailFromCache = false
  server.pageFromCache = false
  server.pageFail = null
  server.fullFail = null
  server.other = Array.from({ length: 30 }, (_, i) =>
    bill(i + 1, {
      id: `o-${pad(i + 1)}`,
      title: `Other #${pad(i + 1)}`,
      groupId: 'g-2',
      paidBy: i % 2 === 0 ? 'ana' : 'me',
      createdBy: i % 2 === 0 ? 'ana' : 'me',
      payorName: i % 2 === 0 ? 'Ana' : 'Me',
    }),
  )
  server.fullFromCache = false
  server.fullTotal = 0
  server.noMatch = false
  server.gate = null
  server.inFlight = 0
  server.generation++
  detailPaged().mockClear()
  billsPage().mockClear()
  fullDetail().mockClear()
  vi.mocked(getBillWithDetails).mockClear()
  vi.mocked(exportGroupToCSV).mockClear()
  vi.mocked(generateGroupPDF).mockClear()
  vi.mocked(toast.error).mockClear()
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

describe('GroupDetailPage bills, server-paged', () => {
  it('C6: opening the group reads the paged detail and shows exactly its 20 newest bills, no full list', async () => {
    const t = await render()
    expect(detailPaged()).toHaveBeenCalled()
    expect(detailPaged().mock.calls[0].slice(0, 2)).toEqual(['me', 'g-1'])
    expect(fullDetail()).not.toHaveBeenCalled()
    expect(billsPage()).not.toHaveBeenCalled()
    expect(t).toContain('Bill #001')
    expect(t).toContain('Bill #020')
    expect(t).not.toContain('Bill #021')
  })

  it('C6/C24: Show more asks only for the 20 rows after the last one held, and N remaining comes from billCount', async () => {
    await render()
    expect(button(/^Show more/)?.textContent).toContain('40 remaining')

    await click(button(/^Show more/))

    expect(pageCalls()).toHaveLength(1)
    const q = pageCalls()[0]
    expect(billsPage().mock.calls[0].slice(0, 2)).toEqual(['me', 'g-1'])
    expect(q).toMatchObject({ limit: 20, after: { id: 'b-020', createdAt: createdAtOf(20) } })
    expect(q.payer ?? null).toBeNull()
    expect(text()).toContain('Bill #001')
    expect(text()).toContain('Bill #040')
    expect(text()).not.toContain('Bill #041')
    expect(button(/^Show more/)?.textContent).toContain('20 remaining')

    await click(button(/^Show more/))
    expect(lastPageCall()).toMatchObject({ limit: 20, after: { id: 'b-040', createdAt: createdAtOf(40) } })
    expect(text()).toContain('Bill #060')
    expect(text().match(/Bill #060/g)).toHaveLength(1)
    expect(button(/^Show more/)).toBeUndefined()
  })

  it('C6/C24: Show more is not offered when the group has exactly 20 bills', async () => {
    server.bills = server.bills.slice(0, 20)
    const t = await render()
    expect(t).toContain('Bill #020')
    expect(button(/^Show more/)).toBeUndefined()
  })

  it('C6: a data bump with only the first page loaded re-reads the paged detail and makes no page call', async () => {
    await render()
    const before = detailPaged().mock.calls.length

    await bump()

    expect(detailPaged().mock.calls.length).toBeGreaterThan(before)
    expect(billsPage()).not.toHaveBeenCalled()
  })

  it('C6: a bump with 40 rows loaded reloads every loaded row and keeps them on screen', async () => {
    await render()
    await click(button(/^Show more/))
    expect(text()).toContain('Bill #040')
    server.bills = server.bills.map((b) => (b.id === 'b-035' ? { ...b, title: 'Renamed 035' } : b))
    const before = pageCalls().length

    await bump()

    const added = pageCalls().slice(before)
    expect(added.length).toBeGreaterThanOrEqual(1)
    expect(added[0]).toMatchObject({ after: { id: 'b-020', createdAt: createdAtOf(20) } })
    expect(added[0].limit).toBeGreaterThanOrEqual(20)
    expect(added[0].payer ?? null).toBeNull()
    expect(text()).toContain('Bill #001')
    expect(text()).toContain('Bill #040')
    expect(text()).toContain('Renamed 035')
    expect(text()).not.toContain('Bill #035')
    expect(text()).not.toContain('Bill #041')
    expect(button(/^Show more/)?.textContent).toContain('20 remaining')
  })

  it('C6 race: a Show more answer landing after a fresh first page is re-issued once from the new last row', async () => {
    await render()
    server.gate = { match: (q) => q.after?.id === 'b-020', release: [] }
    await click(button(/^Show more/))
    const gate = server.gate
    expect(gate.release).toHaveLength(1)
    server.gate = null
    // A bill added at the top while the tap is in flight shifts the list by one.
    server.bills = [bill(0), ...server.bills]

    await bump()
    const before = pageCalls().length
    await act(async () => gate.release.forEach((r) => r()))
    await settle()

    const after = pageCalls().slice(before).filter((q) => q.after)
    expect(after).toHaveLength(1)
    expect(after[0]).toMatchObject({ limit: 20, after: { id: 'b-019', createdAt: createdAtOf(19) } })
    expect(text()).toContain('Bill #000')
    expect(text()).toContain('Bill #039')
    expect(text().match(/Bill #020/g)).toHaveLength(1)
    expect(text()).not.toContain('Bill #040')
  })

  it('C6 race: a Show more answer landing after a reload started is dropped, and no deleted bill returns', async () => {
    await render()
    await click(button(/^Show more/))
    server.gate = { match: (q) => q.after?.id === 'b-040', release: [] }
    await click(button(/^Show more/))
    expect(server.gate.release).toHaveLength(1)
    server.bills = server.bills.filter((b) => b.id !== 'b-030')

    await bump()
    await act(async () => server.gate!.release.forEach((r) => r()))
    await settle()

    expect(text()).not.toContain('Bill #030')
    expect(text()).toContain('Bill #060')
    expect(text().match(/Bill #041/g)).toHaveLength(1)
    expect(text().match(/Bill #060/g)).toHaveLength(1)
    expect(button(/^Show more/)).toBeUndefined()
  })

  it('C7/C23: payer chips are billPayers on the current roster, so a removed member gets no chip but still counts', async () => {
    await render()
    expect(button(/^All$/)).toBeDefined()
    expect(button(/^You$/)).toBeDefined()
    expect(button(/^Ana$/)).toBeDefined()
    // Zed paid 5 bills but left the group; Ben is on the roster but paid nothing.
    expect(button(/^Zed$/)).toBeUndefined()
    expect(button(/^Ben$/)).toBeUndefined()
    // billCount is 60 including Zed's 5 bills.
    expect(button(/^Show more/)?.textContent).toContain('40 remaining')
  })

  it('C7: the chips come from billPayers, not from the loaded rows (a payer seen only past the first page)', async () => {
    server.bills = Array.from({ length: 30 }, (_, i) =>
      bill(i + 1, i < 20 ? { paidBy: 'me', createdBy: 'me', payorName: 'Me' } : { paidBy: 'ben', createdBy: 'ben', payorName: 'Ben' }),
    )
    const t = await render()
    expect(detailPaged()).toHaveBeenCalled()
    expect(t).not.toContain('Paid by Ben')
    expect(button(/^You$/)).toBeDefined()
    expect(button(/^Ben$/)).toBeDefined()
  })

  it('C23: the chip row is hidden when fewer than two roster members paid', async () => {
    server.bills = Array.from({ length: 30 }, (_, i) =>
      bill(i + 1, i < 25 ? { paidBy: 'ana', createdBy: 'ana', payorName: 'Ana' } : { paidBy: 'zed', createdBy: 'zed', payorName: 'Zed' }),
    )
    await render()
    expect(button(/^All$/)).toBeUndefined()
    expect(button(/^Ana$/)).toBeUndefined()
    expect(button(/^Zed$/)).toBeUndefined()
  })

  it("C7: choosing a chip fetches that payer's first page from the server, no cursor", async () => {
    await render()

    await click(button(/^Ana$/))

    const q = lastPageCall()
    expect(billsPage().mock.calls[billsPage().mock.calls.length - 1].slice(0, 2)).toEqual(['me', 'g-1'])
    expect(q).toMatchObject({ limit: 20, payer: 'ana' })
    expect(q.after).toBeUndefined()
    expect(text()).toContain('Bill #001')
    expect(text()).toContain('Bill #039')
    expect(text()).not.toContain('Bill #002')
    expect(text()).not.toContain('Bill #041')
    // Ana paid 28: 28 - 20 loaded.
    expect(button(/^Show more/)?.textContent).toContain('8 remaining')
  })

  it('C25: Show more under a payer filter follows that payer\'s cursor', async () => {
    await render()
    await click(button(/^Ana$/))

    await click(button(/^Show more/))

    expect(lastPageCall()).toMatchObject({ limit: 20, payer: 'ana', after: { id: 'b-039', createdAt: createdAtOf(39) } })
    expect(text()).toContain('Bill #041')
    expect(text()).toContain('Bill #055')
    expect(text()).not.toContain('Bill #002')
    expect(text()).not.toContain('Bill #056')
    expect(button(/^Show more/)).toBeUndefined()
  })

  it('C25: the All chip clears the filter and returns to the paged detail\'s rows', async () => {
    await render()
    await click(button(/^Ana$/))
    expect(text()).not.toContain('Bill #002')

    await click(button(/^All$/))

    expect(text()).toContain('Bill #002')
    expect(text()).toContain('Bill #020')
    expect(text()).not.toContain('Bill #021')
    expect(button(/^Show more/)?.textContent).toContain('40 remaining')
  })

  it('C25: tapping the active chip again clears the filter', async () => {
    await render()
    await click(button(/^Ana$/))
    expect(text()).not.toContain('Bill #002')

    await click(button(/^Ana$/))

    expect(text()).toContain('Bill #002')
    expect(text()).not.toContain('Bill #021')
    expect(button(/^Show more/)?.textContent).toContain('40 remaining')
  })

  it('C25: a filter chosen after Show more drops the appended rows and starts that payer at 20', async () => {
    await render()
    await click(button(/^Show more/))
    expect(text()).toContain('Bill #040')

    await click(button(/^You$/))

    expect(lastPageCall()).toMatchObject({ limit: 20, payer: 'me' })
    expect(lastPageCall().after).toBeUndefined()
    expect(text()).toContain('Bill #040')
    expect(text()).not.toContain('Bill #021')
    expect(text()).not.toContain('Bill #042')
    expect(text()).not.toContain('Bill #001')
  })

  it("C24: a group with no bills says 'No bills in this group yet'", async () => {
    server.bills = []
    const t = await render()
    expect(t).toContain('No bills in this group yet')
    expect(button(/^Show more/)).toBeUndefined()
  })

  it("C24: a filtered first page with matching 0 says 'No bills paid by Ana', not the empty-group text", async () => {
    await render()
    server.noMatch = true

    await click(button(/^Ana$/))

    expect(text()).toContain('No bills paid by Ana')
    expect(text()).not.toContain('No bills in this group yet')
    expect(button(/^Show more/)).toBeUndefined()
  })

  it('C8/C26/C21: Export CSV fetches the full list on tap and exports every bill; the page keeps its 20', async () => {
    await render()
    expect(fullDetail()).not.toHaveBeenCalled()

    await click(byLabel('Share group summary'))
    await click(button(/^Export CSV$/))

    expect(fullDetail()).toHaveBeenCalledWith('me', 'g-1')
    expect(exportGroupToCSV).toHaveBeenCalledTimes(1)
    const [detail, history] = vi.mocked(exportGroupToCSV).mock.calls[0] as unknown as [GroupDetail, unknown[]]
    const ids = detail.bills.map((b) => b.id)
    expect(ids).toHaveLength(60)
    expect(ids).toContain('b-001')
    expect(ids).toContain('b-060')
    expect(history).toEqual([])
    expect(toast.error).not.toHaveBeenCalled()
    // The full fetch never touches the page's own list: it still has 40 bills to load.
    expect(button(/^Show more/)?.textContent).toContain('40 remaining')
  })

  it('C8/C21: opening Share group summary fetches the full list once and the card shows every bill', async () => {
    await render()
    expect(fullDetail()).not.toHaveBeenCalled()

    await click(byLabel('Share group summary'))

    expect(fullDetail()).toHaveBeenCalledTimes(1)
    expect(fullDetail()).toHaveBeenCalledWith('me', 'g-1')
    expect(text()).toContain('Bills (60)')
    expect(text()).toContain('Bill #060')
    expect(button(/^Save PNG$|^Share$/)?.disabled).toBe(false)
  })

  it('C8: exporting from the opened summary reuses the full list instead of asking again', async () => {
    await render()
    await click(byLabel('Share group summary'))
    await click(button(/^Export CSV$/))

    expect(fullDetail()).toHaveBeenCalledTimes(1)
    const [detail] = vi.mocked(exportGroupToCSV).mock.calls[0] as unknown as [GroupDetail]
    expect(detail.bills).toHaveLength(60)
  })

  it('C8: when the full list cannot be loaded the summary builds no card from the first page and blocks the image', async () => {
    await render()
    server.fullFail = new ApiError('Network request failed')

    await click(byLabel('Share group summary'))

    expect(text()).toContain(SHARE_FAIL)
    expect(text()).not.toContain('Bills (20)')
    expect(button(/^Save PNG$|^Share$/)?.disabled).toBe(true)

    server.fullFail = null
    await click(button(/^Try again$/))
    expect(text()).toContain('Bills (60)')
  })

  it('C8/C26: Export PDF fetches the full list on tap and exports every bill', async () => {
    await render()
    expect(fullDetail()).not.toHaveBeenCalled()

    await click(byLabel('Share group summary'))
    await click(button(/^Export PDF$/))

    expect(fullDetail()).toHaveBeenCalledWith('me', 'g-1')
    expect(generateGroupPDF).toHaveBeenCalledTimes(1)
    const [detail] = vi.mocked(generateGroupPDF).mock.calls[0] as unknown as [GroupDetail]
    expect(detail.bills.map((b) => b.id)).toHaveLength(60)
    expect(detail.bills.map((b) => b.id)).toContain('b-060')
  })

  it('C8: a failed full-list fetch exports no CSV and the dialog reports it', async () => {
    await render()
    server.fullFail = new ApiError('Network request failed')

    await click(byLabel('Share group summary'))
    await click(button(/^Export CSV$/))

    expect(exportGroupToCSV).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Could not export CSV', expect.anything())
  })

  it('C8: a failed full-list fetch exports no PDF and the dialog reports it', async () => {
    await render()
    server.fullFail = new ApiError('Network request failed')

    await click(byLabel('Share group summary'))
    await click(button(/^Export PDF$/))

    expect(generateGroupPDF).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Could not generate PDF', expect.anything())
  })

  it("C8/C26: the member share card fetches the full list on tap and covers bills past the first page", async () => {
    await render()
    fullDetail().mockClear()
    vi.mocked(getBillWithDetails).mockClear()

    await click(byLabel("Share Ana's share"))

    expect(fullDetail()).toHaveBeenCalledWith('me', 'g-1')
    const asked = new Set(vi.mocked(getBillWithDetails).mock.calls.map((c) => c[0]))
    expect(asked.size).toBe(60)
    expect(asked.has('b-021')).toBe(true)
    expect(asked.has('b-060')).toBe(true)
    // The card lists Ana's share of each bill, the 60th included.
    expect(text()).toContain('Bill #060')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('C8: a failed full-list fetch builds no member card and says so', async () => {
    await render()
    server.fullFail = new ApiError('Network request failed')
    vi.mocked(getBillWithDetails).mockClear()

    await click(byLabel("Share Ana's share"))

    expect(toast.error).toHaveBeenCalledWith(SHARE_FAIL)
    expect(getBillWithDetails).not.toHaveBeenCalled()
    expect(text()).not.toContain('Bill #060')
  })

  it('H9.1: opening another group in place drops the first group\'s loaded rows, even with a Show more in flight', async () => {
    await render()
    server.gate = { match: (q) => q.after?.id === 'b-020', release: [] }
    await click(button(/^Show more/))
    const gate = server.gate
    expect(gate.release).toHaveLength(1)
    server.gate = null

    await goToGroup('g-2')
    expect(text()).toContain('Other #001')
    expect(text()).not.toContain('Bill #')

    await act(async () => gate.release.forEach((r) => r()))
    await settle()

    expect(text()).not.toContain('Bill #')
    expect(text()).toContain('Other #020')
    expect(text()).not.toContain('Other #021')
    expect(button(/^Show more/)?.textContent).toContain('10 remaining')
    expect(billsPage().mock.calls.filter((c) => c[1] === 'g-2')).toHaveLength(0)
  })

  it('H9.1: rows loaded by Show more in one group never appear under the next', async () => {
    await render()
    await click(button(/^Show more/))
    expect(text()).toContain('Bill #040')

    await goToGroup('g-2')

    expect(text()).not.toContain('Bill #')
    expect(text().match(/Other #\d+/g)).toHaveLength(20)
    expect(button(/^Show more/)?.textContent).toContain('10 remaining')
  })

  it('H9.1: a payer chosen in one group is not applied to the next', async () => {
    await render()
    await click(button(/^Ana$/))
    expect(text()).not.toContain('Bill #002')

    await goToGroup('g-2')

    expect(text()).toContain('Other #002')
    expect(text()).toContain('Other #001')
    expect(billsPage().mock.calls.filter((c) => c[1] === 'g-2')).toHaveLength(0)
  })

  it('a payer filter whose chip disappeared does not come back with the chip', async () => {
    const all = server.bills
    await render()
    await click(button(/^Ana$/))
    expect(text()).not.toContain('Bill #002')

    server.bills = all.filter((b) => b.paidBy !== 'ana')
    await bump()
    expect(button(/^Ana$/)).toBeUndefined()
    const before = pageCalls().length

    server.bills = all
    await bump()

    expect(button(/^Ana$/)).toBeDefined()
    expect(pageCalls().slice(before).filter((q) => q.payer === 'ana')).toHaveLength(0)
    expect(text()).toContain('Bill #002')
    expect(button(/^Show more/)?.textContent).toContain('40 remaining')
  })

  it('lost access: a payer page the server declined shows the error, never "No bills paid by"', async () => {
    await render()
    server.pageFail = new ApiError("You no longer have access to this group's bills.")

    await click(button(/^Ana$/))

    expect(text()).toContain("You no longer have access to this group's bills.")
    expect(text()).not.toContain('No bills paid by')
    expect(text()).not.toContain('No bills in this group yet')
  })

  it('H9.2: CSV and PDF take the money from the screen and only the bills from the full list', async () => {
    server.fullTotal = 999
    await render()
    await click(byLabel('Share group summary'))

    await click(button(/^Export CSV$/))
    await click(button(/^Export PDF$/))

    const [csv] = vi.mocked(exportGroupToCSV).mock.calls[0] as unknown as [GroupDetail]
    const [pdf] = vi.mocked(generateGroupPDF).mock.calls[0] as unknown as [GroupDetail]
    for (const payload of [csv, pdf]) {
      expect(payload.totalToReceive).toBe(0)
      expect(payload.bills).toHaveLength(60)
    }
  })

  it('H9.2: a saved full list is refused while the screen shows fresh data: nothing exported, summary card not built', async () => {
    server.fullFromCache = true
    await render()

    await click(byLabel('Share group summary'))
    expect(text()).toContain(FULL_STALE)
    expect(text()).not.toContain('Bills (60)')
    await click(button(/^Export CSV$/))

    expect(exportGroupToCSV).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Could not export CSV', expect.anything())
  })

  it('H9.2: the member share refuses a saved full list the same way', async () => {
    server.fullFromCache = true
    await render()

    await click(byLabel("Share Ana's share"))

    expect(toast.error).toHaveBeenCalledWith(FULL_STALE)
    expect(getBillWithDetails).not.toHaveBeenCalled()
  })

  it('H9.2: when the screen is itself a saved copy, the saved full list is used', async () => {
    server.detailFromCache = true
    server.fullFromCache = true
    await render()

    await click(byLabel('Share group summary'))
    expect(text()).toContain('Bills (60)')
    await click(button(/^Export CSV$/))

    expect(exportGroupToCSV).toHaveBeenCalledTimes(1)
    const [csv] = vi.mocked(exportGroupToCSV).mock.calls[0] as unknown as [GroupDetail]
    expect(csv.bills).toHaveLength(60)
  })

  it('C22: offline, a payer filter with no saved copy shows the unavailable message, never an empty list', async () => {
    await render()
    await goOffline()
    server.pageFail = new ApiError(OFFLINE_ERROR)

    await click(button(/^Ana$/))

    expect(text()).toContain(OFFLINE_ERROR)
    expect(text()).not.toContain('No bills paid by Ana')
    expect(text()).not.toContain('No bills in this group yet')
  })

  it("C22: offline, a payer filter with a saved copy shows that copy's rows", async () => {
    await render()
    await goOffline()
    server.pageFromCache = true

    await click(button(/^Ana$/))

    expect(lastPageCall()).toMatchObject({ limit: 20, payer: 'ana' })
    expect(text()).toContain('Bill #001')
    expect(text()).not.toContain('Bill #002')
    expect(text()).not.toContain('No bills paid by Ana')
  })

  it('C22: offline with no saved full list, Export CSV writes no file and the dialog reports it', async () => {
    await render()
    await goOffline()
    server.fullFail = new ApiError("You're offline and this group has not been loaded yet.")

    await click(byLabel('Share group summary'))
    await click(button(/^Export CSV$/))

    expect(exportGroupToCSV).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Could not export CSV', expect.anything())
  })

  it('C22: offline with no saved full list, the member share builds no card and says so', async () => {
    await render()
    await goOffline()
    server.fullFail = new ApiError("You're offline and this group has not been loaded yet.")

    await click(byLabel("Share Ana's share"))

    expect(toast.error).toHaveBeenCalledWith(SHARE_FAIL)
    expect(text()).not.toContain('Bill #060')
  })

  it('C12: opening the group shows the page skeleton, not a spinner, until the detail answers', async () => {
    vi.mocked(balances.fetchGroupDetailPaged).mockImplementationOnce(() => new Promise(() => {}))
    await render()
    expect(container.querySelector('[aria-label="Loading group"]')).not.toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})
