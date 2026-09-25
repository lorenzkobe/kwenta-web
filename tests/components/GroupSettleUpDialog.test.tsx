import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GroupSettleUpDialog } from '@/components/common/GroupSettleUpDialog'
import type { SuggestedPayerGroup } from '@/lib/settlement'
import { formatCurrency } from '@/lib/utils'

/**
 * A settle-up that cuts out a middle person leaves part of the payer's "owes you" on their row
 * until OTHER members settle. The dialog says so before it is recorded (a user deleted a correct
 * payment because the leftover looked like a bug), and a middle person is named, never shown as
 * a raw id. Driven with React's own `act` + `react-dom/client`, like `ConfirmDialog.test.tsx`.
 */

vi.mock('@/db/operations', () => ({ recordDecomposedSettlement: vi.fn() }))

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

const YUMI_ID = '00000000-0000-4000-8000-00000000yumi'

const vince: SuggestedPayerGroup = {
  fromUserId: 'vince',
  fromName: 'Vince',
  total: 15194.05,
  recipients: [{ toUserId: 'me', toName: 'Kobz', amount: 15194.05 }],
  legs: [
    { fromUserId: 'vince', toUserId: 'me', amount: 14984.05 },
    { fromUserId: 'vince', toUserId: YUMI_ID, amount: 210 },
    { fromUserId: YUMI_ID, toUserId: 'me', amount: 210 },
  ],
}

type Props = Parameters<typeof GroupSettleUpDialog>[0]

async function render(over: Partial<Props> = {}) {
  const props: Props = {
    open: true,
    onOpenChange: vi.fn(),
    groupId: 'g',
    currency: 'PHP',
    markedBy: 'me',
    payer: vince,
    rosterName: new Map([[YUMI_ID, 'Yumi']]),
    onUsePayInto: vi.fn(),
    ...over,
  }
  await act(async () => root.render(<GroupSettleUpDialog {...props} />))
}

describe('GroupSettleUpDialog', () => {
  it('says how much stays on the payer\'s row and who clears it', async () => {
    await render({ coveredByOthers: { amount: 1344.1, payerNames: ['Levi', 'Nek', 'Rince'] } })
    const text = container.textContent ?? ''
    expect(text).toContain(formatCurrency(1344.1, 'PHP'))
    expect(text).toContain('Levi, Nek & Rince')
    expect(text).toContain('stays on')
  })

  it('shows no note when nothing is carried by other settle-ups', async () => {
    await render()
    expect(container.textContent).not.toContain('stays on')
  })

  it('names a middle person in "How this settles" instead of showing their id', async () => {
    await render()
    const toggle = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'How this settles',
    )!
    await act(async () => toggle.click())
    const text = container.textContent ?? ''
    expect(text).toContain('Yumi pays Kobz')
    expect(text).toContain('Vince pays Yumi')
    expect(text).not.toContain(YUMI_ID)
  })
})
