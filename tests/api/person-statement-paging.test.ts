import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))

import * as balances from '@/api/balances'
import { ApiError } from '@/api/balances'
import { readCache, writeCache } from '@/api/cache'
import { clearPrimedReads, markReadMounted, mountedReadSpecs, primeReads } from '@/api/primed-reads'

/**
 * Person statement paging, client half (086). Written from the interface contract, blind to the code:
 *  - fetchPersonStatementPage(userId, personId, { limit = 20 } = {}): key `statement-page:<id>`,
 *    spec { fn: 'kwenta_person_statement_page', argName: 'p_person_id', id, limit } so a write
 *    primes the first 20 events through kwenta_read (C10);
 *  - fetchPersonStatementPageMore(userId, personId, { limit, kind, before? }): arguments ride
 *    extraArgs (never primed); the first 'payments' page is cached under
 *    `statement-page:<id>:payments`; a page `before` a row is live only, never cached, refused
 *    offline (C12);
 *  - data = { events: StatementEvent & { runningNet, prevRunning }, matching, latestPersonalCurrency };
 *    a NULL answer is an access error, never an empty statement (C14);
 *  - fetchPersonStatement (the full, old endpoint) moves to `statement-full:<id>` (C13);
 *  - an old-shape saved copy under `statement:<id>` is never read by the new view (C17).
 *
 * Hand-made rows: SERVER_EVENT mirrors one kwenta_person_statement event
 * (065_list_settled_map_and_payor_names.sql:477) plus the runningNet / prevRunning keys 086 adds,
 * with numerics as strings the way PostgREST sends them. OLD_SHAPE_COPY is what the pre-086 client
 * cached under `statement:<id>`: the mapped StatementEvent[] array (src/api/balances.ts at HEAD).
 */

