import { db } from '@/db/db'
import { MONEY_EPSILON, roundMoney } from '@/lib/utils'
import { expandProfileIdsForSplitMatching, listBillsInvolvingPair } from '@/lib/people'

/**
 * Money-flow ledger between the current user ("me") and one other person.
 *
 * A chronological running-balance statement that interleaves EVERY bill and payment
 * between the two — personal and across every shared group — plus general-credit events.
 * Its purpose is to demystify the credit-clamped headline balance and, especially,
 * "available general credit": you can watch the exact overpayment that created it and
 * see it get consumed.
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
 * Credit is personal-only; group settlements adjust group net directly (no pooling).
 */

export type MoneyFlowRowType = 'personal_bill' | 'group_bill' | 'payment' | 'general_payment'

/**
 * A semantic key describing what a row did to the balance. The UI maps it to display text;
 * kept as a key (not a formatted sentence) so currency formatting stays a UI concern.
 */
export type MoneyFlowNote =
  | 'they_owe_you'
  | 'you_owe_them'
  | 'covered_by_their_credit'
  | 'covered_by_your_credit'
  | 'cleared_their_debt'
  | 'cleared_your_debt'
  | 'banked_their_credit'
  | 'banked_your_credit'
  | 'cleared_and_banked_their'
  | 'cleared_and_banked_your'

export interface MoneyFlowExplanation {
  /** Signed change this row made to the overall running net (in the row's currency). */
  balanceDelta: number
  /** Signed change to total available credit (their credit minus my credit). */
  creditChange: number
  /** How much of a payment went to clearing a real debt (>= 0). */
  clearedAmount: number
  note: MoneyFlowNote
}

export interface MoneyFlowRow {
  /** Stable key: the underlying bill or settlement id. */
  id: string
  type: MoneyFlowRowType
  createdAt: string
  currency: string
  groupId: string | null
  /** 'Personal' or the group's name. */
  contextLabel: string
  /** Bill title, or a "You paid X" / "X paid you" phrase for payments. */
  title: string
  /** Magnitude of the event: a bill's pairwise share, or a payment amount. */
  rawAmount: number
  /** Overall net AFTER this row, in this row's currency (+ they owe me). */
  runningNet: number
  /** Their available credit (they prepaid me) AFTER this row, >= 0. */
  theirCreditAvailable: number
  /** My available credit (I prepaid them) AFTER this row, >= 0. */
  myCreditAvailable: number
  explanation: MoneyFlowExplanation
}

export interface MoneyFlowResult {
  /** Chronological ASCENDING. The UI reverses for a newest-first display. */
  rows: MoneyFlowRow[]
  currentNet: Map<string, number>
  currentTheirCredit: Map<string, number>
  currentMyCredit: Map<string, number>
}

interface RawEvent {
  id: string
  type: MoneyFlowRowType
  createdAt: string
  currency: string
  groupId: string | null
  contextLabel: string
  title: string
  rawAmount: number
  /** Signed change to the personal bill-net (personal bills + personal bill-tagged payments). */
  billNetDelta: number
  /** Signed change to the group net in this currency. */
  groupNetDelta: number
  /** Amount they prepaid me (untargeted personal payment) at this event. */
  prepaidByThemDelta: number
  /** Amount I prepaid them (untargeted personal payment) at this event. */
  prepaidByMeDelta: number
}

interface GroupInfo {
  currency: string
  name: string
  otherRosterId: string
}

/** Clamp helpers mirror `computePairwiseNetPersonalOnly` (people.ts) exactly. */
function effectivePersonalNet(billNet: number, prepaidThem: number, prepaidMe: number): number {
  if (billNet > 0) return roundMoney(billNet - Math.min(billNet, prepaidThem))
  if (billNet < 0) return roundMoney(billNet + Math.min(-billNet, prepaidMe))
  return 0
}

function availableTheirCredit(billNet: number, prepaidThem: number): number {
  return roundMoney(prepaidThem - Math.min(Math.max(billNet, 0), prepaidThem))
}

function availableMyCredit(billNet: number, prepaidMe: number): number {
  return roundMoney(prepaidMe - Math.min(Math.max(-billNet, 0), prepaidMe))
}

