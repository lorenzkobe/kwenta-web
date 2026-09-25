import { describe, expect, it } from 'vitest'
import {
  buildGroupShareRows,
  buildPeerShareRows,
  describeGroupShareRow,
  groupPoolAmount,
  selectionShareState,
} from '@/lib/balance-share'
import { buildSuggestedPayers } from '@/lib/settlement-suggestions'
import { formatCurrency } from '@/lib/utils'

/**
 * The multi-select balance image. Everything here filters and phrases numbers the server already
 * computed (pool balances) or the page already derived (`buildSuggestedPayers`); no money rule
 * lives in this module, so the tests drive it through the real suggestion pipeline.
 */

const NAMES: Record<string, string> = { a: 'Ana', b: 'Ben', c: 'Cha', d: 'Dan' }
const nameOf = (id: string) => NAMES[id] ?? 'Unknown'
const members = ['a', 'b', 'c', 'd'].map((userId) => ({ userId, name: nameOf(userId) }))
const php = (n: number) => formatCurrency(n, 'PHP')

function group(
  rawDebts: { from: string; to: string; amount: number }[],
  pool: Record<string, number>,
) {
  return {
    members,
    memberBalances: Object.entries(pool).map(([userId, amount]) => ({
      userId,
      displayName: nameOf(userId),
      amount,
    })),
    payers: buildSuggestedPayers(rawDebts, nameOf),
  }
}

describe('buildGroupShareRows', () => {
  // a owes b 200 and c 100; d is square.
  const simple = group(
    [
      { from: 'a', to: 'b', amount: 200 },
      { from: 'a', to: 'c', amount: 100 },
    ],
    { a: -300, b: 200, c: 100, d: 0 },
  )

  it('returns only the selected members, in roster order', () => {
    const rows = buildGroupShareRows({ ...simple, selectedIds: new Set(['c', 'a']) })
    expect(rows.map((r) => r.userId)).toEqual(['a', 'c'])
  })

  it('returns nothing for an empty selection', () => {
    expect(buildGroupShareRows({ ...simple, selectedIds: new Set() })).toEqual([])
  })

  it('lists what a payer pays, summing to their pool balance', () => {
    const [ana] = buildGroupShareRows({ ...simple, selectedIds: new Set(['a']) })
    expect(ana.poolAmount).toBe(-300)
    expect(ana.receives).toEqual([])
    expect(ana.pays.map((p) => [p.toName, p.amount])).toEqual([
      ['Ben', 200],
      ['Cha', 100],
    ])
    expect(ana.pays.reduce((s, p) => s + p.amount, 0)).toBe(300)
    expect(ana.pays.every((p) => p.via.length === 0)).toBe(true)
  })

  it('gathers what a receiver gets from several payers', () => {
    const g = group(
      [
        { from: 'a', to: 'b', amount: 200 },
        { from: 'c', to: 'b', amount: 300 },
      ],
      { a: -200, b: 500, c: -300, d: 0 },
    )
    const [ben] = buildGroupShareRows({ ...g, selectedIds: new Set(['b']) })
    expect(ben.pays).toEqual([])
    expect(ben.receives.map((r) => [r.fromName, r.amount])).toEqual([
      ['Ana', 200],
      ['Cha', 300],
    ])
  })

  it('explains a transfer that skips a middle person with its path', () => {
    // a owes b 100, b owes c 100: b nets to zero, so the suggestion is a pays c directly.
    const g = group(
      [
        { from: 'a', to: 'b', amount: 100 },
        { from: 'b', to: 'c', amount: 100 },
      ],
      { a: -100, b: 0, c: 100, d: 0 },
    )
    const [ana] = buildGroupShareRows({ ...g, selectedIds: new Set(['a']) })
    expect(ana.pays).toHaveLength(1)
    expect(ana.pays[0].toName).toBe('Cha')
    expect(ana.pays[0].amount).toBe(100)
    expect(ana.pays[0].via).toEqual([{ names: ['Ana', 'Ben', 'Cha'], amount: 100 }])
  })

  it('gives a settled member no transfers', () => {
    const [dan] = buildGroupShareRows({ ...simple, selectedIds: new Set(['d']) })
    expect(dan.poolAmount).toBe(0)
    expect(dan.pays).toEqual([])
    expect(dan.receives).toEqual([])
  })

  it('treats a sub-cent pool balance as settled', () => {
    const g = group([], { a: 0.004, b: -0.004, c: 0, d: 0 })
    const [ana] = buildGroupShareRows({ ...g, selectedIds: new Set(['a']) })
    expect(ana.poolAmount).toBe(0)
  })

  it('drops a selected id that is no longer on the roster or has no pool balance', () => {
    const noD = { ...simple, memberBalances: simple.memberBalances.filter((m) => m.userId !== 'd') }
    const rows = buildGroupShareRows({ ...noD, selectedIds: new Set(['d', 'ghost', 'a']) })
    expect(rows.map((r) => r.userId)).toEqual(['a'])
  })

  it('builds a 30-member group in one pass without touching the network', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `m${String(i).padStart(2, '0')}`)
    const rawDebts = ids.slice(1).map((id) => ({ from: id, to: ids[0], amount: 10 }))
    const pool = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 290 : -10]))
    const rows = buildGroupShareRows({
      members: ids.map((userId) => ({ userId, name: userId })),
      memberBalances: Object.entries(pool).map(([userId, amount]) => ({
        userId,
        displayName: userId,
        amount,
      })),
      payers: buildSuggestedPayers(rawDebts, (id) => id),
      selectedIds: new Set(ids),
    })
    expect(rows).toHaveLength(30)
    expect(rows[0].receives).toHaveLength(29)
  })
})

