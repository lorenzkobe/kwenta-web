import type { GroupBalanceSummary } from '@/lib/settlement'

export function mergeCurrencyTotals(
  a: Map<string, number>,
  b: Map<string, number>,
): Map<string, number> {
  const out = new Map(a)
  for (const [cur, v] of b) {
    out.set(cur, (out.get(cur) ?? 0) + v)
  }
  return out
}

/** Roll up per-currency group to-receive / to-pay from group balance summaries (matches Balances page). */
export function groupReceivePayMapsFromSummaries(summaries: GroupBalanceSummary[]): {
  groupReceive: Map<string, number>
  groupPay: Map<string, number>
} {
  const groupReceive = new Map<string, number>()
  const groupPay = new Map<string, number>()
  for (const s of summaries) {
    if (s.totalToReceive > 0) {
      groupReceive.set(s.currency, (groupReceive.get(s.currency) ?? 0) + s.totalToReceive)
    }
    if (s.totalToPay > 0) {
      groupPay.set(s.currency, (groupPay.get(s.currency) ?? 0) + s.totalToPay)
    }
  }
  return { groupReceive, groupPay }
}
