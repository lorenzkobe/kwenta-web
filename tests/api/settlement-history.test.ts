import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())

vi.mock('@/lib/supabase', () => ({ supabase: { rpc } }))

import {
  fetchBillSettlementHistory,
  fetchGroupMemberBreakdown,
  fetchGroupSettlementHistory,
  fetchGroupSpending,
  fetchPersonSettlementHistory,
  loadGroupMemberBreakdownFresh,
  loadOwedInGroup,
} from '@/api/balances'
import { writeCache } from '@/api/cache'

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

/** A server row with every field populated, so a mapper that drops one is visible. */
function serverItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bundle-1',
    settlementIds: ['s1', 's2'],
    bundleId: 'bundle-1',
    isBundled: true,
    groupId: 'g1',
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

describe('settlement history API', () => {
  beforeEach(() => {
    localStorage.clear()
    rpc.mockReset()
    setOnline(true)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    setOnline(true)
  })

  it('maps a bundled item, coercing every numeric out of its PostgREST string form', async () => {
    rpc.mockResolvedValue({ data: [serverItem()], error: null })

    const { data } = await fetchGroupSettlementHistory('u1', 'g1')
    const item = data![0]

    expect(item.amount).toBe(100.5)
    expect(typeof item.amount).toBe('number')
    expect(item.recipients.map((r) => r.amount)).toEqual([70.5, 30])
    expect(item.legs.map((l) => l.amount)).toEqual([70.5, 30])
    expect(item.isBundled).toBe(true)
    expect(item.settlementIds).toEqual(['s1', 's2'])
    expect(item.recordedByUserId).toBe('u-me')
  })

  it('keeps legs distinct from recipients — the movement chain depends on it', async () => {
    rpc.mockResolvedValue({ data: [serverItem()], error: null })
    const { data } = await fetchGroupSettlementHistory('u1', 'g1')
    const item = data![0]

    // Two legs land on the same recipient here; collapsing them would erase the fact that Bob's
    // share of the payment came from Bob and not from the headline payer.
    expect(item.legs).toHaveLength(2)
    expect(item.legs.map((l) => l.fromName).sort()).toEqual(['Bob', 'Me'])
    expect(item.legs.some((l) => l.fromUserId !== item.fromUserId)).toBe(true)
  })

  it('carries the payment method through (069)', async () => {
    rpc.mockResolvedValue({ data: [serverItem()], error: null })
    const { data } = await fetchGroupSettlementHistory('u1', 'g1')

    expect(data![0].method).toBe('GCash')
  })

  it('reports a missing or blank method as null, never undefined or ""', async () => {
    // A pre-069 server omits the key entirely. `undefined` would defeat `method ?? ''` seeding in
    // the edit dialog, and `''` would paint an empty tag on every payment ever recorded.
    for (const row of [serverItem({ method: undefined }), serverItem({ method: null }),
                       serverItem({ method: '' })]) {
      rpc.mockResolvedValue({ data: [row], error: null })
      const { data } = await fetchGroupSettlementHistory('u1', 'g1')
      expect(data![0].method).toBeNull()
    }
  })

  it('turns a null groupName into an ABSENT key, never the string "null"', async () => {
    rpc.mockResolvedValue({ data: [serverItem({ groupName: null })], error: null })
    const { data } = await fetchGroupSettlementHistory('u1', 'g1')

    // `String(null)` is "null", which would render as a group called null above the row.
    expect('groupName' in data![0]).toBe(false)
    expect(data![0].groupName).toBeUndefined()
  })

  it('carries a per-row group label through on the person list', async () => {
    rpc.mockResolvedValue({
      data: [serverItem({ groupName: 'Personal', groupId: null, isBundled: false })],
      error: null,
    })
    const { data } = await fetchPersonSettlementHistory('u1', 'p1')
    expect(data[0].groupName).toBe('Personal')
    expect(data[0].groupId).toBeNull()
  })

  it('normalises nulls rather than stringifying them', async () => {
    rpc.mockResolvedValue({
      data: [
        serverItem({
          bundleId: null,
          billId: null,
          billTitle: null,
          recordedByUserId: null,
          recordedByName: null,
          label: '',
        }),
      ],
      error: null,
    })
    const { data } = await fetchBillSettlementHistory('u1', 'b1')
    const item = data[0]
    expect(item.bundleId).toBeNull()
    expect(item.billId).toBeNull()
    expect(item.billTitle).toBeNull()
    expect(item.recordedByUserId).toBeNull()
    expect(item.label).toBe('')
  })

  it('passes a null group history through as null, distinct from an empty list', async () => {
    // Null means "you may not read this group"; [] means "no payments yet". A screen that
    // conflates them tells a non-member they are settled up.
    rpc.mockResolvedValue({ data: null, error: null })
    const { data } = await fetchGroupSettlementHistory('u1', 'g1')
    expect(data).toBeNull()

    rpc.mockResolvedValue({ data: [], error: null })
    const empty = await fetchGroupSettlementHistory('u1', 'g2')
    expect(empty.data).toEqual([])
  })

  it('falls back to the cached history when the request fails', async () => {
    writeCache('group-payments:g1', 'u1', [serverItem({ amount: 5 })], '2026-08-01T00:00:00.000Z')
    rpc.mockRejectedValue(new Error('network down'))

    const { data, fromCache } = await fetchGroupSettlementHistory('u1', 'g1')
    expect(fromCache).toBe(true)
    expect(data![0].amount).toBe(5)
  })
})

