import { describe, expect, it } from 'vitest'
import { buildMoneyFlowRows, collapsePaymentLegs, type MoneyFlowEvent } from '@/lib/money-flow'

/**
 * The statement's client half: a pure mapper over server events, plus collapsePaymentLegs.
 *
 * Which bills and payments belong to a pair, and what each did to the tab, moved to migration
 * 062 and is covered by `supabase/tests/sql/062_person_statement.test.sql`.
 *
 * Since migration 086 the RUNNING BALANCE is computed by the server too: once the statement is
 * paged the client holds only a window of the events, so walking them here would be aggregation
 * over data it does not have (CLAUDE.md rule 8). Each event arrives with `runningNet` and
 * `prevRunning`. The running-sum cases this file used to pin — the signed running total, an
 * overpayment flipping the tab past zero (both directions), a later bill moving a flipped tab back,
 * the independent running balance per currency, the chronological walk and the timestamp tie broken
 * by id — were deleted here and now live in `supabase/tests/sql/086_person_statement_paging.test.sql`
 * (rule 10: a rule that moves into SQL takes its coverage with it).
 *
 * What stays: the mapper keeps the server's running number, derives `balanceDelta` from
 * runningNet - prevRunning and the note from the sign, returns rows ascending whatever the input
 * order, and does not mutate its input; collapsePaymentLegs is unchanged.
 *
 * Hand-made events: `ev()` below builds one kwenta_person_statement_page event as the client
 * mapper hands it over (StatementEvent fields from src/api/balances.ts, plus runningNet and
 * prevRunning as numbers).
 */

const T = {
  t1: '2026-01-01T00:00:00.000Z',
  t2: '2026-01-02T00:00:00.000Z',
  t3: '2026-01-03T00:00:00.000Z',
}

type ServerEvent = MoneyFlowEvent & { runningNet: number; prevRunning: number }

function ev(over: Partial<ServerEvent> & { id: string; delta: number }): ServerEvent {
  return {
    type: 'personal_bill',
    createdAt: T.t1,
    currency: 'PHP',
    groupId: null,
    bundleId: null,
    contextLabel: 'Personal',
    title: 'Bill',
    rawAmount: Math.abs(over.delta),
    runningNet: over.delta,
    prevRunning: 0,
    ...over,
  }
}

describe('buildMoneyFlowRows — server running balance', () => {
  it('keeps the runningNet the server sent instead of walking from zero', () => {
    // A page from the middle of the history: the tab stood at 400 before this bill.
    const { rows } = buildMoneyFlowRows([ev({ id: 'b9', delta: 100, prevRunning: 400, runningNet: 500 })])
    expect(rows).toHaveLength(1)
    expect(rows[0].runningNet).toBe(500)
  })

  it('does not re-derive runningNet from the events it was handed', () => {
    // Two adjacent rows whose server numbers are NOT a walk of these two deltas (a payments-only
    // page: the bills between them still counted on the server).
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'p1', type: 'payment', delta: -50, createdAt: T.t1, prevRunning: 250, runningNet: 200 }),
      ev({ id: 'p2', type: 'payment', delta: -50, createdAt: T.t3, prevRunning: 700, runningNet: 650 }),
    ])
    expect(rows.map((r) => r.runningNet)).toEqual([200, 650])
  })

  it('balanceDelta is runningNet - prevRunning, rounded to cents', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'b1', delta: 0.2, prevRunning: 0.1, runningNet: 0.3 }),
      ev({ id: 'p1', type: 'payment', delta: -200, createdAt: T.t2, prevRunning: 500, runningNet: 300 }),
    ])
    expect(rows[0].explanation.balanceDelta).toBe(0.2)
    expect(rows[1].explanation.balanceDelta).toBe(-200)
  })

  it('a row that flipped the tab past zero reports the full movement as its balanceDelta', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'p1', type: 'payment', delta: -800, prevRunning: 500, runningNet: -300 }),
    ])
    expect(rows[0].runningNet).toBe(-300)
    expect(rows[0].explanation.balanceDelta).toBe(-800)
  })

  it('signedAmount is the event delta rounded to cents', () => {
    const { rows } = buildMoneyFlowRows([ev({ id: 'b1', delta: 0.1 + 0.2, runningNet: 0.3 })])
    expect(rows[0].signedAmount).toBe(0.3)
  })
})

