import { describe, expect, it } from 'vitest'
import { buildMoneyFlowRows, collapsePaymentLegs, type MoneyFlowEvent } from '@/lib/money-flow'

/**
 * The running-balance half of the statement.
 *
 * Which bills and payments belong to a pair, and what each did to the tab, moved to migration
 * 062 and is covered by `supabase/tests/sql/062_person_statement.test.sql` — including the
 * reconciliation invariant (the deltas sum to the hero number), the peer-linked
 * one-split-per-item rule, third-party exclusions, deletions, the currency filters, and the
 * roster name used to title a payment. What is left here is the walk itself, which is where the
 * ORDER and the SIGN of the running total live.
 */

const T = {
  t1: '2026-01-01T00:00:00.000Z',
  t2: '2026-01-02T00:00:00.000Z',
  t3: '2026-01-03T00:00:00.000Z',
}

function ev(over: Partial<MoneyFlowEvent> & { id: string; delta: number }): MoneyFlowEvent {
  return {
    type: 'personal_bill',
    createdAt: T.t1,
    currency: 'PHP',
    groupId: null,
    bundleId: null,
    contextLabel: 'Personal',
    title: 'Bill',
    rawAmount: Math.abs(over.delta),
    ...over,
  }
}

describe('buildMoneyFlowRows — running balance', () => {
  it('carries a signed running total across events', () => {
    const { rows, currentNet } = buildMoneyFlowRows([
      ev({ id: 'b1', delta: 500, createdAt: T.t1 }),
      ev({ id: 'p1', delta: -200, createdAt: T.t2, type: 'payment', title: 'Other paid you' }),
    ])
    expect(rows.map((r) => r.runningNet)).toEqual([500, 300])
    expect(currentNet.get('PHP')).toBe(300)
  })

  it('reports each row’s own effect on the balance', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'b1', delta: 500, createdAt: T.t1 }),
      ev({ id: 'p1', delta: -200, createdAt: T.t2, type: 'payment' }),
    ])
    expect(rows[0].explanation.balanceDelta).toBe(500)
    expect(rows[1].explanation.balanceDelta).toBe(-200)
  })

  // There is no "credit" concept: an overpayment carries the tab past zero and flips its sign.
  it('an overpayment from them flips the tab past zero', () => {
    const { rows, currentNet } = buildMoneyFlowRows([
      ev({ id: 'b1', delta: 500, createdAt: T.t1 }),
      ev({ id: 'p1', delta: -800, createdAt: T.t2, type: 'payment' }),
    ])
    expect(rows[1].runningNet).toBe(-300)
    expect(currentNet.get('PHP')).toBe(-300)
  })

  it('a later bill moves a flipped tab back', () => {
    const { rows, currentNet } = buildMoneyFlowRows([
      ev({ id: 'b1', delta: 500, createdAt: T.t1 }),
      ev({ id: 'p1', delta: -800, createdAt: T.t2, type: 'payment' }),
      ev({ id: 'b2', delta: 200, createdAt: T.t3 }),
    ])
    expect(rows[2].runningNet).toBe(-100)
    expect(currentNet.get('PHP')).toBe(-100)
  })

  it('my own overpayment flips the tab the other way', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'b1', delta: -300, createdAt: T.t1 }),
      ev({ id: 'p1', delta: 500, createdAt: T.t2, type: 'payment' }),
    ])
    expect(rows[1].runningNet).toBe(200)
  })
})

