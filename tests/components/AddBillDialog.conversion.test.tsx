import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

const mocks = vi.hoisted(() => ({
  updateBill: vi.fn(async () => {}),
  createBill: vi.fn(async () => 'new-bill'),
  bill: null as Record<string, unknown> | null,
  rate: { live: null, loading: false } as { live: null; loading: boolean },
}))

vi.mock('@/db/operations', () => ({
  createBill: mocks.createBill,
  updateBill: mocks.updateBill,
  getBillWithDetails: vi.fn(async () => mocks.bill),
  resolveGroupMemberUserId: vi.fn(async (_groupId: string, id: string) => id),
}))
vi.mock('@/sync/bill-mirror', () => ({
  loadBillIntoMirror: vi.fn(async () => {}),
  captureBillVersion: vi.fn(async () => ({ versions: {}, itemIds: [], splitIds: [] })),
}))
vi.mock('@/hooks/useExchangeRate', () => ({ useExchangeRate: () => mocks.rate }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }))

import { AddBillDialog } from '@/components/common/AddBillDialog'

/**
 * C30 and the Save gate of C24, through the dialog itself: editing a group bill keeps the currency
 * it was stored in even after the group's currency changed, hydrates a converted bill in the
 * currency it was paid in with its saved rate, and a converting form cannot save without a rate.
 */

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  Element.prototype.scrollIntoView ??= () => {}
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.releasePointerCapture ??= () => {}
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
  mocks.updateBill.mockClear()
  mocks.createBill.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  document.body.style.overflow = ''
})

const members = [
  { userId: 'me', displayName: 'Me', isCurrentUser: true },
  { userId: 'ben', displayName: 'Ben', isCurrentUser: false },
]

const split = (user_id: string, computed_amount: number, original_amount: number | null) => ({
  id: `s-${user_id}`,
  user_id,
  displayName: user_id,
  split_type: 'equal',
  split_value: 1,
  computed_amount,
  original_amount,
})

function storedBill(converted: boolean) {
  return {
    id: 'b1',
    title: 'Hanoi dinner',
    note: '',
    currency: 'PHP',
    created_by: 'me',
    paid_by: 'me',
    payorName: 'Me',
    category: null,
    original_currency: converted ? 'VND' : null,
    exchange_rate: converted ? 0.0025 : null,
    rate_source: converted ? 'manual' : null,
    original_total: converted ? 500000 : null,
    items: [
      {
        id: 'i1',
        name: 'Hanoi dinner',
        amount: converted ? 1250 : 1000,
        original_amount: converted ? 500000 : null,
        splits: [split('me', 625, converted ? 250000 : null), split('ben', 625, converted ? 250000 : null)],
      },
    ],
  }
}

async function openEdit(bill: Record<string, unknown>, groupCurrency = 'USD') {
  mocks.bill = bill
  await act(async () =>
    root.render(
      <AddBillDialog
        groupId="g1"
        groupCurrency={groupCurrency}
        groupMembers={members}
        currentUserId="me"
        editBillId="b1"
        onClose={vi.fn()}
      />,
    ),
  )
  await settle()
}

async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function amountInputValue() {
  const label = [...container.querySelectorAll('label')].find((l) => l.textContent === 'Total amount')!
  return (label.parentElement!.querySelector('input') as HTMLInputElement).value
}

async function typeInto(input: HTMLInputElement, text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function pickPaidIn(code: string) {
  const trigger = [...container.querySelectorAll('button[role="combobox"]')].find((b) =>
    b.id !== '' && document.querySelector(`label[for="${b.id}"]`)?.textContent === 'Paid in',
  ) as HTMLButtonElement
  await act(async () => {
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  const option = [...document.body.querySelectorAll('[role="option"]')].find((o) =>
    o.textContent?.startsWith(code),
  ) as HTMLElement
  await act(async () => {
    option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
}

function saveButton() {
  return [...container.querySelectorAll('button')].find((b) => /Save (changes|bill)/.test(b.textContent ?? ''))!
}

describe('AddBillDialog conversion', () => {
  it('C30: editing a PHP bill after the group moved to USD saves it as PHP', async () => {
    await openEdit(storedBill(false))
    expect(container.textContent).toContain('PHP')
    await act(async () => saveButton().click())
    expect(mocks.updateBill).toHaveBeenCalledTimes(1)
    const patch = (mocks.updateBill.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2]
    expect(patch.currency).toBe('PHP')
    expect(patch.conversion).toBeNull()
  })

  it('C24/C29: a converted bill hydrates in the paid-in currency and re-saves with its saved rate', async () => {
    await openEdit(storedBill(true))
    expect(amountInputValue()).toBe('500000')
    expect(container.textContent).toContain('Saved rate')
    await act(async () => saveButton().click())
    const patch = (mocks.updateBill.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2]
    expect(patch.currency).toBe('PHP')
    expect(patch.conversion).toEqual({ fromCurrency: 'VND', rate: 0.0025, source: 'manual' })
    expect((patch.items as { amount: number }[])[0].amount).toBe(500000)
  })

  it('C29: a stale conversion record (an item without its original) hydrates as the plain balance amounts', async () => {
    const bill = storedBill(true) as ReturnType<typeof storedBill>
    bill.items[0].original_amount = null
    await openEdit(bill)
    expect(amountInputValue()).toBe('1250')
    await act(async () => saveButton().click())
    const patch = (mocks.updateBill.mock.calls[0] as unknown as [string, string, Record<string, unknown>])[2]
    expect(patch.conversion).toBeNull()
    expect((patch.items as { amount: number }[])[0].amount).toBe(1250)
  })

  it('C24: a new group bill converts into the group currency, and Save waits for a rate', async () => {
    mocks.bill = null
    await act(async () =>
      root.render(
        <AddBillDialog groupId="g1" groupCurrency="USD" groupMembers={[]} currentUserId="me" onClose={vi.fn()} />,
      ),
    )
    await settle()
    const inputs = () => [...container.querySelectorAll('input')]
    await typeInto(inputs().find((i) => i.placeholder.startsWith('e.g.'))!, 'Hanoi dinner')
    await typeInto(inputs().find((i) => i.placeholder === '0.00')!, '500000')
    expect(saveButton().disabled).toBe(false)

    await pickPaidIn('VND')
    expect(saveButton().disabled).toBe(true)
    expect(container.textContent).toContain('Enter an exchange rate to save')

    await typeInto(container.querySelector('input[inputmode="decimal"][id]') as HTMLInputElement, '0.00004')
    expect(saveButton().disabled).toBe(false)
    await act(async () => saveButton().click())
    const input = (mocks.createBill.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(input.currency).toBe('USD')
    expect((input.conversion as { fromCurrency: string; source: string }).fromCurrency).toBe('VND')
    expect((input.conversion as { source: string }).source).toBe('manual')
  })
})