describe('group spending API', () => {
  beforeEach(() => {
    localStorage.clear()
    rpc.mockReset()
    setOnline(true)
  })

  it('maps rows and coerces string amounts', async () => {
    rpc.mockResolvedValue({
      data: {
        currency: 'PHP',
        rows: [
          { userId: 'a', displayName: 'Alice', amount: '90.25' },
          { userId: 'b', displayName: 'Bob', amount: 50 },
        ],
      },
      error: null,
    })
    const { data } = await fetchGroupSpending('u1', 'g1')
    expect(data!.currency).toBe('PHP')
    expect(data!.rows.map((r) => r.amount)).toEqual([90.25, 50])
  })

  it('returns null when the caller may not read the group', async () => {
    rpc.mockResolvedValue({ data: null, error: null })
    const { data } = await fetchGroupSpending('u1', 'g1')
    expect(data).toBeNull()
  })
})

describe('member breakdown and the payment cap', () => {
  beforeEach(() => {
    localStorage.clear()
    rpc.mockReset()
    setOnline(true)
  })

  it('maps pays and receives as positive magnitudes', async () => {
    rpc.mockResolvedValue({
      data: {
        memberUserId: 'b',
        displayName: 'Bob',
        currency: 'PHP',
        pays: [{ memberUserId: 'a', displayName: 'Alice', amount: '30' }],
        receives: [{ memberUserId: 'c', displayName: 'Cha', amount: '10' }],
      },
      error: null,
    })
    const { data } = await fetchGroupMemberBreakdown('u1', 'g1', 'b')
    expect(data!.pays[0].amount).toBe(30)
    expect(data!.receives[0].amount).toBe(10)
    expect(data!.memberUserId).toBe('b')
  })

  it('does NOT serve the guard a cached answer', async () => {
    // A guard that reads the offline cache decides whether money may move from a stale copy.
    writeCache('group-breakdown:g1:b', 'u1', { pays: [] }, '2026-08-01T00:00:00.000Z')
    rpc.mockRejectedValue(new Error('network down'))

    await expect(loadGroupMemberBreakdownFresh('g1', 'b')).rejects.toThrow(/network down/i)
  })

  it('surfaces the owed cap as a number, and null when not a member', async () => {
    rpc.mockResolvedValue({ data: '42.50', error: null })
    expect(await loadOwedInGroup('g1', 'a', 'b')).toBe(42.5)

    rpc.mockResolvedValue({ data: null, error: null })
    expect(await loadOwedInGroup('g1', 'a', 'b')).toBeNull()
  })

  it('treats a zero cap as zero, not as "unknown"', async () => {
    // `0` is falsy; a `data || null` shaped mapper would turn "owes nothing" into "cannot say",
    // and the caller skips the cap when it cannot say.
    rpc.mockResolvedValue({ data: 0, error: null })
    expect(await loadOwedInGroup('g1', 'a', 'b')).toBe(0)
  })

  it('propagates an RPC error instead of reporting no debt', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await expect(loadOwedInGroup('g1', 'a', 'b')).rejects.toBeTruthy()
  })
})
