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
  return splits.map((s) => ({
    userId: s.userId,
    computedAmount: Math.round(amount * (s.splitValue / 100) * 100) / 100,
  }))
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