type Event = {
  id: string
  type: string
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
type Page = { events: Event[]; matching: number; latestPersonalCurrency: string | null }
type AnyFn = (...args: unknown[]) => Promise<{ data: Page; fromCache: boolean }>
// Loaded through the namespace so a missing export fails each test instead of the whole file.
const api = balances as unknown as Record<string, AnyFn>
const fetchPersonStatementPage: AnyFn = (...a) => api.fetchPersonStatementPage(...a)
const fetchPersonStatementPageMore: AnyFn = (...a) => api.fetchPersonStatementPageMore(...a)
const fetchPersonStatement = (...a: unknown[]) =>
  (balances.fetchPersonStatement as unknown as (...x: unknown[]) => Promise<{ data: unknown[]; fromCache: boolean }>)(...a)

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

const P = 'p-ana'
const SERVER_EVENT = {
  id: 'e1',
  type: 'personal_bill',
  createdAt: '2026-10-01T00:00:00.000Z',
  currency: 'PHP',
  groupId: null,
  bundleId: null,
  contextLabel: 'Personal',
  title: 'Taxi',
  rawAmount: '120.50',
  delta: '120.50',
  category: 'transport',
  runningNet: '420.75',
  prevRunning: '300.25',
}
const MAPPED_EVENT: Event = {
  id: 'e1',
  type: 'personal_bill',
  createdAt: '2026-10-01T00:00:00.000Z',
  currency: 'PHP',
  groupId: null,
  bundleId: null,
  contextLabel: 'Personal',
  title: 'Taxi',
  rawAmount: 120.5,
  delta: 120.5,
  category: 'transport',
  runningNet: 420.75,
  prevRunning: 300.25,
}
const PAYMENT_EVENT = {
  ...SERVER_EVENT,
  id: 'e2',
  type: 'payment',
  bundleId: 'bun-1',
  groupId: 'g-1',
  contextLabel: 'Siquijor',
  title: 'Ana paid you',
  category: null,
  rawAmount: '50',
  delta: '-50',
  runningNet: '370.75',
  prevRunning: '420.75',
}
const PAGE_PAYLOAD = { events: [PAYMENT_EVENT, SERVER_EVENT], matching: '136', latestPersonalCurrency: 'USD' }
const BEFORE = { createdAt: '2026-09-01T00:00:00.000Z', id: 'e20' }
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

beforeEach(() => {
  localStorage.clear()
  clearPrimedReads()
  rpc.mockReset()
  setOnline(true)
})
afterEach(() => setOnline(true))

describe('fetchPersonStatementPage, the first page (C10/C12/C14)', () => {
  it('C12: calls kwenta_person_statement_page with p_person_id and p_limit 20 by default', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPage('u1', P)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('kwenta_person_statement_page', { p_person_id: P, p_limit: 20 })
  })

  it('C12: maps events with runningNet and prevRunning as numbers, matching and latestPersonalCurrency', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    const { data, fromCache } = await fetchPersonStatementPage('u1', P)
    expect(fromCache).toBe(false)
    expect(data.events[1]).toEqual(MAPPED_EVENT)
    expect(data.events[0]).toMatchObject({
      id: 'e2',
      type: 'payment',
      bundleId: 'bun-1',
      groupId: 'g-1',
      delta: -50,
      runningNet: 370.75,
      prevRunning: 420.75,
      category: null,
    })
    // Server order (newest first) is kept as sent.
    expect(data.events.map((e) => e.id)).toEqual(['e2', 'e1'])
    expect(data.matching).toBe(136)
    expect(data.latestPersonalCurrency).toBe('USD')
  })

  it('C18: latestPersonalCurrency null (no personal bill ever) stays null', async () => {
    rpc.mockResolvedValue({ data: { ...PAGE_PAYLOAD, latestPersonalCurrency: null }, error: null })
    const { data } = await fetchPersonStatementPage('u1', P)
    expect(data.latestPersonalCurrency).toBeNull()
  })

  it('C12: an empty statement is an answer: no events, matching 0', async () => {
    rpc.mockResolvedValue({ data: { events: [], matching: 0, latestPersonalCurrency: null }, error: null })
    const { data } = await fetchPersonStatementPage('u1', P)
    expect(data.events).toEqual([])
    expect(data.matching).toBe(0)
  })

  it('C10: is a mounted read a write can recompute: key statement-page:<id>, no extraArgs, limit 20', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPage('u1', P)
    markReadMounted(`statement-page:${P}`)
    const spec = mountedReadSpecs().find((s) => s.key === `statement-page:${P}`)
    expect(spec).toEqual({
      key: `statement-page:${P}`,
      fn: 'kwenta_person_statement_page',
      argName: 'p_person_id',
      id: P,
      limit: 20,
    })
  })

  it('C10: a primed payload under statement-page:<id> is served without a request, through the same mapper', async () => {
    primeReads({ [`statement-page:${P}`]: PAGE_PAYLOAD })
    const { data, fromCache } = await fetchPersonStatementPage('u1', P)
    expect(rpc).not.toHaveBeenCalled()
    expect(fromCache).toBe(false)
    expect(data.events[1]).toEqual(MAPPED_EVENT)
    expect(data.matching).toBe(136)
  })

  it('C17: caches under statement-page:<id> and never writes the old statement:<id> key', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPage('u1', P)
    expect(readCache<Page>(`statement-page:${P}`, 'u1')?.data.matching).toBe(136)
    expect(readCache(`statement:${P}`, 'u1')).toBeNull()
  })

  it('C14: a NULL answer is an access error, never an empty statement, and nothing is cached', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    await expect(fetchPersonStatementPage('u1', P)).rejects.toBeInstanceOf(ApiError)
    expect(readCache(`statement-page:${P}`, 'u1')).toBeNull()
  })

  it('C14: a saved copy is not served after the server answered NULL', async () => {
    rpc.mockResolvedValueOnce({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPage('u1', P)
    rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(fetchPersonStatementPage('u1', P)).rejects.toBeInstanceOf(ApiError)
  })

  it('C14: a permission error is "no longer have access", not a saved copy', async () => {
    rpc.mockResolvedValueOnce({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPage('u1', P)
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'permission denied' } })
    await expect(fetchPersonStatementPage('u1', P)).rejects.toThrow(/no longer have access/i)
  })

  it('offline with a saved first page serves it, flagged', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPage('u1', P)
    setOnline(false)
    const r = await fetchPersonStatementPage('u1', P)
    expect(r.fromCache).toBe(true)
    expect(r.data.events[1]).toEqual(MAPPED_EVENT)
  })

  it('C17: offline, an old-shape copy under statement:<id> is never served as the page', async () => {
    writeCache(`statement:${P}`, 'u1', OLD_SHAPE_COPY, '2026-10-01T00:00:00.000Z')
    setOnline(false)
    await expect(fetchPersonStatementPage('u1', P)).rejects.toThrow(/offline/i)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('C17: a transport failure does not fall back to an old-shape statement:<id> copy', async () => {
    writeCache(`statement:${P}`, 'u1', OLD_SHAPE_COPY, '2026-10-01T00:00:00.000Z')
    rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch' } })
    await expect(fetchPersonStatementPage('u1', P)).rejects.toBeInstanceOf(ApiError)
  })

  it('the offline message names the statement, never the cache key', async () => {
    setOnline(false)
    const err = await fetchPersonStatementPage('u1', '0f3a1c8e-2b41-4c77-9a11-8d2f7b3e5c19').catch((e: unknown) => e as Error)
    expect(err.message).toContain('this statement')
    expect(err.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/i)
    expect(err.message).not.toContain('statement-page')
  })
})