/** Sum a single bill's pairwise delta from item-splits only (settlements are separate rows). */
async function sumBillDelta(
  billId: string,
  paidBy: string,
  isMe: (id: string) => boolean,
  isOther: (id: string) => boolean,
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
    for (const sp of splits) {
      if (payerMe && isOther(sp.user_id)) delta += sp.computed_amount
      else if (payerOther && isMe(sp.user_id)) delta -= sp.computed_amount
    }
  }
  return roundMoney(delta)
}

async function resolveOtherName(otherIds: Set<string>): Promise<string> {
  for (const id of otherIds) {
    const p = await db.profiles.get(id)
    if (p && !p.is_deleted && p.display_name?.trim()) return p.display_name.trim()
  }
  const member = await db.group_members.where('user_id').anyOf([...otherIds]).first()
  if (member?.display_name?.trim()) return member.display_name.trim()
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
      )
      if (Math.abs(delta) <= MONEY_EPSILON) continue
      events.push({
        id: bill.id,
        type: 'personal_bill',
        createdAt: bill.created_at,
        currency: bill.currency,
        groupId: null,
        contextLabel: 'Personal',
        title: bill.title,
        rawAmount: Math.abs(delta),
        billNetDelta: delta,
        groupNetDelta: 0,
        prepaidByThemDelta: 0,
        prepaidByMeDelta: 0,
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
      )
      if (Math.abs(delta) <= MONEY_EPSILON) continue
      events.push({
        id: bill.id,
        type: 'group_bill',
        createdAt: bill.created_at,
        currency: gi.currency,
        groupId: bill.group_id,
        contextLabel: gi.name,
        title: bill.title,
        rawAmount: Math.abs(delta),
        billNetDelta: 0,
        groupNetDelta: delta,
        prepaidByThemDelta: 0,
        prepaidByMeDelta: 0,
      })
    }
  }

  // --- Settlements (personal bill-tagged, group, general credit) ---
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
      const delta = iToThem ? s.amount : -s.amount
      events.push({
        id: s.id,
        type: 'payment',
        createdAt: s.created_at,
        currency: gi.currency,
        groupId: s.group_id,
        contextLabel: gi.name,
        title: iToThem ? `You paid ${otherName}` : `${otherName} paid you`,
        rawAmount: s.amount,
        billNetDelta: 0,
        groupNetDelta: delta,
        prepaidByThemDelta: 0,
        prepaidByMeDelta: 0,
      })
      continue
    }
    // personal (group_id === null) — expanded matching
    const fromMe = meIds.has(s.from_user_id)
    const toMe = meIds.has(s.to_user_id)
    const fromOther = otherIds.has(s.from_user_id)
    const toOther = otherIds.has(s.to_user_id)
    const iToThem = fromMe && toOther
    const themToMe = fromOther && toMe
    if (!iToThem && !themToMe) continue
    if (s.bill_id != null) {
      events.push({
        id: s.id,
        type: 'payment',
        createdAt: s.created_at,
        currency: s.currency,
        groupId: null,
        contextLabel: 'Personal',
        title: iToThem ? `You paid ${otherName}` : `${otherName} paid you`,
        rawAmount: s.amount,
        billNetDelta: iToThem ? s.amount : -s.amount,
        groupNetDelta: 0,
        prepaidByThemDelta: 0,
        prepaidByMeDelta: 0,
      })
    } else {
      events.push({
        id: s.id,
        type: 'general_payment',
        createdAt: s.created_at,
        currency: s.currency,
        groupId: null,
        contextLabel: 'Personal',
        title: iToThem ? `You paid ${otherName}` : `${otherName} paid you`,
        rawAmount: s.amount,
        billNetDelta: 0,
        groupNetDelta: 0,
        prepaidByThemDelta: themToMe ? s.amount : 0,
        prepaidByMeDelta: iToThem ? s.amount : 0,
      })
    }
  }

  events.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))

  // --- Running-balance pass ---
  const billNet = new Map<string, number>()
  const groupNet = new Map<string, number>()
  const prepaidThem = new Map<string, number>()
  const prepaidMe = new Map<string, number>()
  const prevRunning = new Map<string, number>()
  const prevTheir = new Map<string, number>()
  const prevMine = new Map<string, number>()

  const rows: MoneyFlowRow[] = []
  for (const ev of events) {
    const cur = ev.currency
    billNet.set(cur, roundMoney((billNet.get(cur) ?? 0) + ev.billNetDelta))
    groupNet.set(cur, roundMoney((groupNet.get(cur) ?? 0) + ev.groupNetDelta))
    prepaidThem.set(cur, roundMoney((prepaidThem.get(cur) ?? 0) + ev.prepaidByThemDelta))
    prepaidMe.set(cur, roundMoney((prepaidMe.get(cur) ?? 0) + ev.prepaidByMeDelta))

    const b = billNet.get(cur) ?? 0
    const pt = prepaidThem.get(cur) ?? 0
    const pm = prepaidMe.get(cur) ?? 0
    const theirCredit = availableTheirCredit(b, pt)
    const myCredit = availableMyCredit(b, pm)
    const runningNet = roundMoney(effectivePersonalNet(b, pt, pm) + (groupNet.get(cur) ?? 0))

    const balanceDelta = roundMoney(runningNet - (prevRunning.get(cur) ?? 0))
    const theirCreditChange = roundMoney(theirCredit - (prevTheir.get(cur) ?? 0))
    const myCreditChange = roundMoney(myCredit - (prevMine.get(cur) ?? 0))
    const clearedAmount = Math.abs(balanceDelta)

    rows.push({
      id: ev.id,
      type: ev.type,
      createdAt: ev.createdAt,
      currency: cur,
      groupId: ev.groupId,
      contextLabel: ev.contextLabel,
      title: ev.title,
      rawAmount: ev.rawAmount,
      runningNet,
      theirCreditAvailable: theirCredit,
      myCreditAvailable: myCredit,
      explanation: {
        balanceDelta,
        creditChange: roundMoney(theirCreditChange - myCreditChange),
        clearedAmount,
        note: describeNote(ev, balanceDelta, theirCreditChange, myCreditChange),
      },
    })

    prevRunning.set(cur, runningNet)
    prevTheir.set(cur, theirCredit)
    prevMine.set(cur, myCredit)
  }

  // --- Current standing per currency ---
  const currentNet = new Map<string, number>()
  const currentTheirCredit = new Map<string, number>()
  const currentMyCredit = new Map<string, number>()
  const currencies = new Set<string>([
    ...billNet.keys(),
    ...groupNet.keys(),
    ...prepaidThem.keys(),
    ...prepaidMe.keys(),
  ])
  for (const cur of currencies) {
    const b = billNet.get(cur) ?? 0
    const pt = prepaidThem.get(cur) ?? 0
    const pm = prepaidMe.get(cur) ?? 0
    currentNet.set(cur, roundMoney(effectivePersonalNet(b, pt, pm) + (groupNet.get(cur) ?? 0)))
    currentTheirCredit.set(cur, availableTheirCredit(b, pt))
    currentMyCredit.set(cur, availableMyCredit(b, pm))
  }

  return { rows, currentNet, currentTheirCredit, currentMyCredit }
}

