import { describe, expect, it } from 'vitest'
import {
  buildDebtGraph,
  buildSuggestedPayers,
  coveredByOtherSettleUps,
  decomposeDebtGraph,
  groupTransfersByPayer,
  joinNames,
  suggestionPartyName,
  type SuggestedTransfer,
} from '@/lib/settlement-suggestions'
import type { SuggestedPayerGroup } from '@/lib/settlement'

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

describe('buildSuggestedPayers', () => {
  // Ported from the computeGroupSuggestions coverage when that function was deleted (its data
  // gathering moved to migration 061). The middleman-cutting behaviour only exists once build →
  // decompose → group run together, so it has to be tested on the composition, not the parts.
  it('cuts the middleman and backs each transfer with real pairwise legs', () => {
    // Ana owes Carlo 200 (Carlo paid), Carlo owes John 100 (John paid).
    const payers = buildSuggestedPayers(
      [
        { from: 'Ana', to: 'Carlo', amount: 200 },
        { from: 'Carlo', to: 'John', amount: 100 },
      ],
      (id) => id,
    )

    expect(payers).toHaveLength(1)
    const ana = payers[0]
    expect(ana.fromUserId).toBe('Ana')
    expect(ana.total).toBe(200)
    // Ana pays John directly for the 100 that would otherwise route through Carlo.
    expect(ana.recipients.map((r) => `${r.toName}:${r.amount}`).sort()).toEqual([
      'Carlo:100',
      'John:100',
    ])
    // The legs still trace the real debts, so the recorded settlements stay truthful.
    expect(ana.legs).toEqual([
      { fromUserId: 'Ana', toUserId: 'Carlo', amount: 200 },
      { fromUserId: 'Carlo', toUserId: 'John', amount: 100 },
    ])
  })

  it('returns no payers when nothing is owed', () => {
    expect(buildSuggestedPayers([], (id) => id)).toEqual([])
  })

  it('resolves names through the injected resolver, and sorts by it', () => {
    const names: Record<string, string> = { u1: 'Zoe', u2: 'Adam', u3: 'Mia' }
    const payers = buildSuggestedPayers(
      [
        { from: 'u1', to: 'u3', amount: 10 },
        { from: 'u2', to: 'u3', amount: 10 },
      ],
      (id) => names[id] ?? 'Unknown',
    )
    expect(payers.map((p) => p.fromName)).toEqual(['Adam', 'Zoe'])
    expect(payers[0].recipients[0].toName).toBe('Mia')
  })

  it('falls back to Unknown rather than rendering a raw uuid', () => {
    const payers = buildSuggestedPayers([{ from: 'ghost', to: 'u1', amount: 5 }], () => 'Unknown')
    expect(payers[0].fromName).toBe('Unknown')
  })
})

function payer(
  from: string,
  legs: [string, string, number][],
): SuggestedPayerGroup {
  return {
    fromUserId: from,
    fromName: from,
    total: 0,
    recipients: [],
    legs: legs.map(([f, t, amount]) => ({ fromUserId: f, toUserId: t, amount })),
  }
}