describe('buildMoneyFlowRows — ordering', () => {
  // A mis-ordered walk produces wrong running balances rather than failing, so the pass sorts
  // rather than trusting its caller.
  it('sorts events chronologically regardless of input order', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'b3', delta: 100, createdAt: T.t3 }),
      ev({ id: 'b1', delta: 500, createdAt: T.t1 }),
      ev({ id: 'b2', delta: -200, createdAt: T.t2 }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['b1', 'b2', 'b3'])
    expect(rows.map((r) => r.runningNet)).toEqual([500, 300, 400])
  })

  it('breaks a timestamp tie by id, so two devices agree', () => {
    const a = buildMoneyFlowRows([ev({ id: 'zzz', delta: 10 }), ev({ id: 'aaa', delta: 20 })])
    const b = buildMoneyFlowRows([ev({ id: 'aaa', delta: 20 }), ev({ id: 'zzz', delta: 10 })])
    expect(a.rows.map((r) => r.id)).toEqual(['aaa', 'zzz'])
    expect(a.rows.map((r) => r.runningNet)).toEqual(b.rows.map((r) => r.runningNet))
  })
})

describe('buildMoneyFlowRows — currencies', () => {
  it('keeps an independent running balance per currency', () => {
    const { rows, currentNet } = buildMoneyFlowRows([
      ev({ id: 'b1', delta: 500, createdAt: T.t1, currency: 'PHP' }),
      ev({ id: 'b2', delta: -20, createdAt: T.t2, currency: 'USD' }),
      ev({ id: 'b3', delta: 100, createdAt: T.t3, currency: 'PHP' }),
    ])
    expect(currentNet.get('PHP')).toBe(600)
    expect(currentNet.get('USD')).toBe(-20)
    // The USD row must not inherit the PHP running total.
    expect(rows.find((r) => r.id === 'b2')?.runningNet).toBe(-20)
  })
})

describe('buildMoneyFlowRows — explanation notes', () => {
  it('describes bills from the viewer’s side', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'b1', delta: 50 }),
      ev({ id: 'b2', delta: -50, createdAt: T.t2 }),
    ])
    expect(rows[0].explanation.note).toBe('they_owe_you')
    expect(rows[1].explanation.note).toBe('you_owe_them')
  })

  it('describes payments by who paid', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'p1', delta: 50, type: 'payment' }),
      ev({ id: 'p2', delta: -50, createdAt: T.t2, type: 'payment' }),
    ])
    expect(rows[0].explanation.note).toBe('you_paid_them')
    expect(rows[1].explanation.note).toBe('they_paid_you')
  })
})

describe('buildMoneyFlowRows — passthrough', () => {
  it('preserves the fields the UI renders', () => {
    const { rows } = buildMoneyFlowRows([
      ev({
        id: 'g1',
        delta: -30,
        type: 'group_bill',
        groupId: 'grp',
        bundleId: 'bundle',
        contextLabel: 'Flat',
        title: 'Wifi',
        rawAmount: 30,
      }),
    ])
    expect(rows[0]).toMatchObject({
      type: 'group_bill',
      groupId: 'grp',
      bundleId: 'bundle',
      contextLabel: 'Flat',
      title: 'Wifi',
      rawAmount: 30,
      signedAmount: -30,
    })
  })

  it('returns an empty statement for no events', () => {
    const { rows, currentNet } = buildMoneyFlowRows([])
    expect(rows).toEqual([])
    expect(currentNet.size).toBe(0)
  })

  it('does not mutate the caller’s array', () => {
    const events = [ev({ id: 'b2', delta: 1, createdAt: T.t2 }), ev({ id: 'b1', delta: 1 })]
    buildMoneyFlowRows(events)
    expect(events.map((e) => e.id)).toEqual(['b2', 'b1'])
  })
})

