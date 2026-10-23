import { useEffect, useRef, useState } from 'react'
import { fetchExchangeRate, type LiveRate } from '@/lib/exchange-rates'

/**
 * Today's rate for one currency pair, fetched once per pair change (and only when the pair
 * differs). Never gates a save: the form stays usable with `live` null while loading or offline.
 * `refresh` asks the provider again past the 12 h cache; everything it reports is keyed by pair,
 * so a pair change mid-refresh neither waits on nor inherits the old pair's answer.
 */
export function useExchangeRate(
  from: string,
  to: string,
): { live: LiveRate | null; loading: boolean; refreshing: boolean; refreshFailed: boolean; refresh: () => void } {
  const pair = from === to ? null : `${from}:${to}`
  const [resolved, setResolved] = useState<{ pair: string; live: LiveRate | null; refreshFailed: boolean } | null>(
    null,
  )
  const [refreshingPair, setRefreshingPair] = useState<string | null>(null)
  const pairRef = useRef(pair)
  // State lags a second tap in the same tick; the ref does not.
  const inFlight = useRef<string | null>(null)

  useEffect(() => {
    pairRef.current = pair
  }, [pair])

  useEffect(() => {
    if (!pair) return
    let cancelled = false
    void fetchExchangeRate(from, to).then((live) => {
      if (!cancelled) setResolved({ pair, live, refreshFailed: false })
    })
    return () => {
      cancelled = true
    }
  }, [pair, from, to])

  const current = pair !== null && resolved?.pair === pair ? resolved : null
  const refreshing = pair !== null && refreshingPair === pair

  const refresh = () => {
    if (pair === null || current === null || inFlight.current === pair) return
    inFlight.current = pair
    setRefreshingPair(pair)
    void fetchExchangeRate(from, to, { force: true }).then((fresh) => {
      if (inFlight.current === pair) inFlight.current = null
      setRefreshingPair((p) => (p === pair ? null : p))
      if (pairRef.current !== pair) return
      const failed = fresh === null || fresh.fromCache
      setResolved((prev) => ({
        pair,
        live: fresh ?? (prev?.pair === pair ? prev.live : null),
        refreshFailed: failed,
      }))
    })
  }

  return {
    live: current?.live ?? null,
    loading: pair !== null && current === null,
    refreshing,
    refreshFailed: current?.refreshFailed ?? false,
    refresh,
  }
}
