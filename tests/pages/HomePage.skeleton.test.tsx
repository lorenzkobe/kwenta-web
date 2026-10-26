import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

/**
 * skeleton-on-fetch on the Home screen: online, opening Home over a saved copy shows the balance and
 * recent-bill skeletons until the server answers, never the saved numbers first; after
 * SAVED_COPY_FALLBACK_MS the saved copy is shown.
 */

const server = vi.hoisted(() => ({
  overview: null as null | ((v: unknown) => void),
  recent: null as null | ((v: unknown) => void),
}))

vi.mock('@/api/balances', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/balances')>()
  return {
    ...actual,
    fetchBalancesOverview: vi.fn(() => new Promise((resolve) => (server.overview = resolve))),
    fetchRecentBills: vi.fn(() => new Promise((resolve) => (server.recent = resolve))),
  }
})
vi.mock('@/hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ userId: 'me', profile: { display_name: 'Me' } }),
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), warning: vi.fn(), dismiss: vi.fn(), error: vi.fn() } }))

import { HomePage } from '@/pages/HomePage'
import { SAVED_COPY_FALLBACK_MS } from '@/hooks/useServerData'
import { writeCache } from '@/api/cache'
import { useAppStore } from '@/store/app-store'

const totals = (php: number) => ({ PHP: php })
const overview = (php: number) => ({
  personalReceive: totals(php),
  personalPay: {},
  groupReceive: {},
  groupPay: {},
  combinedReceive: totals(php),
  combinedPay: {},
})

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  localStorage.clear()
  useAppStore.setState({ currentUserId: 'me', isOnline: true, screenLoadCount: 0 })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  localStorage.clear()
})

async function render() {
  await act(async () => {
    root.render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    )
  })
}

const text = () => container.textContent ?? ''
const balancesSkeleton = () => container.querySelector('[aria-label="Loading balances"]')

describe('HomePage skeletons', () => {
  it('C12: opening Home over a saved copy shows the skeleton, not the saved balance, then the fresh one', async () => {
    writeCache('overview', 'me', overview(900), '2026-10-01T00:00:00.000Z')
    writeCache('recent-bills', 'me', [], '2026-10-01T00:00:00.000Z')
    await render()

    expect(balancesSkeleton()).not.toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(text()).not.toMatch(/900/)

    await act(async () => {
      server.overview?.({ data: overview(1250), fromCache: false, fetchedAt: '2026-10-26T00:00:00.000Z' })
      server.recent?.({ data: [], fromCache: false, fetchedAt: '2026-10-26T00:00:00.000Z' })
    })
    expect(balancesSkeleton()).toBeNull()
    expect(text()).toMatch(/1,250/)
    expect(text()).not.toMatch(/900/)
  })

  it('C2: a slow server shows the saved balance after the fallback', async () => {
    writeCache('overview', 'me', overview(900), '2026-10-01T00:00:00.000Z')
    await render()
    expect(text()).not.toMatch(/900/)

    await act(async () => {
      vi.advanceTimersByTime(SAVED_COPY_FALLBACK_MS)
    })
    expect(balancesSkeleton()).toBeNull()
    expect(text()).toMatch(/900/)
  })
})
