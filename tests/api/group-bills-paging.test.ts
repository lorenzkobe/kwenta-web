import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))

import * as balances from '@/api/balances'
import { readCache } from '@/api/cache'
import { clearPrimedReads, markReadMounted, mountedReadSpecs, primeReads } from '@/api/primed-reads'

/**
 * Group bills paging, client half (085). Written from the interface contract, not from the code:
 *  - fetchGroupDetailPaged(userId, groupId, limit = 20): key `group:<id>`, spec
 *    { fn: 'kwenta_group_detail_paged', argName: 'p_group_id', id, limit } so a write primes it;
 *    the group-detail mapper plus billCount / billPayers.
 *  - fetchGroupBillsPage(userId, groupId, { limit, payer, after? }): key `group-bills:<id>:<payer>`,
 *    extraArgs (never in p_reads); a cursor page is never cached or primed and throws offline.
 *  - fetchGroupDetail(userId, groupId): the full list, under `group-full:<id>`.
 *
 * Hand-made rows: GROUP_PAYLOAD / BILL_ROW mirror one kwenta_group_detail response
 * (083_smaller_screen_payloads.sql:91-293, bill row keys :97-114), numerics as strings the way
 * PostgREST sends them.
 */

// Loaded through the namespace so a missing export fails each test instead of the whole file.
type Loaded = {
  bills: unknown[]
  group: { name: string }
  billCount: number
  billPayers: unknown[]
  rows: unknown[]
  matching: number
}
type AnyFn = (...args: unknown[]) => Promise<{ data: Loaded; fromCache: boolean }>
const api = balances as unknown as Record<string, AnyFn>
const fetchGroupDetailPaged: AnyFn = (...a) => api.fetchGroupDetailPaged(...a)
const fetchGroupBillsPage: AnyFn = (...a) => api.fetchGroupBillsPage(...a)
const fetchGroupDetail: AnyFn = (...a) => api.fetchGroupDetail(...a)

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

const G = 'g-1'
const BILL_ROW = {
  id: 'b1',
  title: 'Hotel',
  note: '',
  currency: 'PHP',
  totalAmount: '120.50',
  createdAt: '2026-10-01T00:00:00.000Z',
  createdBy: 'u1',
  paidBy: 'u2',
  groupId: G,
  category: null,
  originalCurrency: null,
  originalTotal: null,
  exchangeRate: null,
  payorName: 'Ana',
}
const MAPPED_BILL = {
  id: 'b1',
  title: 'Hotel',
  note: '',
  currency: 'PHP',
  totalAmount: 120.5,
  createdAt: '2026-10-01T00:00:00.000Z',
  createdBy: 'u1',
  paidBy: 'u2',
  groupId: G,
  category: null,
  payorName: 'Ana',
  originalCurrency: null,
  originalTotal: null,
  exchangeRate: null,
}
const GROUP_PAYLOAD = {
  group: { id: G, name: 'Siquijor', currency: 'PHP', createdBy: 'u1', inviteCode: 'abc', updatedAt: '2026-10-01T00:00:00Z' },
  members: [{ id: 'm1', userId: 'u1', profileName: 'Me', isCurrentUser: true }],
  bills: [BILL_ROW],
  pairwise: [],
  totalToReceive: '0',
  totalToPay: '0',
  memberBalances: [],
  rawDebts: [],
}
const PAGED_PAYLOAD = { ...GROUP_PAYLOAD, billCount: 59, billPayers: [{ userId: 'u2', count: '40' }, { userId: 'u1', count: 19 }] }
const PAGE_PAYLOAD = { rows: [BILL_ROW], matching: '8' }

beforeEach(() => {
  localStorage.clear()
  clearPrimedReads()
  rpc.mockReset()
  setOnline(true)
})
afterEach(() => setOnline(true))

