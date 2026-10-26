import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))

import { fetchPersonalBillsPage } from '@/api/balances'
import { readCache } from '@/api/cache'
import { clearPrimedReads, markReadMounted, mountedReadSpecs } from '@/api/primed-reads'

/**
 * fetchPersonalBillsPage (C8, C15, C21, C23 client half): the Bills page's server-side page.
 * The RPC arguments are kwenta_personal_bills_page's signature (migration 083); the key leaves the
 * limit out so "Show more" re-reads the same saved copy offline, and the spec carries extraArgs so
 * kwenta_write is never asked to recompute it (kwenta_read dispatches on id/limit only).
 *
 * Hand-made rows: the RPC payload below mirrors one kwenta_personal_bills row
 * (079_foreign_currency_bills.sql:663-679), with numerics as strings the way PostgREST sends them.
 */

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

const SERVER_ROW = {
  id: 'b1',
  title: 'Taxi',
  currency: 'PHP',
  totalAmount: '120.50',
  createdAt: '2026-10-01T00:00:00.000Z',
  createdBy: 'u1',
  payorName: 'Me',
  itemCount: 2,
  settled: true,
  category: 'transport',
  originalCurrency: null,
  originalTotal: null,
  exchangeRate: null,
  participants: [{ id: 'p2', label: 'Ana' }],
}

const QUERY = { bucket: 'mine' as const, limit: 40, settled: 'unsettled' as const, category: 'food', sort: 'title_asc' as const }

describe('fetchPersonalBillsPage', () => {
  beforeEach(() => {
    localStorage.clear()
    clearPrimedReads()
    rpc.mockReset()
    setOnline(true)
  })
  afterEach(() => setOnline(true))

  it('C8: calls kwenta_personal_bills_page with every argument', async () => {
    rpc.mockResolvedValue({ data: { rows: [], matching: 0, mine: 0, shared: 0, categories: [] }, error: null })

    await fetchPersonalBillsPage('u1', QUERY)

    expect(rpc).toHaveBeenCalledWith('kwenta_personal_bills_page', {
      p_bucket: 'mine',
      p_limit: 40,
      p_settled: 'unsettled',
      p_category: 'food',
      p_sort: 'title_asc',
    })
  })

  it('C8: a null category is sent as null', async () => {
    rpc.mockResolvedValue({ data: { rows: [], matching: 0, mine: 0, shared: 0, categories: [] }, error: null })

    await fetchPersonalBillsPage('u1', { ...QUERY, category: null })

    expect(rpc.mock.calls[0][1]).toMatchObject({ p_category: null })
  })

  it('C8/C10: maps rows like fetchPersonalBills and passes the counts through', async () => {
    rpc.mockResolvedValue({
      data: { rows: [SERVER_ROW], matching: 45, mine: 109, shared: 60, categories: ['food', 'transport'] },
      error: null,
    })

    const { data, fromCache } = await fetchPersonalBillsPage('u1', QUERY)

    expect(fromCache).toBe(false)
    expect(data.matching).toBe(45)
    expect(data.mine).toBe(109)
    expect(data.shared).toBe(60)
    expect(data.categories).toEqual(['food', 'transport'])
    expect(data.rows).toEqual([
      {
        id: 'b1',
        title: 'Taxi',
        currency: 'PHP',
        totalAmount: 120.5,
        createdAt: '2026-10-01T00:00:00.000Z',
        createdBy: 'u1',
        payorName: 'Me',
        itemCount: 2,
        settled: true,
        category: 'transport',
        participants: [{ id: 'p2', label: 'Ana' }],
        originalCurrency: null,
        originalTotal: null,
        exchangeRate: null,
      },
    ])
  })

  it('C8: the cache key names bucket, settled, category and sort but not the limit', async () => {
    rpc.mockResolvedValue({ data: { rows: [SERVER_ROW], matching: 1, mine: 1, shared: 0, categories: [] }, error: null })

    await fetchPersonalBillsPage('u1', QUERY)
    await fetchPersonalBillsPage('u1', { ...QUERY, category: null, settled: 'all', sort: 'date_desc' })

    expect(readCache('personal-bills-page:mine:unsettled:food:title_asc', 'u1')).not.toBeNull()
    expect(readCache('personal-bills-page:mine:all::date_desc', 'u1')).not.toBeNull()
  })

  it('C21: offline, a different limit for the same filters is served the saved copy', async () => {
    rpc.mockResolvedValue({ data: { rows: [SERVER_ROW], matching: 1, mine: 1, shared: 0, categories: [] }, error: null })
    await fetchPersonalBillsPage('u1', QUERY)

    setOnline(false)
    const offline = await fetchPersonalBillsPage('u1', { ...QUERY, limit: 60 })

    expect(offline.fromCache).toBe(true)
    expect(offline.data.rows.map((r) => r.id)).toEqual(['b1'])
  })

  it('C21: offline with no copy for that filter refuses instead of answering empty', async () => {
    setOnline(false)
    await expect(fetchPersonalBillsPage('u1', { ...QUERY, settled: 'settled' })).rejects.toThrow(/offline/i)
  })

  it('C23: the spec is never handed to a write as a read to recompute', async () => {
    rpc.mockResolvedValue({ data: { rows: [], matching: 0, mine: 0, shared: 0, categories: [] }, error: null })
    await fetchPersonalBillsPage('u1', QUERY)
    markReadMounted('personal-bills-page:mine:unsettled:food:title_asc')

    expect(mountedReadSpecs().map((s) => s.key)).not.toContain('personal-bills-page:mine:unsettled:food:title_asc')
  })
})

