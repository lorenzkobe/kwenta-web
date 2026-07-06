import { type ReactNode, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { ArrowLeft, Banknote, Loader2, Receipt, Wallet } from 'lucide-react'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { resolveProfileDisplay } from '@/lib/people'
import { buildPersonMoneyFlow, type MoneyFlowNote, type MoneyFlowRow } from '@/lib/money-flow'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const PAGE_SIZE = 20

function noteText(row: MoneyFlowRow, otherName: string): string {
  const c = row.currency
  const map: Record<MoneyFlowNote, string> = {
    they_owe_you: `${otherName} owes you`,
    you_owe_them: `You owe ${otherName}`,
    covered_by_their_credit: 'Covered by their available credit',
    covered_by_your_credit: 'Covered by your available credit',
    cleared_their_debt: 'Cleared what they owed you',
    cleared_your_debt: 'Cleared what you owed',
    banked_their_credit: 'Saved entirely as their credit',
    banked_your_credit: 'Saved entirely as your credit',
    cleared_and_banked_their: `Cleared their debt · ${formatCurrency(
      row.explanation.creditChange,
      c,
    )} saved as their credit`,
    cleared_and_banked_your: `Cleared what you owed · ${formatCurrency(
      Math.abs(row.explanation.creditChange),
      c,
    )} saved as your credit`,
  }
  return map[row.explanation.note]
}

/** Bill rows carry a signed +/- effect; payments/credit show a neutral money amount. */
function isTheirDirectionBill(note: MoneyFlowNote): boolean {
  return note === 'they_owe_you' || note === 'covered_by_their_credit'
}

function LedgerRowItem({ row, otherName }: { row: MoneyFlowRow; otherName: string }) {
  const isBill = row.type === 'personal_bill' || row.type === 'group_bill'
  const Icon = row.type === 'general_payment' ? Wallet : isBill ? Receipt : Banknote

  let amountEl: ReactNode
  if (isBill) {
    const positive = isTheirDirectionBill(row.explanation.note)
    amountEl = (
      <span className={cn('text-sm font-semibold', positive ? 'text-emerald-700' : 'text-stone-600')}>
        {positive ? '+' : '−'}
        {formatCurrency(row.rawAmount, row.currency)}
      </span>
    )
  } else {
    amountEl = (
      <span className="text-sm font-semibold text-emerald-700">
        {formatCurrency(row.rawAmount, row.currency)}
      </span>
    )
  }

  const creditSuffix =
    row.theirCreditAvailable > 0.005
      ? ` · ${formatCurrency(row.theirCreditAvailable, row.currency)} their credit`
      : row.myCreditAvailable > 0.005
        ? ` · ${formatCurrency(row.myCreditAvailable, row.currency)} your credit`
        : ''

  return (
    <li className="flex items-start justify-between gap-3 rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-teal-500/15 text-teal-700">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-stone-800">{row.title}</p>
          <p className="mt-0.5 text-xs text-stone-500">
            {row.contextLabel} · {noteText(row, otherName)}
          </p>
          <p className="mt-0.5 text-[11px] text-stone-400">
            {new Date(row.createdAt).toLocaleDateString(undefined, {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
            })}
          </p>
        </div>
      </div>
      <div className="shrink-0 text-right">
        {amountEl}
        <p className="mt-0.5 text-xs text-stone-500">
          Bal {formatCurrency(row.runningNet, row.currency)}
          {creditSuffix}
        </p>
      </div>
    </li>
  )
}

export function PersonLedgerPage() {
  const { personId } = useParams<{ personId: string }>()
  const { userId } = useCurrentUser()
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const person = useLiveQuery(async () => {
    if (!personId || !userId) return null
    return resolveProfileDisplay(personId, userId)
  }, [personId, userId])
  const otherName = person?.displayName ?? 'Them'

  const flow = useLiveQuery(async () => {
    if (!personId || !userId) return null
    return buildPersonMoneyFlow(userId, personId)
  }, [personId, userId])

  if (!personId) return null

  // Newest-first for display + pagination; each row still carries the balance as of its event.
  const rowsDesc = flow ? [...flow.rows].reverse() : []
  const visibleRows = rowsDesc.slice(0, visibleCount)

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to={`/app/people/${personId}`}>
            <ArrowLeft className="size-4" />
            {otherName}
          </Link>
        </Button>
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <h1 className="text-lg font-semibold">Money flow</h1>
        <p className="mt-1 text-sm text-stone-500">
          Every bill and payment between you and {otherName}, in order, with a running balance.
        </p>

        {flow && flow.currentNet.size > 0 && (
          <div className="mt-4 space-y-2 rounded-2xl border border-stone-200 bg-stone-50/60 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-400">
              Where this stands
            </p>
            {[...flow.currentNet.entries()].map(([currency, net]) => {
              const their = flow.currentTheirCredit.get(currency) ?? 0
              const mine = flow.currentMyCredit.get(currency) ?? 0
              return (
                <div key={currency} className="text-sm text-stone-700">
                  <p className="font-medium">
                    {net > 0.005
                      ? `${otherName} owes you ${formatCurrency(net, currency)}`
                      : net < -0.005
                        ? `You owe ${otherName} ${formatCurrency(-net, currency)}`
                        : 'Settled up'}
                  </p>
                  {their > 0.005 && (
                    <p className="text-xs text-stone-500">
                      {otherName} has {formatCurrency(their, currency)} credit with you (a prepayment
                      not yet applied to any bill).
                    </p>
                  )}
                  {mine > 0.005 && (
                    <p className="text-xs text-stone-500">
                      You have {formatCurrency(mine, currency)} credit with {otherName} (a prepayment
                      not yet applied to any bill).
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        {flow === undefined ? (
          <div className="flex items-center gap-2 text-sm text-stone-500">
            <Loader2 className="size-4 animate-spin text-teal-800" />
            Loading money flow…
          </div>
        ) : rowsDesc.length === 0 ? (
          <p className="text-sm text-stone-500">No bills or payments between you yet.</p>
        ) : (
          <>
            <ul className="space-y-2">
              {visibleRows.map((row) => (
                <LedgerRowItem key={`${row.type}-${row.id}`} row={row} otherName={otherName} />
              ))}
            </ul>
            {rowsDesc.length > visibleCount && (
              <button
                type="button"
                onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
                className="mt-3 w-full rounded-xl border border-stone-200 py-2.5 text-sm font-medium text-stone-500 transition-colors hover:bg-stone-50"
              >
                Show more ({rowsDesc.length - visibleCount} remaining)
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