function describeNote(
  ev: RawEvent,
  balanceDelta: number,
  theirCreditChange: number,
  myCreditChange: number,
): MoneyFlowNote {
  if (ev.type === 'personal_bill' || ev.type === 'group_bill') {
    const signed = ev.billNetDelta + ev.groupNetDelta
    const absorbed = roundMoney(ev.rawAmount - Math.abs(balanceDelta))
    if (absorbed > MONEY_EPSILON) {
      return signed > 0 ? 'covered_by_their_credit' : 'covered_by_your_credit'
    }
    return signed >= 0 ? 'they_owe_you' : 'you_owe_them'
  }
  if (ev.type === 'payment') {
    return balanceDelta < 0 ? 'cleared_their_debt' : 'cleared_your_debt'
  }
  // general_payment
  const theirs = ev.prepaidByThemDelta > MONEY_EPSILON
  const cleared = Math.abs(balanceDelta) > MONEY_EPSILON
  const banked = (theirs ? theirCreditChange : myCreditChange) > MONEY_EPSILON
  if (cleared && banked) return theirs ? 'cleared_and_banked_their' : 'cleared_and_banked_your'
  if (banked) return theirs ? 'banked_their_credit' : 'banked_your_credit'
  return theirs ? 'cleared_their_debt' : 'cleared_your_debt'
}
