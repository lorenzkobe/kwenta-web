import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { AppHeader } from '@/components/layout/AppHeader'
import { OfflineBanner } from '@/components/common/OfflineBanner'
import { useAppStore } from '@/store/app-store'

/**
 * The installed iPhone app draws under the status bar (viewport-fit=cover, black-translucent), so
 * anything pinned to the top must pad itself below env(safe-area-inset-top) or it sits behind the
 * Dynamic Island. A backdrop blur on that edge also samples past the screen and washes the top rows
 * out to white, so the bars there are solid.
 */

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ userType: 'user' }) }))
vi.mock('@/hooks/useCurrentUser', () => ({ useCurrentUser: () => ({ userId: null, profile: undefined }) }))
vi.mock('@/components/notifications/NotificationsBell', () => ({ NotificationsBell: () => null }))
vi.mock('@/components/common/RefreshButton', () => ({ RefreshButton: () => null }))
vi.mock('@/api/balances', () => ({
  searchEverything: () => Promise.resolve({ bills: [], groups: [], profiles: [] }),
}))

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
  useAppStore.setState({ isOnline: true })
})

async function renderHeader() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <AppHeader />
      </MemoryRouter>,
    ),
  )
}

const classes = (el: Element | null) => (el?.getAttribute('class') ?? '').split(/\s+/)

describe('top of the installed app on a notched iPhone', () => {
  it('starts the search sheet below the safe area', async () => {
    await renderHeader()
    const open = container.querySelector('button[aria-label="Search"]') as HTMLButtonElement
    await act(async () => open.click())

    const input = container.querySelector('input[placeholder^="Search bills"]')
    const sheet = input?.closest('.fixed.inset-0')
    expect(sheet, 'the full-screen search sheet').not.toBeNull()
    expect(classes(sheet!)).toContain('pt-[env(safe-area-inset-top)]')

    const close = container.querySelector('button[aria-label="Close search"]') as HTMLButtonElement
    await act(async () => close.click())
    expect(container.querySelector('input[placeholder^="Search bills"]')).toBeNull()
  })

  it('gives the header a solid background with no backdrop blur, still padded below the safe area', async () => {
    await renderHeader()
    const header = classes(container.querySelector('header'))
    expect(header).toContain('bg-white')
    expect(header).toContain('pt-[env(safe-area-inset-top)]')
    expect(header.filter((c) => c.startsWith('backdrop-blur'))).toEqual([])
  })

  it('gives the offline banner a solid background with no backdrop blur', async () => {
    useAppStore.setState({ isOnline: false })
    await act(async () => root.render(<OfflineBanner />))
    const banner = classes(container.firstElementChild)
    expect(banner).toContain('bg-amber-500')
    expect(banner.filter((c) => c.startsWith('backdrop-blur'))).toEqual([])
  })
})