describe('describeGroupShareRow', () => {
  it('gives a payer the reason, not a second copy of the transfers', () => {
    const g = group(
      [
        { from: 'a', to: 'b', amount: 200 },
        { from: 'a', to: 'c', amount: 100 },
      ],
      { a: -300, b: 200, c: 100, d: 0 },
    )
    const [ana] = buildGroupShareRows({ ...g, selectedIds: new Set(['a']) })
    expect(describeGroupShareRow(ana, 'PHP')).toEqual([
      `Ana is down ${php(300)} in the group, so that is what Ana pays`,
    ])
  })

  it('gives a receiver the reason', () => {
    const g = group(
      [
        { from: 'a', to: 'b', amount: 200 },
        { from: 'c', to: 'b', amount: 300 },
      ],
      { a: -200, b: 500, c: -300, d: 0 },
    )
    const [ben] = buildGroupShareRows({ ...g, selectedIds: new Set(['b']) })
    expect(describeGroupShareRow(ben, 'PHP')).toEqual([
      `Ben is up ${php(500)} in the group, so that is what Ben gets back`,
    ])
  })

  it('adds a path line when a transfer skips a middle person', () => {
    const g = group(
      [
        { from: 'a', to: 'b', amount: 100 },
        { from: 'b', to: 'c', amount: 100 },
      ],
      { a: -100, b: 0, c: 100, d: 0 },
    )
    const [ana] = buildGroupShareRows({ ...g, selectedIds: new Set(['a']) })
    expect(describeGroupShareRow(ana, 'PHP')).toEqual([
      `Ana is down ${php(100)} in the group, so that is what Ana pays`,
      `${php(100)} of it goes Ana → Ben → Cha`,
    ])
  })

  it('says nothing for a settled member', () => {
    const g = group([], { a: 0, b: 0, c: 0, d: 0 })
    const [ana] = buildGroupShareRows({ ...g, selectedIds: new Set(['a']) })
    expect(describeGroupShareRow(ana, 'PHP')).toEqual([])
  })
})

describe('buildPeerShareRows', () => {
  const rows = [
    { peerId: 'p1', displayName: 'Ana', net: { PHP: 250, USD: -10 }, staged: false },
    { peerId: 'p2', displayName: 'Ben', net: { PHP: 0.001 }, staged: false },
    { peerId: 'p3', displayName: 'Cha', net: {}, staged: true },
    { peerId: 'p4', displayName: 'Dan', net: { PHP: -40 }, staged: false },
  ]

  it('phrases each currency from the viewer side, in currency order', () => {
    const [ana] = buildPeerShareRows(rows, new Set(['p1']))
    expect(ana.settled).toBe(false)
    expect(ana.lines).toEqual([
      { currency: 'PHP', amount: 250, text: `Owes you ${php(250)}` },
      { currency: 'USD', amount: -10, text: `You owe ${formatCurrency(10, 'USD')}` },
    ])
  })

  it('reads an effectively-zero balance as settled', () => {
    const [ben] = buildPeerShareRows(rows, new Set(['p2']))
    expect(ben.settled).toBe(true)
    expect(ben.lines).toEqual([])
  })

  it('never includes a contact that has not synced yet', () => {
    expect(buildPeerShareRows(rows, new Set(['p3', 'p4'])).map((r) => r.peerId)).toEqual(['p4'])
  })

  it('keeps list order and ignores ids that are not in the given rows', () => {
    const visible = rows.filter((r) => r.peerId !== 'p1')
    expect(buildPeerShareRows(visible, new Set(['p4', 'p1', 'p2'])).map((r) => r.peerId)).toEqual([
      'p2',
      'p4',
    ])
  })
})

describe('groupPoolAmount', () => {
  it('is the number the image shows, so the select-mode list shows the same one', () => {
    const g = group([], { a: -16836.469, b: 0.004, c: 0, d: 0 })
    const rows = buildGroupShareRows({ ...g, selectedIds: new Set(['a', 'b']) })
    expect(rows.map((r) => r.poolAmount)).toEqual([groupPoolAmount(-16836.469), groupPoolAmount(0.004)])
    expect(groupPoolAmount(-16836.469)).toBe(-16836.47)
    expect(groupPoolAmount(0.004)).toBe(0)
  })

  it('is null for a member the server did not report, never a fabricated zero', () => {
    expect(groupPoolAmount(undefined)).toBeNull()
  })
})

describe('selectionShareState', () => {
  it('cannot share an empty selection', () => {
    expect(selectionShareState(0, false)).toEqual({ disabled: true, label: 'Share image' })
  })

  it('cannot share while the numbers are revalidating', () => {
    expect(selectionShareState(3, true)).toEqual({ disabled: true, label: 'Updating…' })
  })

  it('shares a settled answer', () => {
    expect(selectionShareState(3, false)).toEqual({ disabled: false, label: 'Share image' })
  })
})
