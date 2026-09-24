import type { ManifestOptions } from 'vite-plugin-pwa'

/**
 * The web app manifest. An installed app launches into `/app` — the landing page is for visitors,
 * and `/app` already sends a signed-out user to login. Scope stays the whole origin so `/login`
 * opens inside the app window rather than in a browser tab. Offline, the launch works because
 * `src/sw.ts` serves the precached shell for every navigation.
 *
 * `id` pins the app's identity to what it was when `start_url` was `/`: without it Chrome derives
 * the identity from `start_url`, so moving that to `/app` would make existing installs a different
 * app and they would ignore the update.
 */
export const pwaManifest: Partial<ManifestOptions> = {
  name: 'Kwenta — Bill Splitter',
  short_name: 'Kwenta',
  description: 'Offline-first bill splitting for real-life groups',
  theme_color: '#1f2937',
  background_color: '#faf8f5',
  id: '/',
  display: 'standalone',
  start_url: '/app',
  scope: '/',
  icons: [
    { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
    { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
    { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
}
