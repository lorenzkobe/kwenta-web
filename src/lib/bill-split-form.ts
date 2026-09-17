import type { SplitType } from '@/types'

const SUM_EPS = 0.06

/** Equal percentage shares that sum to 100 (2 decimal places). */
export function equalPercentMap(userIds: string[]): Record<string, string> {
  const n = userIds.length
  if (n === 0) return {}
  const base = Math.floor((100 / n) * 100) / 100
  const out: Record<string, string> = {}
  let allocated = 0
  userIds.forEach((id, i) => {
    if (i === n - 1) {
      out[id] = String(Math.round((100 - allocated) * 100) / 100)
    } else {
      out[id] = String(base)
      allocated += base
    }
  })
  return out
}

/** Equal currency shares for a line total. */
export function equalCustomMap(userIds: string[], amount: number): Record<string, string> {
  const n = userIds.length
  if (n === 0 || amount <= 0) return {}
  const splits = computeEqualAmounts(amount, n)
  const out: Record<string, string> = {}
  userIds.forEach((id, i) => {
    out[id] = String(splits[i] ?? 0)
  })
  return out
}

function computeEqualAmounts(total: number, count: number): number[] {
  const base = Math.floor((total / count) * 100) / 100
  const remainder = Math.round((total - base * count) * 100) / 100
  return Array.from({ length: count }, (_, i) => (i === 0 ? base + remainder : base))
}

/** Split `total` across `count` parts with 2 decimal places; sums exactly to `total`. */
export function splitTotalEvenly(total: number, count: number): number[] {
  if (count <= 0) return []
  const base = Math.floor((total / count) * 100) / 100
  const out: number[] = []
  let sum = 0
  for (let i = 0; i < count - 1; i++) {
    out.push(base)
    sum += base
  }
  out.push(Math.round((total - sum) * 100) / 100)
  return out
}

/** User-edited fields we do not auto-overwrite when adjusting the rest. */
export type PinnedSplits = Record<string, true>

/**
 * Keeps pinned users' values as entered; splits `targetTotal - sum(pinned)` evenly across unpinned selected users.
 */
export function redistributeWithPinned(
  selectedUserIds: string[],
  values: Record<string, string>,
  pinnedUserIds: PinnedSplits,
  targetTotal: number,
): Record<string, string> {
  const out = { ...values }
  let pinnedSum = 0
  for (const id of selectedUserIds) {
    if (pinnedUserIds[id]) {
      pinnedSum += parseSplitNumber(out[id])
    }
  }
  const unpinned = selectedUserIds.filter((id) => !pinnedUserIds[id])
  const remaining = Math.round((targetTotal - pinnedSum) * 100) / 100

  if (unpinned.length === 0) {
    return out
  }
  if (remaining < -0.0001) {
    return out
  }

  const parts = splitTotalEvenly(remaining, unpinned.length)
  unpinned.forEach((id, i) => {
    out[id] = String(parts[i])
  })
  return out
}

