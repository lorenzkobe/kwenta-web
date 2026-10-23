import { isValidRate } from '@/lib/currency-conversion'

export interface LiveRate {
  rate: number
  fetchedAt: string
  fromCache: boolean
}

const FRESH_MS = 12 * 60 * 60 * 1000
const TIMEOUT_MS = 8000

function cacheKey(from: string, to: string): string {
  return `kwenta_fx_v1:${from}:${to}`
}

export function readCachedExchangeRate(from: string, to: string): LiveRate | null {
  try {
    const raw = localStorage.getItem(cacheKey(from, to))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { rate, fetchedAt } = parsed as { rate?: unknown; fetchedAt?: unknown }
    if (!isValidRate(rate) || typeof fetchedAt !== 'string' || Number.isNaN(Date.parse(fetchedAt))) return null
    return { rate, fetchedAt, fromCache: true }
  } catch {
    return null
  }
}

/**
 * Prefill for the rate field: how many `to` units one `from` unit buys. The quote is requested
 * with the balance currency as BASE (6+ significant digits; the direct VND quote carries 4) and
 * inverted. Never throws and never gates a save: any failure serves the last cached rate or null.
 */
export async function fetchExchangeRate(
  from: string,
  to: string,
  opts: { now?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<LiveRate | null> {
  const nowMs = (opts.now ?? Date.now)()
  if (from === to) return { rate: 1, fetchedAt: new Date(nowMs).toISOString(), fromCache: false }

  const cached = readCachedExchangeRate(from, to)
  if (cached) {
    const age = nowMs - Date.parse(cached.fetchedAt)
    if (age >= 0 && age < FRESH_MS) return cached
  }

  try {
    const res = await (opts.fetchImpl ?? fetch)(`https://open.er-api.com/v6/latest/${encodeURIComponent(to)}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) return cached
    const body = (await res.json()) as { result?: unknown; rates?: Record<string, unknown> } | null
    const quoted = body?.result === 'success' ? body.rates?.[from] : undefined
    if (!isValidRate(quoted)) return cached
    const live: LiveRate = { rate: 1 / quoted, fetchedAt: new Date(nowMs).toISOString(), fromCache: false }
    try {
      localStorage.setItem(cacheKey(from, to), JSON.stringify({ rate: live.rate, fetchedAt: live.fetchedAt }))
    } catch {
      // Storage disabled or full: the rate still serves this form.
    }
    return live
  } catch {
    return cached
  }
}
