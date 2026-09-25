import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GroupSelectionExportCard } from '@/components/export/GroupSelectionExportCard'
import { PeopleSelectionExportCard } from '@/components/export/PeopleSelectionExportCard'
import { buildGroupShareRows, buildPeerShareRows } from '@/lib/balance-share'
import { buildSuggestedPayers } from '@/lib/settlement-suggestions'

/**
 * The image is what leaves the app, so what it says is pinned here: the why lines reach it, and a
 * cached answer is stamped as one — an image outlives the screen's "saved copy" notice.
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

const names: Record<string, string> = { a: 'Ana', b: 'Ben', c: 'Cha' }
const groupRows = buildGroupShareRows({
  members: ['a', 'b', 'c'].map((userId) => ({ userId, name: names[userId] })),
  memberBalances: [
    { userId: 'a', amount: -100 },
    { userId: 'b', amount: 0 },
    { userId: 'c', amount: 100 },
  ],
  payers: buildSuggestedPayers(
    [
      { from: 'a', to: 'b', amount: 100 },
      { from: 'b', to: 'c', amount: 100 },
    ],
    (id) => names[id],
  ),
  selectedIds: new Set(['a', 'b']),
})

describe('GroupSelectionExportCard', () => {
  it('shows each selected member, their transfer and why', async () => {
    await act(async () =>
      root.render(<GroupSelectionExportCard groupName="Trip" currency="PHP" rows={groupRows} />),
    )
    const text = container.textContent ?? ''
    expect(text).toContain('Balances for 2 people')
    expect(text).toContain('Pay Cha')
    expect(text).toContain('Ana owes Ben and Ben owes Cha, so Ana pays Cha directly')
    expect(text).toContain('Settled')
    expect(text).not.toContain('Saved copy')
  })

  it('stamps a cached answer as a saved copy', async () => {
    await act(async () =>
      root.render(
        <GroupSelectionExportCard
          groupName="Trip"
          currency="PHP"
          rows={groupRows}
          savedAt="2026-09-20T10:00:00.000Z"
        />,
      ),
    )
    expect(container.textContent).toContain('Saved copy from')
  })
})

describe('PeopleSelectionExportCard', () => {
  it('lists every currency line and reads a zero balance as settled', async () => {
    const rows = buildPeerShareRows(
      [
        { peerId: 'p1', displayName: 'Ana', net: { PHP: 250, USD: -10 }, staged: false },
        { peerId: 'p2', displayName: 'Ben', net: {}, staged: false },
      ],
      new Set(['p1', 'p2']),
    )
    await act(async () => root.render(<PeopleSelectionExportCard rows={rows} />))
    const text = container.textContent ?? ''
    expect(text).toContain('2 people')
    expect(text).toContain('Owes you')
    expect(text).toContain('You owe')
    expect(text).toContain('Settled up')
  })
})
