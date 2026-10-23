import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

/**
 * perf-pass-1, C18. `executeDelete` had a try/finally and no catch: a rejected cloud-first delete
 * left the user looking at the same modal with no word of what happened. It now toasts the error
 * and keeps the modal (the bill is still there, so it must still be shown).
 *
 * Driven with React's own `act` + `react-dom/client`, like `ConfirmDialog.test.tsx`.
 */

const mocks = vi.hoisted(() => ({
  deleteBill: vi.fn(),
  toastError: vi.fn(),
  loadBill: vi.fn(async () => {}),
  bill: {
    id: 'bill-1',
    title: 'Dinner',
    note: null,
    currency: 'PHP',
    total_amount: 300,
    created_at: '2026-09-01T00:00:00.000Z',
    created_by: 'me',
    payorName: 'You',
    items: [],
  } as Record<string, unknown> | null,
}))

vi.mock('@/db/operations', () => ({
  deleteBill: mocks.deleteBill,
  getBillWithDetails: vi.fn(async () => mocks.bill),
}))
vi.mock('dexie-react-hooks', () => ({ useLiveQuery: () => mocks.bill }))
vi.mock('@/sync/bill-mirror', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/sync/bill-mirror')>()),
  loadBillIntoMirror: mocks.loadBill,
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn(), info: vi.fn() } }))

import { BillDetailModal } from '@/components/common/BillDetailModal'
import { BillUnavailableError } from '@/sync/bill-mirror'

let container: HTMLDivElement
let root: Root

const STORED_BILL = mocks.bill

beforeEach(() => {
  mocks.bill = STORED_BILL
  mocks.loadBill.mockReset()
  mocks.loadBill.mockResolvedValue(undefined)
  mocks.deleteBill.mockReset()
  mocks.toastError.mockReset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function buttonsNamed(text: string): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === text)
}

async function openAndConfirmDelete() {
  const onClose = vi.fn()
  await act(async () =>
    root.render(
      <BillDetailModal billId="bill-1" currentUserId="me" onClose={onClose} onEdit={vi.fn()} />,
    ),
  )
  const [openConfirm] = buttonsNamed('Delete bill')
  expect(openConfirm).toBeDefined()
  await act(async () => openConfirm.click())

  const dialog = container.querySelector('[role="alertdialog"]')
  expect(dialog).not.toBeNull()
  const confirm = [...dialog!.querySelectorAll('button')].find(
    (b) => b.textContent?.trim() === 'Delete bill',
  )
  expect(confirm).toBeDefined()
  await act(async () => confirm!.click())
  return { onClose }
}

describe('BillDetailModal delete', () => {
  it('C18: a rejected delete shows the error in a toast and keeps the modal open', async () => {
    mocks.deleteBill.mockRejectedValue(new Error('Server refused the delete'))

    const { onClose } = await openAndConfirmDelete()

    expect(mocks.deleteBill).toHaveBeenCalledWith('bill-1', 'me')
    expect(mocks.toastError).toHaveBeenCalledWith('Server refused the delete')
    expect(onClose).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Bill details')
    // The delete button is usable again, not stuck on "Deleting…".
    expect(buttonsNamed('Delete bill')[0]?.disabled).toBe(false)
  })

  it('C18: a rejection without a message falls back to a friendly one', async () => {
    mocks.deleteBill.mockRejectedValue({})

    await openAndConfirmDelete()

    expect(mocks.toastError).toHaveBeenCalledWith('Could not delete this bill right now.')
  })

  it('a successful delete closes the modal without an error toast', async () => {
    mocks.deleteBill.mockResolvedValue(undefined)

    const { onClose } = await openAndConfirmDelete()

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})

describe('BillDetailModal load failure', () => {
  async function renderMissing(error: BillUnavailableError) {
    mocks.bill = null
    mocks.loadBill.mockRejectedValue(error)
    await act(async () =>
      root.render(
        <BillDetailModal billId="bill-9" currentUserId="me" onClose={vi.fn()} onEdit={vi.fn()} />,
      ),
    )
    return container.textContent ?? ''
  }

  it('a connection failure is not reported as "Bill not found"', async () => {
    const text = await renderMissing(new BillUnavailableError('unreachable'))
    expect(text).not.toMatch(/not found/i)
    expect(text).toMatch(/connection/i)
  })

  it('a bill the server does not have is reported as missing', async () => {
    const text = await renderMissing(new BillUnavailableError('not_found'))
    expect(text).toMatch(/no longer exists/i)
  })
})

describe('BillDetailModal converted bill', () => {
  const split = (id: string, computed: number, original: number | null) => ({
    id,
    displayName: id,
    split_type: 'equal',
    computed_amount: computed,
    original_amount: original,
  })

  async function renderBill(bill: Record<string, unknown>) {
    mocks.bill = bill
    await act(async () =>
      root.render(<BillDetailModal billId="bill-1" currentUserId="me" onClose={vi.fn()} onEdit={vi.fn()} />),
    )
    return container.textContent ?? ''
  }

  it('C17: shows the paid-in total, the locked rate and the original beside each item and share', async () => {
    const text = await renderBill({
      ...STORED_BILL,
      total_amount: 1231.93,
      original_currency: 'VND',
      original_total: 500000,
      exchange_rate: 1 / 405.868219,
      items: [
        {
          id: 'i1',
          name: 'Dinner',
          amount: 1231.93,
          original_amount: 500000,
          splits: [split('Ana', 615.97, 250000), split('Ben', 615.96, 250000)],
        },
      ],
    })
    expect(text).toContain('1 PHP = 405.87 VND (locked)')
    expect(text).toContain('500,000')
    expect(text.match(/250,000/g)).toHaveLength(2)
  })

  it('C17: a bill with a stale conversion but an item missing its original renders as plain', async () => {
    const text = await renderBill({
      ...STORED_BILL,
      original_currency: 'VND',
      original_total: 500000,
      exchange_rate: 0.0025,
      items: [
        { id: 'i1', name: 'Dinner', amount: 300, original_amount: null, splits: [split('Ana', 300, null)] },
      ],
    })
    expect(text).not.toContain('(locked)')
    expect(text).not.toContain('500,000')
  })

  it('C17: an unconverted bill shows no paid-in line', async () => {
    const text = await renderBill({
      ...STORED_BILL,
      original_currency: null,
      items: [
        { id: 'i1', name: 'Dinner', amount: 300, original_amount: null, splits: [split('Ana', 300, null)] },
      ],
    })
    expect(text).not.toContain('(locked)')
    expect(text).not.toContain('Paid in')
  })
})
