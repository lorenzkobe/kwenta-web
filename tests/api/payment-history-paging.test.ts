import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))

import * as balances from '@/api/balances'
import { readCache } from '@/api/cache'
import { clearPrimedReads, markReadMounted, mountedReadSpecs, primeReads } from '@/api/primed-reads'

/**
 * Payment history paging, client half (087). Written from the interface contract, not the code:
 *  - fetchGroupSettlementHistoryPage(userId, groupId, { limit = 20 }): key
 *    `group-payments-page:<id>`, spec { fn: 'kwenta_group_settlement_history_page',
 *    argName: 'p_group_id', id, limit } so a write primes it; answer { items, matching };
 *  - fetchGroupSettlementHistoryPageMore(userId, groupId, { limit, before: { createdAt, id } }):
 *    p_group_id, p_limit, p_before; never cached or primed; refused offline;
 *  - fetchGroupSettlementHistory (the full list) moves to `group-payments-full:<id>`;
 *  - fetchPersonPaymentItems(userId, personId, settlementIds): kwenta_person_payment_items
 *    (p_person_id, p_settlement_ids) in chunks of at most 500 ids, merged and de-duplicated by
 *    item id; extraArgs (never in p_reads); no ids -> no call;
 *  - fetchPersonSettlementHistory (the full list) moves to `person-payments-full:<id>`;
 *  - a NULL answer from any new endpoint is an access error;
 *  - each new family has its own ENDPOINT_LABELS entry (an error never says "this screen").
 *
 * Hand-made rows: serverItem (one kwenta_settlement_history_build item, keys as 069 emits them,
 * numerics as strings the way PostgREST sends them; the same literal as
 * tests/api/settlement-history.test.ts).
 *
 * The mapped page field is read as `items` (the SQL name) or `rows` (useKeysetMore's KeysetPage),
 * and fetchPersonPaymentItems' answer as either a bare array or { data }: the contract does not
 * fix either, and the tests should fail on behaviour, not on a field name.
 */

type AnyFn = (...args: unknown[]) => Promise<unknown>
const api = balances as unknown as Record<string, AnyFn>
// Through the namespace so a missing export fails each test instead of the whole file.
const fetchGroupSettlementHistoryPage: AnyFn = (...a) => api.fetchGroupSettlementHistoryPage(...a)
const fetchGroupSettlementHistoryPageMore: AnyFn = (...a) => api.fetchGroupSettlementHistoryPageMore(...a)
const fetchGroupSettlementHistory: AnyFn = (...a) => api.fetchGroupSettlementHistory(...a)
const fetchPersonPaymentItems: AnyFn = (...a) => api.fetchPersonPaymentItems(...a)
const fetchPersonSettlementHistory: AnyFn = (...a) => api.fetchPersonSettlementHistory(...a)

type Item = { id: string; amount: number; settlementIds: string[]; method: string | null }
type Page = { items?: Item[]; rows?: Item[]; matching: number }
type Fetched<T> = { data: T; fromCache: boolean }

const pageRows = (p: Page): Item[] => (p.items ?? p.rows ?? []) as Item[]
function itemsOf(r: unknown): Item[] {
  if (Array.isArray(r)) return r as Item[]
  const d = (r as { data?: unknown })?.data
  if (Array.isArray(d)) return d as Item[]
  return pageRows((d ?? r) as Page)
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

const G = 'g-1'
const P = 'p-ana'

function serverItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bundle-1',
    settlementIds: ['s1', 's2'],
    bundleId: 'bundle-1',
    isBundled: true,
    groupId: G,
    groupName: null,
    billId: null,
    billTitle: null,
    fromUserId: 'u-me',
    toUserId: 'u-cha',
    fromName: 'Me',
    toName: 'Cha',
    amount: '100.50',
    currency: 'PHP',
    label: 'Settle up',
    method: 'GCash',
    createdAt: '2026-08-01T00:00:00.000Z',
    recipients: [
      { toUserId: 'u-cha', toName: 'Cha', amount: '70.5' },
      { toUserId: 'u-bob', toName: 'Bob', amount: '30' },
    ],
    legs: [
      { fromUserId: 'u-me', fromName: 'Me', toUserId: 'u-cha', toName: 'Cha', amount: '70.5' },
      { fromUserId: 'u-bob', fromName: 'Bob', toUserId: 'u-cha', toName: 'Cha', amount: '30' },
    ],
    recordedByUserId: 'u-me',
    recordedByName: 'Me',
    ...overrides,
  }
}