describe('coveredByOtherSettleUps', () => {
  // Nek, Rince and Levi owe Vince; the suggestions route that money straight to the viewer, so
  // their settle-ups (not Vince's) record the Vince -> Me legs for it.
  it('attributes a member\'s leg to the viewer to the other payers that carry it', () => {
    const covered = coveredByOtherSettleUps(
      [
        payer('Levi', [['Levi', 'Vince', 300], ['Vince', 'Me', 300]]),
        payer('Nek', [['Nek', 'Vince', 600], ['Vince', 'Me', 600]]),
        payer('Rince', [['Rince', 'Vince', 444.1], ['Vince', 'Me', 444.1]]),
        payer('Vince', [['Vince', 'Me', 14984.05]]),
      ],
      'Me',
    )
    expect(covered.get('Vince')).toEqual({ amount: 1344.1, payerNames: ['Levi', 'Nek', 'Rince'] })
  })

  it('never counts the member\'s own settle-up or the viewer\'s', () => {
    const covered = coveredByOtherSettleUps(
      [
        payer('Vince', [['Vince', 'Me', 100]]),
        payer('Me', [['Me', 'Ana', 50], ['Ana', 'Vince', 50]]),
      ],
      'Me',
    )
    expect(covered.has('Vince')).toBe(false)
    expect(covered.has('Ana')).toBe(false)
  })

  it('signs a viewer -> member leg carried by a third payer as negative', () => {
    const covered = coveredByOtherSettleUps(
      [payer('Bo', [['Bo', 'Me', 40], ['Me', 'Cy', 40]])],
      'Me',
    )
    expect(covered.get('Cy')).toEqual({ amount: -40, payerNames: ['Bo'] })
    // Bo is the payer of those legs, so Bo's own leg is not "covered by someone else".
    expect(covered.has('Bo')).toBe(false)
  })

  it('leaves out a member whose carried legs net to zero', () => {
    const covered = coveredByOtherSettleUps(
      [
        payer('Bo', [['Bo', 'Vi', 10], ['Vi', 'Me', 10]]),
        payer('Cy', [['Cy', 'Me', 10], ['Me', 'Vi', 10]]),
      ],
      'Me',
    )
    expect(covered.has('Vi')).toBe(false)
  })

  it('returns an empty map when nobody pays', () => {
    expect(coveredByOtherSettleUps([], 'Me').size).toBe(0)
  })

  // A cycle through the viewer is cancelled before any path is extracted, so that part of the
  // pairwise balance rides on nobody's legs. The helper reports only what legs carry; the page
  // phrases it as "of this", never as the whole remainder.
  it('reports only the carried amount when a cycle through the viewer was cancelled', () => {
    const payers = buildSuggestedPayers(
      [
        { from: 'Vi', to: 'Me', amount: 100 },
        { from: 'Me', to: 'Ro', amount: 30 },
        { from: 'Ro', to: 'Vi', amount: 30 },
      ],
      (id) => id,
    )
    const covered = coveredByOtherSettleUps(payers, 'Me')
    expect(covered.has('Vi')).toBe(false)
    const own = payers.find((p) => p.fromUserId === 'Vi')!
    const ownToMe = own.legs
      .filter((l) => l.fromUserId === 'Vi' && l.toUserId === 'Me')
      .reduce((s, l) => s + l.amount, 0)
    expect(ownToMe).toBe(70)
  })

  // The Manila Sept pair nets from the live database, 2026-09-25 (viewer = Kobz). Kobz has no
  // outgoing edge, so no cycle runs through the viewer and Vince's own leg plus what other
  // settle-ups carry must add up to his whole pairwise balance.
  it('adds up to the member\'s pairwise balance on the Manila Sept numbers', () => {
    const payers = buildSuggestedPayers(
      [
        { from: 'Eman', to: 'Kobz', amount: 3636.91 },
        { from: 'Levi', to: 'Kobz', amount: 5677.4 },
        { from: 'Rince', to: 'Kobz', amount: 18492.4 },
        { from: 'Yumi', to: 'Kobz', amount: 6176.37 },
        { from: 'Longlong', to: 'Kobz', amount: 1535.82 },
        { from: 'Nek', to: 'Kobz', amount: 15755.07 },
        { from: 'Nek', to: 'Rince', amount: 481.4 },
        { from: 'Nek', to: 'Vince', amount: 600 },
        { from: 'Vince', to: 'Kobz', amount: 16328.15 },
        { from: 'Levi', to: 'Vince', amount: 300 },
        { from: 'Rince', to: 'Vince', amount: 444.1 },
        { from: 'Vince', to: 'Yumi', amount: 210 },
      ],
      (id) => id,
    )
    const covered = coveredByOtherSettleUps(payers, 'Kobz').get('Vince')
    const vince = payers.find((p) => p.fromUserId === 'Vince')!
    const ownToKobz = vince.legs
      .filter((l) => l.fromUserId === 'Vince' && l.toUserId === 'Kobz')
      .reduce((s, l) => s + Math.round(l.amount * 100), 0)
    // How much of Nek/Rince/Levi's 1344.10 is routed on to Kobz (rather than to Yumi via Vince)
    // depends on edge order, so the covered amount itself is not pinned here. What does not
    // depend on routing: Vince's own payments total his net against the group (16328.15 + 210
    // owed, 1344.10 owed to him), others' settle-ups do carry part of his balance, and the two
    // parts add up to the pairwise figure on his row.
    expect(vince.total).toBe(15194.05)
    expect(covered).toBeDefined()
    expect(covered!.amount).toBeGreaterThan(0)
    for (const name of covered!.payerNames) expect(['Nek', 'Rince', 'Levi']).toContain(name)
    expect(ownToKobz + Math.round(covered!.amount * 100)).toBe(1632815)
  })
})

describe('suggestionPartyName', () => {
  it('names the payer, recipients and a middle person, and never returns an id', () => {
    const p: SuggestedPayerGroup = {
      fromUserId: 'v',
      fromName: 'Vince',
      total: 210,
      recipients: [{ toUserId: 'k', toName: 'Kobz', amount: 210 }],
      legs: [
        { fromUserId: 'v', toUserId: 'y', amount: 210 },
        { fromUserId: 'y', toUserId: 'k', amount: 210 },
      ],
    }
    const nameOf = suggestionPartyName(p, new Map([['y', 'Yumi']]))
    expect(nameOf('v')).toBe('Vince')
    expect(nameOf('k')).toBe('Kobz')
    expect(nameOf('y')).toBe('Yumi')
    expect(nameOf('ghost')).toBe('Someone')
  })
})

describe('joinNames', () => {
  it('joins with commas and an ampersand, and caps a long list', () => {
    expect(joinNames([])).toBe('')
    expect(joinNames(['Nek'])).toBe('Nek')
    expect(joinNames(['Nek', 'Levi'])).toBe('Nek & Levi')
    expect(joinNames(['Nek', 'Levi', 'Rince'])).toBe('Nek, Levi & Rince')
    expect(joinNames(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C & 2 more')
  })
})
