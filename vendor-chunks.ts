/**
 * Which vendor chunk a module belongs in, for `build.rollupOptions.output.manualChunks`.
 *
 * Only libraries the entry chunk already loads on every visit are grouped: their own chunks keep a
 * stable content hash across app-only deploys, so the service worker does not make every user
 * re-download ~600 kB of unchanged vendor code with each release. A manual chunk is loaded by
 * whatever imports it, so a LAZY-only library (jspdf, html2canvas, the Radix select) must never be
 * listed here — grouping it with an eager one would move it onto the first load.
 */
const VENDOR_CHUNKS: Record<string, string> = {
  react: 'react',
  'react-dom': 'react',
  scheduler: 'react',
  'react-router': 'react',
  'react-router-dom': 'react',
  'iceberg-js': 'supabase',
  dexie: 'dexie',
  'dexie-react-hooks': 'dexie',
}

export function vendorChunkFor(id: string): string | undefined {
  const path = id.replace(/\\/g, '/')
  const at = path.lastIndexOf('/node_modules/')
  if (at === -1) return undefined
  const segments = path.slice(at + '/node_modules/'.length).split('/')
  const pkg = segments[0].startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0]
  if (pkg.startsWith('@supabase/')) return 'supabase'
  return VENDOR_CHUNKS[pkg]
}