describe('buildMoneyFlowRows — ordering', () => {
  it('a newest-first server page comes out chronological ascending, each row keeping its own number', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'b3', delta: 100, createdAt: T.t3, prevRunning: 300, runningNet: 400 }),
      ev({ id: 'b2', delta: -200, createdAt: T.t2, prevRunning: 500, runningNet: 300 }),
      ev({ id: 'b1', delta: 500, createdAt: T.t1, prevRunning: 0, runningNet: 500 }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['b1', 'b2', 'b3'])
    expect(rows.map((r) => r.runningNet)).toEqual([500, 300, 400])
  })

  it('any input order comes out chronological ascending', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'b2', delta: -200, createdAt: T.t2, prevRunning: 500, runningNet: 300 }),
      ev({ id: 'b3', delta: 100, createdAt: T.t3, prevRunning: 300, runningNet: 400 }),
      ev({ id: 'b1', delta: 500, createdAt: T.t1, prevRunning: 0, runningNet: 500 }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['b1', 'b2', 'b3'])
    expect(rows.map((r) => r.runningNet)).toEqual([500, 300, 400])
  })

  it('a timestamp tie in the server order (newest first: id descending) comes out id ascending', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'zzz', delta: 10, prevRunning: 20, runningNet: 30 }),
      ev({ id: 'aaa', delta: 20, prevRunning: 0, runningNet: 20 }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['aaa', 'zzz'])
    expect(rows.map((r) => r.runningNet)).toEqual([20, 30])
  })
})

describe('buildMoneyFlowRows — real time order', () => {
  it('orders a whole-second timestamp before one with sub-millisecond digits (a string compare puts "." first)', () => {
    // Postgres order: 10:00:00+00:00 < 10:00:00.0001+00:00. localeCompare says the opposite.
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'a', delta: 20, createdAt: '2026-01-01T10:00:00.0001+00:00', prevRunning: 10, runningNet: 30 }),
      ev({ id: 'z', delta: 10, createdAt: '2026-01-01T10:00:00+00:00', prevRunning: 0, runningNet: 10 }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['z', 'a'])
  })

  it('breaks a microsecond difference inside one millisecond by time, not by id', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'a', delta: 20, createdAt: '2026-01-01T10:00:00.123456+00:00', prevRunning: 10, runningNet: 30 }),
      ev({ id: 'z', delta: 10, createdAt: '2026-01-01T10:00:00.123400+00:00', prevRunning: 0, runningNet: 10 }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['z', 'a'])
  })

  it('breaks an exact tie by id in code-point order', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'b', delta: 10, prevRunning: 10, runningNet: 20 }),
      ev({ id: 'B', delta: 10, prevRunning: 0, runningNet: 10 }),
    ])
    expect(rows.map((r) => r.id)).toEqual(['B', 'b'])
  })
})

describe('buildMoneyFlowRows — explanation notes', () => {
  it('describes bills from the viewer’s side', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'b1', delta: 50 }),
      ev({ id: 'b2', delta: -50, createdAt: T.t2, prevRunning: 50, runningNet: 0 }),
    ])
    expect(rows[0].explanation.note).toBe('they_owe_you')
    expect(rows[1].explanation.note).toBe('you_owe_them')
  })

  it('describes payments by who paid', () => {
    const { rows } = buildMoneyFlowRows([
      ev({ id: 'p1', delta: 50, type: 'payment' }),
      ev({ id: 'p2', delta: -50, createdAt: T.t2, type: 'payment', prevRunning: 50, runningNet: 0 }),
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
        createdAt: T.t2,
        currency: 'USD',
        groupId: 'grp',
        bundleId: 'bundle',
        contextLabel: 'Flat',
        title: 'Wifi',
        rawAmount: 30,
        prevRunning: 10,
        runningNet: -20,
      }),
    ])
    expect(rows[0]).toMatchObject({
      id: 'g1',
      type: 'group_bill',
      createdAt: T.t2,
      currency: 'USD',
      groupId: 'grp',
      bundleId: 'bundle',
      contextLabel: 'Flat',
      title: 'Wifi',
      rawAmount: 30,
      signedAmount: -30,
      runningNet: -20,
      explanation: { balanceDelta: -30, note: 'you_owe_them' },
    })
  })

  it('returns no rows for no events', () => {
    const { rows } = buildMoneyFlowRows([])
    expect(rows).toEqual([])
  })

  it('does not mutate the caller’s array', () => {
    const events = [ev({ id: 'b2', delta: 1, createdAt: T.t2 }), ev({ id: 'b1', delta: 1 })]
    const snapshot = JSON.parse(JSON.stringify(events))
    buildMoneyFlowRows(events)
    expect(events.map((e) => e.id)).toEqual(['b2', 'b1'])
    expect(events).toEqual(snapshot)
  })
})

