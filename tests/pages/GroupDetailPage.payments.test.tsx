import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'
import type { GroupDetail, SettlementHistoryItem } from '@/api/balances'

/**
 * The group's payment history pages from the server (087), the page halves of C8, C9, C13, C17.
 * Written from the contract, blind to the new page code:
 *  - the Payment history list shows the first 20 items from fetchGroupSettlementHistoryPage(userId,
 *    groupId), newest first;
 *  - "Show older" loads the next 20 via fetchGroupSettlementHistoryPageMore(userId, groupId,
 *    { limit: 20, before: { createdAt, id: settlementIds[0] } of the last loaded item }) and
 *    disappears when nothing older remains;
 *  - a data bump with older items loaded reloads them and keeps them on screen (useKeysetMore);
 *  - opening another group in place resets the list;
 *  - CSV/PDF and the export card use the FULL history fetched on tap (fetchGroupSettlementHistory);
 *    a failed fetch exports nothing.
 *
 * The real useServerData drives the reads; the server is a fake over one literal dataset that
 * honours limit and a real (createdAt DESC, settlementIds[0] ASC) keyset `before`, the order 069's
 * builder sorts by (sort_at = created_at, sort_id = the primary leg). Item ids deliberately differ
 * from their primary leg ids, and items #020 and #021 share a created_at, so a cursor built from
 * the item id instead of settlementIds[0] answers #020 a second time.
 *
 * Hand-made rows: every history item below (shape = SettlementHistoryItem in src/api/balances.ts,
 * as toHistoryItem produces it), the roster (GroupDetail['members']), the group row, and the
 * paged group detail (no bills; this file is about payments).
 *
 * Dataset: 45 items in g-1, "Payment #001" newest, one minute apart (#021 as old as #020). #020 is
 * a bundle of two legs. g-2 has 25 items labelled "Other pay #NNN".
 */

type Item = SettlementHistoryItem
type Before = { createdAt: string; id: string }
type MoreQuery = { limit: number; before: Before }
type Gate = { match: (q: MoreQuery) => boolean; release: Array<() => void> }

