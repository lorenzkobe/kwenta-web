import { useEffect, useState } from 'react'
import { fetchExchangeRate, type LiveRate } from '@/lib/exchange-rates'

/**
 * Today's rate for one currency pair, fetched once per pair change (and only when the pair
 * differs). Never gates a save: the form stays usable with `live` null while loading or offline.
 */
export function useExchangeRate(from: string, to: string): { live: LiveRate | null; loading: boolean } {
  const pair = from === to ? null : `${from}:${to}`
  const [resolved, setResolved] = useState<{ pair: string; live: LiveRate | null } | null>(null)

  useEffect(() => {
    if (!pair) return
    let cancelled = false
    void fetchExchangeRate(from, to).then((live) => {
      if (!cancelled) setResolved({ pair, live })
    })
    return () => {
      cancelled = true
    }
  }, [pair, from, to])

  const current = pair !== null && resolved?.pair === pair ? resolved : null
  return { live: current?.live ?? null, loading: pair !== null && current === null }
}
