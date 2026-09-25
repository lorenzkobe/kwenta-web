import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { AuthContextValue } from '@/hooks/auth-context'

/**
 * "When I go into the app, if I'm logged in, it still goes into the home page": `/` rendered the
 * marketing landing page for everyone. It now sits behind `RequireGuest`, whose default target is
 * `/app` (src/components/auth/RequireGuest.tsx), so a signed-in visitor lands in the app and a
 * signed-out one still sees the landing page.
 */
const h = vi.hoisted(() => ({
  auth: null as unknown as AuthContextValue,
}))

vi.mock('@/landing/LandingPage', () => ({
  LandingPage: () => <div data-testid="landing" />,
}))
vi.mock('@/components/layout/AppShell', () => ({
  AppShell: () => <div data-testid="app-shell" />,
}))
vi.mock('@/hooks/AuthProvider', async () => {
  const { AuthContext } = await import('@/hooks/auth-context')
  return {
    AuthProvider: ({ children }: { children: React.ReactNode }) => (
      <AuthContext.Provider value={h.auth}>{children}</AuthContext.Provider>
    ),
  }
})

import App from '@/App'

function authValue(overrides: Partial<AuthContextValue>): AuthContextValue {
  return {
    user: null,
    userType: null,
    authReady: false,
    loading: false,
    isAuthenticated: false,
    signIn: async () => ({ error: null }),
    signUp: async () => ({ error: null, requiresEmailConfirmation: false }),
    resetPassword: async () => ({ error: null }),
    updateDisplayName: async () => {},
    ...overrides,
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  // Keep WarmShellPages from importing every page chunk in the background of this test.
  Object.defineProperty(navigator, 'connection', {
    value: { saveData: true },
    configurable: true,
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  window.history.replaceState({}, '', '/')
})

/** Lazy routes resolve over several microtask/macrotask turns; wait until the predicate holds. */
async function settle(until: () => boolean) {
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

const has = (testId: string) => container.querySelector(`[data-testid="${testId}"]`) !== null

describe('the / route', () => {
  it('C8: a signed-in user opening / is redirected to /app', async () => {
    h.auth = authValue({
      isAuthenticated: true,
      authReady: true,
      userType: 'user',
      user: { id: 'u1' } as AuthContextValue['user'],
    })
    window.history.replaceState({}, '', '/')

    await act(async () => root.render(<App />))
    await settle(() => has('app-shell') || has('landing'))

    expect(window.location.pathname).toBe('/app')
    expect(has('app-shell')).toBe(true)
    expect(has('landing')).toBe(false)
  })

  it('C9: a signed-out user opening / still sees the landing page', async () => {
    h.auth = authValue({ isAuthenticated: false })
    window.history.replaceState({}, '', '/')

    await act(async () => root.render(<App />))
    await settle(() => has('landing') || has('app-shell'))

    expect(window.location.pathname).toBe('/')
    expect(has('landing')).toBe(true)
    expect(has('app-shell')).toBe(false)
  })

  it('C9: while auth is still bootstrapping, / shows neither the landing page nor the app', async () => {
    h.auth = authValue({ loading: true })
    window.history.replaceState({}, '', '/')

    await act(async () => root.render(<App />))
    await settle(() => false)

    // A signed-in user must not see the landing page flash before the redirect.
    expect(has('landing')).toBe(false)
    expect(has('app-shell')).toBe(false)
    expect(window.location.pathname).toBe('/')
  })
})