describe('fetchPersonStatementPageMore, kind and cursor (C12/C14)', () => {
  it('C12: the first Payments page sends p_kind payments and no p_before', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'payments' })
    expect(rpc).toHaveBeenCalledTimes(1)
    const [fn, args] = rpc.mock.calls[0]
    expect(fn).toBe('kwenta_person_statement_page')
    expect(args).toMatchObject({ p_person_id: P, p_limit: 20, p_kind: 'payments' })
    expect(args).not.toHaveProperty('p_before')
  })

  it('C12: the first Payments page is cached under statement-page:<id>:payments', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    const { data } = await fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'payments' })
    expect(data.events[0]).toMatchObject({ id: 'e2', runningNet: 370.75, prevRunning: 420.75 })
    expect(readCache<Page>(`statement-page:${P}:payments`, 'u1')?.data.matching).toBe(136)
    // It is not the all-kinds first page.
    expect(readCache(`statement-page:${P}`, 'u1')).toBeNull()
  })

  it('C10: the Payments page is never handed to a write as a read to recompute (extraArgs)', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'payments' })
    markReadMounted(`statement-page:${P}:payments`)
    expect(mountedReadSpecs().map((s) => s.key)).not.toContain(`statement-page:${P}:payments`)
  })

  it('C12: a cursor page sends p_before verbatim with its kind and is never cached', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    const { data, fromCache } = await fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'all', before: BEFORE })
    expect(fromCache).toBe(false)
    const [fn, args] = rpc.mock.calls[0]
    expect(fn).toBe('kwenta_person_statement_page')
    expect(args).toMatchObject({ p_person_id: P, p_limit: 20, p_before: BEFORE })
    expect((args as Record<string, unknown>).p_kind ?? 'all').toBe('all')
    expect(data.events[1]).toEqual(MAPPED_EVENT)
    expect(readCache(`statement-page:${P}`, 'u1')).toBeNull()
    expect(readCache(`statement-page:${P}:payments`, 'u1')).toBeNull()
  })

  it('C12: a Payments cursor page sends p_kind payments and p_before, and is not cached', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'payments', before: BEFORE })
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_person_id: P, p_limit: 20, p_kind: 'payments', p_before: BEFORE })
    expect(readCache(`statement-page:${P}:payments`, 'u1')).toBeNull()
  })

  it('C12: a cursor page does not consume the primed first page', async () => {
    primeReads({ [`statement-page:${P}`]: { events: [], matching: 0, latestPersonalCurrency: null } })
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    const { data } = await fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'all', before: BEFORE })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(data.events).toHaveLength(2)
    // The primed answer is still there for the first-page read.
    const first = await fetchPersonStatementPage('u1', P)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(first.data.matching).toBe(0)
  })

  it('C12: a cursor page offline throws an offline message and sends nothing', async () => {
    setOnline(false)
    await expect(
      fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'all', before: BEFORE }),
    ).rejects.toThrow(/offline/i)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('C12: offline, the first Payments page with no saved copy refuses instead of answering empty', async () => {
    setOnline(false)
    await expect(fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'payments' })).rejects.toThrow(/offline/i)
  })

  it('C12: offline, the first Payments page with a saved copy serves it, flagged', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'payments' })
    setOnline(false)
    const r = await fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'payments' })
    expect(r.fromCache).toBe(true)
    expect(r.data.matching).toBe(136)
  })

  it('C14: a NULL answer to the Payments page is an access error and is not cached', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    await expect(fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'payments' })).rejects.toBeInstanceOf(ApiError)
    expect(readCache(`statement-page:${P}:payments`, 'u1')).toBeNull()
  })

  it('C14: a NULL answer to a cursor page is an access error, never an empty page', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    await expect(
      fetchPersonStatementPageMore('u1', P, { limit: 20, kind: 'all', before: BEFORE }),
    ).rejects.toBeInstanceOf(ApiError)
  })
})

