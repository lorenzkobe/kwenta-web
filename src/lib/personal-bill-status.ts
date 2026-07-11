import { db } from '@/db/db'
import { computePairwiseNetAllContexts, participantUnionForBill } from '@/lib/people'
import { isEffectivelyZero } from '@/lib/utils'

/**
 * True when you're square with every other participant on this bill. Status is derived from
 * the person-level tab (combined personal + group), NOT from bill-tagged payments — so a
 * payment that clears your balance with someone settles all their bills at once, and a bill
 * never shows "unpaid" once you're actually even.
 *
 * Pass a shared `tabCache` when checking many bills (e.g. the bills list) to compute each
 * distinct counterparty's tab once instead of per bill.
 */
export async function isPersonalBillFullySettled(
  billId: string,
  currentUserId: string,
  tabCache?: Map<string, Map<string, number>>,
): Promise<boolean> {
  const bill = await db.bills.get(billId)
  if (!bill || bill.is_deleted) return true
  const union = await participantUnionForBill(billId)
  const others = [...union].filter((id) => id !== currentUserId)
  for (const oid of others) {
    let net = tabCache?.get(oid)
    if (!net) {
      net = await computePairwiseNetAllContexts(currentUserId, oid)
      tabCache?.set(oid, net)
    }
    // Scope to THIS bill's currency only. The tab spans every currency; an unrelated open
    // balance in another currency must not mark a bill that's settled in its own currency
    // as unpaid (the old per-bill check was single-currency).
    if (!isEffectivelyZero(net.get(bill.currency) ?? 0)) return false
  }
  return true
}