export function parseSplitNumber(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0
  const t = String(raw).trim()
  if (t === '') return 0
  const n = parseFloat(t.replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

/**
 * User cleared one field to ''. Keep it empty, treat as 0 for totals, and rebalance so the
 * line target still matches when exactly one other person still has a value (they get the full target).
 */
export function applyClearedSplitField(
  selectedUserIds: string[],
  values: Record<string, string>,
  pinnedUserIds: PinnedSplits,
  clearedUid: string,
  mode: 'percentage' | 'custom',
  targetTotal: number,
): { values: Record<string, string>; pinned: PinnedSplits } {
  const pinned = { ...pinnedUserIds }
  delete pinned[clearedUid]
  let nextValues = { ...values, [clearedUid]: '' }

  if (targetTotal <= 0 || selectedUserIds.length === 0) {
    return { values: nextValues, pinned }
  }

  const others = selectedUserIds.filter((id) => id !== clearedUid)
  const nonEmptyOthers = others.filter((id) => (nextValues[id] ?? '').trim() !== '')

  if (nonEmptyOthers.length === 1) {
    const only = nonEmptyOthers[0]
    delete pinned[only]
    const [whole] = splitTotalEvenly(targetTotal, 1)
    nextValues = { ...nextValues, [only]: String(whole) }
    return { values: nextValues, pinned }
  }

  if (nonEmptyOthers.length === 0) {
    if (mode === 'percentage') {
      return { values: equalPercentMap(selectedUserIds), pinned: {} }
    }
    return { values: equalCustomMap(selectedUserIds, targetTotal), pinned: {} }
  }

  return { values: nextValues, pinned }
}

/**
 * Applies a single split-value edit for one user, returning the next {values, pinned}.
 * Quantity inputs are stored verbatim (each person's units are independent — no
 * redistribution). Percentage/custom edits pin the edited user and rebalance the rest;
 * clearing a field delegates to `applyClearedSplitField`. Shared by the simple-split
 * handlers in AddBillPage and AddBillDialog so they cannot drift apart.
 */
export function applySplitInputChange(
  selectedUserIds: string[],
  splitType: SplitType,
  lineAmount: number,
  values: Record<string, string>,
  pinnedUserIds: PinnedSplits,
  uid: string,
  raw: string,
): { values: Record<string, string>; pinned: PinnedSplits } {
  if (splitType === 'quantity') {
    return { values: { ...values, [uid]: raw }, pinned: pinnedUserIds }
  }
  if (raw.trim() === '') {
    const target = splitType === 'percentage' ? 100 : lineAmount
    return applyClearedSplitField(
      selectedUserIds,
      values,
      pinnedUserIds,
      uid,
      splitType === 'percentage' ? 'percentage' : 'custom',
      target,
    )
  }
  const pinned: PinnedSplits = { ...pinnedUserIds, [uid]: true }
  const nextValues = { ...values, [uid]: raw }
  if (splitType === 'percentage') {
    return { pinned, values: redistributeWithPinned(selectedUserIds, nextValues, pinned, 100) }
  }
  if (lineAmount <= 0) return { pinned, values: nextValues }
  return { pinned, values: redistributeWithPinned(selectedUserIds, nextValues, pinned, lineAmount) }
}

export function lineSplitsValid(
  splitType: SplitType,
  lineAmount: number,
  selectedUserIds: string[],
  splitValues: Record<string, string>,
): boolean {
  if (selectedUserIds.length === 0) return true
  if (splitType === 'equal') return true
  const nums = selectedUserIds.map((uid) => parseSplitNumber(splitValues[uid]))
  if (splitType === 'percentage') {
    const sum = nums.reduce((a, b) => a + b, 0)
    return Math.abs(sum - 100) <= SUM_EPS
  }
  if (splitType === 'custom') {
    const sum = nums.reduce((a, b) => a + b, 0)
    return Math.abs(sum - lineAmount) <= SUM_EPS
  }
  if (splitType === 'quantity') {
    return nums.every((n) => Number.isInteger(n) && n >= 1)
  }
  return true
}

export function buildSplitPayload(
  selectedUserIds: string[],
  splitType: SplitType,
  splitValues: Record<string, string>,
): { userId: string; splitType: SplitType; splitValue: number }[] {
  return selectedUserIds.map((uid) => ({
    userId: uid,
    splitType,
    splitValue: splitType === 'equal' ? 1 : parseSplitNumber(splitValues[uid]),
  }))
}

/**
 * Turns a line's STORED splits into a picker selection, via the id mapper the edit effect
 * resolved from Dexie (`personalPickerIdFor` / `resolveGroupMemberUserId`). Two stored rows that
 * resolve to the same picker id are the legacy-plus-canonical case (a bill written before an
 * on-link rewrite); the first row wins so the value shown matches what a single-selection form
 * can hold.
 */
export function remapLineSplits(
  splits: { user_id: string; split_type: SplitType; split_value: number }[],
  pickerIdFor: (storedId: string) => string,
): { selectedUserIds: string[]; splitValues: Record<string, string> } {
  const selectedUserIds: string[] = []
  const splitValues: Record<string, string> = {}
  const seen = new Set<string>()
  for (const s of splits) {
    const pid = pickerIdFor(s.user_id)
    if (seen.has(pid)) continue
    seen.add(pid)
    selectedUserIds.push(pid)
    splitValues[pid] = String(s.split_value)
  }
  return { selectedUserIds, splitValues }
}

/**
 * Appends the bill's participants the picker cannot list (a contact deleted from the phonebook,
 * a member removed from the group) as `unlisted` options, so they still render as a removable
 * chip instead of being silently dropped from view while still being saved.
 */
export function mergeUnlistedParticipants<T extends { userId: string }>(
  listed: T[],
  participants: { userId: string; displayName: string }[],
): (T | { userId: string; displayName: string; isCurrentUser: false; unlisted: true })[] {
  const listedIds = new Set(listed.map((m) => m.userId))
  const out: (T | { userId: string; displayName: string; isCurrentUser: false; unlisted: true })[] = [
    ...listed,
  ]
  const seen = new Set<string>()
  for (const p of participants) {
    if (listedIds.has(p.userId) || seen.has(p.userId)) continue
    seen.add(p.userId)
    out.push({ userId: p.userId, displayName: p.displayName, isCurrentUser: false, unlisted: true })
  }
  return out
}

/**
 * The shared half of the edit-load effect in AddBillPage/AddBillDialog: resolve every distinct
 * stored id on the bill to its picker id ONCE, then derive the participant list a picker option
 * cannot cover on its own. `resolve` is injected (`personalPickerIdFor` for a personal bill,
 * `resolveGroupMemberUserId` for a group one) so this stays free of a Dexie dependency and the
 * two callers cannot drift on the resolve-once / dedupe / viewer-exclusion rules.
 */
export async function resolveBillEditIds(
  detail: {
    paid_by: string
    payorName: string
    items: { splits: { user_id: string; displayName: string }[] }[]
  },
  resolve: (storedId: string) => Promise<string>,
  viewerId: string,
): Promise<{
  pickerIdFor: (storedId: string) => string
  billParticipants: { userId: string; displayName: string }[]
}> {
  const distinctIds = new Set<string>([detail.paid_by])
  for (const item of detail.items) {
    for (const s of item.splits) distinctIds.add(s.user_id)
  }
  const idMap = new Map<string, string>()
  for (const id of distinctIds) {
    idMap.set(id, await resolve(id))
  }
  const pickerIdFor = (storedId: string) => idMap.get(storedId) ?? storedId

  const nameByPickerId = new Map<string, string>()
  for (const item of detail.items) {
    for (const s of item.splits) {
      const pid = pickerIdFor(s.user_id)
      if (!nameByPickerId.has(pid)) nameByPickerId.set(pid, s.displayName)
    }
  }
  const payorPickerId = pickerIdFor(detail.paid_by)
  if (!nameByPickerId.has(payorPickerId)) nameByPickerId.set(payorPickerId, detail.payorName)

  const billParticipants = [...nameByPickerId.entries()]
    .filter(([pid]) => pid !== viewerId)
    .map(([pid, displayName]) => ({ userId: pid, displayName }))

  return { pickerIdFor, billParticipants }
}
