import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { ManualGeneralCreditSelectionPlan } from '@/lib/people'
import {
  applyClearedSplitField,
  equalPercentMap,
  lineSplitsValid,
  redistributeWithPinned,
  parseSplitNumber,
  type PinnedSplits,
} from '@/lib/bill-split-form'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { SplitValueRows } from '@/components/common/SplitValueRows'
import type { SplitType } from '@/types'

type DestinationBucket = {
  id: string
  label: string
  subtitle: string
  maxAmount: number
  kind: 'personal' | 'group'
  groupId?: string
}

function splitAmountEqually(total: number, count: number): number[] {
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

function buildCappedCustomMap(
  selectedBuckets: DestinationBucket[],
  appliedAmount: number,
): Record<string, string> {
  if (selectedBuckets.length === 0 || appliedAmount <= 0) return {}

  const out: Record<string, string> = {}
  let remaining = Math.round(appliedAmount * 100) / 100
  let openBuckets = [...selectedBuckets]

  while (openBuckets.length > 0) {
    const equalShares = splitAmountEqually(remaining, openBuckets.length)
    const cappedBucketIndexes = openBuckets
      .map((bucket, index) => ({ bucket, index, share: equalShares[index] ?? 0 }))
      .filter(({ bucket, share }) => share > bucket.maxAmount + 0.005)

    if (cappedBucketIndexes.length === 0) {
      equalShares.forEach((share, index) => {
        out[openBuckets[index].id] = String(Math.round(share * 100) / 100)
      })
      break
    }

    const cappedIds = new Set(cappedBucketIndexes.map(({ bucket }) => bucket.id))
    for (const { bucket } of cappedBucketIndexes) {
      out[bucket.id] = String(Math.round(bucket.maxAmount * 100) / 100)
      remaining = Math.round((remaining - bucket.maxAmount) * 100) / 100
    }
    openBuckets = openBuckets.filter((bucket) => !cappedIds.has(bucket.id))
  }

  return out
}

function equalSplitExceedsBucketCaps(selectedBuckets: DestinationBucket[], appliedAmount: number): boolean {
  if (selectedBuckets.length <= 1) return false
  const equalShares = splitAmountEqually(appliedAmount, selectedBuckets.length)
  return selectedBuckets.some((bucket, index) => (equalShares[index] ?? 0) > bucket.maxAmount + 0.005)
}

function buildSplitState(
  selectedBuckets: DestinationBucket[],
  splitType: SplitType,
  appliedAmount: number,
  allowAutoCustomDefault = false,
): {
  splitType: SplitType
  values: Record<string, string>
  pinned: PinnedSplits
} {
  if (selectedBuckets.length <= 1) {
    return { splitType: 'equal', values: {}, pinned: {} }
  }

  if (allowAutoCustomDefault && splitType === 'equal' && equalSplitExceedsBucketCaps(selectedBuckets, appliedAmount)) {
    return {
      splitType: 'custom',
      values: buildCappedCustomMap(selectedBuckets, appliedAmount),
      pinned: {},
    }
  }

  if (splitType === 'equal') {
    return { splitType, values: {}, pinned: {} }
  }
  if (splitType === 'percentage') {
    return { splitType, values: equalPercentMap(selectedBuckets.map((bucket) => bucket.id)), pinned: {} }
  }
  return {
    splitType,
    values: buildCappedCustomMap(selectedBuckets, appliedAmount),
    pinned: {},
  }
}

export function ApplyGeneralCreditDialog({
  open,
  onOpenChange,
  plan,
  saving,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  plan: ManualGeneralCreditSelectionPlan
  saving: boolean
  onSubmit: (args: {
    appliedAmount: number
    personalAmount: number
    groupAllocations: { groupId: string; amount: number }[]
  }) => Promise<void>
}) {
  const personalBucket = useMemo<DestinationBucket | null>(() => {
    if (plan.personalAllocatableAmount <= 0.005) return null
    return {
      id: 'personal',
      label: 'Personal bills',
      subtitle: `Up to ${formatCurrency(plan.personalAllocatableAmount, plan.currency)} across ${plan.personalPlan.affectedBillCount} bill${
        plan.personalPlan.affectedBillCount === 1 ? '' : 's'
      }`,
      maxAmount: plan.personalAllocatableAmount,
      kind: 'personal',
    }
  }, [plan.currency, plan.personalAllocatableAmount, plan.personalPlan.affectedBillCount])

  const groupBuckets = useMemo<DestinationBucket[]>(
    () =>
      plan.eligibleGroups.map((group) => ({
        id: group.groupId,
        label: group.groupName,
        subtitle: `Up to ${formatCurrency(group.allocatableAmount, group.currency)}`,
        maxAmount: group.allocatableAmount,
        kind: 'group',
        groupId: group.groupId,
      })),
    [plan.eligibleGroups],
  )

  const bucketById = useMemo(
    () =>
      new Map<string, DestinationBucket>(
        [personalBucket, ...groupBuckets].filter((bucket): bucket is DestinationBucket => Boolean(bucket)).map((bucket) => [
          bucket.id,
          bucket,
        ]),
      ),
    [groupBuckets, personalBucket],
  )

  const [includePersonal, setIncludePersonal] = useState(Boolean(personalBucket))
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])
  const [splitType, setSplitType] = useState<SplitType>('equal')
  const [splitValues, setSplitValues] = useState<Record<string, string>>({})
  const [pinnedBucketIds, setPinnedBucketIds] = useState<PinnedSplits>({})

  const selectedBucketIds = useMemo(() => {
    const ids: string[] = []
    if (includePersonal && personalBucket) ids.push(personalBucket.id)
    ids.push(...selectedGroupIds.filter((id) => bucketById.has(id)))
    return ids
  }, [bucketById, includePersonal, personalBucket, selectedGroupIds])

  const selectedBuckets = useMemo(
    () => selectedBucketIds.map((id) => bucketById.get(id)).filter((bucket): bucket is DestinationBucket => Boolean(bucket)),
    [bucketById, selectedBucketIds],
  )

  const selectedCapacity = useMemo(
    () => Math.round(selectedBuckets.reduce((sum, bucket) => sum + bucket.maxAmount, 0) * 100) / 100,
    [selectedBuckets],
  )
  const appliedAmount = Math.min(plan.availableGeneralCredit, selectedCapacity)

  const members = useMemo(
    () =>
      selectedBuckets.map((bucket) => ({
        userId: bucket.id,
        displayName: bucket.label,
        isCurrentUser: false,
      })),
    [selectedBuckets],
  )

  const allocations = useMemo(() => {
    if (selectedBuckets.length === 0 || appliedAmount <= 0.005) return new Map<string, number>()
    if (selectedBuckets.length === 1) {
      return new Map<string, number>([[selectedBuckets[0].id, Math.round(appliedAmount * 100) / 100]])
    }

    if (splitType === 'equal') {
      return new Map<string, number>(
        splitAmountEqually(appliedAmount, selectedBuckets.length).map((amount, index) => [
          selectedBuckets[index].id,
          Math.round(amount * 100) / 100,
        ]),
      )
    }

    if (splitType === 'percentage') {
      let remaining = Math.round(appliedAmount * 100) / 100
      return new Map<string, number>(
        selectedBuckets.map((bucket, index) => {
          if (index === selectedBuckets.length - 1) return [bucket.id, Math.round(remaining * 100) / 100]
          const rawPercent = parseSplitNumber(splitValues[bucket.id])
          const amount = Math.round((appliedAmount * rawPercent) / 100 * 100) / 100
          remaining = Math.round((remaining - amount) * 100) / 100
          return [bucket.id, amount]
        }),
      )
    }

    return new Map<string, number>(
      selectedBuckets.map((bucket) => [bucket.id, Math.round(parseSplitNumber(splitValues[bucket.id]) * 100) / 100]),
    )
  }, [appliedAmount, selectedBuckets, splitType, splitValues])

  const splitInputsValid =
    selectedBucketIds.length <= 1 || lineSplitsValid(splitType, appliedAmount, selectedBucketIds, splitValues)
  const bucketCapError = selectedBuckets.find((bucket) => (allocations.get(bucket.id) ?? 0) > bucket.maxAmount + 0.005)

  const errorMessage = useMemo(() => {
    if (selectedBuckets.length === 0) return 'Select personal bills, one or more groups, or both.'
    if (appliedAmount <= 0.005) return 'No available credit can be applied to the selected destinations.'
    if (!splitInputsValid) {
      return splitType === 'percentage'
        ? 'Percentages must add up to 100%.'
        : 'Amounts must add up to the selected credit amount.'
    }
    if (bucketCapError) {
      return `${bucketCapError.label} only has ${formatCurrency(bucketCapError.maxAmount, plan.currency)} available to apply.`
    }
    return null
  }, [appliedAmount, bucketCapError, plan.currency, selectedBuckets.length, splitInputsValid, splitType])

  function toggleGroup(groupId: string) {
    const nextGroupIds = selectedGroupIds.includes(groupId)
      ? selectedGroupIds.filter((id) => id !== groupId)
      : [...selectedGroupIds, groupId]
    const nextBucketIds = [
      ...(includePersonal && personalBucket ? [personalBucket.id] : []),
      ...nextGroupIds.filter((id) => bucketById.has(id)),
    ]
    const nextAppliedAmount = Math.min(
      plan.availableGeneralCredit,
      nextBucketIds.reduce((sum, id) => sum + (bucketById.get(id)?.maxAmount ?? 0), 0),
    )
    const nextBuckets = nextBucketIds
      .map((id) => bucketById.get(id))
      .filter((bucket): bucket is DestinationBucket => Boolean(bucket))
    const nextSplitState = buildSplitState(nextBuckets, splitType, nextAppliedAmount, true)
    setSelectedGroupIds(nextGroupIds)
    setSplitType(nextSplitState.splitType)
    setSplitValues(nextSplitState.values)
    setPinnedBucketIds(nextSplitState.pinned)
  }

  function handleSplitTypeChange(next: SplitType) {
    const nextSplitState = buildSplitState(selectedBuckets, next, appliedAmount)
    setSplitType(nextSplitState.splitType)
    setSplitValues(nextSplitState.values)
    setPinnedBucketIds(nextSplitState.pinned)
  }

  function handleSplitValueChange(bucketId: string, raw: string) {
    if (splitType === 'equal') return

    const targetTotal = splitType === 'percentage' ? 100 : appliedAmount
    if (raw.trim() === '') {
      const next = applyClearedSplitField(
        selectedBucketIds,
        splitValues,
        pinnedBucketIds,
        bucketId,
        splitType,
        targetTotal,
      )
      setSplitValues(next.values)
      setPinnedBucketIds(next.pinned)
      return
    }

    const nextPinned: PinnedSplits = { ...pinnedBucketIds, [bucketId]: true }
    const nextValues = redistributeWithPinned(
      selectedBucketIds,
      { ...splitValues, [bucketId]: raw },
      nextPinned,
      targetTotal,
    )
    setSplitValues(nextValues)
    setPinnedBucketIds(nextPinned)
  }

  async function handleSubmit() {
    if (saving || errorMessage) return
    const personalAmount = Math.round((allocations.get('personal') ?? 0) * 100) / 100
    const groupAllocations = selectedBuckets
      .filter((bucket) => bucket.kind === 'group' && bucket.groupId)
      .map((bucket) => ({
        groupId: bucket.groupId as string,
        amount: Math.round((allocations.get(bucket.id) ?? 0) * 100) / 100,
      }))
      .filter((bucket) => bucket.amount > 0.005)

    await onSubmit({
      appliedAmount: Math.round(appliedAmount * 100) / 100,
      personalAmount,
      groupAllocations,
    })
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-60 flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/30 backdrop-blur-sm"
        onClick={() => !saving && onOpenChange(false)}
        aria-hidden
      />
      <div className="relative w-full max-w-lg animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex items-center justify-between border-b border-stone-100 px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Apply available credit to bills</h2>
            <p className="mt-1 text-xs text-stone-500">
              Available general credit: {formatCurrency(plan.availableGeneralCredit, plan.currency)}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-full"
            disabled={saving}
            onClick={() => onOpenChange(false)}
          >
            <X className="size-4" />
          </Button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {personalBucket && (
            <button
              type="button"
              className={cn(
                'flex w-full items-start justify-between rounded-2xl border px-4 py-3 text-left transition-colors',
                includePersonal
                  ? 'border-teal-700 bg-teal-50/70'
                  : 'border-stone-200 bg-white hover:border-stone-300',
              )}
              onClick={() => {
                const nextIncludePersonal = !includePersonal
                const nextBucketIds = [
                  ...(nextIncludePersonal && personalBucket ? [personalBucket.id] : []),
                  ...selectedGroupIds.filter((id) => bucketById.has(id)),
                ]
                const nextAppliedAmount = Math.min(
                  plan.availableGeneralCredit,
                  nextBucketIds.reduce((sum, id) => sum + (bucketById.get(id)?.maxAmount ?? 0), 0),
                )
                const nextBuckets = nextBucketIds
                  .map((id) => bucketById.get(id))
                  .filter((bucket): bucket is DestinationBucket => Boolean(bucket))
                const nextSplitState = buildSplitState(nextBuckets, splitType, nextAppliedAmount, true)
                setIncludePersonal(nextIncludePersonal)
                setSplitType(nextSplitState.splitType)
                setSplitValues(nextSplitState.values)
                setPinnedBucketIds(nextSplitState.pinned)
              }}
              disabled={saving}
            >
              <div>
                <p className="text-sm font-medium text-stone-900">Include personal bills</p>
                <p className="mt-1 text-xs text-stone-500">{personalBucket.subtitle}</p>
              </div>
              <span
                className={cn(
                  'rounded-full px-2 py-1 text-[11px] font-medium',
                  includePersonal ? 'bg-teal-800 text-white' : 'bg-stone-100 text-stone-500',
                )}
              >
                {includePersonal ? 'Included' : 'Add'}
              </span>
            </button>
          )}

          {groupBuckets.length > 0 && (
            <div className="space-y-2 rounded-2xl border border-stone-200 bg-stone-50 p-3">
              <div>
                <p className="text-sm font-medium text-stone-900">Select groups</p>
                <p className="mt-1 text-xs text-stone-500">
                  Choose the shared groups that should receive this credit.
                </p>
              </div>
              <div className="space-y-2">
                {groupBuckets.map((bucket) => {
                  const selected = selectedGroupIds.includes(bucket.id)
                  return (
                    <button
                      key={bucket.id}
                      type="button"
                      className={cn(
                        'flex w-full items-start justify-between rounded-xl border px-3 py-2.5 text-left transition-colors',
                        selected
                          ? 'border-teal-700 bg-white'
                          : 'border-stone-200 bg-white hover:border-stone-300',
                      )}
                      onClick={() => toggleGroup(bucket.id)}
                      disabled={saving}
                    >
                      <div>
                        <p className="text-sm font-medium text-stone-900">{bucket.label}</p>
                        <p className="mt-1 text-xs text-stone-500">{bucket.subtitle}</p>
                      </div>
                      <span
                        className={cn(
                          'rounded-full px-2 py-1 text-[11px] font-medium',
                          selected ? 'bg-teal-800 text-white' : 'bg-stone-100 text-stone-500',
                        )}
                      >
                        {selected ? 'Selected' : 'Select'}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {selectedBuckets.length > 1 && (
            <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50 p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-stone-500">Split selected credit</p>
              <div className="grid grid-cols-3 gap-1 rounded-lg border border-stone-200 bg-white p-1">
                {(['equal', 'percentage', 'custom'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    className={cn(
                      'rounded-md px-2 py-2 text-xs font-medium transition-colors',
                      splitType === mode
                        ? 'bg-teal-800/10 text-teal-900'
                        : 'text-stone-500 hover:text-stone-800',
                    )}
                    onClick={() => handleSplitTypeChange(mode)}
                    disabled={saving}
                  >
                    {mode === 'equal' ? 'Equal' : mode === 'percentage' ? 'Percentage' : 'Custom'}
                  </button>
                ))}
              </div>

              <SplitValueRows
                splitType={splitType}
                currency={plan.currency}
                selectedUserIds={selectedBucketIds}
                members={members}
                values={splitValues}
                pinnedUserIds={pinnedBucketIds}
                onChange={handleSplitValueChange}
                lineAmount={appliedAmount}
              />
            </div>
          )}

          <div className="space-y-2 rounded-xl border border-stone-200 bg-stone-50 px-4 py-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-stone-500">Selected to apply now</span>
              <span className="font-semibold text-teal-800">{formatCurrency(appliedAmount, plan.currency)}</span>
            </div>
            {plan.availableGeneralCredit - appliedAmount > 0.005 && (
              <div className="flex items-center justify-between gap-3 text-xs text-stone-500">
                <span>Remaining as general credit</span>
                <span>{formatCurrency(plan.availableGeneralCredit - appliedAmount, plan.currency)}</span>
              </div>
            )}
            {selectedBuckets.length > 0 && (
              <div className="space-y-1 border-t border-stone-200 pt-2">
                {selectedBuckets.map((bucket) => (
                  <div key={bucket.id} className="flex items-center justify-between gap-3 text-xs text-stone-600">
                    <span>{bucket.label}</span>
                    <span>{formatCurrency(allocations.get(bucket.id) ?? 0, plan.currency)}</span>
                  </div>
                ))}
              </div>
            )}
            {errorMessage && <p className="text-xs text-amber-700">{errorMessage}</p>}
          </div>

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              className="rounded-xl"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="button" className="rounded-xl" disabled={saving || Boolean(errorMessage)} onClick={handleSubmit}>
              {saving ? 'Applying…' : 'Apply credit'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
