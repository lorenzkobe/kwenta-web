import { type SettlementLeg } from '@/lib/settlement-suggestions'

/**
 * Group settlement view models, and the one transform that still belongs on this side of the line.
 *
 * Every balance this module used to compute now comes from SQL (migrations 053, 061, 064): a
 * money rule has exactly one implementation, and aggregation over unbounded data is the server's
 * (CLAUDE.md rule 8). What remains is `buildMovementChains` — a pure transform of ONE payment's
 * legs, which is bounded input and keeps its Vitest coverage — plus the shapes the group screen
 * assembles from the server payload.
 */

export interface BalanceEntry {
  userId: string
  displayName: string
  /** Net in group: positive = should receive, negative = should pay */
  amount: number
}

/** One hop in a settle-up's money movement (a single recorded settlement row). */
export interface SettlementMovementLeg {
  fromUserId: string
  fromName: string
  toUserId: string
  toName: string
  amount: number
}

export interface MovementChainStep {
  userId: string
  name: string
}

/** A single end-to-end money path (e.g. You → Cha → Yumi) and the amount that flowed along it. */
export interface MovementChain {
  steps: MovementChainStep[]
  amount: number
}

/**
 * Reconstruct readable money paths from a bundle's bookkeeping legs.
 *
 * A settle-up stores pairwise legs (e.g. You→Cha, Cha→Yumi) that reduce the
 * underlying debts, but on their own they read as nonsense ("why is Cha paying
 * Yumi inside *my* payment?"). This decomposes the legs into the flows that
 * produced them — each maximal path from a source (a node that only pays) to a
 * sink (a node that only receives) — so the UI can show "You → Cha → Yumi".
 *
 * Pure + integer-cents internally to avoid float drift. Any leftover from an
 * unexpected cycle is emitted as its own single-hop chain so nothing is dropped.
 */
export function buildMovementChains(legs: SettlementMovementLeg[]): MovementChain[] {
  if (legs.length === 0) return []

  const nameOf = new Map<string, string>()
  for (const l of legs) {
    nameOf.set(l.fromUserId, l.fromName)
    nameOf.set(l.toUserId, l.toName)
  }
  const name = (id: string) => nameOf.get(id) ?? 'Someone'

  const edges = legs.map((l) => ({ from: l.fromUserId, to: l.toUserId }))
  const remaining = legs.map((l) => Math.round(l.amount * 100))
  const outIdx = new Map<string, number[]>()
  const indeg = new Map<string, number>()
  edges.forEach((e, i) => {
    if (!outIdx.has(e.from)) outIdx.set(e.from, [])
    outIdx.get(e.from)!.push(i)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
    if (!indeg.has(e.from)) indeg.set(e.from, indeg.get(e.from) ?? 0)
  })

  const pickOut = (node: string): number => {
    for (const i of outIdx.get(node) ?? []) if (remaining[i] > 0) return i
    return -1
  }

  // Sources only pay (never receive). If a cycle leaves none, fall back to every
  // distinct payer so the loop below still drains the edges.
  const fromNodes = [...new Set(edges.map((e) => e.from))]
  const roots = fromNodes.filter((f) => (indeg.get(f) ?? 0) === 0)
  const starts = roots.length ? roots : fromNodes

  const chains: MovementChain[] = []
  const maxIter = edges.length * 4 + 8
  let guard = 0
  for (const root of starts) {
    while (pickOut(root) !== -1 && guard++ < maxIter) {
      const path: number[] = []
      let node = root
      for (let i = pickOut(node); i !== -1; i = pickOut(node)) {
        path.push(i)
        node = edges[i].to
      }
      const bottleneck = Math.min(...path.map((i) => remaining[i]))
      for (const i of path) remaining[i] -= bottleneck
      const steps: MovementChainStep[] = [
        { userId: edges[path[0]].from, name: name(edges[path[0]].from) },
      ]
      for (const i of path) steps.push({ userId: edges[i].to, name: name(edges[i].to) })
      chains.push({ steps, amount: bottleneck / 100 })
    }
  }
  // Emit any residual (cycle) edges so no money silently disappears.
  edges.forEach((e, i) => {
    if (remaining[i] > 0) {
      chains.push({
        steps: [
          { userId: e.from, name: name(e.from) },
          { userId: e.to, name: name(e.to) },
        ],
        amount: remaining[i] / 100,
      })
      remaining[i] = 0
    }
  })
  return chains
}

export interface GroupBalanceSummary {
  groupId: string
  groupName: string
  currency: string
  balances: BalanceEntry[]
  /** Positive net for you in this group: amount you should receive */
  totalToReceive: number
  /** Magnitude of negative net for you in this group: amount you should pay */
  totalToPay: number
}

export interface GroupPairwiseEntry {
  /** The other member's canonical roster user id */
  memberUserId: string
  displayName: string
  /** Net from the viewer's perspective: positive = they owe you, negative = you owe them */
  net: number
}

export interface GroupPairwiseSummary {
  groupId: string
  groupName: string
  currency: string
  /** One entry per other member (and any non-member id still present in rows). Excludes the viewer. */
  entries: GroupPairwiseEntry[]
  /** Sum of positive nets: total others owe you in this group */
  totalToReceive: number
  /** Sum of |negative nets|: total you owe others in this group */
  totalToPay: number
}

export interface SuggestedPayerGroup {
  fromUserId: string
  fromName: string
  total: number
  recipients: { toUserId: string; toName: string; amount: number }[]
  legs: SettlementLeg[]
}

export interface GroupSuggestionsSummary {
  groupId: string
  groupName: string
  currency: string
  /** One entry per physical payer; empty when the group is settled. */
  payers: SuggestedPayerGroup[]
}
