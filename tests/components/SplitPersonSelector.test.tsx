import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SplitPersonSelector } from '@/components/common/SplitPersonSelector'

/**
 * C6 — a participant the picker cannot list (a contact deleted from the phonebook, a member
 * removed from the group) is still on the bill. Dropping them from the option list hid the chip
 * while the id stayed selected, counted and saved, so the user could neither see nor remove them.
 * Such an option carries `unlisted: true` and renders as a muted chip with a hint, still has its
 * value row, is removable, is NOT offered in the dropdown once deselected, and does not count
 * towards "Select all".
 *
 * Driven with React's own `act` + `react-dom/client`, like `tests/hooks/useServerData.test.tsx`.
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

const listed = [
  { userId: 'ME', displayName: 'Me', isCurrentUser: true },
  { userId: 'LOCAL', displayName: 'Bob', isCurrentUser: false },
]
const gone = { userId: 'GONE', displayName: 'Gone Person', isCurrentUser: false, unlisted: true as const }

type Props = Partial<Parameters<typeof SplitPersonSelector>[0]>

async function render(over: Props) {
  const props = {
    members: [...listed, gone],
    selectedUserIds: ['ME', 'LOCAL', 'GONE'],
    onToggle: vi.fn(),
    splitType: 'equal' as const,
    currency: 'PHP',
    values: {},
    lineAmount: 100,
    onValueChange: vi.fn(),
    ...over,
  }
  await act(async () => root.render(<SplitPersonSelector {...props} />))
  return props
}

function trigger(): HTMLButtonElement {
  // The first button in the tree is the chip trigger.
  return container.querySelector('button') as HTMLButtonElement
}

function chipFor(name: string): HTMLElement | undefined {
  return [...trigger().querySelectorAll('span')].find(
    (s) => s.textContent?.includes(name) && s.classList.contains('rounded-full'),
  )
}

/** The dropdown is portalled to document.body; it is the element holding the search box. */
function dropdown(): HTMLElement | null {
  const search = document.body.querySelector('input[placeholder="Search people…"]')
  return (search?.closest('.shadow-md') as HTMLElement | null) ?? null
}

async function openDropdown() {
  await act(async () => trigger().click())
  const dd = dropdown()
  if (!dd) throw new Error('dropdown did not open')
  return dd
}

describe('SplitPersonSelector — unlisted participants', () => {
  it('C6: renders a selected unlisted participant as a chip with a "not in" hint', async () => {
    await render({})
    const chip = chipFor('Gone Person')
    expect(chip).toBeDefined()
    expect(chip!.textContent).toMatch(/not in (contacts|group)/)
  })

  it('C6: a listed participant chip carries no hint', async () => {
    await render({})
    const chip = chipFor('Bob')
    expect(chip).toBeDefined()
    expect(chip!.textContent).not.toMatch(/not in/)
  })

  it('C6: the unlisted chip is removable — its X toggles the id off', async () => {
    const props = await render({})
    const chip = chipFor('Gone Person')!
    const remove = chip.querySelector('button') as HTMLButtonElement
    expect(remove).not.toBeNull()
    await act(async () => remove.click())
    expect(props.onToggle).toHaveBeenCalledWith('GONE')
    expect(props.onToggle).toHaveBeenCalledTimes(1)
  })

  it('C6: the unlisted participant keeps an editable value row', async () => {
    const props = await render({
      splitType: 'custom',
      values: { ME: '40', LOCAL: '30', GONE: '30' },
    })
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[]
    // One value row per selected member, the unlisted one included.
    expect(inputs.map((i) => i.value)).toEqual(['40', '30', '30'])
    const goneRow = inputs[2]
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(goneRow, '35')
      goneRow.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(props.onValueChange).toHaveBeenCalledWith('GONE', '35')
  })

  it('C6: once deselected, the unlisted participant is not offered in the dropdown', async () => {
    await render({ selectedUserIds: ['ME', 'LOCAL'] })
    expect(chipFor('Gone Person')).toBeUndefined()
    const dd = await openDropdown()
    expect(dd.textContent).toContain('Bob')
    expect(dd.textContent).not.toContain('Gone Person')
  })

  it('C6: while still selected, the unlisted participant IS in the dropdown so it can be unticked there too', async () => {
    const props = await render({})
    const dd = await openDropdown()
    expect(dd.textContent).toContain('Gone Person')
    const row = [...dd.querySelectorAll('div')].find(
      (d) => d.textContent === 'Gone Person' || d.textContent?.startsWith('Gone Person'),
    )
    expect(row).toBeDefined()
    await act(async () => row!.click())
    expect(props.onToggle).toHaveBeenCalledWith('GONE')
  })

  it('C6: "Select all" ignores the unlisted participant — all listed selected reads as all selected', async () => {
    await render({
      selectedUserIds: ['ME', 'LOCAL'],
      onSelectAll: vi.fn(),
      onDeselectAll: vi.fn(),
    })
    const dd = await openDropdown()
    const toggleAll = [...dd.querySelectorAll('button')].find((b) =>
      /select all/i.test(b.textContent ?? ''),
    )
    expect(toggleAll).toBeDefined()
    expect(toggleAll!.textContent).toBe('Deselect all')
  })

  it('C6: "Select all" still reads as not-all-selected when a LISTED member is missing', async () => {
    await render({
      selectedUserIds: ['ME', 'GONE'],
      onSelectAll: vi.fn(),
      onDeselectAll: vi.fn(),
    })
    const dd = await openDropdown()
    const toggleAll = [...dd.querySelectorAll('button')].find((b) =>
      /select all/i.test(b.textContent ?? ''),
    )
    expect(toggleAll!.textContent).toBe('Select all')
  })

  it('C6: a selector with no unlisted options behaves as before (regression guard)', async () => {
    const props = await render({
      members: listed,
      selectedUserIds: ['ME'],
      onSelectAll: vi.fn(),
      onDeselectAll: vi.fn(),
    })
    expect(chipFor('Me')).toBeUndefined() // the current user renders as "You"
    expect(chipFor('You')).toBeDefined()
    const dd = await openDropdown()
    expect(dd.textContent).toContain('Bob')
    const toggleAll = [...dd.querySelectorAll('button')].find((b) =>
      /select all/i.test(b.textContent ?? ''),
    )!
    expect(toggleAll.textContent).toBe('Select all')
    await act(async () => toggleAll.click())
    expect(props.onSelectAll).toHaveBeenCalledTimes(1)
  })
})
