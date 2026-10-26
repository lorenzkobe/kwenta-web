import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

const mocks = vi.hoisted(() => ({ detail: null as unknown }))

vi.mock('@/api/balances', () => ({
  fetchBillDetail: vi.fn(),
  fetchBillSettlementHistory: vi.fn(),
  fetchPersonalBills: vi.fn(),
}))
vi.mock('@/hooks/useServerData', () => ({
  useServerData: (_load: unknown, _deps: unknown, key?: string) =>
    key?.startsWith('bill:')
      ? { data: mocks.detail, loading: false, error: null, refresh: vi.fn() }
      : { data: [], loading: false, error: null, refresh: vi.fn() },
}))
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ userId: 'me' }) }))
vi.mock('@/db/operations', () => ({ deleteBill: vi.fn() }))
vi.mock('@/lib/staged-rows', () => ({ loadStagedBillDetail: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() } }))

import { BillDetailPage } from '@/pages/BillDetailPage'

/**
 * C17 on the page: a converted bill shows the paid-in total, the locked rate and the amount as
 * paid beside every item and share; a plain bill (or one whose conversion record is incomplete)
 * renders exactly as before.
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
  userId: id,
  displayName: id,
  splitType: 'equal',
  splitValue: 1,
  computedAmount,
  originalAmount,
})

function payload(opts: {
  converted: boolean
  itemOriginal?: number | null
  items?: number
  staleSplit?: boolean
}) {
  const originalOf = (n: number | null) => (opts.converted ? n : null)
  const lineCount = opts.items ?? 2
  return {
    bill: {
      id: 'b1',
      title: 'Hanoi dinner',
      note: '',
      currency: 'PHP',
      totalAmount: 1231.93,
      createdAt: '2026-10-01T00:00:00.000Z',
      createdBy: 'me',
      paidBy: 'me',
      payorName: 'Ana',
      creatorName: 'Ana',
      category: null,
      originalCurrency: opts.converted ? 'VND' : null,
      exchangeRate: opts.converted ? 1 / 405.868219 : null,
      rateSource: opts.converted ? 'online' : null,
      originalTotal: originalOf(500000),
    },
    groupName: null,
    mySplitTotal: null,
    pairs: [],
    items: Array.from({ length: lineCount }, (_, i) => ({
      id: `i${i}`,
      name: `Dish ${i}`,
      amount: 600,
      originalAmount: opts.itemOriginal !== undefined ? opts.itemOriginal : originalOf(243000),
      splits: [
        split('Ana', 300, originalOf(121500)),
        split('Ben', 300, opts.staleSplit ? null : originalOf(121500)),
      ],
    })),
  }
}

async function render(data: unknown) {
  mocks.detail = data
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={['/app/bills/b1']}>
        <Routes>
          <Route path="/app/bills/:billId" element={<BillDetailPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
  return container.textContent ?? ''
}

describe('BillDetailPage converted bill', () => {
  it('C17: shows the paid-in total, locked rate, and original beside each item and share', async () => {
    const text = await render(payload({ converted: true }))
    expect(text).toContain('1 PHP = 405.87 VND (locked)')
    expect(text).toContain('500,000')
    expect(text.match(/243,000/g)).toHaveLength(2)
    expect(text.match(/121,500/g)).toHaveLength(4)
  })

  it('C17: a single-item bill shows the original beside each share', async () => {
    const text = await render(payload({ converted: true, items: 1 }))
    expect(text).toContain('(locked)')
    expect(text.match(/121,500/g)).toHaveLength(2)
  })

  it('C17: a plain bill renders no paid-in text at all', async () => {
    const text = await render(payload({ converted: false }))
    expect(text).not.toContain('(locked)')
    expect(text).not.toContain('Paid in')
    expect(text).not.toContain('243,000')
  })

  it('C17: a bill with a stale conversion record but an item missing its original renders as plain', async () => {
    const text = await render(payload({ converted: true, itemOriginal: null }))
    expect(text).not.toContain('(locked)')
    expect(text).not.toContain('500,000')
  })

  it('C17/C29: a converted-looking bill with one share missing its original renders as plain, like the edit form', async () => {
    const text = await render(payload({ converted: true, staleSplit: true }))
    expect(text).not.toContain('(locked)')
    expect(text).not.toContain('500,000')
    expect(text).not.toContain('121,500')
  })
})
