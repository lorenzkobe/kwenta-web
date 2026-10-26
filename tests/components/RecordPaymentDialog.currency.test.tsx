import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

vi.mock('@/db/operations', () => ({ recordPersonPayment: vi.fn(async () => {}) }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

import { RecordPaymentDialog } from '@/components/common/RecordPaymentDialog'

/** The payment amount shows the currency it is recorded in while it is typed. */

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

describe('RecordPaymentDialog currency prefix', () => {
  it('prefixes the amount with the payment currency symbol', async () => {
    await act(async () =>
      root.render(
        <RecordPaymentDialog
          open
          onOpenChange={() => {}}
          meId="me"
          otherId="ben"
          meName="Me"
          otherName="Ben"
          currency="VND"
          markedBy="me"
          contexts={[]}
          onRecorded={() => {}}
        />,
      ),
    )
    const amount = document.getElementById('pay-amt') as HTMLInputElement
    expect(amount).not.toBeNull()
    expect(amount.parentElement?.querySelector('[data-slot="currency-prefix"]')?.textContent).toBe('₫')
  })
})