const PAGE_PAYLOAD = {
  items: [serverItem(), serverItem({ id: 's9', settlementIds: ['s9'], bundleId: null, isBundled: false, amount: '5' })],
  matching: '14',
}
const BEFORE = { createdAt: '2026-08-01T00:00:00.000Z', id: 's1' }
const DENIED = { data: null, error: { code: '42501', message: 'permission denied for function' } }

beforeEach(() => {
  localStorage.clear()
  clearPrimedReads()
  rpc.mockReset()
  setOnline(true)
})
afterEach(() => setOnline(true))

describe('fetchGroupSettlementHistoryPage, the first page (C8 client half)', () => {
  it('C8: calls kwenta_group_settlement_history_page with p_group_id and p_limit 20 by default', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupSettlementHistoryPage('u1', G)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('kwenta_group_settlement_history_page', { p_group_id: G, p_limit: 20 })
  })

  it('C8: maps each item through the history mapper and matching to a number', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    const { data, fromCache } = (await fetchGroupSettlementHistoryPage('u1', G)) as Fetched<Page>
    expect(fromCache).toBe(false)
    const rows = pageRows(data)
    expect(rows.map((r) => r.id)).toEqual(['bundle-1', 's9'])
    expect(rows[0].amount).toBe(100.5)
    expect(rows[0].settlementIds).toEqual(['s1', 's2'])
    expect(rows[0].method).toBe('GCash')
    expect(data.matching).toBe(14)
  })

  it('C7: is a mounted read a write can recompute: key group-payments-page:<id>, no extraArgs, limit 20', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupSettlementHistoryPage('u1', G)
    markReadMounted(`group-payments-page:${G}`)
    const spec = mountedReadSpecs().find((s) => s.key === `group-payments-page:${G}`)
    expect(spec).toEqual({
      key: `group-payments-page:${G}`,
      fn: 'kwenta_group_settlement_history_page',
      argName: 'p_group_id',
      id: G,
      limit: 20,
    })
  })

  it('C7: a primed payload under group-payments-page:<id> is served without a request', async () => {
    primeReads({ [`group-payments-page:${G}`]: PAGE_PAYLOAD })
    const { data, fromCache } = (await fetchGroupSettlementHistoryPage('u1', G)) as Fetched<Page>
    expect(rpc).not.toHaveBeenCalled()
    expect(fromCache).toBe(false)
    expect(pageRows(data)).toHaveLength(2)
    expect(data.matching).toBe(14)
  })

  it('C8: the first page is cached under group-payments-page:<id> and answers offline, flagged', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupSettlementHistoryPage('u1', G)
    expect(readCache(`group-payments-page:${G}`, 'u1')).not.toBeNull()
    setOnline(false)
    const r = (await fetchGroupSettlementHistoryPage('u1', G)) as Fetched<Page>
    expect(r.fromCache).toBe(true)
    expect(pageRows(r.data)).toHaveLength(2)
  })

  it('C13: a NULL answer is an access error: nothing cached, never an empty page, never "this screen"', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    const err = await fetchGroupSettlementHistoryPage('u1', G).then(
      () => null,
      (e: unknown) => e as Error,
    )
    expect(err).not.toBeNull()
    expect(err!.message).toMatch(/no longer have access/i)
    expect(err!.message).not.toContain('this screen')
    expect(readCache(`group-payments-page:${G}`, 'u1')).toBeNull()
  })

  it('C13: a saved first page is not served after the server declined', async () => {
    rpc.mockResolvedValueOnce({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupSettlementHistoryPage('u1', G)
    rpc.mockResolvedValueOnce({ data: null, error: null })
    await expect(fetchGroupSettlementHistoryPage('u1', G)).rejects.toThrow(/no longer have access/i)
  })

  it("C16: an access error names this group's payments, not \"this screen\"", async () => {
    rpc.mockResolvedValue(DENIED)
    const err = (await fetchGroupSettlementHistoryPage('u1', G).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/no longer have access to .*payments/i)
    expect(err.message).not.toContain('this screen')
  })
})

