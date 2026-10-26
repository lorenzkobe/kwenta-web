import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

type Deferred = { resolve: (v: unknown) => void; reject: (e: unknown) => void }

const search = vi.hoisted(() => ({
  userId: null as string | null,
  pending: [] as Deferred[],
  local: [] as Deferred[],
}))

vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ userId: search.userId, profile: undefined }) }))
vi.mock('@/lib/local-search', () => ({
  searchLocalMirror: () =>
    new Promise((resolve, reject) => {
      search.local.push({ resolve, reject })
    }),
}))
vi.mock('@/api/balances', () => ({
  searchEverything: () =>
    new Promise((resolve, reject) => {
      search.pending.push({ resolve, reject })
    }),
}))

import { GlobalSearchSheet } from '@/components/common/GlobalSearchSheet'

/**
 * Between a keystroke and the server's answer the results area used to be blank, which read as
 * "nothing found". It now shows skeleton result rows until the answer for that exact query lands.
 */

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.useFakeTimers()
  search.pending = []
  search.local = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter>
        <GlobalSearchSheet onClose={() => {}} />
      </MemoryRouter>,
    ),
  )
})

afterEach(async () => {
  search.userId = null
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
})

const input = () => container.querySelector('input') as HTMLInputElement
const skeleton = () => container.querySelector('[role="status"][aria-label="Searching"]')
const text = () => container.textContent ?? ''

async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(), value)
    input().dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function passDebounce() {
  await act(async () => {
    vi.advanceTimersByTime(200)
  })
}

async function answer(results: { bills?: unknown[] } | Error) {
  const call = search.pending.shift()!
  await act(async () => {
    if (results instanceof Error) call.reject(results)
    else call.resolve({ bills: [], groups: [], profiles: [], ...results })
  })
}

const bill = { id: 'b1', title: 'Pizza 4Ps', amount: 1663.27, currency: 'PHP' }

describe('GlobalSearchSheet loading state', () => {
  it('shows nothing but the hint under two characters', async () => {
    await type('p')
    expect(skeleton()).toBeNull()
    expect(text()).toContain('Type at least 2 characters to search')
  })

  it('shows skeleton rows from the keystroke until the answer, then the results', async () => {
    await type('pi')
    expect(skeleton()).not.toBeNull()
    await passDebounce()
    expect(skeleton()).not.toBeNull()

    await answer({ bills: [bill] })
    expect(skeleton()).toBeNull()
    expect(text()).toContain('Pizza 4Ps')
  })

  it('replaces the skeleton with the error when the search fails', async () => {
    await type('pi')
    await passDebounce()
    await answer(new Error('Search is unavailable right now.'))
    expect(skeleton()).toBeNull()
    expect(text()).toContain('Search is unavailable right now.')
  })

  it('shows "No results found", not the skeleton, for an empty answer', async () => {
    await type('zz')
    await passDebounce()
    await answer({})
    expect(skeleton()).toBeNull()
    expect(text()).toContain('No results found')
  })

  it('hides the previous results behind the skeleton while a new query is in flight', async () => {
    await type('pi')
    await passDebounce()
    await answer({ bills: [bill] })

    await type('piz')
    expect(skeleton()).not.toBeNull()
    expect(text()).not.toContain('Pizza 4Ps')
  })

  it('keeps the skeleton through the offline fallback, then shows the saved results marked offline', async () => {
    search.userId = 'me'
    await act(async () =>
      root.render(
        <MemoryRouter>
          <GlobalSearchSheet key="signed-in" onClose={() => {}} />
        </MemoryRouter>,
      ),
    )
    await type('pi')
    await passDebounce()
    await answer(new Error('Search is unavailable right now.'))
    expect(search.local).toHaveLength(1)
    expect(skeleton()).not.toBeNull()

    await act(async () => search.local.shift()!.resolve({ bills: [bill], groups: [], profiles: [] }))
    expect(skeleton()).toBeNull()
    expect(text()).toContain('Offline')
    expect(text()).toContain('Pizza 4Ps')
  })
})
