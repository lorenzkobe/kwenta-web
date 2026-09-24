import { describe, expect, it } from 'vitest'
import { vendorChunkFor } from '../../vendor-chunks'

/**
 * Vendor code the entry always loads is split into its own chunks so an app-only deploy does not
 * make every user re-download it (the service worker precaches by content hash). A manual chunk is
 * loaded by whatever imports it, so grouping a LAZY-only dependency with an eager one would make it
 * eager: anything not listed here must stay where Rollup puts it.
 */
const nm = (pkg: string, file = 'index.js') => `/repo/node_modules/${pkg}/dist/${file}`

describe('vendorChunkFor', () => {
  it('groups the React runtime and router', () => {
    for (const pkg of ['react', 'react-dom', 'scheduler', 'react-router', 'react-router-dom']) {
      expect(vendorChunkFor(nm(pkg))).toBe('react')
    }
  })

  it('groups the Supabase client and its dependency', () => {
    for (const pkg of ['@supabase/supabase-js', '@supabase/auth-js', '@supabase/postgrest-js', '@supabase/realtime-js', '@supabase/storage-js', '@supabase/functions-js', 'iceberg-js']) {
      expect(vendorChunkFor(nm(pkg))).toBe('supabase')
    }
  })

  it('groups Dexie', () => {
    expect(vendorChunkFor(nm('dexie'))).toBe('dexie')
    expect(vendorChunkFor(nm('dexie-react-hooks'))).toBe('dexie')
  })

  it('leaves app code, lazy-only libraries and look-alike names alone', () => {
    for (const id of [
      '/repo/src/App.tsx',
      '/repo/src/landing/LandingPage.tsx',
      nm('jspdf'),
      nm('html2canvas'),
      nm('html-to-image'),
      nm('@radix-ui/react-select'),
      nm('react-day-picker'),
      nm('dexie-cloud-addon'),
      nm('@supabasex/thing'),
      '\0vite/preload-helper',
    ]) {
      expect(vendorChunkFor(id)).toBeUndefined()
    }
  })

  it('reads the innermost package of nested node_modules, and Windows paths', () => {
    expect(vendorChunkFor('/repo/node_modules/jspdf/node_modules/react/index.js')).toBe('react')
    expect(vendorChunkFor('/repo/node_modules/react-dom/node_modules/other/index.js')).toBeUndefined()
    expect(vendorChunkFor('C:\\repo\\node_modules\\dexie\\dist\\dexie.mjs')).toBe('dexie')
  })
})
