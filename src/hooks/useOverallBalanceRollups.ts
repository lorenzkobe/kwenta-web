import { useEffect, useMemo, useState } from 'react'
import { computeAllGroupPairwiseBalances, type GroupPairwiseSummary } from '@/lib/settlement'
import { computeCombinedNetRollup, computePersonalNetRollup } from '@/lib/people'
import { groupReceivePayMapsFromSummaries } from '@/lib/balance-rollups'

export function useOverallBalanceRollups(userId: string | undefined) {
  const [summaries, setSummaries] = useState<GroupPairwiseSummary[]>([])
  const [personalReceive, setPersonalReceive] = useState<Map<string, number>>(new Map())
  const [personalPay, setPersonalPay] = useState<Map<string, number>>(new Map())
  // Combined (personal + group) receive/pay, netted per person — matches the person pages.
  const [overallReceive, setOverallReceive] = useState<Map<string, number>>(new Map())
  const [overallPay, setOverallPay] = useState<Map<string, number>>(new Map())
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
        setOverallReceive(new Map())
        setOverallPay(new Map())
        setLoading(false)
        return
      }

      setLoading(true)
      try {
        const [data, personal, combined] = await Promise.all([
          computeAllGroupPairwiseBalances(userId),
          computePersonalNetRollup(userId),
          computeCombinedNetRollup(userId),
        ])
        if (cancelled) return
        setSummaries(data)
        setPersonalReceive(personal.toReceiveByCurrency)
        setPersonalPay(personal.toPayByCurrency)
        setOverallReceive(combined.toReceiveByCurrency)
        setOverallPay(combined.toPayByCurrency)
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
