import { compareInstants } from '@/lib/instant'
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
 * The running balance is computed by the server (migration 086, `kwenta_person_statement_page`):
 * the statement is paged, so the client holds a window of the events and cannot walk them. Which
 * events belong to a pair is migration 062's matching rules, and per currency the newest
 * `runningNet` equals the total reported by `kwenta_person_summary`; the SQL suites pin both.
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
}

/**
 * One event of `kwenta_person_statement_page` (migration 086): a bill or payment between the two
 * people, with its signed effect on the tab and the tab on either side of it.
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
  /** The tab in this event's currency AFTER it, over every event of the history, not this page. */
  runningNet: number
  /** The tab in this event's currency BEFORE it. */
  prevRunning: number
}

/**
 * Map server events to statement rows, oldest first.
 *
 * Nothing is summed here: `runningNet` is the server's, so a page from the middle of the history,
 * or a payments-only page whose bills sit between the rows, shows the balance it really had. The
 * events are re-sorted (instant, then id) because `collapsePaymentLegs` needs a bundle's legs
 * adjacent and a page arrives newest first. The order is the server's (timestamptz, then uuid):
 * strings are not compared with `localeCompare`, which puts '.' before '+' and so misorders
 * `10:00:00+00:00` and `10:00:00.0001+00:00`.
 */
export function buildMoneyFlowRows(events: MoneyFlowEvent[]): MoneyFlowResult {
  const ordered = [...events].sort(
    (a, b) => compareInstants(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )

  const rows = ordered.map((ev): MoneyFlowRow => {
    const signedAmount = roundMoney(ev.delta)
    return {
      id: ev.id,
      type: ev.type,
      createdAt: ev.createdAt,
      currency: ev.currency,
      groupId: ev.groupId,
      bundleId: ev.bundleId,
      contextLabel: ev.contextLabel,
      title: ev.title,
      rawAmount: ev.rawAmount,
      signedAmount,
      runningNet: ev.runningNet,
      explanation: {
        balanceDelta: roundMoney(ev.runningNet - ev.prevRunning),
        note: describeNote(ev.type, signedAmount),
      },
    }
  })

  return { rows }
}

function describeNote(type: MoneyFlowRowType, signedAmount: number): MoneyFlowNote {
  if (type === 'payment') {
    return signedAmount >= 0 ? 'you_paid_them' : 'they_paid_you'
  }
  return signedAmount >= 0 ? 'they_owe_you' : 'you_owe_them'
}

/** One context a statement row touched: personal (`groupId === null`) or a specific group. */
export interface StatementPart {
  groupId: string | null
  /** 'Personal' or the group's name. */
  label: string
  /** Magnitude of this slice (all legs of one payment share a direction). */
  amount: number
}

/** A statement row as displayed: payment legs of one bundle merged into a single line. */
export interface StatementDisplayRow {
  key: string
  kind: 'bill' | 'payment'
  /** Underlying bill id for bill rows (for opening the detail sheet); null for payments. */
  billId: string | null
  title: string
  createdAt: string
  currency: string
  /** + they owe me effect / − I owe them. */
  signedAmount: number
  runningNet: number
  settlementIds: string[]
  bundleId: string | null
  /**
   * Where this row's money sat, one entry per context. A bill and a single-context payment have
   * exactly one; more than one means the payment was SPLIT across contexts.
   *
   * This exists because keeping only the first leg's context was wrong: a payment split across
   * personal and a group is written personal-leg-first, so the merged row inherited
   * `groupId: null` and displayed group money as personal money.
   */
  parts: StatementPart[]
}

/**
 * Merge adjacent payment legs sharing a bundleId into one atomic payment line.
 *
 * The legs of a multi-context payment are one real transfer, so the statement shows one row —
 * but it must still say where each slice went, which is what `parts` carries. Bill rows are never
 * merged. Adjacency is enough because `buildMoneyFlowRows` orders by `createdAt` then `id`, and the
 * server never ends a page inside a bundle (086), so all of a bundle's legs are on the page.
 */
export function collapsePaymentLegs(rows: MoneyFlowRow[]): StatementDisplayRow[] {
  const out: StatementDisplayRow[] = []
  for (const r of rows) {
    const kind: 'bill' | 'payment' = r.type === 'payment' ? 'payment' : 'bill'
    const last = out[out.length - 1]
    if (
      kind === 'payment' &&
      r.bundleId &&
      last &&
      last.kind === 'payment' &&
      last.bundleId === r.bundleId &&
      last.currency === r.currency
    ) {
      last.signedAmount = roundMoney(last.signedAmount + r.signedAmount)
      last.runningNet = r.runningNet
      last.settlementIds.push(r.id)
      addPart(last.parts, r)
      continue
    }
    out.push({
      key: `${r.type}-${r.id}`,
      kind,
      billId: kind === 'bill' ? r.id : null,
      title: r.title,
      createdAt: r.createdAt,
      currency: r.currency,
      signedAmount: r.signedAmount,
      runningNet: r.runningNet,
      settlementIds: kind === 'payment' ? [r.id] : [],
      bundleId: r.bundleId,
      parts: [{ groupId: r.groupId, label: r.contextLabel, amount: Math.abs(r.signedAmount) }],
    })
  }
  return out
}

/** Two legs in the SAME context are one slice, not two lines. */
function addPart(parts: StatementPart[], r: MoneyFlowRow): void {
  const existing = parts.find((p) => p.groupId === r.groupId)
  if (existing) {
    existing.amount = roundMoney(existing.amount + Math.abs(r.signedAmount))
    return
  }
  parts.push({ groupId: r.groupId, label: r.contextLabel, amount: Math.abs(r.signedAmount) })
}
