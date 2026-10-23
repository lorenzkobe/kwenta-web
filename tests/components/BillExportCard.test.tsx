import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { BillExportCard } from '@/components/export/BillExportCard'

/**
 * The share image is what leaves the app, so a converted bill must say what was paid and at which
 * locked rate, and a plain bill (or one whose conversion record is incomplete) must say nothing.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

const split = (id: string, computedAmount: number, originalAmount: number | null) => ({
  id,
  displayName: id,
  computedAmount,
  originalAmount,
})

function billFor(over: Record<string, unknown> = {}, itemOriginal: number | null = 500000, splitOriginal = 250000 as number | null) {
  return {
    title: 'Hanoi dinner',
    note: '',
    currency: 'PHP',
    totalAmount: 1231.93,
    createdAt: '2026-10-01T00:00:00.000Z',
    payorName: 'Ana',
    originalCurrency: 'VND' as string | null,
    originalTotal: 500000 as number | null,
    exchangeRate: (1 / 405.868219) as number | null,
    items: [
      {
        id: 'i1',
        name: 'Dinner',
        amount: 1231.93,
        originalAmount: itemOriginal,
        splits: [split('Ana', 615.97, splitOriginal), split('Ben', 615.96, splitOriginal)],
      },
    ],
    ...over,
  }
}

async function render(bill: ReturnType<typeof billFor>) {
  await act(async () => root.render(<BillExportCard bill={bill} groupName={null} />))
  return container.textContent ?? ''
}

describe('BillExportCard', () => {
  it('C32: a converted bill shows the paid-in total and the locked rate', async () => {
    const text = await render(billFor())
    expect(text).toContain('Paid in')
    expect(text).toContain('500,000')
    expect(text).toContain('1 PHP = 405.87 VND (locked)')
  })

  it('C32: a plain bill shows no paid-in line', async () => {
    const text = await render(
      billFor({ originalCurrency: null, originalTotal: null, exchangeRate: null }, null, null),
    )
    expect(text).not.toContain('Paid in')
    expect(text).not.toContain('(locked)')
  })

  it('C32: a bill whose item lost its original amount (stale conversion) shows no paid-in line', async () => {
    const text = await render(billFor({}, null, null))
    expect(text).not.toContain('(locked)')
  })

  it('C32: a bill whose share lost its original amount shows no paid-in line', async () => {
    const text = await render(billFor({}, 500000, null))
    expect(text).not.toContain('(locked)')
  })

  it('C32: an unreadable currency code or a zero rate shows no paid-in line', async () => {
    expect(await render(billFor({ originalCurrency: 'vnd' }))).not.toContain('(locked)')
    expect(await render(billFor({ exchangeRate: 0 }))).not.toContain('(locked)')
  })
})
