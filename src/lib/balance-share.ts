import { buildMovementChains, type SuggestedPayerGroup } from '@/lib/settlement'
import { formatCurrency, isEffectivelyZero, roundMoney } from '@/lib/utils'

/**
 * The multi-select "share balances as one image" view models.
 *
 * No money rule lives here (CLAUDE.md rule 8): pool balances come from `kwenta_group_detail`,
 * contact nets from `kwenta_contacts_with_balances`, and the suggested transfers from the page's
 * own `buildSuggestedPayers`. This module only picks the selected people out of those and phrases
 * them, so the image can never disagree with the screen it was shared from.
 */

export interface GroupSharePath {
  /** Every hop, payer first and recipient last — only kept when there is a middle person. */
  names: string[]
  amount: number
}

export interface GroupShareRow {
  userId: string
  name: string
  /** Against the group pool: + receives, - pays. Exactly 0 when effectively settled. */
  poolAmount: number
  pays: { toUserId: string; toName: string; amount: number; via: GroupSharePath[] }[]
  receives: { fromUserId: string; fromName: string; amount: number }[]
}

/**
 * The pool figure as the image shows it, or null when the server did not report this member (it
 * is then neither selectable nor shown as a fabricated zero). The select-mode list uses this same
 * function, so the list and the image cannot disagree.
 */
export function groupPoolAmount(pool: number | undefined): number | null {
  if (pool === undefined) return null
  return isEffectivelyZero(pool) ? 0 : roundMoney(pool)
}

/** The Share button of a select mode: nothing picked, or numbers about to change, cannot share. */
export function selectionShareState(count: number, revalidating: boolean) {
  return {
    disabled: count === 0 || revalidating,
    label: revalidating ? 'Updating…' : 'Share image',
  }
}

export function buildGroupShareRows(input: {
  /** Display (roster) order. */
  members: { userId: string; name: string }[]
  memberBalances: { userId: string; amount: number }[]
  payers: SuggestedPayerGroup[]
  selectedIds: ReadonlySet<string>
}): GroupShareRow[] {
  const poolById = new Map(input.memberBalances.map((m) => [m.userId, m.amount]))
  const payerById = new Map(input.payers.map((p) => [p.fromUserId, p]))
  const rosterName = new Map(input.members.map((m) => [m.userId, m.name]))
  const rows: GroupShareRow[] = []

  for (const member of input.members) {
    if (!input.selectedIds.has(member.userId)) continue
    const poolAmount = groupPoolAmount(poolById.get(member.userId))
    if (poolAmount === null) continue

    const payer = payerById.get(member.userId)
    const pays = payer ? paysOf(payer, rosterName) : []
    const receives = input.payers.flatMap((p) =>
      p.recipients
        .filter((r) => r.toUserId === member.userId)
        .map((r) => ({ fromUserId: p.fromUserId, fromName: p.fromName, amount: r.amount })),
    )
    rows.push({ userId: member.userId, name: member.name, poolAmount, pays, receives })
  }
  return rows
}

/**
 * `recipients` stays the authority for who gets how much (it is what the Settle up card shows);
 * the chains only explain it. A payer's legs keep every hop, so a chain longer than one hop is a
 * transfer that cut out a middle person — the "why is Ana paying Cha?" case.
 */
function paysOf(
  payer: SuggestedPayerGroup,
  rosterName: ReadonlyMap<string, string>,
): GroupShareRow['pays'] {
  // The middle person is on neither end of the transfer, so only the roster can name them.
  const nameById = new Map(rosterName)
  nameById.set(payer.fromUserId, payer.fromName)
  for (const r of payer.recipients) nameById.set(r.toUserId, r.toName)
  const chains = buildMovementChains(
    payer.legs.map((l) => ({
      fromUserId: l.fromUserId,
      fromName: nameById.get(l.fromUserId) ?? 'Someone',
      toUserId: l.toUserId,
      toName: nameById.get(l.toUserId) ?? 'Someone',
      amount: l.amount,
    })),
  )
  return payer.recipients.map((r) => ({
    toUserId: r.toUserId,
    toName: r.toName,
    amount: r.amount,
    via: chains
      .filter((c) => c.steps.length > 2 && c.steps[c.steps.length - 1].userId === r.toUserId)
      .map((c) => ({ names: c.steps.map((s) => s.name), amount: c.amount })),
  }))
}

/**
 * The short "why" lines under a member on the image; empty when they are settled. The transfers
 * are already listed above these lines, so the first line gives the reason rather than repeating
 * them: a member's standing against the group is exactly what their transfers clear.
 */
export function describeGroupShareRow(row: GroupShareRow, currency: string): string[] {
  const amount = formatCurrency(Math.abs(row.poolAmount), currency)
  const lines: string[] = []
  if (row.poolAmount < 0) {
    lines.push(`${row.name} is down ${amount} in the group, so that is what ${row.name} pays`)
  } else if (row.poolAmount > 0) {
    lines.push(`${row.name} is up ${amount} in the group, so that is what ${row.name} gets back`)
  }
  for (const p of row.pays) {
    for (const path of p.via) lines.push(describePath(path, currency))
  }
  return lines
}

function describePath(path: GroupSharePath, currency: string): string {
  return `${formatCurrency(path.amount, currency)} of it goes ${path.names.join(' → ')}`
}

export interface PeerShareRow {
  peerId: string
  displayName: string
  settled: boolean
  /** One per currency with a balance, from the viewer's side: + they owe you. */
  lines: { currency: string; amount: number; text: string }[]
}

/**
 * `rows` must be the rows the list is SHOWING (after its filter), so a selected contact the filter
 * hides is neither counted nor exported. A contact this device has not pushed has no server
 * balance yet — its empty net would read as "settled", which is a claim nobody has made.
 */
export function buildPeerShareRows(
  rows: { peerId: string; displayName: string; net: Record<string, number>; staged: boolean }[],
  selectedIds: ReadonlySet<string>,
): PeerShareRow[] {
  return rows
    .filter((r) => !r.staged && selectedIds.has(r.peerId))
    .map((r) => {
      const lines = Object.entries(r.net)
        .filter(([, amount]) => !isEffectivelyZero(amount))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([currency, raw]) => {
          const amount = roundMoney(raw)
          const text =
            amount > 0
              ? `Owes you ${formatCurrency(amount, currency)}`
              : `You owe ${formatCurrency(Math.abs(amount), currency)}`
          return { currency, amount, text }
        })
      return { peerId: r.peerId, displayName: r.displayName, settled: lines.length === 0, lines }
    })
}
