export interface DebtEdge {
  from: string
  to: string
  /** Always > 0. Integer cents that `from` owes `to`. */
  cents: number
}

export interface SettlementLeg {
  fromUserId: string
  toUserId: string
  amount: number
}

export interface SuggestedTransfer {
  /** Physical payer. */
  fromUserId: string
  /** Physical recipient. */
  toUserId: string
  /** Currency units (2 dp). */
  amount: number
  /** Bookkeeping legs; each leg carries `amount` (the path bottleneck). legs.length == hop count. */
  legs: SettlementLeg[]
}

export interface RawPayerGroup {
  fromUserId: string
  total: number
  /** Physical hand-offs (transfer endpoints), one per recipient. */
  recipients: { toUserId: string; amount: number }[]
  /** Merged bookkeeping legs to record (may include intermediary payers). */
  legs: SettlementLeg[]
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * Net all raw directed debts down to one positive edge per member pair.
 * A raw debt `{from, to, amount}` means "from owes to". Opposing debts and
 * settled payments (passed as reverse-direction debts) cancel here.
 */
export function buildDebtGraph(
  rawDebts: { from: string; to: string; amount: number }[],
): DebtEdge[] {
  const pairNet = new Map<string, number>() // key `a|b` (a<b); value = cents a owes b
  for (const d of rawDebts) {
    if (d.from === d.to) continue
    const cents = Math.round(d.amount * 100)
    if (cents === 0) continue
    const [a, b] = d.from < d.to ? [d.from, d.to] : [d.to, d.from]
    const key = `${a}|${b}`
    const signed = d.from === a ? cents : -cents
    pairNet.set(key, (pairNet.get(key) ?? 0) + signed)
  }
  const edges: DebtEdge[] = []
  for (const [key, net] of pairNet) {
    if (net === 0) continue
    const [a, b] = key.split('|')
    edges.push(net > 0 ? { from: a, to: b, cents: net } : { from: b, to: a, cents: -net })
  }
  return edges
}

type Graph = Map<string, Map<string, number>>

function toGraph(edges: DebtEdge[]): Graph {
  const g: Graph = new Map()
  for (const e of edges) {
    if (e.cents <= 0) continue
    const m = g.get(e.from) ?? new Map<string, number>()
    m.set(e.to, (m.get(e.to) ?? 0) + e.cents)
    g.set(e.from, m)
  }
  return g
}

function edgeCents(g: Graph, f: string, t: string): number {
  return g.get(f)?.get(t) ?? 0
}

function subtractEdge(g: Graph, f: string, t: string, c: number) {
  const m = g.get(f)
  if (!m) return
  const left = (m.get(t) ?? 0) - c
  if (left <= 0) {
    m.delete(t)
    if (m.size === 0) g.delete(f)
  } else {
    m.set(t, left)
  }
}

function allNodes(g: Graph): string[] {
  const s = new Set<string>()
  for (const [f, m] of g) {
    s.add(f)
    for (const t of m.keys()) s.add(t)
  }
  return [...s]
}

function nodesWithIncoming(g: Graph): Set<string> {
  const s = new Set<string>()
  for (const m of g.values()) for (const t of m.keys()) s.add(t)
  return s
}

/** Find a directed cycle as an ordered node list (closing edge is last→first), or null. */
function findCycle(g: Graph): string[] | null {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  const stack: string[] = []
  let found: string[] | null = null

  const dfs = (u: string): boolean => {
    color.set(u, GRAY)
    stack.push(u)
    for (const v of g.get(u)?.keys() ?? []) {
      const c = color.get(v) ?? WHITE
      if (c === GRAY) {
        found = stack.slice(stack.indexOf(v))
        return true
      }
      if (c === WHITE && dfs(v)) return true
    }
    color.set(u, BLACK)
    stack.pop()
    return false
  }

  for (const u of allNodes(g)) {
    if ((color.get(u) ?? WHITE) === WHITE && dfs(u)) return found
  }
  return null
}

function cancelCycle(g: Graph, cyc: string[]) {
  let bottleneck = Infinity
  for (let i = 0; i < cyc.length; i++) {
    bottleneck = Math.min(bottleneck, edgeCents(g, cyc[i], cyc[(i + 1) % cyc.length]))
  }
  for (let i = 0; i < cyc.length; i++) {
    subtractEdge(g, cyc[i], cyc[(i + 1) % cyc.length], bottleneck)
  }
}

/**
 * Decompose a pairwise debt graph into the fewest physical transfers, each backed by
 * the real pairwise legs it settles. Cancels cycles first (so the graph becomes a DAG),
 * then extracts source→sink paths. Connectivity-safe: transfers never cross clusters.
 */
export function decomposeDebtGraph(edges: DebtEdge[]): SuggestedTransfer[] {
  const g = toGraph(edges)

  // Phase A: cancel every cycle -> DAG.
  let cyc = findCycle(g)
  while (cyc) {
    cancelCycle(g, cyc)
    cyc = findCycle(g)
  }

  // Phase B: extract source→sink paths from the DAG until no edges remain.
  const transfers: SuggestedTransfer[] = []
  const pickEdge = (): [string, string] | null => {
    for (const [f, m] of g) for (const t of m.keys()) return [f, t]
    return null
  }

  let seed = pickEdge()
  while (seed) {
    const withIn = nodesWithIncoming(g) // stable during this walk (no mutation yet)
    const path: string[] = [seed[0], seed[1]]

    // Walk backward to a true source (no incoming edge).
    let head = seed[0]
    while (withIn.has(head)) {
      let pred: string | null = null
      for (const [f, m] of g) {
        if (m.has(head)) {
          pred = f
          break
        }
      }
      if (pred === null) break
      path.unshift(pred)
      head = pred
    }

    // Walk forward to a sink (no outgoing edge).
    let tail = seed[1]
    while ((g.get(tail)?.size ?? 0) > 0) {
      const next = g.get(tail)!.keys().next().value as string
      path.push(next)
      tail = next
    }

    let bottleneck = Infinity
    for (let i = 0; i < path.length - 1; i++) {
      bottleneck = Math.min(bottleneck, edgeCents(g, path[i], path[i + 1]))
    }
    const legs: SettlementLeg[] = []
    for (let i = 0; i < path.length - 1; i++) {
      legs.push({ fromUserId: path[i], toUserId: path[i + 1], amount: bottleneck / 100 })
      subtractEdge(g, path[i], path[i + 1], bottleneck)
    }
    transfers.push({
      fromUserId: path[0],
      toUserId: path[path.length - 1],
      amount: bottleneck / 100,
      legs,
    })
    seed = pickEdge()
  }

  return transfers
}

/** Group transfers by physical payer; merge duplicate recipients and legs by pair. */
export function groupTransfersByPayer(transfers: SuggestedTransfer[]): RawPayerGroup[] {
  const byPayer = new Map<string, RawPayerGroup>()
  for (const t of transfers) {
    const group =
      byPayer.get(t.fromUserId) ??
      ({ fromUserId: t.fromUserId, total: 0, recipients: [], legs: [] } as RawPayerGroup)

    const recipient = group.recipients.find((r) => r.toUserId === t.toUserId)
    if (recipient) recipient.amount = round2(recipient.amount + t.amount)
    else group.recipients.push({ toUserId: t.toUserId, amount: t.amount })
    group.total = round2(group.total + t.amount)

    for (const leg of t.legs) {
      const existing = group.legs.find(
        (l) => l.fromUserId === leg.fromUserId && l.toUserId === leg.toUserId,
      )
      if (existing) existing.amount = round2(existing.amount + leg.amount)
      else group.legs.push({ ...leg })
    }
    byPayer.set(t.fromUserId, group)
  }
  return [...byPayer.values()]
}

/**
 * The whole suggestion pipeline: a directed debt graph in, named payer groups out.
 *
 * Kept here rather than inline in the page because it is the composition that matters — the
 * middleman-cutting behaviour only appears once build → decompose → group run together, and a
 * page component is not somewhere that can be tested.
 *
 * `nameOf` is injected because names live behind the pull-bundle privacy boundary: on the server
 * they come from the group roster, and only the caller knows which resolver applies.
 */
export function buildSuggestedPayers(
  rawDebts: { from: string; to: string; amount: number }[],
  nameOf: (userId: string) => string,
): {
  fromUserId: string
  fromName: string
  total: number
  recipients: { toUserId: string; toName: string; amount: number }[]
  legs: SettlementLeg[]
}[] {
  return groupTransfersByPayer(decomposeDebtGraph(buildDebtGraph(rawDebts)))
    .map((g) => ({
      fromUserId: g.fromUserId,
      fromName: nameOf(g.fromUserId),
      total: g.total,
      recipients: g.recipients.map((r) => ({
        toUserId: r.toUserId,
        toName: nameOf(r.toUserId),
        amount: r.amount,
      })),
      legs: g.legs,
    }))
    .sort((a, b) => a.fromName.localeCompare(b.fromName))
}
