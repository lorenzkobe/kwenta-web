import { db } from '@/db/db'
import { MONEY_EPSILON, roundMoney } from '@/lib/utils'
import { expandProfileIdsForSplitMatching, listBillsInvolvingPair } from '@/lib/people'

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
 * Reconciliation invariant: per currency, the final `runningNet` equals
 * `computePairwiseNetAllContexts(meId, otherId)`. To hold this, each context mirrors the
 * exact matching rule of the balance function it reconciles to:
 *  - personal events use the EXPANDED id-sets (like `computePairwiseNetPersonalOnly`),
 *  - group events use the EXACT `meId` + roster id and the group-currency filter
 *    (like `computeGroupPairwiseBalances`).
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

interface RawEvent {
  id: string
  type: MoneyFlowRowType
  createdAt: string
  currency: string
  groupId: string | null
  bundleId: string | null
  contextLabel: string
  title: string
  rawAmount: number
  /** Signed change to the personal net (personal bills + personal payments). */
  billNetDelta: number
  /** Signed change to the group net in this currency. */
  groupNetDelta: number
}

interface GroupInfo {
  currency: string
  name: string
  otherRosterId: string
}

/**
 * Sum a single bill's pairwise delta from item-splits only (settlements are separate rows).
 *
 * `firstMatchOnly` selects the matching rule of the balance function this reconciles to:
 *  - personal bills mirror `computePairwiseNetPersonalOnly` (ONE split per side per item, via
 *    `.find`) — so peer-linked ids for the same person on one item don't double-count,
 *  - group bills mirror `computeGroupPairwiseBalances` (sum EVERY matching split).
 */
async function sumBillDelta(
  billId: string,
  paidBy: string,
  isMe: (id: string) => boolean,
  isOther: (id: string) => boolean,
  firstMatchOnly: boolean,
): Promise<number> {
  const payerMe = isMe(paidBy)
  const payerOther = isOther(paidBy)
  if (!payerMe && !payerOther) return 0 // third-party payer → nothing for our pair
  const items = (await db.bill_items.where('bill_id').equals(billId).toArray()).filter(
    (i) => !i.is_deleted,
  )
  let delta = 0
  for (const it of items) {
    const splits = (await db.item_splits.where('item_id').equals(it.id).toArray()).filter(
      (s) => !s.is_deleted,
    )
    if (firstMatchOnly) {
      if (payerMe) {
        const other = splits.find((sp) => isOther(sp.user_id))
        if (other) delta += other.computed_amount
      } else {
        const mine = splits.find((sp) => isMe(sp.user_id))
        if (mine) delta -= mine.computed_amount
      }
    } else {
      for (const sp of splits) {
        if (payerMe && isOther(sp.user_id)) delta += sp.computed_amount
        else if (payerOther && isMe(sp.user_id)) delta -= sp.computed_amount
      }
    }
  }
  return roundMoney(delta)
}

async function resolveOtherName(otherIds: Set<string>): Promise<string> {
  for (const id of otherIds) {
    const p = await db.profiles.get(id)
    if (p && !p.is_deleted && p.display_name?.trim()) return p.display_name.trim()
  }
  // Fall back to a live roster name; skip soft-deleted memberships so a removed member's
  // stale name doesn't win over an active one.
  const members = await db.group_members.where('user_id').anyOf([...otherIds]).toArray()
  const named = members.find((m) => !m.is_deleted && m.display_name?.trim())
  if (named) return named.display_name.trim()
  return 'Them'
}

