import { db } from '@/db/db'
import { computePairwiseNetForBill, participantUnionForBill } from '@/lib/people'

/** True when all bill-attributed pairwise nets vs other participants are ~zero (nothing left to settle on this bill). */
export async function isPersonalBillFullySettled(
  billId: string,
  currentUserId: string,
): Promise<boolean> {
  const bill = await db.bills.get(billId)
  if (!bill || bill.is_deleted) return true
  const union = await participantUnionForBill(billId)
  const others = [...union].filter((id) => id !== currentUserId)
  for (const oid of others) {
    const net = await computePairwiseNetForBill(billId, currentUserId, oid)
    if (Math.abs(net) > 0.02) return false
  }
  return true
}
