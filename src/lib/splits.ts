import type { SplitType } from '@/types'

export interface SplitInput {
  userId: string
  splitType: SplitType
  splitValue: number
}

export function computeSplits(
  itemAmount: number,
  splits: SplitInput[],
): { userId: string; computedAmount: number }[] {
  if (splits.length === 0) return []

  const splitType = splits[0].splitType

  switch (splitType) {
    case 'equal':
      return computeEqual(itemAmount, splits)
    case 'percentage':
      return computePercentage(itemAmount, splits)
    case 'custom':
      return computeCustom(itemAmount, splits)
    case 'quantity':
      return computeQuantity(itemAmount, splits)
    default:
      return []
  }
}

function computeEqual(
  amount: number,
  splits: SplitInput[],
): { userId: string; computedAmount: number }[] {
  const count = splits.length
  const base = Math.floor((amount / count) * 100) / 100
  const remainder = Math.round((amount - base * count) * 100) / 100

  return splits.map((s, i) => ({
    userId: s.userId,
    computedAmount: i === 0 ? base + remainder : base,
  }))
}

function computePercentage(
  amount: number,
  splits: SplitInput[],
): { userId: string; computedAmount: number }[] {
  const rows = splits.map((s) => ({
    userId: s.userId,
    computedAmount: Math.round(amount * (s.splitValue / 100) * 100) / 100,
  }))
  if (rows.length === 0) return rows
  // Reconcile independent rounding so the shares sum to the intended total
  // (round(amount × Σpct/100)); without this, e.g. 33.33/33.33/33.34 can drift a cent.
  const totalPct = splits.reduce((sum, s) => sum + s.splitValue, 0)
  const target = Math.round(amount * (totalPct / 100) * 100) / 100
  const sum = rows.reduce((s, r) => s + r.computedAmount, 0)
  const diff = Math.round((target - sum) * 100) / 100
  if (diff !== 0) rows[0].computedAmount = Math.round((rows[0].computedAmount + diff) * 100) / 100
  return rows
}

function computeQuantity(
  unitPrice: number,
  splits: SplitInput[],
): { userId: string; computedAmount: number }[] {
  const rows = splits.map((s) => ({
    userId: s.userId,
    computedAmount: Math.round(s.splitValue * unitPrice * 100) / 100,
  }))
  if (rows.length === 0) return rows
  // Reconcile rounding so shares sum to round(unitPrice × Σqty); assign any leftover
  // cent to the largest-quantity share.
  const totalQty = splits.reduce((sum, s) => sum + s.splitValue, 0)
  const target = Math.round(unitPrice * totalQty * 100) / 100
  const sum = rows.reduce((s, r) => s + r.computedAmount, 0)
  const diff = Math.round((target - sum) * 100) / 100
  if (diff !== 0) {
    let idx = 0
    for (let i = 1; i < splits.length; i++) {
      if (splits[i].splitValue > splits[idx].splitValue) idx = i
    }
    rows[idx].computedAmount = Math.round((rows[idx].computedAmount + diff) * 100) / 100
  }
  return rows
}

function computeCustom(
  amount: number,
  splits: SplitInput[],
): { userId: string; computedAmount: number }[] {
  const totalCustom = splits.reduce((sum, s) => sum + s.splitValue, 0)
  const remaining = Math.round((amount - totalCustom) * 100) / 100

  if (remaining <= 0) {
    return splits.map((s) => ({
      userId: s.userId,
      computedAmount: s.splitValue,
    }))
  }

  const unassignedCount = splits.filter((s) => s.splitValue === 0).length
  if (unassignedCount === 0) {
    return splits.map((s) => ({
      userId: s.userId,
      computedAmount: s.splitValue,
    }))
  }

  const perUnassigned = Math.floor((remaining / unassignedCount) * 100) / 100
  const leftover = Math.round((remaining - perUnassigned * unassignedCount) * 100) / 100
  let firstUnassigned = true

  return splits.map((s) => {
    if (s.splitValue > 0) {
      return { userId: s.userId, computedAmount: s.splitValue }
    }
    const extra = firstUnassigned ? leftover : 0
    firstUnassigned = false
    return { userId: s.userId, computedAmount: perUnassigned + extra }
  })
}
