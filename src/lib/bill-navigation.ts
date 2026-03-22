/** Query key for “return to this in-app path after viewing/editing a bill”. */
export const BILL_BACK_QUERY = 'back'

/**
 * Only allow same-origin-style app paths (no open redirects).
 * Accepts raw or URL-encoded values.
 */
export function parseSafeAppPath(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null
  try {
    const decoded = decodeURIComponent(raw.trim())
    if (!decoded.startsWith('/app/')) return null
    if (decoded.includes('//')) return null
    if (decoded.includes(':')) return null
    return decoded
  } catch {
    return null
  }
}

/** Where the bill detail “Back” action should go: `back` query, then optional location state, else bills list. */
export function billDetailBackPath(options: {
  backSearchParam: string | null
  locationState: unknown
}): string {
  const fromQuery = parseSafeAppPath(options.backSearchParam)
  if (fromQuery) return fromQuery
  const s = options.locationState
  if (s && typeof s === 'object' && s !== null && 'backTo' in s) {
    const v = (s as { backTo?: unknown }).backTo
    if (typeof v === 'string') {
      const p = parseSafeAppPath(v)
      if (p) return p
    }
  }
  return '/app/bills'
}

export function withBillBackQuery(path: string, backTarget: string): string {
  const safe = parseSafeAppPath(backTarget)
  if (!safe || safe === '/app/bills') return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}${BILL_BACK_QUERY}=${encodeURIComponent(safe)}`
}
