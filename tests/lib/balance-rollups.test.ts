import { describe, expect, it } from 'vitest'
import { groupReceivePayMapsFromSummaries, mergeCurrencyTotals } from '@/lib/balance-rollups'
import type { GroupBalanceSummary } from '@/lib/settlement'

describe('mergeCurrencyTotals', () => {
  it('sums overlapping currencies', () => {
    const a = new Map([['PHP', 100]])
    const b = new Map([['PHP', 50]])
    expect(mergeCurrencyTotals(a, b).get('PHP')).toBe(150)
  })

  it('keeps distinct currencies separate', () => {
    const a = new Map([['PHP', 100]])
    const b = new Map([['USD', 20]])
    const merged = mergeCurrencyTotals(a, b)
    expect(merged.get('PHP')).toBe(100)
    expect(merged.get('USD')).toBe(20)
  })

  it('does not mutate the inputs', () => {
    const a = new Map([['PHP', 100]])
    const b = new Map([['PHP', 50]])
    mergeCurrencyTotals(a, b)
    expect(a.get('PHP')).toBe(100)
    expect(b.get('PHP')).toBe(50)
  })
})

const summary = (over: Partial<GroupBalanceSummary>): GroupBalanceSummary => ({
  groupId: 'g',
  groupName: 'G',
  currency: 'PHP',
  balances: [],
  totalToReceive: 0,
  totalToPay: 0,
  ...over,
})

describe('groupReceivePayMapsFromSummaries', () => {
  it('rolls up receive and pay totals per currency', () => {
    const { groupReceive, groupPay } = groupReceivePayMapsFromSummaries([
      summary({ currency: 'PHP', totalToReceive: 100 }),
      summary({ currency: 'PHP', totalToPay: 40 }),
      summary({ currency: 'USD', totalToReceive: 10 }),
    ])
    expect(groupReceive.get('PHP')).toBe(100)
    expect(groupReceive.get('USD')).toBe(10)
    expect(groupPay.get('PHP')).toBe(40)
  })

  it('ignores zero totals', () => {
    const { groupReceive, groupPay } = groupReceivePayMapsFromSummaries([
      summary({ totalToReceive: 0, totalToPay: 0 }),
    ])
    expect(groupReceive.size).toBe(0)
    expect(groupPay.size).toBe(0)
  })

  it('accumulates same-currency summaries', () => {
    const { groupReceive } = groupReceivePayMapsFromSummaries([
      summary({ totalToReceive: 30 }),
      summary({ totalToReceive: 20 }),
    ])
    expect(groupReceive.get('PHP')).toBe(50)
  })
})