describe('fetchPersonalBillsPage after a cursor (Show more)', () => {
  const AFTER = { id: 'b1', createdAt: '2026-10-01T00:00:00.000Z', title: 'Taxi' }
  const KEY = 'personal-bills-page:mine:unsettled:food:title_asc'

  beforeEach(() => {
    localStorage.clear()
    clearPrimedReads()
    rpc.mockReset()
    setOnline(true)
  })
  afterEach(() => setOnline(true))

  it('passes the cursor as p_after next to the other arguments', async () => {
    rpc.mockResolvedValue({ data: { rows: [SERVER_ROW], matching: 45, mine: 109, shared: 60, categories: [] }, error: null })

    const { data, fromCache } = await fetchPersonalBillsPage('u1', { ...QUERY, limit: 20, after: AFTER })

    expect(rpc).toHaveBeenCalledWith('kwenta_personal_bills_page', {
      p_bucket: 'mine',
      p_limit: 20,
      p_settled: 'unsettled',
      p_category: 'food',
      p_sort: 'title_asc',
      p_after: AFTER,
    })
    expect(fromCache).toBe(false)
    expect(data.rows.map((r) => r.id)).toEqual(['b1'])
    expect(data.matching).toBe(45)
  })

  it('never writes a cursor page to the cache, so a later first page cannot start mid-list', async () => {
    rpc.mockResolvedValue({ data: { rows: [SERVER_ROW], matching: 1, mine: 1, shared: 0, categories: [] }, error: null })

    await fetchPersonalBillsPage('u1', { ...QUERY, after: AFTER })

    expect(readCache(KEY, 'u1')).toBeNull()
  })

  it('does not replace the saved first page', async () => {
    rpc.mockResolvedValueOnce({ data: { rows: [SERVER_ROW], matching: 1, mine: 1, shared: 0, categories: [] }, error: null })
    await fetchPersonalBillsPage('u1', QUERY)
    rpc.mockResolvedValueOnce({ data: { rows: [], matching: 1, mine: 1, shared: 0, categories: [] }, error: null })

    await fetchPersonalBillsPage('u1', { ...QUERY, after: AFTER })

    expect(readCache<{ rows: unknown[] }>(KEY, 'u1')?.data.rows).toHaveLength(1)
  })

  it('does not consume a primed read for the first-page key', async () => {
    const { primeReads } = await import('@/api/primed-reads')
    primeReads({ [KEY]: { rows: [], matching: 0, mine: 0, shared: 0, categories: [] } })
    rpc.mockResolvedValue({ data: { rows: [SERVER_ROW], matching: 1, mine: 1, shared: 0, categories: [] }, error: null })

    const { data } = await fetchPersonalBillsPage('u1', { ...QUERY, after: AFTER })

    expect(data.rows).toHaveLength(1)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('offline refuses with a connection message instead of answering from a saved copy', async () => {
    rpc.mockResolvedValueOnce({ data: { rows: [SERVER_ROW], matching: 1, mine: 1, shared: 0, categories: [] }, error: null })
    await fetchPersonalBillsPage('u1', QUERY)
    setOnline(false)

    await expect(fetchPersonalBillsPage('u1', { ...QUERY, after: AFTER })).rejects.toThrow(/offline/i)
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('a failed call throws an ApiError and does not fall back to the saved first page', async () => {
    rpc.mockResolvedValueOnce({ data: { rows: [SERVER_ROW], matching: 1, mine: 1, shared: 0, categories: [] }, error: null })
    await fetchPersonalBillsPage('u1', QUERY)
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom', code: '500' } })

    await expect(fetchPersonalBillsPage('u1', { ...QUERY, after: AFTER })).rejects.toThrow(/Could not load more of your bills/)
  })

  it('an authorization failure says access was lost', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'permission denied', code: '42501' } })

    await expect(fetchPersonalBillsPage('u1', { ...QUERY, after: AFTER })).rejects.toThrow(/no longer have access to your bills/)
  })
})

describe('mountedReadSpecs(skipFamilies)', () => {
  beforeEach(() => clearPrimedReads())

  it('C24: omits mounted specs whose family is skipped', async () => {
    const { rememberReadSpec } = await import('@/api/primed-reads')
    rememberReadSpec({ key: 'group:G', fn: 'kwenta_group_detail', argName: 'p_group_id', id: 'G' })
    rememberReadSpec({ key: 'group-payments:G', fn: 'kwenta_group_settlement_history', argName: 'p_group_id', id: 'G' })
    rememberReadSpec({ key: 'group-spending:G', fn: 'kwenta_group_spending', argName: 'p_group_id', id: 'G' })
    markReadMounted('group:G')
    markReadMounted('group-payments:G')
    markReadMounted('group-spending:G')

    expect(mountedReadSpecs(['group-payments']).map((s) => s.key).sort()).toEqual(['group-spending:G', 'group:G'])
    expect(mountedReadSpecs(['group']).map((s) => s.key).sort()).toEqual(['group-payments:G', 'group-spending:G'])
    expect(mountedReadSpecs().map((s) => s.key).sort()).toEqual(['group-payments:G', 'group-spending:G', 'group:G'])
  })
})
