import { Banknote, Pencil } from 'lucide-react'
import type { SettlementHistoryItem } from '@/lib/settlement'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'

function describePayment(h: SettlementHistoryItem, currentUserId: string | null | undefined) {
  if (h.isBundled) {
    const recipientCount = h.recipients.length
    const currentUserIsRecipient = Boolean(
      currentUserId && h.recipients.some((recipient) => recipient.toUserId === currentUserId),
    )
    if (currentUserId && h.fromUserId === currentUserId) {
      return recipientCount === 1
        ? `You paid ${h.recipients[0]?.toName ?? h.toName}`
        : `You paid ${recipientCount} people`
    }
    if (currentUserIsRecipient) {
      return recipientCount === 1 ? `${h.fromName} paid you` : `${h.fromName} paid you and others`
    }
    return recipientCount === 1 ? `${h.fromName} paid ${h.toName}` : `${h.fromName} paid ${recipientCount} people`
  }
  if (currentUserId && h.toUserId === currentUserId) return `${h.fromName} paid you`
  if (currentUserId && h.fromUserId === currentUserId) return `You paid ${h.toName}`
  return `${h.fromName} paid ${h.toName}`
}

export function SettlementHistoryList({
  items,
  currentUserId,
  showGroupName,
  className,
  onEdit,
}: {
  items: SettlementHistoryItem[]
  currentUserId?: string | null
  /** When true, show group name above each row (cross-group lists). */
  showGroupName?: boolean
  className?: string
  onEdit?: (item: SettlementHistoryItem) => void
}) {
  if (items.length === 0) return null

  return (
    <ul className={cn('space-y-2', className)}>
      {items.map((h) => {
        const primary = describePayment(h, currentUserId)
        return (
          <li
            key={h.id}
            className="flex flex-col gap-0.5 rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700">
                <Banknote className="size-4" aria-hidden />
              </div>
              <div>
                {showGroupName && h.groupName && (
                  <p className="text-[0.65rem] font-medium uppercase tracking-wide text-stone-400">
                    {h.groupName}
                  </p>
                )}
                <p className="text-sm font-medium text-stone-800">{primary}</p>
                {h.billTitle && (
                  <p className="mt-0.5 text-xs text-teal-800/90">Bill: {h.billTitle}</p>
                )}
                {!h.billTitle && h.groupId === null && (
                  <p className="mt-0.5 text-xs text-stone-500">General payment</p>
                )}
                {h.label.trim() !== '' && (
                  <p className="mt-0.5 text-xs font-medium text-stone-600">{h.label}</p>
                )}
                {h.isBundled && h.recipients.length > 1 && (
                  <div className="mt-1 space-y-0.5">
                    {h.recipients.map((recipient) => (
                      <p key={recipient.toUserId} className="text-xs text-stone-500">
                        • {recipient.toName} {formatCurrency(recipient.amount, h.currency)}
                      </p>
                    ))}
                  </div>
                )}
                <p className="text-xs text-stone-400">
                  {new Date(h.createdAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  })}
                  {h.recordedByUserId && h.recordedByUserId !== h.fromUserId && h.recordedByName && (
                    <> · Added by {h.recordedByUserId === currentUserId ? 'you' : h.recordedByName}</>
                  )}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1 pl-10 sm:pl-0">
              <p className="text-sm font-semibold text-emerald-700">
                {formatCurrency(h.amount, h.currency)}
              </p>
              {onEdit && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-full text-stone-500 hover:text-teal-800"
                  aria-label="Edit payment"
                  onClick={() => onEdit(h)}
                >
                  <Pencil className="size-3.5" />
                </Button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
