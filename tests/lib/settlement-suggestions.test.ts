import { describe, expect, it } from 'vitest'
import {
  buildDebtGraph,
  decomposeDebtGraph,
  groupTransfersByPayer,
  type SuggestedTransfer,
} from '@/lib/settlement-suggestions'

// Sum of a member's signed position implied by a set of legs:
// +amount when they are the payer (they pay out), -amount when they receive.
function signedNetFromLegs(transfers: SuggestedTransfer[]): Map<string, number> {
  const net = new Map<string, number>()
  const bump = (id: string, c: number) => net.set(id, (net.get(id) ?? 0) + c)
  for (const t of transfers)
    for (const leg of t.legs) {
      bump(leg.fromUserId, Math.round(leg.amount * 100))
      bump(leg.toUserId, -Math.round(leg.amount * 100))
    }
  return net
}

describe('buildDebtGraph', () => {
  it('nets opposing debts within a pair into one direction', () => {
    const edges = buildDebtGraph([
      { from: 'A', to: 'B', amount: 200 },
      { from: 'B', to: 'A', amount: 50 },
    ])
    expect(edges).toEqual([{ from: 'A', to: 'B', cents: 15000 }])
  })

  it('drops fully cancelled pairs and self-loops', () => {
    const edges = buildDebtGraph([
      { from: 'A', to: 'B', amount: 100 },
      { from: 'B', to: 'A', amount: 100 },
      { from: 'C', to: 'C', amount: 50 },
    ])
    expect(edges).toEqual([])
  })
})

describe('decomposeDebtGraph', () => {
  it('returns nothing for an empty / settled graph', () => {
    expect(decomposeDebtGraph([])).toEqual([])
  })

  it('passes a single debt straight through as one transfer with one leg', () => {
    const transfers = decomposeDebtGraph([{ from: 'A', to: 'B', cents: 10000 }])
    expect(transfers).toEqual([
      {
        fromUserId: 'A',
        toUserId: 'B',
        amount: 100,
        legs: [{ fromUserId: 'A', toUserId: 'B', amount: 100 }],
      },
    ])
  })

  it('cuts the middleman: Ana→Carlo→John becomes Ana→Carlo + Ana→John, John leg routed through Carlo', () => {
    // Ana owes Carlo 200; Carlo owes John 100.
    const transfers = decomposeDebtGraph([
      { from: 'Ana', to: 'Carlo', cents: 20000 },
      { from: 'Carlo', to: 'John', cents: 10000 },
    ])
    // Ana is the only net debtor (−200); Carlo net +100; John net +100.
    const byTo = new Map(transfers.map((t) => [t.toUserId, t]))
    expect(transfers.every((t) => t.fromUserId === 'Ana')).toBe(true)
    expect(byTo.get('Carlo')?.amount).toBe(100)
    expect(byTo.get('John')?.amount).toBe(100)
    // The Ana→John transfer is bookkept as Ana→Carlo then Carlo→John.
    expect(byTo.get('John')?.legs).toEqual([
      { fromUserId: 'Ana', toUserId: 'Carlo', amount: 100 },
      { fromUserId: 'Carlo', toUserId: 'John', amount: 100 },
    ])
    // Net implied by all legs reconstructs the original debt positions exactly:
    // Ana owes 200 (net debtor, +), Carlo and John each receive 100 (−).
    const net = signedNetFromLegs(transfers)
    expect(net.get('Ana')).toBe(20000)
    expect(net.get('Carlo')).toBe(-10000)
    expect(net.get('John')).toBe(-10000)
  })

  it('never crosses disconnected debt clusters', () => {
    // Cluster 1: Ana owes Carlo. Cluster 2: John owes Bea. Same amounts.
    const transfers = decomposeDebtGraph([
      { from: 'Ana', to: 'Carlo', cents: 10000 },
      { from: 'John', to: 'Bea', cents: 10000 },
    ])
    const pairs = transfers.map((t) => `${t.fromUserId}->${t.toUserId}`).sort()
    expect(pairs).toEqual(['Ana->Carlo', 'John->Bea'])
  })

  it('cancels a pure 3-cycle to zero transfers', () => {
    // A→B→C→A all 100: everyone is square.
    const transfers = decomposeDebtGraph([
      { from: 'A', to: 'B', cents: 10000 },
      { from: 'B', to: 'C', cents: 10000 },
      { from: 'C', to: 'A', cents: 10000 },
    ])
    expect(transfers).toEqual([])
  })

  it('property: every leg carries the transfer amount and legs reconstruct every member net', () => {
    // Deterministic pseudo-random graphs (seeded LCG, no Date/Math.random reliance).
    let seed = 123456789
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    const ids = ['A', 'B', 'C', 'D', 'E']
    for (let trial = 0; trial < 50; trial++) {
      const raw: { from: string; to: string; amount: number }[] = []
      const m = 3 + rand(6)
      for (let i = 0; i < m; i++) {
        const a = ids[rand(ids.length)]
        const b = ids[rand(ids.length)]
        if (a === b) continue
        raw.push({ from: a, to: b, amount: (1 + rand(500)) }) // whole-peso debts
      }
      const edges = buildDebtGraph(raw)
      const expectedNet = new Map<string, number>()
      for (const e of edges) {
        expectedNet.set(e.from, (expectedNet.get(e.from) ?? 0) + e.cents)
        expectedNet.set(e.to, (expectedNet.get(e.to) ?? 0) - e.cents)
      }
      const transfers = decomposeDebtGraph(edges)
      for (const t of transfers) {
        // Each leg of a single path-transfer carries the same bottleneck amount.
        for (const l of t.legs) {
          expect(Math.round(l.amount * 100)).toBe(Math.round(t.amount * 100))
        }
      }
      const got = signedNetFromLegs(transfers)
      for (const id of ids) {
        expect(got.get(id) ?? 0).toBe(expectedNet.get(id) ?? 0)
      }
    }
  })
})

describe('groupTransfersByPayer', () => {
  it('groups a payer\'s transfers and merges legs by pair', () => {
    const transfers: SuggestedTransfer[] = [
      {
        fromUserId: 'Ana',
        toUserId: 'Carlo',
        amount: 100,
        legs: [{ fromUserId: 'Ana', toUserId: 'Carlo', amount: 100 }],
      },
      {
        fromUserId: 'Ana',
        toUserId: 'John',
        amount: 100,
        legs: [
          { fromUserId: 'Ana', toUserId: 'Carlo', amount: 100 },
          { fromUserId: 'Carlo', toUserId: 'John', amount: 100 },
        ],
      },
    ]
    const groups = groupTransfersByPayer(transfers)
    expect(groups).toHaveLength(1)
    expect(groups[0].fromUserId).toBe('Ana')
    expect(groups[0].total).toBe(200)
    expect(groups[0].recipients).toEqual([
      { toUserId: 'Carlo', amount: 100 },
      { toUserId: 'John', amount: 100 },
    ])
    // Two Ana→Carlo legs merge to 200; Carlo→John stays 100.
    expect(groups[0].legs).toEqual([
      { fromUserId: 'Ana', toUserId: 'Carlo', amount: 200 },
      { fromUserId: 'Carlo', toUserId: 'John', amount: 100 },
    ])
  })
})
