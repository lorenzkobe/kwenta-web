import { roundMoney } from '@/lib/utils'

/**
 * Money-flow statement between the current user ("me") and one other person.
 *
 * A chronological running-balance statement that interleaves EVERY bill and payment
 * between the two — personal and across every shared group. The balance is a plain
 * signed sum: bills add, payments subtract, overpayment flips the sign (no "credit").
 *
 * Sign convention (matches the rest of the codebase): positive = they owe me / I receive,
 * negative = I owe them / I pay.
 *
 * Reconciliation invariant: per currency, the final `runningNet` equals the total reported by
 * `kwenta_person_summary`. The matching rules that make it hold now live in migration 062 (and
 * are pinned by its SQL suite) — personal events take one split per side per item under expanded
 * ids, group events sum every matching split under exact roster ids.
 */

export type MoneyFlowRowType = 'personal_bill' | 'group_bill' | 'payment'

/** A semantic key describing what a row did to the balance; the UI maps it to display text. */
export type MoneyFlowNote = 'they_owe_you' | 'you_owe_them' | 'they_paid_you' | 'you_paid_them'

export interface MoneyFlowExplanation {
  /** Signed change this row made to the running net (in the row's currency). */
  balanceDelta: number
  note: MoneyFlowNote
}

export interface MoneyFlowRow {
  /** Stable key: the underlying bill or settlement id. */
  id: string
  type: MoneyFlowRowType
  createdAt: string
  currency: string
  groupId: string | null
  /** Bundle id when this payment is one leg of a multi-leg atomic payment, else null. */
  bundleId: string | null
  /** 'Personal' or the group's name. */
  contextLabel: string
  /** Bill title, or a "You paid X" / "X paid you" phrase for payments. */
  title: string
  /** Magnitude of the event: a bill's pairwise share, or a payment amount. */
  rawAmount: number
  /** Signed effect on the tab (+ they owe me / − I owe them). */
  signedAmount: number
  /** Overall net AFTER this row, in this row's currency (+ they owe me). */
  runningNet: number
  explanation: MoneyFlowExplanation
}

export interface MoneyFlowResult {
  /** Chronological ASCENDING. The UI reverses for a newest-first display. */
  rows: MoneyFlowRow[]
  currentNet: Map<string, number>
}

/**
 * One event from `kwenta_person_statement` (migration 062): a bill or payment between the two
 * people, with its signed effect on the tab.
 */
export interface MoneyFlowEvent {
  id: string
  type: MoneyFlowRowType
  createdAt: string
  currency: string
  groupId: string | null
  bundleId: string | null
  contextLabel: string
  title: string
  rawAmount: number
  /** Signed change to the tab: + they owe me, - I owe them. */
  delta: number
}

/**
 * Walk the events in order, carrying a per-currency running net.
 *
 * This is the half of the statement that stayed in TypeScript: a pure transform of a bounded
 * list (CLAUDE.md rule 8). Deciding WHICH bills and payments involve this pair, and what each
 * did to the tab, is aggregation over unbounded data and now lives in migration 062.
 *
 * The events must arrive in ascending chronological order — the server orders them by
 * `createdAt` then `id` so the walk is deterministic across devices — but this re-sorts anyway
 * rather than trusting the caller, because a mis-ordered walk silently produces wrong running
 * balances instead of failing.
 */
export function buildMoneyFlowRows(events: MoneyFlowEvent[]): MoneyFlowResult {
  const ordered = [...events].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  )

  const net = new Map<string, number>()
  const prevRunning = new Map<string, number>()
  const rows: MoneyFlowRow[] = []

  for (const ev of ordered) {
    const cur = ev.currency
    const runningNet = roundMoney((net.get(cur) ?? 0) + ev.delta)
    net.set(cur, runningNet)
    const signedAmount = roundMoney(ev.delta)
    const balanceDelta = roundMoney(runningNet - (prevRunning.get(cur) ?? 0))

    rows.push({
      id: ev.id,
      type: ev.type,
      createdAt: ev.createdAt,
      currency: cur,
      groupId: ev.groupId,
      bundleId: ev.bundleId,
      contextLabel: ev.contextLabel,
      title: ev.title,
      rawAmount: ev.rawAmount,
      signedAmount,
      runningNet,
      explanation: { balanceDelta, note: describeNote(ev.type, signedAmount) },
    })

    prevRunning.set(cur, runningNet)
  }

  return { rows, currentNet: net }
}

function describeNote(type: MoneyFlowRowType, signedAmount: number): MoneyFlowNote {
  if (type === 'payment') {
    return signedAmount >= 0 ? 'you_paid_them' : 'they_paid_you'
  }
  return signedAmount >= 0 ? 'they_owe_you' : 'you_owe_them'
}
