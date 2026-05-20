import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Lock, Search, UserPlus, X } from 'lucide-react'
import type { SplitType } from '@/types'
import type { PinnedSplits } from '@/lib/bill-split-form'
import { parseSplitNumber } from '@/lib/bill-split-form'
import { filterDecimalInput, stripLeadingZerosAmount } from '@/lib/amount-input'
import { cn, formatCurrency } from '@/lib/utils'
import { Input } from '@/components/ui/input'
export interface SplitMemberOption {
  userId: string
  displayName: string
  isCurrentUser: boolean
}

interface SplitPersonSelectorProps {
  members: SplitMemberOption[]
  selectedUserIds: string[]
  onToggle: (uid: string) => void
  lockedUserIds?: Set<string>
  splitType: SplitType
  currency: string
  values: Record<string, string>
  pinnedUserIds?: PinnedSplits
  lineAmount: number
  onValueChange: (uid: string, raw: string) => void
  onSelectAll?: () => void
  onDeselectAll?: () => void
  size?: 'default' | 'compact'
  showHeader?: boolean
}

export function SplitPersonSelector({
  members,
  selectedUserIds,
  onToggle,
  lockedUserIds,
  splitType,
  currency,
  values,
  pinnedUserIds,
  lineAmount,
  onValueChange,
  onSelectAll,
  onDeselectAll,
  size = 'default',
  showHeader = true,
}: SplitPersonSelectorProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const isEqual = splitType === 'equal'
  const allSelected = members.length > 0 && members.every((m) => selectedUserIds.includes(m.userId))
  const selectedMembers = members.filter((m) => selectedUserIds.includes(m.userId))
  const filtered = search
    ? members.filter((m) =>
        (m.isCurrentUser ? 'You' : m.displayName).toLowerCase().includes(search.toLowerCase()),
      )
    : members

  const sum = selectedUserIds.reduce((a, uid) => a + parseSplitNumber(values[uid]), 0)
  const pctOk = splitType === 'percentage' && Math.abs(sum - 100) <= 0.06
  const customOk = splitType === 'custom' && lineAmount > 0 && Math.abs(sum - lineAmount) <= 0.06
  const qtyValid =
    splitType === 'quantity' &&
    selectedUserIds.every((uid) => {
      const n = parseSplitNumber(values[uid])
      return Number.isInteger(n) && n >= 1
    })

  function openDropdown() {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    const openUpward = spaceAbove > spaceBelow && spaceBelow < 200
    const MAX_DROPDOWN_HEIGHT = 280

    setDropdownStyle(
      openUpward
        ? {
            position: 'fixed',
            bottom: window.innerHeight - rect.top + 4,
            left: rect.left,
            width: rect.width,
            maxHeight: `clamp(120px, calc(${spaceAbove}px - env(safe-area-inset-top)), ${MAX_DROPDOWN_HEIGHT}px)`,
            zIndex: 9999,
          }
        : {
            position: 'fixed',
            top: rect.bottom + 4,
            left: rect.left,
            width: rect.width,
            maxHeight: `clamp(120px, calc(${spaceBelow}px - env(safe-area-inset-bottom)), ${MAX_DROPDOWN_HEIGHT}px)`,
            zIndex: 9999,
          },
    )
    setOpen(true)
  }

  function closeDropdown() {
    setOpen(false)
    setSearch('')
  }

  // Close on click outside
  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      const target = e.target as Node
      if (triggerRef.current?.contains(target) || dropdownRef.current?.contains(target)) return
      closeDropdown()
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  // Close when scrolling outside the dropdown (e.g. the dialog body behind it).
  // Uses composedPath() because e.target on mobile can be document/window, not the actual element.
  useEffect(() => {
    if (!open) return
    function handleScroll(e: Event) {
      const path = e.composedPath?.() ?? []
      const insideDropdown =
        dropdownRef.current &&
        path.some((n) => n === dropdownRef.current || dropdownRef.current!.contains(n as Node))
      if (insideDropdown) return
      closeDropdown()
    }
    window.addEventListener('scroll', handleScroll, true)
    return () => window.removeEventListener('scroll', handleScroll, true)
  }, [open])

  return (
    <div className="flex flex-col gap-1.5">
      {showHeader && (
        <div className="flex items-center gap-1.5 font-medium text-stone-600"
          style={{ fontSize: size === 'compact' ? '0.75rem' : '0.875rem' }}
        >
          <UserPlus className="size-3.5" />
          Split with
        </div>
      )}

      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closeDropdown() : openDropdown())}
        className={cn(
          'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-xl border bg-white px-3 py-2 text-left transition-colors',
          open ? 'border-stone-400' : 'border-stone-200 hover:border-stone-300',
        )}
      >
        {selectedMembers.length === 0 ? (
          <span className="flex-1 text-sm text-stone-400">Select people…</span>
        ) : (
          <div className="flex flex-1 flex-wrap gap-1">
            {selectedMembers.map((m) => {
              const locked = lockedUserIds?.has(m.userId)
              const name = m.isCurrentUser ? 'You' : m.displayName
              return (
                <span
                  key={m.userId}
                  className="inline-flex items-center gap-0.5 rounded-full bg-teal-800/10 px-2 py-0.5 text-xs font-medium text-teal-800"
                >
                  {name}
                  {!locked && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onToggle(m.userId)
                      }}
                      className="ml-0.5 rounded-full p-0.5 hover:bg-teal-800/20"
                    >
                      <X className="size-2.5" />
                    </button>
                  )}
                </span>
              )
            })}
          </div>
        )}
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 text-stone-400 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {/* Dropdown — rendered via portal to escape overflow clipping */}
      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            style={dropdownStyle}
            className="flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-md"
          >
            {/* Search */}
            <div className="shrink-0 border-b border-stone-100 p-2">
              <div className="flex items-center gap-2 rounded-lg border border-stone-200 bg-stone-50 px-2.5">
                <Search className="size-3.5 shrink-0 text-stone-400" />
                <input
                  type="text"
                  placeholder="Search people…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') closeDropdown()
                  }}
                  className="flex-1 bg-transparent py-2 text-[16px] leading-5 outline-none placeholder:text-stone-400"
                  autoFocus
                />
              </div>
            </div>

            {/* Select all — only when not filtering and props provided */}
            {members.length > 1 && !search && (onSelectAll || onDeselectAll) && (
              <div className="shrink-0 border-b border-stone-100 px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => (allSelected ? onDeselectAll?.() : onSelectAll?.())}
                  className="text-xs font-medium text-teal-700 hover:text-teal-900"
                >
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              </div>
            )}

            {/* Member list — flex-1 so it fills remaining height within the panel's maxHeight */}
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-stone-400">No people found</p>
              ) : (
                filtered.map((m) => {
                  const selected = selectedUserIds.includes(m.userId)
                  const locked = lockedUserIds?.has(m.userId)
                  return (
                    <div
                      key={m.userId}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (locked) return
                        onToggle(m.userId)
                        setSearch('')
                      }}
                      className={cn(
                        'flex items-center gap-2 rounded-lg px-2 py-2',
                        locked ? 'cursor-default opacity-70' : 'cursor-pointer hover:bg-stone-50',
                      )}
                    >
                      <div
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
                          selected
                            ? 'border-transparent bg-teal-800 text-white'
                            : 'border-stone-300 bg-white',
                        )}
                      >
                        {selected && <Check className="size-2.5" />}
                      </div>
                      <span className={cn('flex-1 truncate text-sm', selected && 'font-medium text-stone-800')}>
                        {m.isCurrentUser ? 'You' : m.displayName}
                      </span>
                      {locked && <Lock className="size-3 text-stone-400" />}
                    </div>
                  )
                })
              )}
            </div>
          </div>,
          document.body,
        )}

      {/* Split value inputs — shown below trigger for non-equal splits */}
      {!isEqual && selectedMembers.length > 0 && (
        <div className="space-y-1.5 rounded-xl border border-stone-200 bg-white px-3 py-2">
          <p className="text-xs font-medium text-stone-500">
            {splitType === 'quantity'
              ? 'Units per person (must be 1 or more each)'
              : splitType === 'percentage'
                ? 'Percent per person (total must be 100%). Edited fields stay fixed; the rest update.'
                : `Amount per person (${currency}, must total the line amount). Edited fields stay fixed.`}
          </p>
          {selectedMembers.map((m) => {
            const pinned = Boolean(pinnedUserIds?.[m.userId])
            return (
              <div key={m.userId} className="flex items-center gap-2">
                <span
                  className={cn(
                    'flex shrink-0 items-center gap-1 truncate text-stone-700',
                    size === 'compact' ? 'w-20 text-xs' : 'w-24 text-sm',
                  )}
                >
                  {pinned && <Lock className="size-3 shrink-0 text-stone-400" aria-hidden />}
                  {m.isCurrentUser ? 'You' : m.displayName}
                </span>
                {splitType === 'quantity' ? (
                  <Input
                    type="text"
                    inputMode="numeric"
                    className={cn('flex-1 rounded-lg', size === 'compact' ? 'h-7 text-xs' : 'h-9 text-sm')}
                    placeholder="Qty"
                    value={values[m.userId] ?? ''}
                    onChange={(e) => onValueChange(m.userId, e.target.value.replace(/[^0-9]/g, ''))}
                  />
                ) : (
                  <Input
                    type="text"
                    inputMode="decimal"
                    className={cn('flex-1 rounded-lg', size === 'compact' ? 'h-7 text-xs' : 'h-9 text-sm')}
                    placeholder={splitType === 'percentage' ? '%' : '0.00'}
                    value={values[m.userId] ?? ''}
                    onChange={(e) => onValueChange(m.userId, filterDecimalInput(e.target.value))}
                    onBlur={() => {
                      const v = values[m.userId] ?? ''
                      const next = stripLeadingZerosAmount(v)
                      if (next !== v) onValueChange(m.userId, next)
                    }}
                  />
                )}
              </div>
            )
          })}
          {splitType === 'quantity' && lineAmount > 0 && (
            <p className={cn('text-xs', qtyValid ? 'text-emerald-600' : 'text-amber-600')}>
              {sum} unit{sum !== 1 ? 's' : ''} · {formatCurrency(sum * lineAmount, currency)} total
            </p>
          )}
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
      )}
    </div>
  )
}