describe('collapsePaymentLegs', () => {
  /** The legs one split payment writes: personal first, then the group leg. */
  const splitLegs = () =>
    buildMoneyFlowRows([
      ev({
        id: 'leg-personal',
        delta: -1000,
        createdAt: T.t1,
        type: 'payment',
        bundleId: 'bundle-1',
        title: 'Cha paid you',
      }),
      ev({
        id: 'leg-group',
        delta: -3000,
        createdAt: T.t2,
        type: 'payment',
        bundleId: 'bundle-1',
        groupId: 'g1',
        contextLabel: 'Beach Trip',
        title: 'Cha paid you',
      }),
    ]).rows

  it('merges the legs of one bundle into a single row', () => {
    const rows = collapsePaymentLegs(splitLegs())
    expect(rows).toHaveLength(1)
    expect(rows[0].signedAmount).toBe(-4000)
    expect(rows[0].settlementIds).toEqual(['leg-personal', 'leg-group'])
    // The running balance must be the one AFTER the last leg, not a mid-payment figure.
    expect(rows[0].runningNet).toBe(-4000)
  })

  it('reports every context the payment touched', () => {
    const [row] = collapsePaymentLegs(splitLegs())
    expect(row.parts).toEqual([
      { groupId: null, label: 'Personal', amount: 1000 },
      { groupId: 'g1', label: 'Beach Trip', amount: 3000 },
    ])
  })

  it('does not let a personal-first bundle hide the group half', () => {
    // Regression: the merged row used to keep only the FIRST leg's context, so a payment whose
    // personal leg was written first reported groupId null for the whole amount and rendered
    // ₱3,000 of group money as personal money.
    const [row] = collapsePaymentLegs(splitLegs())
    expect(row.parts.some((p) => p.groupId === 'g1')).toBe(true)
    expect(row.parts).toHaveLength(2)
  })

  it('gives a single-context payment exactly one part', () => {
    const rows = collapsePaymentLegs(
      buildMoneyFlowRows([
        ev({ id: 'p1', delta: -500, type: 'payment', title: 'Cha paid you' }),
      ]).rows,
    )
    expect(rows[0].parts).toEqual([{ groupId: null, label: 'Personal', amount: 500 }])
  })

  it('merges two legs in the SAME group into one slice', () => {
    const rows = collapsePaymentLegs(
      buildMoneyFlowRows([
        ev({ id: 'a', delta: -100, createdAt: T.t1, type: 'payment', bundleId: 'b', groupId: 'g1', contextLabel: 'Beach Trip' }),
        ev({ id: 'b', delta: -200, createdAt: T.t2, type: 'payment', bundleId: 'b', groupId: 'g1', contextLabel: 'Beach Trip' }),
      ]).rows,
    )
    expect(rows[0].parts).toEqual([{ groupId: 'g1', label: 'Beach Trip', amount: 300 }])
  })

  it('never merges across currencies', () => {
    const rows = collapsePaymentLegs(
      buildMoneyFlowRows([
        ev({ id: 'a', delta: -100, createdAt: T.t1, type: 'payment', bundleId: 'b' }),
        ev({ id: 'b', delta: -200, createdAt: T.t2, type: 'payment', bundleId: 'b', currency: 'USD' }),
      ]).rows,
    )
    expect(rows).toHaveLength(2)
  })

  it('never merges bills, even when they sit next to each other', () => {
    const rows = collapsePaymentLegs(
      buildMoneyFlowRows([
        ev({ id: 'b1', delta: 100, createdAt: T.t1 }),
        ev({ id: 'b2', delta: 200, createdAt: T.t2 }),
      ]).rows,
    )
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.settlementIds.length === 0)).toBe(true)
  })

  it('does not merge legs of the same bundle separated by another event', () => {
    const rows = collapsePaymentLegs(
      buildMoneyFlowRows([
        ev({ id: 'a', delta: -100, createdAt: T.t1, type: 'payment', bundleId: 'b' }),
        ev({ id: 'mid', delta: 50, createdAt: T.t2 }),
        ev({ id: 'c', delta: -200, createdAt: T.t3, type: 'payment', bundleId: 'b' }),
      ]).rows,
    )
    expect(rows).toHaveLength(3)
  })

  it('leaves an unbundled payment alone', () => {
    const rows = collapsePaymentLegs(
      buildMoneyFlowRows([
        ev({ id: 'a', delta: -100, createdAt: T.t1, type: 'payment' }),
        ev({ id: 'b', delta: -200, createdAt: T.t2, type: 'payment' }),
      ]).rows,
    )
    expect(rows).toHaveLength(2)
  })
})
