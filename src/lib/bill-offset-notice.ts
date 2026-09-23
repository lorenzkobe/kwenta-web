import { toast } from 'sonner'
import { fetchPersonSummary } from '@/api/balances'
import { formatCurrency } from '@/lib/utils'

/**
 * After saving a personal bill someone else paid, tell the user where that leaves them with the
 * payer ("offset" / "now even").
 *
 * Returns `void`, not a Promise, on purpose: the bill is already confirmed, and the save used to
 * await this extra round trip before navigating, so the button looked frozen. A caller cannot
 * wait on it by mistake.
 */
export function announceBillOffset(input: {
  userId: string
  payerId: string | null | undefined
  payerName: string
  currency: string
}): void {
  const { userId, payerId, payerName, currency } = input
  if (!payerId || payerId === userId) return
  void (async () => {
    try {
      const { data: summary, fromCache } = await fetchPersonSummary(userId, payerId)
      // A cached answer predates the bill that was just written, so it would state a balance that
      // is knowably wrong. This toast is a courtesy, not a screen: saying nothing is the right
      // degradation.
      if (fromCache) return
      const net = summary.total[currency] ?? 0
      if (net > 0.005) {
        toast.info(
          `This bill is offset — ${payerName} still owes you ${formatCurrency(net, currency)} overall`,
        )
      } else if (Math.abs(net) <= 0.005) {
        toast.info(`This bill cancels out — you and ${payerName} are now even`)
      }
    } catch {
      // non-critical
    }
  })()
}
