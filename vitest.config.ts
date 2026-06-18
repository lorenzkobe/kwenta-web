import path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // happy-dom gives us localStorage / crypto / Intl for the pure helpers.
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
  },
})