describe('fetchGroupDetailPaged (C2/C5 client half)', () => {
  it('C5: calls kwenta_group_detail_paged with p_group_id and p_limit 20 by default', async () => {
    rpc.mockResolvedValue({ data: PAGED_PAYLOAD, error: null })
    await fetchGroupDetailPaged('u1', G)
    expect(rpc).toHaveBeenCalledWith('kwenta_group_detail_paged', { p_group_id: G, p_limit: 20 })
  })

  it('C2: maps like group detail plus billCount and billPayers as numbers', async () => {
    rpc.mockResolvedValue({ data: PAGED_PAYLOAD, error: null })
    const { data } = await fetchGroupDetailPaged('u1', G)
    expect(data.bills).toEqual([MAPPED_BILL])
    expect(data.group.name).toBe('Siquijor')
    expect(data.billCount).toBe(59)
    expect(data.billPayers).toEqual([{ userId: 'u2', count: 40 }, { userId: 'u1', count: 19 }])
  })

  it('C5: is a mounted read a write can recompute: key group:<id>, no extraArgs, limit 20', async () => {
    rpc.mockResolvedValue({ data: PAGED_PAYLOAD, error: null })
    await fetchGroupDetailPaged('u1', G)
    markReadMounted(`group:${G}`)
    const spec = mountedReadSpecs().find((s) => s.key === `group:${G}`)
    expect(spec).toEqual({ key: `group:${G}`, fn: 'kwenta_group_detail_paged', argName: 'p_group_id', id: G, limit: 20 })
  })

  it('C5: a primed payload under group:<id> is served without a request', async () => {
    primeReads({ [`group:${G}`]: PAGED_PAYLOAD })
    const { data, fromCache } = await fetchGroupDetailPaged('u1', G)
    expect(rpc).not.toHaveBeenCalled()
    expect(fromCache).toBe(false)
    expect(data.billCount).toBe(59)
  })

  it('refused side: a NULL answer (not a member) maps to null', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    const { data } = await fetchGroupDetailPaged('u1', G)
    expect(data).toBeNull()
  })
})

describe('fetchGroupDetail, the full list (C21)', () => {
  it('C21: still calls kwenta_group_detail with no limit', async () => {
    rpc.mockResolvedValue({ data: GROUP_PAYLOAD, error: null })
    await fetchGroupDetail('u1', G)
    expect(rpc).toHaveBeenCalledWith('kwenta_group_detail', { p_group_id: G })
  })

  it('C21: caches under group-full:<id> and never touches the page key', async () => {
    rpc.mockResolvedValueOnce({ data: PAGED_PAYLOAD, error: null })
    await fetchGroupDetailPaged('u1', G)
    rpc.mockResolvedValueOnce({ data: { ...GROUP_PAYLOAD, bills: [BILL_ROW, { ...BILL_ROW, id: 'b2' }] }, error: null })
    await fetchGroupDetail('u1', G)

    expect(readCache<{ bills: unknown[] }>(`group-full:${G}`, 'u1')?.data.bills).toHaveLength(2)
    expect(readCache<{ billCount: number }>(`group:${G}`, 'u1')?.data.billCount).toBe(59)
  })

  it('C21: the full fetch does not replace the mounted page spec (a write keeps priming 20 bills)', async () => {
    rpc.mockResolvedValue({ data: PAGED_PAYLOAD, error: null })
    await fetchGroupDetailPaged('u1', G)
    markReadMounted(`group:${G}`)
    rpc.mockResolvedValue({ data: GROUP_PAYLOAD, error: null })
    await fetchGroupDetail('u1', G)

    const specs = mountedReadSpecs()
    expect(specs.find((s) => s.key === `group:${G}`)).toMatchObject({ fn: 'kwenta_group_detail_paged', limit: 20 })
    expect(specs.some((s) => s.fn === 'kwenta_group_detail')).toBe(false)
  })

  it('C21: the full fetch does not consume the page\'s primed read', async () => {
    primeReads({ [`group:${G}`]: PAGED_PAYLOAD })
    rpc.mockResolvedValue({ data: GROUP_PAYLOAD, error: null })
    await fetchGroupDetail('u1', G)
    expect(rpc).toHaveBeenCalledTimes(1)
    const { data } = await fetchGroupDetailPaged('u1', G)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(data.billCount).toBe(59)
  })

  it('C22: offline with no saved full copy refuses with an offline message, never an empty list', async () => {
    rpc.mockResolvedValue({ data: PAGED_PAYLOAD, error: null })
    await fetchGroupDetailPaged('u1', G)
    setOnline(false)
    await expect(fetchGroupDetail('u1', G)).rejects.toThrow(/offline/i)
  })

  it('C22: offline with a saved full copy serves it', async () => {
    rpc.mockResolvedValue({ data: GROUP_PAYLOAD, error: null })
    await fetchGroupDetail('u1', G)
    setOnline(false)
    const r = await fetchGroupDetail('u1', G)
    expect(r.fromCache).toBe(true)
    expect(r.data.bills).toEqual([MAPPED_BILL])
  })
})