describe('fetchGroupSettlementHistoryPageMore, Show older (C8/C17 client half)', () => {
  it('C17: sends p_group_id, p_limit and p_before = { createdAt, id } exactly as given', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    const { data, fromCache } = (await fetchGroupSettlementHistoryPageMore('u1', G, { limit: 20, before: BEFORE })) as Fetched<Page>
    expect(rpc).toHaveBeenCalledWith('kwenta_group_settlement_history_page', {
      p_group_id: G,
      p_limit: 20,
      p_before: BEFORE,
    })
    expect(fromCache).toBe(false)
    expect(pageRows(data).map((r) => r.id)).toEqual(['bundle-1', 's9'])
    expect(data.matching).toBe(14)
  })

  it('C8: an older page is never cached under the first-page key', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupSettlementHistoryPageMore('u1', G, { limit: 20, before: BEFORE })
    expect(readCache(`group-payments-page:${G}`, 'u1')).toBeNull()
  })

  it('C8: an older page does not consume the primed first page', async () => {
    primeReads({ [`group-payments-page:${G}`]: { items: [], matching: 0 } })
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    const { data } = (await fetchGroupSettlementHistoryPageMore('u1', G, { limit: 20, before: BEFORE })) as Fetched<Page>
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(pageRows(data)).toHaveLength(2)
    const first = (await fetchGroupSettlementHistoryPage('u1', G)) as Fetched<Page>
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(pageRows(first.data)).toHaveLength(0)
  })

  it('C8: an older page does not replace the mounted first-page spec', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupSettlementHistoryPage('u1', G)
    markReadMounted(`group-payments-page:${G}`)
    await fetchGroupSettlementHistoryPageMore('u1', G, { limit: 20, before: BEFORE })
    const specs = mountedReadSpecs().filter((s) => s.fn === 'kwenta_group_settlement_history_page')
    expect(specs).toEqual([
      { key: `group-payments-page:${G}`, fn: 'kwenta_group_settlement_history_page', argName: 'p_group_id', id: G, limit: 20 },
    ])
  })

  it('C8: offline it refuses with an offline message and sends nothing', async () => {
    setOnline(false)
    await expect(fetchGroupSettlementHistoryPageMore('u1', G, { limit: 20, before: BEFORE })).rejects.toThrow(/offline/i)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('C13: a NULL answer to an older page is an access error, never an empty page', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    const err = (await fetchGroupSettlementHistoryPageMore('u1', G, { limit: 20, before: BEFORE }).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/no longer have access/i)
    expect(err.message).not.toContain('this screen')
  })
})

