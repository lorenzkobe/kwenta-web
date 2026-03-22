import { Lock } from 'lucide-react'
import type { SplitType } from '@/types'
import type { PinnedSplits } from '@/lib/bill-split-form'
import { parseSplitNumber } from '@/lib/bill-split-form'
import { cn, formatCurrency } from '@/lib/utils'
import { Input } from '@/components/ui/input'

export interface SplitMemberOption {
  userId: string
  displayName: string
  isCurrentUser: boolean
}

export function SplitValueRows({
  splitType,
  currency,
  selectedUserIds,
  members,
  values,
  pinnedUserIds,
  onChange,
  lineAmount,
}: {
  splitType: SplitType
  currency: string
  selectedUserIds: string[]
  members: SplitMemberOption[]
  values: Record<string, string>
  pinnedUserIds?: PinnedSplits
  onChange: (uid: string, raw: string) => void
  lineAmount: number
}) {
  if (splitType === 'equal' || selectedUserIds.length === 0) return null
  const sum = selectedUserIds.reduce((a, uid) => a + parseSplitNumber(values[uid]), 0)
  const pctOk = splitType === 'percentage' && Math.abs(sum - 100) <= 0.06
  const customOk = splitType === 'custom' && lineAmount > 0 && Math.abs(sum - lineAmount) <= 0.06

  return (
    <div className="mt-2 space-y-2 rounded-xl border border-stone-200 bg-white px-3 py-2">
      <p className="text-xs font-medium text-stone-500">
        {splitType === 'percentage'
          ? 'Percent per person (total must be 100%). Edited fields stay fixed; the rest update.'
          : `Amount per person (${currency}, must total the line amount). Edited fields stay fixed.`}
      </p>
      {selectedUserIds.map((uid) => {
        const m = members.find((x) => x.userId === uid)
        const locked = Boolean(pinnedUserIds?.[uid])
        return (
          <div key={uid} className="flex items-center gap-2">
            <span
              className="flex w-24 shrink-0 items-center gap-1 truncate text-sm text-stone-700"
              title={locked ? 'You set this — not auto-changed when others edit' : undefined}
            >
              {locked && <Lock className="size-3 shrink-0 text-stone-400" aria-hidden />}
              {m?.isCurrentUser ? 'You' : m?.displayName}
            </span>
            <Input
              type="number"
              className="h-9 flex-1 rounded-lg text-sm"
              min={splitType === 'percentage' ? 0 : undefined}
              step={splitType === 'percentage' ? 0.1 : 0.01}
              placeholder={splitType === 'percentage' ? '%' : '0.00'}
              value={values[uid] ?? ''}
              onChange={(e) => onChange(uid, e.target.value)}
            />
          </div>
        )
      })}
      {splitType === 'percentage' && (
        <p className={cn('text-xs', pctOk ? 'text-emerald-600' : 'text-amber-600')}>
          Total: {sum.toFixed(2)}%
        </p>
      )}
      {splitType === 'custom' && lineAmount > 0 && (
        <p className={cn('text-xs', customOk ? 'text-emerald-600' : 'text-amber-600')}>
          Total: {formatCurrency(sum, currency)}
        </p>
      )}
    </div>
  )
}
