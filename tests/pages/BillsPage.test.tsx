import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import type { PersonalBillRow } from '@/api/balances'
import type { PendingMutation } from '@/types'

/**
 * The Bills page loads from the server in pages of 20 per tab (C16-C22). The server filters,
 * sorts, counts and lists categories (kwenta_personal_bills_page, migration 083); the page sends
 * its controls and renders what comes back, plus the one thing only this device knows — unsent
 * (staged) bills. "Show more" is a keyset step: it asks only for the 20 rows after the last one
 * held (`after`), never for the rows already loaded. Export fetches the full list on tap.
 *
 * The real useServerData drives the first-page fetches; the server is a fake that honours bucket,
 * settled, category, limit and `after` over two literal datasets. The Radix Select is swapped for a native select
 * so the filter and sort can be changed in happy-dom.
 *
 * Hand-made rows: every PersonalBillRow below (shape = PersonalBillRow in src/api/balances.ts,
 * as toBillRow produces it), and the staged row (shape of loadStagedPersonalBillRows: settled
 * false, no participants money).
 */

const server = vi.hoisted(() => ({
  mine: [] as PersonalBillRow[],
  shared: [] as PersonalBillRow[],
  categories: ['food', 'transport'] as string[],
  staged: [] as PersonalBillRow[],
  fromCache: false,
  fail: null as Error | null,
  exportFail: null as Error | null,
  /** When set, every page answers with no rows and matching 0 (the counts stay). */
  noMatch: false,
  /** Calls matching `match` answer only when released: the answer is computed at call time, delivered later. */
  gate: null as null | { match: (q: { limit: number; after?: { id: string } }) => boolean; release: Array<() => void> },
  /** A Show more step answers with this many rows instead of `limit` (stands in for many earlier taps). */
  stepRows: 0,
  /** Fake calls not yet answered; a call held by `gate` does not count, so settle() cannot wait on it. */
  inFlight: 0,
  /** Bumped per test: a late answer from an earlier test must not move this test's in-flight count. */
  generation: 0,
  /** The per-call row cap the page sees (500 in the app); the chunking test lowers it. */
  pageCap: 500,
}))

vi.mock('@/api/balances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/balances')>()
  return {
    ...actual,
    get MAX_BILLS_PAGE_ROWS() {
      return server.pageCap
    },
    fetchPersonalBillsPage: vi.fn(
      async (
        _userId: string,
        q: {
          bucket: 'mine' | 'shared'
          limit: number
          settled: string
          category: string | null
          sort: string
          after?: { id: string }
        },
      ) => {
        const gen = server.generation
        const track = (delta: number) => {
          if (gen === server.generation) server.inFlight += delta
        }
        track(1)
        try {
          if (server.fail) throw server.fail
          let rows = q.bucket === 'mine' ? server.mine : server.shared
          if (q.settled === 'settled') rows = rows.filter((r) => r.settled)
          if (q.settled === 'unsettled') rows = rows.filter((r) => !r.settled)
          if (q.category) rows = rows.filter((r) => r.category === q.category)
          if (server.noMatch) rows = []
          const start = q.after ? rows.findIndex((r) => r.id === q.after!.id) + 1 : 0
          const size = q.after && server.stepRows > 0 && q.limit === 20 ? server.stepRows : q.limit
          const answer = {
            data: {
              rows: rows.slice(start, start + size),
              matching: rows.length,
              mine: server.mine.length,
              shared: server.shared.length,
              categories: server.categories,
            },
            fromCache: server.fromCache,
            fetchedAt: '2026-10-20T00:00:00.000Z',
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
      },
    ),
    fetchPersonalBills: vi.fn(async () => {
      if (server.exportFail) throw server.exportFail
      return {
        data: { mine: server.mine, shared: server.shared },
        fromCache: false,
        fetchedAt: '2026-10-20T00:00:00.000Z',
      }
    }),
  }
})
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ userId: 'me', profile: undefined }) }))
vi.mock('@/lib/staged-rows', () => ({ loadStagedPersonalBillRows: vi.fn(async () => server.staged) }))
vi.mock('@/db/operations', () => ({ deleteBill: vi.fn() }))
vi.mock('@/lib/export-csv', () => ({ exportBillsToCSV: vi.fn(async () => {}) }))
vi.mock('@/lib/export-pdf', () => ({ generateBillsPDF: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), loading: vi.fn(() => 'toast-id') },
}))
vi.mock('@/components/ui/select', async () => {
  const React = await import('react')
  return {
    Select: ({ value, onValueChange, children }: { value: string; onValueChange: (v: string) => void; children: React.ReactNode }) =>
      React.createElement('select', { value, onChange: (e: { target: { value: string } }) => onValueChange(e.target.value) }, children),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) =>
      React.createElement('option', { value }, children),
  }
})

