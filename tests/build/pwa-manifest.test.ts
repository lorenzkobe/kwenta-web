import { describe, expect, it } from 'vitest'
import { pwaManifest } from '../../pwa-manifest'

describe('pwaManifest', () => {
  it('launches the installed app into /app, not the landing page', () => {
    expect(pwaManifest.start_url).toBe('/app')
  })

  it('keeps the identity existing installs have (the old start_url), so they accept the update', () => {
    expect(pwaManifest.id).toBe('/')
  })

  it('keeps the whole origin in scope so /login and the landing page stay inside the app window', () => {
    expect(pwaManifest.scope).toBe('/')
  })
})