describe('fetchPersonStatement, the full statement for exports (C13)', () => {
  it('C13: still calls kwenta_person_statement with p_person_id only', async () => {
    rpc.mockResolvedValue({ data: [SERVER_EVENT], error: null })
    await fetchPersonStatement('u1', P)
    expect(rpc).toHaveBeenCalledWith('kwenta_person_statement', { p_person_id: P })
  })

  it('C13/C17: caches under statement-full:<id>, not statement:<id>, and leaves the page key alone', async () => {
    rpc.mockResolvedValueOnce({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPage('u1', P)
    rpc.mockResolvedValueOnce({ data: [SERVER_EVENT, { ...SERVER_EVENT, id: 'e0' }], error: null })
    await fetchPersonStatement('u1', P)

    expect(readCache<unknown[]>(`statement-full:${P}`, 'u1')?.data).toHaveLength(2)
    expect(readCache(`statement:${P}`, 'u1')).toBeNull()
    expect(readCache<Page>(`statement-page:${P}`, 'u1')?.data.matching).toBe(136)
  })

  it('C10/C13: the full fetch does not replace the mounted page spec', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPage('u1', P)
    markReadMounted(`statement-page:${P}`)
    rpc.mockResolvedValue({ data: [SERVER_EVENT], error: null })
    await fetchPersonStatement('u1', P)

    const specs = mountedReadSpecs()
    expect(specs.find((s) => s.key === `statement-page:${P}`)).toMatchObject({
      fn: 'kwenta_person_statement_page',
      limit: 20,
    })
    expect(specs.some((s) => s.fn === 'kwenta_person_statement')).toBe(false)
  })

  it('C13: the full fetch does not consume the page\'s primed read', async () => {
    primeReads({ [`statement-page:${P}`]: PAGE_PAYLOAD })
    rpc.mockResolvedValue({ data: [SERVER_EVENT], error: null })
    await fetchPersonStatement('u1', P)
    expect(rpc).toHaveBeenCalledTimes(1)
    const { data } = await fetchPersonStatementPage('u1', P)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(data.matching).toBe(136)
  })

  it('C13: offline with no saved full copy refuses (never answered from the page copy)', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchPersonStatementPage('u1', P)
    setOnline(false)
    await expect(fetchPersonStatement('u1', P)).rejects.toThrow(/offline/i)
  })

  it('C13/C17: offline, an old-shape statement:<id> copy is not served as the full statement', async () => {
    writeCache(`statement:${P}`, 'u1', OLD_SHAPE_COPY, '2026-10-01T00:00:00.000Z')
    setOnline(false)
    await expect(fetchPersonStatement('u1', P)).rejects.toThrow(/offline/i)
  })

  it('C13: offline with a saved full copy serves it, flagged', async () => {
    rpc.mockResolvedValue({ data: [SERVER_EVENT], error: null })
    await fetchPersonStatement('u1', P)
    setOnline(false)
    const r = await fetchPersonStatement('u1', P)
    expect(r.fromCache).toBe(true)
    expect(r.data).toHaveLength(1)
  })

  it('C13: the offline message for the full statement names the statement, never the key', async () => {
    setOnline(false)
    const err = await fetchPersonStatement('u1', '0f3a1c8e-2b41-4c77-9a11-8d2f7b3e5c19').catch((e: unknown) => e as Error)
    expect(err.message).toContain('this statement')
    expect(err.message).not.toContain('statement-full')
  })
})
