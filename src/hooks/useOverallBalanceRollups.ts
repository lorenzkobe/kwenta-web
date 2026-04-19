import { useEffect, useMemo, useState } from 'react'
import { computeAllGroupBalances, type GroupBalanceSummary } from '@/lib/settlement'
import { computePersonalNetRollup } from '@/lib/people'
import {
  groupReceivePayMapsFromSummaries,
  mergeCurrencyTotals,
} from '@/lib/balance-rollups'

export function useOverallBalanceRollups(userId: string | undefined) {
  const [summaries, setSummaries] = useState<GroupBalanceSummary[]>([])
  const [personalReceive, setPersonalReceive] = useState<Map<string, number>>(new Map())
  const [personalPay, setPersonalPay] = useState<Map<string, number>>(new Map())
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      await Promise.resolve()
      if (cancelled) return

      if (!userId) {
        setSummaries([])
        setPersonalReceive(new Map())
        setPersonalPay(new Map())
        setLoading(false)
        return
      }

      setLoading(true)
      try {
        const [data, personal] = await Promise.all([
          computeAllGroupBalances(userId),
          computePersonalNetRollup(userId),
        ])
        if (cancelled) return
        setSummaries(data)
        setPersonalReceive(personal.toReceiveByCurrency)
        setPersonalPay(personal.toPayByCurrency)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [userId])

  const { groupReceive, groupPay } = useMemo(
    () => groupReceivePayMapsFromSummaries(summaries),
    [summaries],
  )

  const overallReceive = useMemo(
    () => mergeCurrencyTotals(groupReceive, personalReceive),
    [groupReceive, personalReceive],
  )
  const overallPay = useMemo(
    () => mergeCurrencyTotals(groupPay, personalPay),
    [groupPay, personalPay],
  )

  return {
    loading,
    groupReceive,
    groupPay,
    personalReceive,
    personalPay,
    overallReceive,
    overallPay,
  }
}
