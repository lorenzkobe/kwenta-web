import { describe, expect, it } from 'vitest'
import { buildMovementChains } from '@/lib/settlement'

/**
 * `buildMovementChains` is all that is left of this module's logic: a pure transform of ONE
 * payment's legs, which CLAUDE.md rule 8 keeps on the TypeScript side.
 *
 * Everything else this file used to cover moved into SQL with the code, per rule 10 — the group
 * ledger and its pairwise nets to `supabase/tests/sql/053_money_group_net_and_breakdown.test.sql`
 * and `061_group_detail.test.sql`, and settlement history, the member payment breakdown and the
 * payment cap to `064_settlement_history_and_group_math.test.sql`. In particular the leg-vs-
 * recipient distinction these chains consume is pinned there under "recipients collapse, legs
 * do not".
 */

describe('buildMovementChains', () => {
  const leg = (fromUserId: string, toUserId: string, amount: number) => ({
    fromUserId,
    fromName: fromUserId,
    toUserId,
    toName: toUserId,
    amount,
  })

  it('reconstructs a pass-through into a single arrow chain', () => {
    // You pay Yumi directly (1000) and cover Cha's 923 debt to Yumi, recorded as
    // bookkeeping legs You→Cha and Cha→Yumi. The flow is You → Cha → Yumi.
    const chains = buildMovementChains([
      leg('You', 'Yumi', 1000),
      leg('You', 'Cha', 923),
      leg('Cha', 'Yumi', 923),
    ])
    const rendered = chains.map((c) => `${c.steps.map((s) => s.name).join('→')}:${c.amount}`)
    expect(rendered).toEqual(['You→Yumi:1000', 'You→Cha→Yumi:923'])
  })

  it('keeps direct payments as two-step chains', () => {
    const chains = buildMovementChains([leg('You', 'A', 50), leg('You', 'B', 30)])
    expect(chains).toEqual([
      { steps: [{ userId: 'You', name: 'You' }, { userId: 'A', name: 'A' }], amount: 50 },
      { steps: [{ userId: 'You', name: 'You' }, { userId: 'B', name: 'B' }], amount: 30 },
    ])
  })

  it('returns one chain for a single leg', () => {
    const chains = buildMovementChains([leg('You', 'Cha', 200)])
    expect(chains).toHaveLength(1)
    expect(chains[0].steps.map((s) => s.name)).toEqual(['You', 'Cha'])
    expect(chains[0].amount).toBe(200)
  })

  it('splits a longer pass-through correctly (two hops, equal amounts)', () => {
    const chains = buildMovementChains([
      leg('Ana', 'Carlo', 100),
      leg('Carlo', 'John', 100),
    ])
    expect(chains).toHaveLength(1)
    expect(chains[0].steps.map((s) => s.name)).toEqual(['Ana', 'Carlo', 'John'])
    expect(chains[0].amount).toBe(100)
  })
})