describe('fetchGroupSettlementHistory, the full list for exports (C9 client half)', () => {
  it('C9: still calls kwenta_group_settlement_history with p_group_id only', async () => {
    rpc.mockResolvedValue({ data: [serverItem()], error: null })
    await fetchGroupSettlementHistory('u1', G)
    expect(rpc).toHaveBeenCalledWith('kwenta_group_settlement_history', { p_group_id: G })
  })

  it('C9: caches under group-payments-full:<id>, never under the page key or the old key', async () => {
    rpc.mockResolvedValueOnce({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupSettlementHistoryPage('u1', G)
    rpc.mockResolvedValueOnce({ data: [serverItem(), serverItem({ id: 'b2' }), serverItem({ id: 'b3' })], error: null })
    await fetchGroupSettlementHistory('u1', G)

    expect(readCache<unknown[]>(`group-payments-full:${G}`, 'u1')?.data).toHaveLength(3)
    expect(readCache<{ matching: number }>(`group-payments-page:${G}`, 'u1')?.data.matching).toBe(14)
    expect(readCache(`group-payments:${G}`, 'u1')).toBeNull()
  })

  it('C9: the full fetch does not replace the mounted page spec (a write keeps priming 20 items)', async () => {
    rpc.mockResolvedValue({ data: PAGE_PAYLOAD, error: null })
    await fetchGroupSettlementHistoryPage('u1', G)
    markReadMounted(`group-payments-page:${G}`)
    rpc.mockResolvedValue({ data: [serverItem()], error: null })
    await fetchGroupSettlementHistory('u1', G)

    const specs = mountedReadSpecs()
    expect(specs.find((s) => s.key === `group-payments-page:${G}`)).toMatchObject({
      fn: 'kwenta_group_settlement_history_page',
      limit: 20,
    })
    expect(specs.some((s) => s.fn === 'kwenta_group_settlement_history')).toBe(false)
  })

  it("C9: the full fetch does not consume the page's primed read", async () => {
    primeReads({ [`group-payments-page:${G}`]: PAGE_PAYLOAD })
    rpc.mockResolvedValue({ data: [serverItem()], error: null })
    await fetchGroupSettlementHistory('u1', G)
    expect(rpc).toHaveBeenCalledTimes(1)
    const { data } = (await fetchGroupSettlementHistoryPage('u1', G)) as Fetched<Page>
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(data.matching).toBe(14)
  })

  it('C16: an access error on the full list names the payments, not "this screen"', async () => {
    rpc.mockResolvedValue(DENIED)
    const err = (await fetchGroupSettlementHistory('u1', G).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/no longer have access to .*payments/i)
    expect(err.message).not.toContain('this screen')
  })
})

describe('fetchPersonPaymentItems, the statement-row lookup (C10/C15 client half)', () => {
  it('C10: calls kwenta_person_payment_items with p_person_id and p_settlement_ids only', async () => {
    rpc.mockResolvedValue({ data: [serverItem({ groupId: null })], error: null })
    const r = await fetchPersonPaymentItems('u1', P, ['s1', 's2'])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('kwenta_person_payment_items', { p_person_id: P, p_settlement_ids: ['s1', 's2'] })
    const items = itemsOf(r)
    expect(items.map((i) => i.id)).toEqual(['bundle-1'])
    expect(items[0].amount).toBe(100.5)
    expect(items[0].method).toBe('GCash')
  })

  it('C10: no leg ids makes no request and answers no items', async () => {
    const r = await fetchPersonPaymentItems('u1', P, [])
    expect(rpc).not.toHaveBeenCalled()
    expect(itemsOf(r)).toEqual([])
  })

  it('C15: exactly 500 ids is one request', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const ids = Array.from({ length: 500 }, (_, i) => `s-${i}`)
    await fetchPersonPaymentItems('u1', P, ids)
    expect(rpc).toHaveBeenCalledTimes(1)
    expect((rpc.mock.calls[0][1] as { p_settlement_ids: string[] }).p_settlement_ids).toHaveLength(500)
  })

  it('C15: 1100 ids go in chunks of at most 500 that together cover every id once', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    const ids = Array.from({ length: 1100 }, (_, i) => `s-${i}`)
    await fetchPersonPaymentItems('u1', P, ids)

    expect(rpc).toHaveBeenCalledTimes(3)
    const sent: string[] = []
    for (const [fn, args] of rpc.mock.calls as [string, { p_person_id: string; p_settlement_ids: string[] }][]) {
      expect(fn).toBe('kwenta_person_payment_items')
      expect(args.p_person_id).toBe(P)
      expect(args.p_settlement_ids.length).toBeGreaterThan(0)
      expect(args.p_settlement_ids.length).toBeLessThanOrEqual(500)
      sent.push(...args.p_settlement_ids)
    }
    expect(sent).toHaveLength(1100)
    expect([...new Set(sent)].sort()).toEqual([...ids].sort())
  })

  it('C15: 501 ids is two requests, never one over the server cap', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    await fetchPersonPaymentItems('u1', P, Array.from({ length: 501 }, (_, i) => `s-${i}`))
    expect(rpc).toHaveBeenCalledTimes(2)
    const sizes = rpc.mock.calls.map((c) => (c[1] as { p_settlement_ids: string[] }).p_settlement_ids.length).sort((a, b) => a - b)
    expect(sizes).toEqual([1, 500])
  })

  it('C15: a bundle whose legs fall in two chunks comes back once (merged and de-duplicated by item id)', async () => {
    const ids = Array.from({ length: 600 }, (_, i) => `s-${i}`)
    rpc.mockImplementation(async (_fn: string, args: { p_settlement_ids: string[] }) => {
      const out = [serverItem({ id: 'bundle-x', settlementIds: ['s-0', 's-599'] })]
      if (args.p_settlement_ids.includes('s-1')) out.push(serverItem({ id: 'solo-1', settlementIds: ['s-1'], isBundled: false }))
      return { data: out, error: null }
    })
    const items = itemsOf(await fetchPersonPaymentItems('u1', P, ids))
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(items.map((i) => i.id).sort()).toEqual(['bundle-x', 'solo-1'])
  })

  it('C13: a NULL answer is an access error, never an empty lookup', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    const err = (await Promise.resolve(fetchPersonPaymentItems('u1', P, ['s1'])).catch((e: unknown) => e)) as Error
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/no longer have access/i)
    expect(err.message).not.toContain('this screen')
  })

  it('C13: a NULL answer to any chunk fails the whole lookup', async () => {
    rpc.mockResolvedValueOnce({ data: [serverItem()], error: null }).mockResolvedValueOnce({ data: null, error: null })
    await expect(
      Promise.resolve(fetchPersonPaymentItems('u1', P, Array.from({ length: 700 }, (_, i) => `s-${i}`))),
    ).rejects.toThrow(/no longer have access/i)
  })

  it('C16: an access error names the payments, not "this screen"', async () => {
    rpc.mockResolvedValue(DENIED)
    const err = (await Promise.resolve(fetchPersonPaymentItems('u1', P, ['s1'])).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/no longer have access to .*payments/i)
    expect(err.message).not.toContain('this screen')
  })

  it('C15: never handed to a write as a read to recompute (not in p_reads)', async () => {
    rpc.mockResolvedValue({ data: [serverItem()], error: null })
    await fetchPersonPaymentItems('u1', P, ['s1', 's2'])
    // The key is the implementation's; mark every plausible spelling mounted.
    for (const key of [`person-payment-items:${P}`, `person-payment-items:${P}:s1,s2`, 'person-payment-items']) {
      markReadMounted(key)
    }
    expect(mountedReadSpecs().some((s) => s.fn === 'kwenta_person_payment_items')).toBe(false)
  })
})

