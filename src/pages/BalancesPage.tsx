import { useState, useEffect, useCallback, useMemo } from 'react'
import { ArrowRight, Check, History, Loader2, Scale, User, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import {
  computeAllGroupBalances,
  type GroupBalanceSummary,
  type SettlementHistoryItem,
} from '@/lib/settlement'
import { computePersonalNetRollup, getPersonalBalanceContactRows } from '@/lib/people'
import { useUserSettlementHistory } from '@/db/hooks'
import { SettlementHistoryList } from '@/components/common/SettlementHistoryList'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import { RecordSettlementDialog } from '@/components/common/RecordSettlementDialog'
import { formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

function mergeCurrencyTotals(
  a: Map<string, number>,
  b: Map<string, number>,
): Map<string, number> {
  const out = new Map(a)
  for (const [cur, v] of b) {
    out.set(cur, (out.get(cur) ?? 0) + v)
  }
  return out
}

function sumMapPositive(m: Map<string, number>): number {
  let s = 0
  for (const v of m.values()) s += v
  return s
}

export function BalancesPage() {
  const { userId } = useCurrentUser()
  const [summaries, setSummaries] = useState<GroupBalanceSummary[]>([])
  const [personalReceive, setPersonalReceive] = useState<Map<string, number>>(new Map())
  const [personalPay, setPersonalPay] = useState<Map<string, number>>(new Map())
  const [personalRows, setPersonalRows] = useState<
    Awaited<ReturnType<typeof getPersonalBalanceContactRows>>
  >([])
  const [loading, setLoading] = useState(true)
  const [editingSettlement, setEditingSettlement] = useState<SettlementHistoryItem | null>(null)
  const [recordSettlement, setRecordSettlement] = useState<{
    groupId: string
    currency: string
    fromUserId: string
    toUserId: string
    amount: number
    fromName: string
    toName: string
  } | null>(null)
  const userSettlementHistory = useUserSettlementHistory(userId ?? undefined)

  const reloadSummaries = useCallback(async () => {
    if (!userId) return
    const [data, personal, rows] = await Promise.all([
      computeAllGroupBalances(userId),
      computePersonalNetRollup(userId),
      getPersonalBalanceContactRows(userId),
    ])
    setSummaries(data)
    setPersonalReceive(personal.toReceiveByCurrency)
    setPersonalPay(personal.toPayByCurrency)
    setPersonalRows(rows)
  }, [userId])

  useEffect(() => {
    if (!userId) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reloadSummaries().finally(() => setLoading(false))
  }, [userId, reloadSummaries])

  const groupReceiveByCurrency = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of summaries) {
      if (s.totalToReceive <= 0) continue
      m.set(s.currency, (m.get(s.currency) ?? 0) + s.totalToReceive)
    }
    return m
  }, [summaries])

  const groupPayByCurrency = useMemo(() => {
    const m = new Map<string, number>()
    for (const s of summaries) {
      if (s.totalToPay <= 0) continue
      m.set(s.currency, (m.get(s.currency) ?? 0) + s.totalToPay)
    }
    return m
  }, [summaries])

  const overallReceiveByCurrency = useMemo(
    () => mergeCurrencyTotals(groupReceiveByCurrency, personalReceive),
    [groupReceiveByCurrency, personalReceive],
  )
  const overallPayByCurrency = useMemo(
    () => mergeCurrencyTotals(groupPayByCurrency, personalPay),
    [groupPayByCurrency, personalPay],
  )

  const hasPersonalNet =
    sumMapPositive(personalReceive) > 0.005 || sumMapPositive(personalPay) > 0.005
  const hasGroupSummaries = summaries.length > 0
  const showEmptyState = !hasGroupSummaries && !hasPersonalNet && personalRows.length === 0

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-teal-800" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Balances</h1>
        <p className="mt-1 text-sm text-stone-600">
          See who should receive and who should pay
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/8 p-4">
          <p className="text-xs font-medium text-emerald-600/70">To receive</p>
          {(() => {
            const lines = [...overallReceiveByCurrency.entries()].filter(([, v]) => v > 0.005)
            if (lines.length === 0) {
              return (
                <p className="mt-1 text-2xl font-semibold text-emerald-600">
                  {formatCurrency(0)}
                </p>
              )
            }
            if (lines.length === 1) {
              const [cur, v] = lines[0]
              return (
                <p className="mt-1 text-2xl font-semibold text-emerald-600">
                  {formatCurrency(v, cur)}
                </p>
              )
            }
            return (
              <ul className="mt-1 space-y-0.5">
                {lines.map(([cur, v]) => (
                  <li key={cur} className="text-lg font-semibold text-emerald-600">
                    {formatCurrency(v, cur)}
                  </li>
                ))}
              </ul>
            )
          })()}
        </div>
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4">
          <p className="text-xs font-medium text-amber-600/70">To pay</p>
          {(() => {
            const lines = [...overallPayByCurrency.entries()].filter(([, v]) => v > 0.005)
            if (lines.length === 0) {
              return (
                <p className="mt-1 text-2xl font-semibold text-amber-600">
                  {formatCurrency(0)}
                </p>
              )
            }
            if (lines.length === 1) {
              const [cur, v] = lines[0]
              return (
                <p className="mt-1 text-2xl font-semibold text-amber-600">
                  {formatCurrency(v, cur)}
                </p>
              )
            }
            return (
              <ul className="mt-1 space-y-0.5">
                {lines.map(([cur, v]) => (
                  <li key={cur} className="text-lg font-semibold text-amber-600">
                    {formatCurrency(v, cur)}
                  </li>
                ))}
              </ul>
            )
          })()}
        </div>
      </div>

      {showEmptyState ? (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col items-center py-12 text-center">
            <div className="rounded-2xl bg-stone-100 p-4">
              <Scale className="size-6 text-stone-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-stone-500">No balances yet</p>
            <p className="mt-1 text-xs text-stone-400">
              Add a personal bill or join a group and split expenses to see balances
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <Button asChild size="sm" className="rounded-full">
                <Link to="/app/people">
                  <User className="size-3.5" />
                  People
                </Link>
              </Button>
              <Button asChild size="sm" variant="secondary" className="rounded-full">
                <Link to="/app/groups">
                  <Users className="size-3.5" />
                  Groups
                </Link>
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <>
        {(() => {
          const personalPaymentHistory =
            userSettlementHistory?.filter((h) => h.groupId === null) ?? []
          const showPersonal =
            hasPersonalNet || personalPaymentHistory.length > 0 || personalRows.length > 0
          if (!showPersonal) return null
          return (
            <div
              key="personal"
              className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-center justify-between">
                <div>
                  <Link
                    to="/app/people"
                    className="text-lg font-semibold text-stone-800 hover:text-teal-800"
                  >
                    Personal
                  </Link>
                  <p className="text-xs text-stone-400">{hasPersonalNet ? 'Outside groups' : 'Settlements'}</p>
                </div>
                <User className="size-4 text-teal-800" />
              </div>
              {hasPersonalNet && (
                <div className="mt-4 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-emerald-500/15 bg-emerald-500/8 px-3 py-2">
                    <p className="text-xs font-medium text-emerald-600/70">To receive</p>
                    <div className="mt-1 space-y-0.5">
                      {[...personalReceive.entries()].filter(([, v]) => v > 0.005).length ===
                      0 ? (
                        <p className="text-sm font-semibold text-emerald-600">{formatCurrency(0)}</p>
                      ) : (
                        [...personalReceive.entries()]
                          .filter(([, v]) => v > 0.005)
                          .map(([cur, v]) => (
                            <p key={cur} className="text-sm font-semibold text-emerald-600">
                              {formatCurrency(v, cur)}
                            </p>
                          ))
                      )}
                    </div>
                  </div>
                  <div className="rounded-xl border border-amber-500/15 bg-amber-500/8 px-3 py-2">
                    <p className="text-xs font-medium text-amber-600/70">To pay</p>
                    <div className="mt-1 space-y-0.5">
                      {[...personalPay.entries()].filter(([, v]) => v > 0.005).length === 0 ? (
                        <p className="text-sm font-semibold text-amber-600">{formatCurrency(0)}</p>
                      ) : (
                        [...personalPay.entries()]
                          .filter(([, v]) => v > 0.005)
                          .map(([cur, v]) => (
                            <p key={cur} className="text-sm font-semibold text-amber-600">
                              {formatCurrency(v, cur)}
                            </p>
                          ))
                      )}
                    </div>
                  </div>
                </div>
              )}
              {personalRows.length > 0 && (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-medium text-stone-400">Per person (personal)</p>
                  <div className="space-y-1.5">
                    {personalRows.map((row) => (
                      <Link
                        key={row.otherId}
                        to={`/app/people/${row.otherId}`}
                        className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-2.5 text-sm transition-colors hover:bg-stone-100"
                      >
                        <span className="font-medium text-stone-800">{row.displayName}</span>
                        <div className="flex flex-wrap justify-end gap-x-2 gap-y-0.5 text-xs">
                          {[...row.netByCurrency.entries()]
                            .filter(([, v]) => Math.abs(v) > 0.005)
                            .map(([cur, v]) => (
                              <span
                                key={cur}
                                className={cn(
                                  'font-semibold',
                                  v > 0 ? 'text-emerald-600' : 'text-amber-600',
                                )}
                              >
                                {v > 0 ? '+' : ''}
                                {formatCurrency(v, cur)}
                              </span>
                            ))}
                        </div>
                      </Link>
                    ))}
                  </div>
                </div>
              )}
              {personalPaymentHistory.length > 0 && (
                <div className="mt-4 border-t border-stone-100 pt-4">
                  <div className="flex items-center gap-2">
                    <History className="size-3.5 text-stone-400" />
                    <p className="text-xs font-medium text-stone-500">Payment history</p>
                  </div>
                  <SettlementHistoryList
                    className="mt-2"
                    items={personalPaymentHistory}
                    currentUserId={userId}
                    onEdit={(item) => setEditingSettlement(item)}
                  />
                </div>
              )}
            </div>
          )
        })()}
        {summaries.map((summary) => {
          const groupPaymentHistory =
            userSettlementHistory?.filter((h) => h.groupId === summary.groupId) ?? []
          return (
          <div
            key={summary.groupId}
            className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div>
                <Link
                  to={`/app/groups/${summary.groupId}`}
                  className="text-lg font-semibold text-stone-800 hover:text-teal-800"
                >
                  {summary.groupName}
                </Link>
                <p className="text-xs text-stone-400">{summary.currency}</p>
              </div>
              <div className="flex items-center gap-2">
                <Users className="size-4 text-teal-800" />
              </div>
            </div>

            <div className="mt-4">
              <p className="text-xs font-medium text-stone-400">Member balances</p>
              <div className="mt-2 space-y-1.5">
                {summary.balances
                  .filter((b) => Math.abs(b.amount) > 0.01)
                  .sort((a, b) => b.amount - a.amount)
                  .map((balance) => (
                    <div
                      key={balance.userId}
                      className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-2.5"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="flex size-7 items-center justify-center rounded-full bg-teal-800/15 text-xs font-semibold text-teal-800">
                          {balance.displayName.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm font-medium text-stone-800">
                          {balance.displayName}
                        </span>
                      </div>
                      <span
                        className={cn(
                          'text-sm font-semibold',
                          balance.amount > 0 ? 'text-emerald-600' : 'text-amber-600',
                        )}
                      >
                        {balance.amount > 0 ? '+' : ''}
                        {formatCurrency(balance.amount, summary.currency)}
                      </span>
                    </div>
                  ))}
                {summary.balances.every((b) => Math.abs(b.amount) <= 0.01) && (
                  <div className="flex items-center justify-center gap-2 rounded-xl bg-emerald-500/10 px-4 py-3">
                    <Check className="size-4 text-emerald-600" />
                    <span className="text-sm font-medium text-emerald-600">All paid up</span>
                  </div>
                )}
              </div>
            </div>

            {summary.suggestions.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-stone-400">
                  Suggested payments
                </p>
                <div className="mt-2 space-y-2">
                  {summary.suggestions.map((s) => {
                    const key = `${s.fromUserId}-${s.toUserId}`
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3"
                      >
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium text-stone-800">{s.fromName}</span>
                          <ArrowRight className="size-3.5 text-stone-400" />
                          <span className="font-medium text-stone-800">{s.toName}</span>
                          <span className="font-semibold text-teal-800">
                            {formatCurrency(s.amount, summary.currency)}
                          </span>
                        </div>
                        <Button
                          variant="success"
                          size="xs"
                          className="rounded-lg"
                          type="button"
                          onClick={() =>
                            setRecordSettlement({
                              groupId: summary.groupId,
                              currency: summary.currency,
                              fromUserId: s.fromUserId,
                              toUserId: s.toUserId,
                              amount: s.amount,
                              fromName: s.fromName,
                              toName: s.toName,
                            })
                          }
                        >
                          <Check className="size-3" />
                          Pay
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {groupPaymentHistory.length > 0 && (
              <div className="mt-4 border-t border-stone-100 pt-4">
                <div className="flex items-center gap-2">
                  <History className="size-3.5 text-stone-400" />
                  <p className="text-xs font-medium text-stone-500">Payment history</p>
                </div>
                <SettlementHistoryList
                  className="mt-2"
                  items={groupPaymentHistory}
                  currentUserId={userId}
                  onEdit={(item) => setEditingSettlement(item)}
                />
              </div>
            )}
          </div>
          )
        })}
        </>
      )}

      {editingSettlement && (
        <EditSettlementDialog
          item={editingSettlement}
          onClose={() => setEditingSettlement(null)}
          onSaved={() => {
            void reloadSummaries()
          }}
        />
      )}

      {recordSettlement && userId && (
        <RecordSettlementDialog
          open
          onOpenChange={(o) => {
            if (!o) setRecordSettlement(null)
          }}
          groupId={recordSettlement.groupId}
          currency={recordSettlement.currency}
          fromUserId={recordSettlement.fromUserId}
          toUserId={recordSettlement.toUserId}
          defaultAmount={recordSettlement.amount}
          fromName={recordSettlement.fromName}
          toName={recordSettlement.toName}
          markedBy={userId}
          onRecorded={() => void reloadSummaries()}
        />
      )}
    </div>
  )
}
