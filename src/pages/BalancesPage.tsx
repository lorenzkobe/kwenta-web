import { useState, useEffect, useCallback } from 'react'
import { ArrowRight, Check, History, Loader2, Scale, Users } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import {
  computeAllGroupBalances,
  type GroupBalanceSummary,
  type SettlementHistoryItem,
} from '@/lib/settlement'
import { useUserSettlementHistory } from '@/db/hooks'
import { SettlementHistoryList } from '@/components/common/SettlementHistoryList'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import { RecordSettlementDialog } from '@/components/common/RecordSettlementDialog'
import { formatCurrency, cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function BalancesPage() {
  const { userId } = useCurrentUser()
  const [summaries, setSummaries] = useState<GroupBalanceSummary[]>([])
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
    const data = await computeAllGroupBalances(userId)
    setSummaries(data)
  }, [userId])

  useEffect(() => {
    if (!userId) return
    setLoading(true)
    reloadSummaries().finally(() => setLoading(false))
  }, [userId, reloadSummaries])

  const overallOwed = summaries.reduce((sum, s) => sum + s.totalOwed, 0)
  const overallOwing = summaries.reduce((sum, s) => sum + s.totalOwing, 0)

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-5 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Balances</h1>
        <p className="mt-1 text-sm text-slate-600">
          See who should collect and who should pay
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/8 p-4">
          <p className="text-xs font-medium text-emerald-600/70">To collect</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-600">
            {formatCurrency(overallOwed)}
          </p>
        </div>
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/8 p-4">
          <p className="text-xs font-medium text-amber-600/70">To pay</p>
          <p className="mt-1 text-2xl font-semibold text-amber-600">
            {formatCurrency(overallOwing)}
          </p>
        </div>
      </div>

      {summaries.length === 0 ? (
        <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col items-center py-12 text-center">
            <div className="rounded-2xl bg-slate-100 p-4">
              <Scale className="size-6 text-slate-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-slate-500">No balances yet</p>
            <p className="mt-1 text-xs text-slate-400">
              Join a group and add bills to see balances
            </p>
            <Button asChild size="sm" className="mt-4 rounded-full">
              <Link to="/app/groups">
                <Users className="size-3.5" />
                Go to groups
              </Link>
            </Button>
          </div>
        </div>
      ) : (
        summaries.map((summary) => {
          const groupPaymentHistory =
            userSettlementHistory?.filter((h) => h.groupId === summary.groupId) ?? []
          return (
          <div
            key={summary.groupId}
            className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm"
          >
            <div className="flex items-center justify-between">
              <div>
                <Link
                  to={`/app/groups/${summary.groupId}`}
                  className="text-lg font-semibold text-slate-800 hover:text-blue-600"
                >
                  {summary.groupName}
                </Link>
                <p className="text-xs text-slate-400">{summary.currency}</p>
              </div>
              <div className="flex items-center gap-2">
                <Users className="size-4 text-blue-600" />
              </div>
            </div>

            <div className="mt-4">
              <p className="text-xs font-medium text-slate-400">Member balances</p>
              <div className="mt-2 space-y-1.5">
                {summary.balances
                  .filter((b) => Math.abs(b.amount) > 0.01)
                  .sort((a, b) => b.amount - a.amount)
                  .map((balance) => (
                    <div
                      key={balance.userId}
                      className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-100/60 px-4 py-2.5"
                    >
                      <div className="flex items-center gap-2.5">
                        <div className="flex size-7 items-center justify-center rounded-full bg-blue-600/15 text-xs font-semibold text-blue-600">
                          {balance.displayName.charAt(0).toUpperCase()}
                        </div>
                        <span className="text-sm font-medium text-slate-800">
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
                <p className="text-xs font-medium text-slate-400">
                  Suggested payments
                </p>
                <div className="mt-2 space-y-2">
                  {summary.suggestions.map((s) => {
                    const key = `${s.fromUserId}-${s.toUserId}`
                    return (
                      <div
                        key={key}
                        className="flex items-center justify-between rounded-xl border border-slate-200 bg-slate-100/60 px-4 py-3"
                      >
                        <div className="flex items-center gap-2 text-sm">
                          <span className="font-medium text-slate-800">{s.fromName}</span>
                          <ArrowRight className="size-3.5 text-slate-400" />
                          <span className="font-medium text-slate-800">{s.toName}</span>
                          <span className="font-semibold text-blue-600">
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
              <div className="mt-4 border-t border-slate-100 pt-4">
                <div className="flex items-center gap-2">
                  <History className="size-3.5 text-slate-400" />
                  <p className="text-xs font-medium text-slate-500">Payment history</p>
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
        })
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