describe('fetchPersonPaymentItems, saved set for offline (coordinator decision on the offline edit regression)', () => {
  const SAVED = `person-payment-items:${P}`
  const answering = (items: ReturnType<typeof serverItem>[]) =>
    rpc.mockImplementation(async (_fn: string, args: { p_settlement_ids: string[] }) => ({
      data: items.filter((it) => (it.settlementIds as string[]).some((id) => args.p_settlement_ids.includes(id))),
      error: null,
    }))
  const a = serverItem({ id: 'item-a', settlementIds: ['a1'], createdAt: '2026-08-03T00:00:00.000Z' })
  const b = serverItem({ id: 'item-b', settlementIds: ['b1', 'b2'], createdAt: '2026-08-02T00:00:00.000Z' })
  const c = serverItem({ id: 'item-c', settlementIds: ['c1'], createdAt: '2026-08-01T00:00:00.000Z' })

  it('a successful lookup is saved per person and answers fresh', async () => {
    answering([a, b])
    const r = (await fetchPersonPaymentItems('u1', P, ['a1', 'b1'])) as Fetched<Item[]>
    expect(r.fromCache).toBe(false)
    expect(r.data.map((i) => i.id).sort()).toEqual(['item-a', 'item-b'])
    expect(readCache<Item[]>(SAVED, 'u1')?.data.map((i) => i.id).sort()).toEqual(['item-a', 'item-b'])
  })

  it('later lookups merge into the saved set by item id, so older loaded pages stay covered', async () => {
    answering([a, b, c])
    await fetchPersonPaymentItems('u1', P, ['a1'])
    await fetchPersonPaymentItems('u1', P, ['b2', 'c1'])
    expect(readCache<Item[]>(SAVED, 'u1')?.data.map((i) => i.id)).toEqual(['item-a', 'item-b', 'item-c'])
  })

  it('offline, the saved items for exactly the requested legs are served, flagged, with no request', async () => {
    answering([a, b, c])
    await fetchPersonPaymentItems('u1', P, ['a1', 'b1', 'c1'])
    rpc.mockClear()
    setOnline(false)

    const r = (await fetchPersonPaymentItems('u1', P, ['b2', 'zzz'])) as Fetched<Item[]>

    expect(rpc).not.toHaveBeenCalled()
    expect(r.fromCache).toBe(true)
    expect(r.data.map((i) => i.id)).toEqual(['item-b'])
  })

  it('offline with nothing saved refuses, never answers empty', async () => {
    setOnline(false)
    await expect(fetchPersonPaymentItems('u1', P, ['a1'])).rejects.toThrow(/offline/i)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("one person's saved set never answers for another person or user", async () => {
    answering([a])
    await fetchPersonPaymentItems('u1', P, ['a1'])
    setOnline(false)
    await expect(fetchPersonPaymentItems('u1', 'p-other', ['a1'])).rejects.toThrow(/offline/i)
    await expect(fetchPersonPaymentItems('u2', P, ['a1'])).rejects.toThrow(/offline/i)
  })

  it('a transport failure online serves the saved items, flagged', async () => {
    answering([a])
    await fetchPersonPaymentItems('u1', P, ['a1'])
    rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch', status: 0 } })

    const r = (await fetchPersonPaymentItems('u1', P, ['a1'])) as Fetched<Item[]>

    expect(r.fromCache).toBe(true)
    expect(r.data.map((i) => i.id)).toEqual(['item-a'])
  })

  it('a transport failure with nothing saved is an error, never an empty lookup', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'Failed to fetch', status: 0 } })
    await expect(fetchPersonPaymentItems('u1', P, ['a1'])).rejects.toThrow(/could not load .*payments/i)
  })

  it('a declined (NULL) answer is not served from the saved set and empties it', async () => {
    answering([a])
    await fetchPersonPaymentItems('u1', P, ['a1'])
    rpc.mockReset()
    rpc.mockResolvedValue({ data: null, error: null })

    await expect(fetchPersonPaymentItems('u1', P, ['a1'])).rejects.toThrow(/no longer have access/i)

    expect(readCache<Item[]>(SAVED, 'u1')?.data).toEqual([])
    setOnline(false)
    const offline = (await fetchPersonPaymentItems('u1', P, ['a1'])) as Fetched<Item[]>
    expect(offline.data).toEqual([])
  })

  it('a permission error is not served from the saved set and empties it', async () => {
    answering([a])
    await fetchPersonPaymentItems('u1', P, ['a1'])
    rpc.mockReset()
    rpc.mockResolvedValue(DENIED)

    await expect(fetchPersonPaymentItems('u1', P, ['a1'])).rejects.toThrow(/no longer have access/i)

    expect(readCache<Item[]>(SAVED, 'u1')?.data).toEqual([])
  })

  it('the saved set keeps at most the newest 500 items', async () => {
    const many = Array.from({ length: 520 }, (_, i) =>
      serverItem({ id: `m-${i}`, settlementIds: [`m-leg-${i}`], createdAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString() }),
    )
    answering(many)
    await fetchPersonPaymentItems('u1', P, many.slice(0, 500).map((m) => (m.settlementIds as string[])[0]))
    await fetchPersonPaymentItems('u1', P, many.slice(500).map((m) => (m.settlementIds as string[])[0]))

    const saved = readCache<Item[]>(SAVED, 'u1')!.data
    expect(saved).toHaveLength(500)
    expect(saved[0].id).toBe('m-519')
    expect(saved.some((i) => i.id === 'm-19')).toBe(false)
    expect(saved.some((i) => i.id === 'm-20')).toBe(true)
  })
})

describe('fetchPersonSettlementHistory, the full list for exports (C11 client half)', () => {
  it('C11: still calls kwenta_person_settlement_history with p_person_id only', async () => {
    rpc.mockResolvedValue({ data: [serverItem()], error: null })
    await fetchPersonSettlementHistory('u1', P)
    expect(rpc).toHaveBeenCalledWith('kwenta_person_settlement_history', { p_person_id: P })
  })

  it('C11: caches under person-payments-full:<id>, never under the old key', async () => {
    rpc.mockResolvedValue({ data: [serverItem(), serverItem({ id: 'b2' })], error: null })
    await fetchPersonSettlementHistory('u1', P)
    expect(readCache<unknown[]>(`person-payments-full:${P}`, 'u1')?.data).toHaveLength(2)
    expect(readCache(`person-payments:${P}`, 'u1')).toBeNull()
  })

  it('C16: an access error on the full list names the payments, not "this screen"', async () => {
    rpc.mockResolvedValue(DENIED)
    const err = (await fetchPersonSettlementHistory('u1', P).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/no longer have access to .*payments/i)
    expect(err.message).not.toContain('this screen')
  })
})