const server = vi.hoisted(() => ({
  items: [] as Item[],
  other: [] as Item[],
  members: [] as GroupDetail['members'],
  pageFail: null as Error | null,
  moreFail: null as Error | null,
  fullFail: null as Error | null,
  fullNull: false,
  gate: null as Gate | null,
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
  const itemsFor = (groupId: string) => (groupId === 'g-2' ? server.other : server.items)
  const base = (groupId: string) => ({
    group: { ...group, id: groupId },
    members: server.members,
    bills: [],
    pairwise: [],
    totalToReceive: 0,
    totalToPay: 0,
    memberBalances: [],
    rawDebts: [],
  })
  // (createdAt DESC, primary leg ASC): older, or as old with a greater primary leg id.
  const isOlder = (it: Item, b: Before) =>
    it.createdAt < b.createdAt || (it.createdAt === b.createdAt && it.settlementIds[0] > b.id)
  // Both spellings of the page's list field: the SQL's `items` and useKeysetMore's `rows`.
  const page = (rows: Item[], matching: number) => ({ items: rows, rows, matching })
  async function tracked<T>(answer: () => T, gated = false): Promise<T> {
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
      if (gated && server.gate) {
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
  return {
    ...actual,
    fetchGroupDetailPaged: vi.fn(async (_u: string, groupId: string) =>
      tracked(() => ({ data: { ...base(groupId), billCount: 0, billPayers: [] }, fromCache: false, fetchedAt })),
    ),
    fetchGroupBillsPage: vi.fn(async () => tracked(() => ({ data: { rows: [], matching: 0 }, fromCache: false, fetchedAt }))),
    fetchGroupDetail: vi.fn(async (_u: string, groupId: string) =>
      tracked(() => ({ data: base(groupId), fromCache: false, fetchedAt })),
    ),
    fetchGroupSpending: vi.fn(async () => tracked(() => ({ data: { rows: [] }, fromCache: false, fetchedAt }))),
    fetchGroupSettlementHistoryPage: vi.fn(async (_u: string, groupId: string, opts?: { limit?: number }) =>
      tracked(() => {
        if (server.pageFail) throw server.pageFail
        const all = itemsFor(groupId)
        return { data: page(all.slice(0, opts?.limit ?? 20), all.length), fromCache: false, fetchedAt }
      }),
    ),
    fetchGroupSettlementHistoryPageMore: vi.fn(async (_u: string, groupId: string, q: MoreQuery) =>
      tracked(() => {
        if (server.moreFail) throw server.moreFail
        const all = itemsFor(groupId)
        const rows = all.filter((it) => isOlder(it, q.before)).slice(0, q.limit)
        return { data: page(rows, all.length), fromCache: false, fetchedAt }
      }, Boolean(server.gate?.match(q))),
    ),
    fetchGroupSettlementHistory: vi.fn(async (_u: string, groupId: string) =>
      tracked(() => {
        if (server.fullFail) throw server.fullFail
        return { data: server.fullNull ? null : itemsFor(groupId), fromCache: false, fetchedAt }
      }),
    ),
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
  getBillWithDetails: vi.fn(async (billId: string) => ({ id: billId, note: null, items: [] })),
}))
vi.mock('@/lib/export-csv', () => ({ exportGroupToCSV: vi.fn(async () => {}) }))
vi.mock('@/lib/export-pdf', () => ({ generateGroupPDF: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(() => 'toast-id') },
}))

import * as balances from '@/api/balances'
import { ApiError } from '@/api/balances'
import { exportGroupToCSV } from '@/lib/export-csv'
import { generateGroupPDF } from '@/lib/export-pdf'
import { toast } from 'sonner'
import { formatCurrency } from '@/lib/utils'
import { useAppStore } from '@/store/app-store'
import { GroupDetailPage } from '@/pages/GroupDetailPage'

type AnyMock = ReturnType<typeof vi.fn>
const api = balances as unknown as Record<string, AnyMock>
const firstPage = () => vi.mocked(api.fetchGroupSettlementHistoryPage)
const morePage = () => vi.mocked(api.fetchGroupSettlementHistoryPageMore)
const fullHistory = () => vi.mocked(api.fetchGroupSettlementHistory)

const pad = (i: number) => String(i).padStart(3, '0')
const createdAtOf = (i: number) => new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString()

function payItem(i: number, prefix = 'Payment', groupId = 'g-1'): Item {
  const tag = prefix === 'Payment' ? '' : 'o'
  const legs = i === 20 && !tag ? [`s-${pad(i)}`, `s-${pad(i)}b`] : [`s${tag}-${pad(i)}`]
  return {
    id: `pay${tag}-${pad(i)}`,
    settlementIds: legs,
    bundleId: legs.length > 1 ? `pay-${pad(i)}` : null,
    isBundled: legs.length > 1,
    groupId,
    billId: null,
    billTitle: null,
    fromUserId: 'ana',
    toUserId: 'me',
    fromName: 'Ana',
    toName: 'Me',
    amount: 10,
    currency: 'PHP',
    label: `${prefix} #${pad(i)}`,
    method: null,
    // #021 is exactly as old as #020: the tie the primary-leg tiebreak exists for.
    createdAt: createdAtOf(i === 21 && !tag ? 20 : i),
    recipients: [{ toUserId: 'me', toName: 'Me', amount: 10 }],
    legs: [{ fromUserId: 'ana', fromName: 'Ana', toUserId: 'me', toName: 'Me', amount: 10 }],
    recordedByUserId: 'ana',
    recordedByName: 'Ana',
  }
}

const ROSTER: GroupDetail['members'] = [
  { id: 'm-me', userId: 'me', profileName: 'Me', isCurrentUser: true },
  { id: 'm-ana', userId: 'ana', profileName: 'Ana', isCurrentUser: false },
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
}

const text = () => document.body.textContent ?? ''
const count = (re: RegExp) => (text().match(re) ?? []).length
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

async function click(el: Element | undefined) {
  expect(el).toBeDefined()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

/** Group options -> Payment history. */
async function openPayments() {
  await click(byLabel('Group options'))
  await click(button(/^Payment history$/))
}

async function bump() {
  await act(async () => useAppStore.getState().bumpDataVersion())
  await settle()
}

const SHOW_OLDER = /^Show older/

beforeEach(() => {
  server.items = Array.from({ length: 45 }, (_, i) => payItem(i + 1))
  server.other = Array.from({ length: 25 }, (_, i) => payItem(i + 1, 'Other pay', 'g-2'))
  server.members = ROSTER
  server.pageFail = null
  server.moreFail = null
  server.fullFail = null
  server.fullNull = false
  server.gate = null
  server.inFlight = 0
  server.generation++
  firstPage().mockClear()
  morePage().mockClear()
  fullHistory().mockClear()
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

describe('GroupDetailPage payment history, server-paged (C8)', () => {
  it('C8: the payments list reads the first page and shows exactly its 20 newest items; no full history', async () => {
    await render()
    await openPayments()

    expect(firstPage()).toHaveBeenCalled()
    expect(firstPage().mock.calls[0].slice(0, 2)).toEqual(['me', 'g-1'])
    expect(fullHistory()).not.toHaveBeenCalled()
    expect(morePage()).not.toHaveBeenCalled()
    expect(text()).toContain('Payment #001')
    expect(text()).toContain('Payment #020')
    expect(text()).not.toContain('Payment #021')
    expect(text().indexOf('Payment #001')).toBeLessThan(text().indexOf('Payment #002'))
  })

  it("C8/C17: Show older asks for the 20 items before the last one, keyed on its PRIMARY leg, not its item id", async () => {
    await render()
    await openPayments()

    await click(button(SHOW_OLDER))

    expect(moreCalls()).toHaveLength(1)
    expect(morePage().mock.calls[0].slice(0, 2)).toEqual(['me', 'g-1'])
    const q = moreCalls()[0]
    // #020 is the bundle pay-020 with legs [s-020, s-020b]: the cursor id is settlementIds[0].
    expect(q).toMatchObject({ limit: 20, before: { createdAt: createdAtOf(20), id: 's-020' } })
    expect(q.before.id).not.toBe('pay-020')
    expect(text()).toContain('Payment #021')
    expect(text()).toContain('Payment #040')
    expect(text()).not.toContain('Payment #041')
    // #021 shares #020's created_at: it is on this page once, and #020 is not repeated.
    expect(count(/Payment #020/g)).toBe(1)
    expect(count(/Payment #021/g)).toBe(1)
  })

  it('C8: walking to the oldest item shows every item once, then Show older disappears', async () => {
    await render()
    await openPayments()
    await click(button(SHOW_OLDER))
    await click(button(SHOW_OLDER))

    expect(lastMoreCall()).toMatchObject({ limit: 20, before: { createdAt: createdAtOf(40), id: 's-040' } })
    for (let i = 1; i <= 45; i++) expect(count(new RegExp(`Payment #${pad(i)}`, 'g'))).toBe(1)
    expect(button(SHOW_OLDER)).toBeUndefined()
  })

  it('C8: Show older is not offered when the group has exactly 20 payments', async () => {
    server.items = server.items.slice(0, 20)
    await render()
    await openPayments()
    expect(text()).toContain('Payment #020')
    expect(button(SHOW_OLDER)).toBeUndefined()
  })

  it('C8: a group with no payments shows the empty copy and no Show older', async () => {
    server.items = []
    await render()
    await openPayments()
    expect(text()).toContain('No recorded payments yet')
    expect(button(SHOW_OLDER)).toBeUndefined()
  })

  it('C8: a data bump with only the first page loaded re-reads it and makes no older-page call', async () => {
    await render()
    await openPayments()
    const before = firstPage().mock.calls.length

    await bump()

    expect(firstPage().mock.calls.length).toBeGreaterThan(before)
    expect(morePage()).not.toHaveBeenCalled()
  })

  it('C8: a bump with 40 items loaded reloads the older items and keeps them on screen', async () => {
    await render()
    await openPayments()
    await click(button(SHOW_OLDER))
    expect(text()).toContain('Payment #040')
    server.items = server.items.map((it) => (it.id === 'pay-035' ? { ...it, label: 'Renamed 035' } : it))
    const calls = moreCalls().length

    await bump()

    const reloads = moreCalls().slice(calls)
    expect(reloads.length).toBeGreaterThanOrEqual(1)
    expect(reloads[0]).toMatchObject({ before: { createdAt: createdAtOf(20), id: 's-020' } })
    expect(reloads[0].limit).toBeGreaterThanOrEqual(20)
    expect(text()).toContain('Payment #001')
    expect(text()).toContain('Renamed 035')
    expect(text()).not.toContain('Payment #035')
    expect(text()).toContain('Payment #040')
    expect(text()).not.toContain('Payment #041')
    expect(button(SHOW_OLDER)).toBeDefined()
  })

  it("C8: opening another group in place drops the first group's loaded payments", async () => {
    await render()
    await openPayments()
    await click(button(SHOW_OLDER))
    expect(text()).toContain('Payment #040')

    await act(async () => navigateTo('/app/groups/g-2'))
    await settle()
    if (!text().includes('Other pay #001')) await openPayments()

    expect(firstPage().mock.calls.some((c) => c[1] === 'g-2')).toBe(true)
    expect(text()).not.toMatch(/Payment #\d{3}/)
    expect(text()).toContain('Other pay #001')
    expect(text()).toContain('Other pay #020')
    expect(text()).not.toContain('Other pay #021')
    expect(morePage().mock.calls.filter((c) => c[1] === 'g-2')).toHaveLength(0)
  })

  it("C8: an older page still in flight when the group changes never lands in the next group's list", async () => {
    await render()
    await openPayments()
    server.gate = { match: (q) => q.before.id === 's-020', release: [] }
    await click(button(SHOW_OLDER))
    const gate = server.gate
    expect(gate.release).toHaveLength(1)
    server.gate = null

    await act(async () => navigateTo('/app/groups/g-2'))
    await settle()
    if (!text().includes('Other pay #001')) await openPayments()
    await act(async () => gate.release.forEach((r) => r()))
    await settle()

    expect(text()).not.toMatch(/Payment #\d{3}/)
    expect(text()).toContain('Other pay #020')
    expect(text()).not.toContain('Other pay #021')
  })
})

describe('GroupDetailPage payment history, totals over a partial list (gap, not in the case table)', () => {
  it('"Total paid" is never a sum over only the loaded first page', async () => {
    // 45 payments of 10 by Ana: the true total is 450; the first page alone sums to 200. A money
    // number summed on the client from a partial list understates it (CLAUDE.md rule 8).
    await render()
    await openPayments()
    expect(text()).toContain('Payment #020')
    expect(text()).not.toContain(`Ana${formatCurrency(200, 'PHP')}`)
  })
})

describe('GroupDetailPage payment history, refusals (C13)', () => {
  it('C13: a declined first page is never rendered as "No recorded payments yet"', async () => {
    server.pageFail = new ApiError("You no longer have access to this group's payments.")
    await render()
    await openPayments()
    expect(text()).not.toContain('No recorded payments yet')
    expect(text()).not.toMatch(/Payment #\d{3}/)
  })

  it('C13: a declined older page says so and keeps the 20 already shown', async () => {
    await render()
    await openPayments()
    server.moreFail = new ApiError("You no longer have access to this group's payments.")

    await click(button(SHOW_OLDER))

    expect(toast.error).toHaveBeenCalledWith("You no longer have access to this group's payments.")
    expect(text()).toContain('Payment #020')
    expect(text()).not.toContain('Payment #021')
  })
})

describe('GroupDetailPage exports use the full payment history fetched on tap (C9)', () => {
  it('C9: Export CSV fetches the full history on tap and exports all 45 items, past the first page', async () => {
    await render()
    expect(fullHistory()).not.toHaveBeenCalled()

    await click(byLabel('Share group summary'))
    await click(button(/^Export CSV$/))

    expect(fullHistory()).toHaveBeenCalled()
    expect(fullHistory().mock.calls[0].slice(0, 2)).toEqual(['me', 'g-1'])
    expect(exportGroupToCSV).toHaveBeenCalledTimes(1)
    const [, history] = vi.mocked(exportGroupToCSV).mock.calls[0] as unknown as [GroupDetail, Item[]]
    expect(history).toHaveLength(45)
    expect(history.map((h) => h.id)).toContain('pay-045')
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('C9: Export PDF fetches the full history on tap and exports all 45 items', async () => {
    await render()
    await click(byLabel('Share group summary'))
    await click(button(/^Export PDF$/))

    expect(fullHistory()).toHaveBeenCalled()
    expect(generateGroupPDF).toHaveBeenCalledTimes(1)
    const [, history] = vi.mocked(generateGroupPDF).mock.calls[0] as unknown as [GroupDetail, Item[]]
    expect(history).toHaveLength(45)
    expect(history.map((h) => h.id)).toContain('pay-045')
  })

  it('C9: the export card lists the full history, not the 20 the screen holds', async () => {
    await render()
    await openPayments()
    expect(text()).not.toContain('Payment #021')

    await click(byLabel('Share group summary'))

    expect(fullHistory()).toHaveBeenCalled()
    expect(text()).toContain('Payment History (45)')
    expect(text()).not.toContain('Payment History (20)')
  })

  it('C9: a failed full-history fetch exports no CSV and no PDF, and says so', async () => {
    await render()
    server.fullFail = new ApiError('Network request failed')

    await click(byLabel('Share group summary'))
    await click(button(/^Export CSV$/))
    await click(button(/^Export PDF$/))

    expect(exportGroupToCSV).not.toHaveBeenCalled()
    expect(generateGroupPDF).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Could not export CSV', expect.anything())
    expect(toast.error).toHaveBeenCalledWith('Could not generate PDF', expect.anything())
  })

  it('C9: a failed full-history fetch never builds the card from the first page, and blocks the image', async () => {
    await render()
    await openPayments()
    server.fullFail = new ApiError('Network request failed')

    await click(byLabel('Share group summary'))

    expect(text()).not.toContain('Payment History (20)')
    expect(text()).not.toContain('Payment History (45)')
    expect(button(/^Save PNG$|^Share$/)?.disabled).toBe(true)
  })

  it('C9/C13: a declined (NULL) full history exports nothing rather than an empty Payments section', async () => {
    await render()
    server.fullNull = true

    await click(byLabel('Share group summary'))
    await click(button(/^Export CSV$/))

    expect(exportGroupToCSV).not.toHaveBeenCalled()
  })
})
