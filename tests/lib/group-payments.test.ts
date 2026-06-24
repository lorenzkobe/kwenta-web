import { describe, expect, it } from 'vitest'
import { allocateLumpSum, type OwedParty } from '@/lib/group-payments'

const owed: OwedParty[] = [
  { userId: 'maria', name: 'Maria', owed: 500 },
  { userId: 'ana', name: 'Ana', owed: 300 },
]

describe('allocateLumpSum', () => {
  it('equal: splits evenly when under everyone\'s cap', () => {
    const r = allocateLumpSum({ mode: 'equal', total: 600, owed })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(300)
    expect(byId.ana).toBe(300)
    expect(r.unallocated).toBe(0)
  })

  it('equal: caps per person and reports the unallocatable remainder', () => {
    // 1000 / 2 = 500 each, but Ana only owes 300 → 200 cannot be applied.
    const r = allocateLumpSum({ mode: 'equal', total: 1000, owed })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(500)
    expect(byId.ana).toBe(300)
    expect(r.allocatedTotal).toBe(800)
    expect(r.unallocated).toBe(200)
  })

  it('percentage: allocates by ratio, capped, remainder reported', () => {
    const r = allocateLumpSum({
      mode: 'percentage',
      total: 600,
      owed,
      percentages: { maria: 50, ana: 50 },
    })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(300)
    expect(byId.ana).toBe(300)
    expect(r.unallocated).toBe(0)
  })

  it('custom: uses explicit amounts, total is their sum, caps at owed', () => {
    const r = allocateLumpSum({
      mode: 'custom',
      total: 0, // ignored in custom mode
      owed,
      customAmounts: { maria: 500, ana: 100 },
    })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(500)
    expect(byId.ana).toBe(100)
    expect(r.allocatedTotal).toBe(600)
    expect(r.unallocated).toBe(0)
  })

  it('custom: caps an over-cap entry and counts the excess as unallocated', () => {
    const r = allocateLumpSum({
      mode: 'custom',
      total: 0,
      owed,
      customAmounts: { maria: 700, ana: 0 }, // 700 > 500 owed
    })
    const byId = Object.fromEntries(r.allocations.map((a) => [a.userId, a.amount]))
    expect(byId.maria).toBe(500)
    expect(r.unallocated).toBe(200)
  })

  it('drops zero allocations', () => {
    const r = allocateLumpSum({
      mode: 'custom',
      total: 0,
      owed,
      customAmounts: { maria: 100, ana: 0 },
    })
    expect(r.allocations.map((a) => a.userId)).toEqual(['maria'])
  })
})