describe('fetchGroupBillsPage (C3/C7 client half)', () => {
  it('C7: a first page sends p_group_id, p_limit and p_payer, no p_after', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    const { data, fromCache } = await fetchGroupBillsPage('u1', G, { limit: 20, payer: 'u2' })
    expect(rpc).toHaveBeenCalledWith('kwenta_group_bills_page', { p_group_id: G, p_limit: 20, p_payer: 'u2' })
    expect(fromCache).toBe(false)
    expect(data.rows).toEqual([MAPPED_BILL])
    expect(data.matching).toBe(8)
  })

  it('C7: the first page is cached per payer under group-bills:<id>:<payer>', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupBillsPage('u1', G, { limit: 20, payer: 'u2' })
    await fetchGroupBillsPage('u1', G, { limit: 20, payer: null })
    expect(readCache(`group-bills:${G}:u2`, 'u1')).not.toBeNull()
    expect(readCache(`group-bills:${G}:`, 'u1')).not.toBeNull()
  })

  it('C5/C7: never handed to a write as a read to recompute (extraArgs)', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupBillsPage('u1', G, { limit: 20, payer: 'u2' })
    markReadMounted(`group-bills:${G}:u2`)
    expect(mountedReadSpecs().map((s) => s.key)).not.toContain(`group-bills:${G}:u2`)
  })

  it('C6: a cursor page sends p_after and is never cached', async () => {
    const after = { id: 'b1', createdAt: '2026-10-01T00:00:00.000Z' }
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupBillsPage('u1', G, { limit: 20, payer: null, after })
    expect(rpc).toHaveBeenCalledWith('kwenta_group_bills_page', { p_group_id: G, p_limit: 20, p_payer: null, p_after: after })
    expect(readCache(`group-bills:${G}:`, 'u1')).toBeNull()
  })

  it('C6: a cursor page does not consume a primed read for the first-page key', async () => {
    primeReads({ [`group-bills:${G}:`]: { rows: [], matching: 0 } })
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    const { data } = await fetchGroupBillsPage('u1', G, { limit: 20, payer: null, after: { id: 'b1', createdAt: 'x' } })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(data.rows).toHaveLength(1)
  })

  it('a NULL answer (no longer a member) is an access error: nothing is cached, never an empty page', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    await expect(fetchGroupBillsPage('u1', G, { limit: 20, payer: 'u2' })).rejects.toThrow(/no longer have access/i)
    expect(readCache(`group-bills:${G}:u2`, 'u1')).toBeNull()
  })

  it('a NULL answer to a cursor page is an access error too', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    await expect(
      fetchGroupBillsPage('u1', G, { limit: 20, payer: null, after: { id: 'b1', createdAt: '2026-10-01T00:00:00.000Z' } }),
    ).rejects.toThrow(/no longer have access/i)
  })

  it('a saved copy is not served after the server declined', async () => {
    rpc.mockResolvedValueOnce({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupBillsPage('u1', G, { limit: 20, payer: 'u2' })
    rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(fetchGroupBillsPage('u1', G, { limit: 20, payer: 'u2' })).rejects.toThrow(/no longer have access/i)
  })

  it('C22: a cursor page offline throws with an offline message and sends nothing', async () => {
    setOnline(false)
    await expect(
      fetchGroupBillsPage('u1', G, { limit: 20, payer: null, after: { id: 'b1', createdAt: '2026-10-01T00:00:00.000Z' } }),
    ).rejects.toThrow(/offline/i)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('C22: a filtered first page offline with no saved copy refuses instead of answering empty', async () => {
    setOnline(false)
    await expect(fetchGroupBillsPage('u1', G, { limit: 20, payer: 'u2' })).rejects.toThrow(/offline/i)
  })

  it('C22: a filtered first page offline with a saved copy serves it, flagged', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupBillsPage('u1', G, { limit: 20, payer: 'u2' })
    setOnline(false)
    const r = await fetchGroupBillsPage('u1', G, { limit: 20, payer: 'u2' })
    expect(r.fromCache).toBe(true)
    expect(r.data.matching).toBe(8)
  })
})
