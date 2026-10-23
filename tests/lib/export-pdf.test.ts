import { describe, expect, it } from 'vitest'
import { paidInSubtitle } from '@/lib/export-pdf'
import type { BillDetail } from '@/api/balances'

/**
 * The subtitle generateBillDetailPDF prints under the title. It is built by `paidInSubtitle`, so
 * the PDF's wording is pinned here without driving jsPDF. The amount uses the "VND 500,000" code
 * form because the PDF font has no glyph for symbols like the dong sign.
 */

function detail(over: Partial<BillDetail['bill']> = {}, itemOriginal: number | null = 500000): BillDetail {
  return {
    bill: {
      currency: 'PHP',
      originalCurrency: 'VND',
      originalTotal: 500000,
      exchangeRate: 1 / 405.868219,
      ...over,
    },
    items: [
      {
        id: 'i1',
        name: 'Dinner',
        amount: 1231.93,
        originalAmount: itemOriginal,
        splits: [{ id: 's1', originalAmount: itemOriginal === null ? null : 500000 }],
      },
    ],
  } as unknown as BillDetail
}

describe('paidInSubtitle', () => {
  it('C19: names the paid-in total and the locked rate of a converted bill', () => {
    expect(paidInSubtitle(detail())).toBe(' · Paid in VND 500,000.00 · 1 PHP = 405.87 VND (locked)')
  })

  it('C19: is empty for a plain bill', () => {
    expect(paidInSubtitle(detail({ originalCurrency: null, originalTotal: null, exchangeRate: null }, null))).toBe('')
  })

  it('C19: is empty when an item lost its original amount, or the rate or code is unusable', () => {
    expect(paidInSubtitle(detail({}, null))).toBe('')
    expect(paidInSubtitle(detail({ exchangeRate: 0 }))).toBe('')
    expect(paidInSubtitle(detail({ originalCurrency: 'vnd' }))).toBe('')
  })
})