import { ApiError, fetchPersonalBills, fetchPersonalBillsPage } from '@/api/balances'
import { db } from '@/db/db'
import { exportBillsToCSV } from '@/lib/export-csv'
import { toast } from 'sonner'
import { useAppStore } from '@/store/app-store'
import { BillsPage } from '@/pages/BillsPage'

const pad = (i: number) => String(i).padStart(3, '0')

function row(prefix: 'Mine' | 'Shared', i: number, over: Partial<PersonalBillRow> = {}): PersonalBillRow {
  return {
    id: `${prefix.toLowerCase()}-${pad(i)}`,
    title: `${prefix} #${pad(i)}`,
    currency: 'PHP',
    totalAmount: 100,
    createdAt: new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString(),
    createdBy: prefix === 'Mine' ? 'me' : 'ana',
    payorName: prefix === 'Mine' ? 'Me' : 'Ana',
    itemCount: 1,
    settled: i % 2 === 0,
    category: i % 3 === 0 ? 'food' : null,
    participants: [],
    originalCurrency: null,
    originalTotal: null,
    exchangeRate: null,
    ...over,
  }
}

/** Bills this device created offline: staged rows plus the queue's create_bill entry for each. */
async function stageNew(rows: PersonalBillRow[]) {
  server.staged = rows
  const entries: PendingMutation[] = rows.map((r, i) => ({
    id: `pm-${r.id}`,
    actor_user_id: 'me',
    operation: 'create_bill',
    entity_type: 'bill',
    entity_id: r.id,
    payload_json: '{}',
    status: 'pending',
    retry_count: 0,
    last_error: null,
    seq: i + 1,
    submission_id: `sub-${r.id}`,
    push: null,
    row_keys: [],
    next_attempt_at: null,
    last_error_kind: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  }))
  await db.pending_mutations.bulkPut(entries)
}

const STAGED = row('Mine', 0, { id: 'staged-1', title: 'Offline lunch', settled: false, category: null })

let container: HTMLDivElement
let root: Root

// A test settles several times and each settle may take up to 3 s on a loaded machine; the 5 s default
// timed tests out mid-body, and a timed-out body keeps running into the next test.
vi.setConfig({ testTimeout: 15_000 })

// Waits until no fake call is in flight and the page has stopped changing for three ticks. A fixed
// number of ticks asserted before answers landed under load; the late answer of a timed-out test
// then wrote into the next test's container.
async function settle() {
  // Counting mutations instead of comparing innerHTML: serialising 540 rows every tick was itself
  // slow enough to time the chunked-reload test out under load.
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
      <MemoryRouter initialEntries={['/app/bills']}>
        <BillsPage />
      </MemoryRouter>,
    )
  })
  await settle()
  return container.textContent ?? ''
}

const text = () => container.textContent ?? ''
const calls = () => vi.mocked(fetchPersonalBillsPage).mock.calls.map((c) => c[1])
const lastCall = () => calls()[calls().length - 1]

function button(match: RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => match.test(b.textContent ?? '')) as HTMLButtonElement | undefined
}

async function click(el: Element | undefined) {
  expect(el).toBeDefined()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await settle()
}

