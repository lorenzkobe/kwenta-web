import { isConvertedBill, paidInNote } from '@/lib/currency-conversion'

type DetailBill = {
  currency: string
  originalCurrency: string | null
  originalTotal: number | null
  exchangeRate: number | null
}
type DetailItems = { originalAmount: number | null; splits: { originalAmount: number | null }[] }[]

/** `isConvertedBill` over the Bill detail payload (camelCase), the shape the screen, share image and PDF are handed. */
export function isConvertedDetail(bill: Pick<DetailBill, 'originalCurrency'>, items: DetailItems): boolean {
  return isConvertedBill(
    { original_currency: bill.originalCurrency },
    items.map((i) => ({
      original_amount: i.originalAmount,
      splits: i.splits.map((s) => ({ original_amount: s.originalAmount })),
    })),
  )
}

/** "Paid in ₫500,000 · 1 PHP = 405.87 VND (locked)" for a converted Bill detail payload, else null. */
export function detailPaidInNote(bill: DetailBill, items: DetailItems): string | null {
  return isConvertedDetail(bill, items) ? paidInNote(bill) : null
}
