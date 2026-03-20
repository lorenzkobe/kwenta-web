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
