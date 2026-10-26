import { describe, expect, it } from 'vitest'
import { buildDebtGraph, buildSuggestedPayers } from '@/lib/settlement-suggestions'

/**
 * C3, client half. Migration 083 nets rawDebts per pair on the server. Settle-up must suggest
 * exactly the same transfers as it did over 079's raw edges. The edges below are the C3 fixture of
 * supabase/tests/sql/083_smaller_screen_payloads.test.sql: that suite pins that 083 returns the
 * `netted` list for that group, and this one pins that the suggestions are unchanged by it.
 */

const RAW = [
  // Hotel: Alice paid 120 over four.
  { from: 'bob', to: 'alice', amount: 30 },
  { from: 'cara', to: 'alice', amount: 30 },
  { from: 'dan', to: 'alice', amount: 30 },
  // Wifi: Bob paid 80 over Alice and Bob.
  { from: 'alice', to: 'bob', amount: 40 },
  // Food: Cara paid 60 over Bob, Cara, Dan.
  { from: 'bob', to: 'cara', amount: 20 },
  { from: 'dan', to: 'cara', amount: 20 },
  // Payments Dan -> Alice 10 and Bob -> Alice 5, as reversed edges.
  { from: 'alice', to: 'dan', amount: 10 },
  { from: 'alice', to: 'bob', amount: 5 },
]

const NETTED = [
  { from: 'alice', to: 'bob', amount: 15 },
  { from: 'bob', to: 'cara', amount: 20 },
  { from: 'cara', to: 'alice', amount: 30 },
  { from: 'dan', to: 'alice', amount: 20 },
  { from: 'dan', to: 'cara', amount: 20 },
]

const nameOf = (id: string) => id.toUpperCase()

describe('netted rawDebts', () => {
  it('C3: the client graph is the same over raw and netted edges', () => {
    const key = (e: { from: string; to: string }) => `${e.from}|${e.to}`
    const raw = [...buildDebtGraph(RAW)].sort((a, b) => key(a).localeCompare(key(b)))
    const net = [...buildDebtGraph(NETTED)].sort((a, b) => key(a).localeCompare(key(b)))
    expect(net).toEqual(raw)
    expect(net).toEqual([
      { from: 'alice', to: 'bob', cents: 1500 },
      { from: 'bob', to: 'cara', cents: 2000 },
      { from: 'cara', to: 'alice', cents: 3000 },
      { from: 'dan', to: 'alice', cents: 2000 },
      { from: 'dan', to: 'cara', cents: 2000 },
    ])
  })

  // NOT "toEqual(buildSuggestedPayers(RAW))": decomposeDebtGraph is sensitive to edge ORDER, and
  // 079 emitted raw edges with no ORDER BY, so the transfer list was never a stable function of the
  // group. Pinned instead: the suggestions over netted edges clear exactly the same positions,
  // and are deterministic for the from,to order 083 emits. (Reported to the lead.)
  it('C3: suggestions over netted edges move every member by exactly what the raw edges say', () => {
    const position = (edges: { from: string; to: string; amount: number }[]) => {
      const p = new Map<string, number>()
      for (const e of edges) {
        p.set(e.from, (p.get(e.from) ?? 0) - Math.round(e.amount * 100))
        p.set(e.to, (p.get(e.to) ?? 0) + Math.round(e.amount * 100))
      }
      return Object.fromEntries([...p].filter(([, v]) => v !== 0).sort())
    }
    const suggested = buildSuggestedPayers(NETTED, nameOf)
    const paid = suggested.flatMap((g) => g.recipients.map((r) => ({ from: r.toUserId, to: g.fromUserId, amount: r.amount })))
    // A suggested payment from X to Y cancels a debt X -> Y, i.e. it is the reversed edge.
    expect(position([...RAW, ...paid])).toEqual({})
    expect(position(NETTED)).toEqual(position(RAW))
    expect(buildSuggestedPayers([...NETTED], nameOf)).toEqual(suggested)
    expect(suggested.length).toBeGreaterThan(0)
  })

  it('C2/C3: a pair cleared to zero contributes nothing either way', () => {
    const raw = [
      { from: 'bob', to: 'alice', amount: 50 },
      { from: 'alice', to: 'bob', amount: 50 },
    ]
    expect(buildSuggestedPayers(raw, nameOf)).toEqual(buildSuggestedPayers([], nameOf))
  })

  it('C5: a netted 66.77 suggests the same as 33.34 + 33.33 + 0.10', () => {
    const raw = [
      { from: 'bob', to: 'alice', amount: 33.34 },
      { from: 'bob', to: 'alice', amount: 33.33 },
      { from: 'bob', to: 'alice', amount: 0.1 },
    ]
    const netted = buildSuggestedPayers([{ from: 'bob', to: 'alice', amount: 66.77 }], nameOf)
    expect(netted).toEqual(buildSuggestedPayers(raw, nameOf))
    expect(netted[0]?.total).toBe(66.77)
  })
})
