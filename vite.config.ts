import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // 'prompt' (not 'autoUpdate'): with injectManifest, autoUpdate expects the
      // SW to self-skipWaiting and never wires onNeedRefresh — our sw.ts only
      // skip-waits on the SKIP_WAITING message, so we drive the update via the
      // prompt path (waiting → onNeedRefresh toast → updateServiceWorker(true)).
      registerType: 'prompt',
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['favicon.svg', 'icons.svg'],
      manifest: {
        name: 'Kwenta — Bill Splitter',
        short_name: 'Kwenta',
        description: 'Offline-first bill splitting for real-life groups',
        theme_color: '#1f2937',
        background_color: '#faf8f5',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      injectManifest: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      },
    }),
  ],
  build: {
    // Prevent occasional workbox SW generation failures caused by terser renderChunk hanging.
    minify: 'esbuild',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
})