function selectWith(optionValue: string): HTMLSelectElement | undefined {
  return [...container.querySelectorAll('select')].find((s) => s.querySelector(`option[value="${optionValue}"]`)) as
    | HTMLSelectElement
    | undefined
}

async function choose(optionValue: string) {
  const sel = selectWith(optionValue)
  expect(sel).toBeDefined()
  await act(async () => {
    sel!.value = optionValue
    sel!.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
}

beforeEach(async () => {
  await db.pending_mutations.clear()
  server.mine = Array.from({ length: 45 }, (_, i) => row('Mine', i + 1))
  server.shared = Array.from({ length: 25 }, (_, i) => row('Shared', i + 1))
  server.categories = ['food', 'transport']
  server.staged = []
  server.fromCache = false
  server.fail = null
  server.exportFail = null
  server.noMatch = false
  server.gate = null
  server.stepRows = 0
  server.inFlight = 0
  server.generation++
  server.pageCap = 500
  vi.mocked(fetchPersonalBillsPage).mockClear()
  vi.mocked(fetchPersonalBills).mockClear()
  vi.mocked(exportBillsToCSV).mockClear()
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

describe('BillsPage, server-paged', () => {
  it('C16/C15: first load asks for 20 of My bills and shows exactly those', async () => {
    const t = await render()
    expect(calls()).toContainEqual({ bucket: 'mine', limit: 20, settled: 'all', category: null, sort: 'date_desc' })
    expect(t).toContain('Mine #001')
    expect(t).toContain('Mine #020')
    expect(t).not.toContain('Mine #021')
  })

  it('C16: Show more asks only for the 20 rows after the last one held and appends them', async () => {
    await render()
    expect(button(/Show more/)?.textContent).toContain('25')
    const before = calls().length

    await click(button(/Show more/))

    const added = calls().slice(before)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({ bucket: 'mine', limit: 20, after: { id: 'mine-020', title: 'Mine #020' } })
    expect(text()).toContain('Mine #001')
    expect(text()).toContain('Mine #040')
    expect(text()).not.toContain('Mine #041')
    expect(button(/Show more/)?.textContent).toContain('5')

    await click(button(/Show more/))
    expect(lastCall()).toMatchObject({ bucket: 'mine', limit: 20, after: { id: 'mine-040' } })
    expect(text()).toContain('Mine #045')
    expect(button(/Show more/)).toBeUndefined()
  })

  it('C16: Show more is not offered when everything matching is loaded', async () => {
    server.mine = server.mine.slice(0, 20)
    await render()
    expect(text()).toContain('Mine #020')
    expect(button(/Show more/)).toBeUndefined()
  })

  it('C17: changing the filter refetches from the server and resets to 20', async () => {
    await render()
    await click(button(/Show more/))
    expect(lastCall()).toMatchObject({ limit: 20, after: { id: 'mine-020' } })

    await choose('unsettled')

    expect(lastCall()).toEqual({ bucket: 'mine', limit: 20, settled: 'unsettled', category: null, sort: 'date_desc' })
    expect(text()).toContain('Mine #001')
    expect(text()).not.toContain('Mine #002')
    expect(text()).not.toContain('Mine #040')
  })

  it('C17: changing the sort refetches from the server and resets to 20', async () => {
    await render()
    await click(button(/Show more/))

    await choose('title_desc')

    expect(lastCall()).toEqual({ bucket: 'mine', limit: 20, settled: 'all', category: null, sort: 'title_desc' })
  })

  it('C17/C22: a category chip (from the server categories) refetches with that category and resets to 20', async () => {
    await render()
    await click(button(/Show more/))

    await click(button(/^Food$/))

    expect(lastCall()).toEqual({ bucket: 'mine', limit: 20, settled: 'all', category: 'food', sort: 'date_desc' })
    expect(text()).toContain('Mine #003')
    expect(text()).not.toContain('Mine #001')
  })

  it('C22: the category chips are the server categories, not the categories of the loaded rows', async () => {
    server.categories = ['transport']
    await render()
    expect(button(/^Transport$/)).toBeDefined()
    expect(button(/^Food$/)).toBeUndefined()
  })

  it('C18: Shared with me shows that bucket\'s first 20 with its own Show more, ignoring the My-bills controls', async () => {
    await render()
    await choose('unsettled')
    await choose('title_asc')

    await click(button(/Shared with me/))

    expect(lastCall()).toEqual({ bucket: 'shared', limit: 20, settled: 'all', category: null, sort: 'date_desc' })
    expect(text()).toContain('Shared #001')
    expect(text()).toContain('Shared #020')
    expect(text()).not.toContain('Shared #021')
    expect(button(/Show more/)?.textContent).toContain('5')

    await click(button(/Show more/))
    expect(lastCall()).toMatchObject({
      bucket: 'shared',
      limit: 20,
      settled: 'all',
      category: null,
      sort: 'date_desc',
      after: { id: 'shared-020' },
    })
    expect(text()).toContain('Shared #025')
  })

  it('C22: tab badges and header total come from the server counts plus unsent bills', async () => {
    await stageNew([STAGED])
    await render()
    expect(button(/My bills/)?.textContent).toContain('46')
    expect(button(/Shared with me/)?.textContent).toContain('25')
    expect(text()).toContain('71 bills')
  })

  it('C19: Export fetches the full list on tap and exports every bill of both buckets plus unsent ones', async () => {
    await stageNew([STAGED])
    await render()
    expect(fetchPersonalBills).not.toHaveBeenCalled()

    await click(button(/Export/))
    await click(button(/Export as CSV/))

    expect(fetchPersonalBills).toHaveBeenCalledWith('me')
    expect(exportBillsToCSV).toHaveBeenCalledTimes(1)
    const [uid, rows] = vi.mocked(exportBillsToCSV).mock.calls[0]
    expect(uid).toBe('me')
    const ids = rows.map((r: PersonalBillRow) => r.id)
    expect(ids).toHaveLength(45 + 25 + 1)
    expect(ids).toContain('mine-045')
    expect(ids).toContain('shared-025')
    expect(ids).toContain('staged-1')
  })

  it('C19: an unsent bill the server already has is exported once', async () => {
    await stageNew([{ ...STAGED, id: 'mine-001' }])
    await render()
    await click(button(/Export/))
    await click(button(/Export as CSV/))
    const ids = vi.mocked(exportBillsToCSV).mock.calls[0][1].map((r: PersonalBillRow) => r.id)
    expect(ids.filter((id: string) => id === 'mine-001')).toHaveLength(1)
    expect(ids).toHaveLength(70)
  })

  it('C19: when the full-list fetch fails, the dialog reports it and nothing is exported', async () => {
    await render()
    server.exportFail = new ApiError("You're offline and your bills has not been loaded yet.")
    await click(button(/Export/))
    await click(button(/Export as CSV/))

    expect(exportBillsToCSV).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith('Could not export CSV', expect.anything())
  })

  it('C20: an unsent bill shows at the top of My bills with Not synced', async () => {
    await stageNew([STAGED])
    const t = await render()
    expect(t).toContain('Offline lunch')
    expect(t).toContain('Not synced')
    expect(t.indexOf('Offline lunch')).toBeLessThan(t.indexOf('Mine #001'))
  })

  it('C20: an unsent bill is hidden when it does not match the filter or category', async () => {
    await stageNew([STAGED])
    await render()
    await choose('settled')
    expect(text()).not.toContain('Offline lunch')

    await choose('unsettled')
    expect(text()).toContain('Offline lunch')

    await click(button(/^Food$/))
    expect(text()).not.toContain('Offline lunch')
  })

  it('C20: an unsent bill is not on the Shared tab', async () => {
    await stageNew([STAGED])
    await render()
    await click(button(/Shared with me/))
    expect(text()).not.toContain('Offline lunch')
  })

  it('C20: once the server has the unsent bill it renders once, flagged Not synced', async () => {
    await stageNew([{ ...STAGED, id: 'mine-001' }])
    server.mine = [{ ...server.mine[0], title: 'Offline lunch' }, ...server.mine.slice(1)]
    const t = await render()
    expect(t.match(/Offline lunch/g)).toHaveLength(1)
    expect(t).toContain('Not synced')
  })

  it('C21: a saved copy is shown with the saved-copy notice', async () => {
    server.fromCache = true
    const t = await render()
    expect(t).toContain('Mine #001')
    expect(t).toContain('Showing a saved copy')
  })

  it('C21: no copy for this filter shows the unavailable message, never an empty list', async () => {
    server.fail = new ApiError("You're offline and your bills has not been loaded yet.")
    const t = await render()
    expect(t).toContain('Bills unavailable')
    expect(t).not.toContain('No personal bills yet')
    expect(t).not.toContain('No bills match this filter.')
  })

  it('C22: a filter that matches nothing keeps the controls and says so, not "No personal bills yet"', async () => {
    await render()
    server.noMatch = true
    await choose('settled')

    expect(selectWith('unsettled')).toBeDefined()
    expect(selectWith('title_asc')).toBeDefined()
    expect(button(/Export/)).toBeDefined()
    expect(text()).toContain('No bills match this filter.')
    expect(text()).not.toContain('No personal bills yet')
  })

  it('C22: a first load whose filter matches nothing still shows the controls (gated on the server count)', async () => {
    server.noMatch = true
    const t = await render()
    expect(selectWith('unsettled')).toBeDefined()
    expect(t).not.toContain('No personal bills yet')
  })

  it('C22: with no bills at all the empty state is shown', async () => {
    server.mine = []
    server.shared = []
    server.categories = []
    const t = await render()
    expect(t).toContain('No personal bills yet')
  })

  it('C23: a data bump re-reads the first page once', async () => {
    await render()
    const before = calls().length

    await act(async () => useAppStore.getState().bumpDataVersion())
    await settle()

    expect(calls().slice(before)).toEqual([
      { bucket: 'mine', limit: 20, settled: 'all', category: null, sort: 'date_desc' },
    ])
  })

  it('C23: a bump with 40 rows loaded reloads all 40 and keeps them on screen', async () => {
    await render()
    await click(button(/Show more/))
    expect(text()).toContain('Mine #040')
    server.mine = server.mine.map((r) => (r.id === 'mine-035' ? { ...r, title: 'Renamed 035' } : r))
    const before = calls().length

    await act(async () => useAppStore.getState().bumpDataVersion())
    await settle()

    const added = calls().slice(before)
    expect(added[0]).toEqual({ bucket: 'mine', limit: 20, settled: 'all', category: null, sort: 'date_desc' })
    expect(added[1]).toMatchObject({ bucket: 'mine', limit: 20, after: { id: 'mine-020' } })
    expect(added).toHaveLength(2)
    expect(text()).toContain('Mine #001')
    expect(text()).toContain('Mine #040')
    expect(text()).toContain('Renamed 035')
    expect(text()).not.toContain('Mine #041')
    expect(button(/Show more/)?.textContent).toContain('5')
  })

  // The per-call cap is lowered to 15 (it is 500 in the app, 083's clamp), so the same chunking is
  // exercised with 50 rows: rendering 540 took over 20 s on a loaded machine and timed the test out.
  // 15, not 20: a cap equal to the page size could not be told apart from a page-size call.
  it('C23: reloading more loaded rows than one call may return is chunked at the per-call cap', async () => {
    server.pageCap = 15
    server.mine = Array.from({ length: 70 }, (_, i) => row('Mine', i + 1))
    // One Show more step that answers 30 rows stands in for several taps: 50 rows are then held.
    server.stepRows = 30
    await render()
    await click(button(/Show more/))
    expect(text()).toContain('Mine #050')
    const before = calls().length

    await act(async () => useAppStore.getState().bumpDataVersion())
    await settle()

    const added = calls().slice(before)
    expect(added.map((q) => q.limit)).toEqual([20, 15, 15])
    expect(added[1]).toMatchObject({ after: { id: 'mine-020' } })
    expect(added[2]).toMatchObject({ after: { id: 'mine-035' } })
    expect(text()).toContain('Mine #050')
  })

  it('C23 race: a Show more tap during a reload is refused until the reload lands, and no deleted bill returns', async () => {
    await render()
    await click(button(/Show more/))
    server.gate = { match: (q) => q.after?.id === 'mine-020', release: [] }
    server.mine = server.mine.filter((r) => r.id !== 'mine-030')
    const before = calls().length

    await act(async () => useAppStore.getState().bumpDataVersion())
    await settle()
    expect(server.gate.release).toHaveLength(1)
    expect(button(/Show more/)?.disabled).toBe(true)
    await click(button(/Show more/))
    expect(calls().slice(before).some((q) => q.after?.id === 'mine-040')).toBe(false)

    await act(async () => server.gate!.release.forEach((r) => r()))
    await settle()

    expect(text()).not.toContain('Mine #030')
    expect(text()).toContain('Mine #041')
    expect(button(/Show more/)?.disabled).toBe(false)
    await click(button(/Show more/))
    expect(text()).toContain('Mine #045')
    expect(text().match(/Mine #041/g)).toHaveLength(1)
  })

  it('C23 race: a Show more answer that lands after a reload started is dropped and the tap re-issued against the reloaded list', async () => {
    await render()
    await click(button(/Show more/))
    server.gate = { match: (q) => q.after?.id === 'mine-040', release: [] }
    await click(button(/Show more/))
    expect(server.gate.release).toHaveLength(1)
    server.mine = server.mine.filter((r) => r.id !== 'mine-030')

    await act(async () => useAppStore.getState().bumpDataVersion())
    await settle()
    await act(async () => server.gate!.release.forEach((r) => r()))
    await settle()

    // The stale answer is dropped, and the tap is re-issued against the reloaded list (it used to be
    // lost, so the user had to tap again): the rest arrives once, and the deleted bill stays gone.
    expect(text()).not.toContain('Mine #030')
    expect(text()).toContain('Mine #045')
    expect(text().match(/Mine #041/g)).toHaveLength(1)
    expect(text().match(/Mine #045/g)).toHaveLength(1)
    expect(button(/Show more/)).toBeUndefined()
  })

  it('edges: a Show more tap whose answer lands after a fresh first page is re-issued after the new last row', async () => {
    await render()
    server.gate = { match: (q) => q.after?.id === 'mine-020', release: [] }
    await click(button(/Show more/))
    const gate = server.gate
    expect(gate.release).toHaveLength(1)
    server.gate = null
    // A bill added at the top while the tap is in flight shifts the list by one.
    server.mine = [row('Mine', 0), ...server.mine]

    await act(async () => useAppStore.getState().bumpDataVersion())
    await settle()
    const before = calls().length
    await act(async () => gate.release.forEach((r) => r()))
    await settle()

    const after = calls().slice(before)
    expect(after.filter((q) => q.after)).toHaveLength(1)
    expect(after.find((q) => q.after)).toMatchObject({ limit: 20, after: { id: 'mine-019' } })
    expect(text()).toContain('Mine #000')
    expect(text()).toContain('Mine #039')
    expect(text().match(/Mine #020/g)).toHaveLength(1)
    expect(text()).not.toContain('Mine #040')
  })

  it('edges: a Show more tap followed by a filter change is not re-issued', async () => {
    await render()
    server.gate = { match: (q) => q.after?.id === 'mine-020', release: [] }
    await click(button(/Show more/))
    const gate = server.gate
    server.gate = null
    await choose('unsettled')
    const before = calls().length
    await act(async () => gate.release.forEach((r) => r()))
    await settle()

    expect(calls().slice(before).filter((q) => q.after)).toHaveLength(0)
    expect(lastCall()).toMatchObject({ settled: 'unsettled' })
  })

  it('edges: tap A, filter change, tap B — A landing late re-issues nothing (each tap has its own token)', async () => {
    await render()
    server.gate = { match: (q) => q.after?.id === 'mine-020', release: [] }
    await click(button(/Show more/))
    const gateA = server.gate
    await choose('unsettled')
    // Unsettled rows are the odd ones, so the new first page ends at Mine #039.
    server.gate = { match: (q) => q.after?.id === 'mine-039', release: [] }
    await click(button(/Show more/))
    const gateB = server.gate
    expect(gateB.release).toHaveLength(1)
    const before = calls().length

    await act(async () => gateA.release.forEach((r) => r()))
    await settle()
    expect(calls().length).toBe(before)

    await act(async () => gateB.release.forEach((r) => r()))
    await settle()
    expect(calls().length).toBe(before)
    expect(text()).toContain('Mine #041')
  })

  it('edges: a re-issue and a user tap at the same moment never fetch the same next page twice', async () => {
    await render()
    server.gate = { match: (q) => q.after?.id === 'mine-020', release: [] }
    await click(button(/Show more/))
    const gate = server.gate
    server.gate = null
    server.mine = [row('Mine', 0), ...server.mine]
    await act(async () => useAppStore.getState().bumpDataVersion())
    await settle()
    const before = calls().length

    await act(async () => {
      gate.release.forEach((r) => r())
      button(/Show more/)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await settle()

    const cursors = calls()
      .slice(before)
      .filter((q) => q.after)
      .map((q) => q.after!.id)
    expect(new Set(cursors).size).toBe(cursors.length)
    expect(text().match(/Mine #020/g)).toHaveLength(1)
  })

  it('edges: a refresh that leaves nothing remaining makes no re-issued call', async () => {
    await render()
    server.gate = { match: (q) => q.after?.id === 'mine-020', release: [] }
    await click(button(/Show more/))
    const gate = server.gate
    server.gate = null
    server.mine = server.mine.slice(0, 20)
    await act(async () => useAppStore.getState().bumpDataVersion())
    await settle()
    const before = calls().length

    await act(async () => gate.release.forEach((r) => r()))
    await settle()

    expect(calls().length).toBe(before)
    expect(button(/Show more/)).toBeUndefined()
  })

  it('edges: a category used only by an unsent bill gets a filter chip', async () => {
    server.categories = ['transport']
    await stageNew([{ ...STAGED, category: 'groceries' }])
    await render()
    expect(button(/^Transport$/)).toBeDefined()
    expect(button(/^Groceries$/)).toBeDefined()
  })

  it('C20: a filter change after Show more drops the appended rows and starts again at 20', async () => {
    await render()
    await click(button(/Show more/))
    await choose('title_asc')
    expect(text()).not.toContain('Mine #040')
    expect(lastCall()).toEqual({ bucket: 'mine', limit: 20, settled: 'all', category: null, sort: 'title_asc' })
  })

  it('H5.1: an unsent edit of a bill outside the loaded page is not counted and not prepended', async () => {
    server.staged = [row('Mine', 30, { title: 'Edited offline', settled: false })]
    await render()
    expect(button(/My bills/)?.textContent).toContain('45')
    expect(button(/My bills/)?.textContent).not.toContain('46')
    expect(text()).toContain('70 bills')
    expect(text()).not.toContain('Edited offline')
  })

  it('H5.1: an unsent edit of a bill on screen marks that row Not synced once', async () => {
    server.staged = [row('Mine', 2, { title: 'Mine #002' })]
    const t = await render()
    expect(t.match(/Not synced/g)).toHaveLength(1)
    expect(t.match(/Mine #002/g)).toHaveLength(1)
    expect(button(/My bills/)?.textContent).toContain('45')
    expect(text()).toContain('70 bills')
  })
})