describe('collapsePaymentLegs', () => {
  /** The legs one split payment writes: personal first, then the group leg. */
  const legs = () => [
    ev({
      id: 'leg-personal',
      delta: -1000,
      createdAt: T.t1,
      type: 'payment',
      bundleId: 'bundle-1',
      title: 'Cha paid you',
      prevRunning: 0,
      runningNet: -1000,
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
      prevRunning: -1000,
      runningNet: -4000,
    }),
  ]
  const splitLegs = () => buildMoneyFlowRows(legs()).rows

  it('merges the legs of one bundle into a single row', () => {
    const rows = collapsePaymentLegs(splitLegs())
    expect(rows).toHaveLength(1)
    expect(rows[0].signedAmount).toBe(-4000)
    expect(rows[0].settlementIds).toEqual(['leg-personal', 'leg-group'])
    // The running balance must be the one AFTER the last leg, not a mid-payment figure.
    expect(rows[0].runningNet).toBe(-4000)
  })

  it('merges a bundle handed over newest-first (a server page) the same way', () => {
    const rows = collapsePaymentLegs(buildMoneyFlowRows([...legs()].reverse()).rows)
    expect(rows).toHaveLength(1)
    expect(rows[0].signedAmount).toBe(-4000)
    expect(rows[0].settlementIds).toEqual(['leg-personal', 'leg-group'])
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
      buildMoneyFlowRows([ev({ id: 'p1', delta: -500, type: 'payment', title: 'Cha paid you' })]).rows,
    )
    expect(rows[0].parts).toEqual([{ groupId: null, label: 'Personal', amount: 500 }])
  })

  it('merges two legs in the SAME group into one slice', () => {
    const rows = collapsePaymentLegs(
      buildMoneyFlowRows([
        ev({ id: 'a', delta: -100, createdAt: T.t1, type: 'payment', bundleId: 'b', groupId: 'g1', contextLabel: 'Beach Trip' }),
        ev({ id: 'b', delta: -200, createdAt: T.t2, type: 'payment', bundleId: 'b', groupId: 'g1', contextLabel: 'Beach Trip', prevRunning: -100, runningNet: -300 }),
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
        ev({ id: 'b2', delta: 200, createdAt: T.t2, prevRunning: 100, runningNet: 300 }),
      ]).rows,
    )
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.settlementIds.length === 0)).toBe(true)
  })

  it('does not merge legs of the same bundle separated by another event', () => {
    const rows = collapsePaymentLegs(
      buildMoneyFlowRows([
        ev({ id: 'a', delta: -100, createdAt: T.t1, type: 'payment', bundleId: 'b' }),
        ev({ id: 'mid', delta: 50, createdAt: T.t2, prevRunning: -100, runningNet: -50 }),
        ev({ id: 'c', delta: -200, createdAt: T.t3, type: 'payment', bundleId: 'b', prevRunning: -50, runningNet: -250 }),
      ]).rows,
    )
    expect(rows).toHaveLength(3)
  })

  it('leaves an unbundled payment alone', () => {
    const rows = collapsePaymentLegs(
      buildMoneyFlowRows([
        ev({ id: 'a', delta: -100, createdAt: T.t1, type: 'payment' }),
        ev({ id: 'b', delta: -200, createdAt: T.t2, type: 'payment', prevRunning: -100, runningNet: -300 }),
      ]).rows,
    )
    expect(rows).toHaveLength(2)
  })
})