export async function buildPersonMoneyFlow(meId: string, otherId: string): Promise<MoneyFlowResult> {
  const meIds = await expandProfileIdsForSplitMatching(meId, meId)
  const otherIds = await expandProfileIdsForSplitMatching(otherId, meId)
  const otherName = await resolveOtherName(otherIds)

  // Groups I'm a member of, with the other person resolved to their roster id.
  const myMemberships = await db.group_members.where('user_id').anyOf([...meIds]).toArray()
  const myGroupIds = [...new Set(myMemberships.filter((m) => !m.is_deleted).map((m) => m.group_id))]
  const groupInfo = new Map<string, GroupInfo>()
  for (const gid of myGroupIds) {
    const g = await db.groups.get(gid)
    if (!g || g.is_deleted) continue
    const members = await db.group_members.where('group_id').equals(gid).toArray()
    const om = members.find((m) => !m.is_deleted && otherIds.has(m.user_id))
    if (!om) continue
    groupInfo.set(gid, { currency: g.currency, name: g.name, otherRosterId: om.user_id })
  }

  const events: RawEvent[] = []

  // --- Bills (personal + group) ---
  const bills = await listBillsInvolvingPair(meId, otherId)
  for (const bill of bills) {
    if (bill.group_id == null) {
      const delta = await sumBillDelta(
        bill.id,
        bill.paid_by,
        (id) => meIds.has(id),
        (id) => otherIds.has(id),
        true, // personal: one split per side per item (peer-link safe)
      )
      if (Math.abs(delta) <= MONEY_EPSILON) continue
      events.push({
        id: bill.id,
        type: 'personal_bill',
        createdAt: bill.created_at,
        currency: bill.currency,
        groupId: null,
        bundleId: null,
        contextLabel: 'Personal',
        title: bill.title,
        rawAmount: Math.abs(delta),
        billNetDelta: delta,
        groupNetDelta: 0,
      })
    } else {
      const gi = groupInfo.get(bill.group_id)
      if (!gi) continue
      if (bill.currency && bill.currency !== gi.currency) continue // matches balance-fn filter
      const delta = await sumBillDelta(
        bill.id,
        bill.paid_by,
        (id) => id === meId,
        (id) => id === gi.otherRosterId,
        false, // group: sum every matching split (mirrors computeGroupPairwiseBalances)
      )
      if (Math.abs(delta) <= MONEY_EPSILON) continue
      events.push({
        id: bill.id,
        type: 'group_bill',
        createdAt: bill.created_at,
        currency: gi.currency,
        groupId: bill.group_id,
        bundleId: null,
        contextLabel: gi.name,
        title: bill.title,
        rawAmount: Math.abs(delta),
        billNetDelta: 0,
        groupNetDelta: delta,
      })
    }
  }

  // --- Payments (personal + group settlements, all as plain signed deltas) ---
  const settlements = await db.settlements.filter((s) => !s.is_deleted && s.is_settled).toArray()
  for (const s of settlements) {
    if (s.amount <= MONEY_EPSILON) continue
    if (s.group_id != null) {
      const gi = groupInfo.get(s.group_id)
      if (!gi) continue
      if (s.currency && s.currency !== gi.currency) continue
      const iToThem = s.from_user_id === meId && s.to_user_id === gi.otherRosterId
      const themToMe = s.to_user_id === meId && s.from_user_id === gi.otherRosterId
      if (!iToThem && !themToMe) continue
      events.push({
        id: s.id,
        type: 'payment',
        createdAt: s.created_at,
        currency: gi.currency,
        groupId: s.group_id,
        bundleId: s.bundle_id ?? null,
        contextLabel: gi.name,
        title: iToThem ? `You paid ${otherName}` : `${otherName} paid you`,
        rawAmount: s.amount,
        billNetDelta: 0,
        groupNetDelta: iToThem ? s.amount : -s.amount,
      })
      continue
    }
    // personal (group_id === null) — expanded matching; bill-tagged or not, plain signed.
    const fromMe = meIds.has(s.from_user_id)
    const toMe = meIds.has(s.to_user_id)
    const fromOther = otherIds.has(s.from_user_id)
    const toOther = otherIds.has(s.to_user_id)
    const iToThem = fromMe && toOther
    const themToMe = fromOther && toMe
    if (!iToThem && !themToMe) continue
    events.push({
      id: s.id,
      type: 'payment',
      createdAt: s.created_at,
      currency: s.currency,
      groupId: null,
      bundleId: s.bundle_id ?? null,
      contextLabel: 'Personal',
      title: iToThem ? `You paid ${otherName}` : `${otherName} paid you`,
      rawAmount: s.amount,
      billNetDelta: iToThem ? s.amount : -s.amount,
      groupNetDelta: 0,
    })
  }

  events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  // --- Running-balance pass (plain signed sum) ---
  const billNet = new Map<string, number>()
  const groupNet = new Map<string, number>()
  const prevRunning = new Map<string, number>()

  const rows: MoneyFlowRow[] = []
  for (const ev of events) {
    const cur = ev.currency
    billNet.set(cur, roundMoney((billNet.get(cur) ?? 0) + ev.billNetDelta))
    groupNet.set(cur, roundMoney((groupNet.get(cur) ?? 0) + ev.groupNetDelta))
    const runningNet = roundMoney((billNet.get(cur) ?? 0) + (groupNet.get(cur) ?? 0))
    const signedAmount = roundMoney(ev.billNetDelta + ev.groupNetDelta)
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

  // --- Current standing per currency ---
  const currentNet = new Map<string, number>()
  const currencies = new Set<string>([...billNet.keys(), ...groupNet.keys()])
  for (const cur of currencies) {
    currentNet.set(cur, roundMoney((billNet.get(cur) ?? 0) + (groupNet.get(cur) ?? 0)))
  }

  return { rows, currentNet }
}

function describeNote(type: MoneyFlowRowType, signedAmount: number): MoneyFlowNote {
  if (type === 'payment') {
    return signedAmount >= 0 ? 'you_paid_them' : 'they_paid_you'
  }
  return signedAmount >= 0 ? 'they_owe_you' : 'you_owe_them'
}
