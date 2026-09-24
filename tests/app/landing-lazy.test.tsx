import { describe, expect, it, vi } from 'vitest'

/**
 * The landing page is for signed-out visitors, so it must not be in the entry chunk. As a static
 * import of App.tsx it put ~100 kB of marketing components on every start of /app. (The service
 * worker still precaches its chunk once in the background; the saving is at start-up and on each
 * update.) Loading App must not evaluate the landing module.
 */
const h = vi.hoisted(() => ({ landingEvaluated: false }))

vi.mock('@/landing/LandingPage', () => {
  h.landingEvaluated = true
  return { LandingPage: () => null }
})
vi.mock('@/hooks/AuthProvider', () => ({ AuthProvider: ({ children }: { children: unknown }) => children }))
vi.mock('@/components/layout/AppShell', () => ({ AppShell: () => null }))

describe('App', () => {
  it('does not load the landing page until its route renders', async () => {
    await import('@/App')
    expect(h.landingEvaluated).toBe(false)
  })
})
