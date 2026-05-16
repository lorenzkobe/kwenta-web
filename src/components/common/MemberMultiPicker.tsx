import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface MemberMultiPickerOption {
  id: string
  displayName: string
  subtitle?: string
}

interface MemberMultiPickerProps {
  people: MemberMultiPickerOption[]
  selectedIds: string[]
  onChange: (ids: string[]) => void
  placeholder?: string
  emptyMessage?: string
  disabled?: boolean
}

export function MemberMultiPicker({
  people,
  selectedIds,
  onChange,
  placeholder = 'Select people…',
  emptyMessage = 'No people found',
  disabled = false,
}: MemberMultiPickerProps) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({})
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const selectedSet = new Set(selectedIds)
  const selectedPeople = people.filter((p) => selectedSet.has(p.id))
  const filtered = search
    ? people.filter((p) =>
        p.displayName.toLowerCase().includes(search.toLowerCase()) ||
        (p.subtitle ?? '').toLowerCase().includes(search.toLowerCase()),
      )
    : people

  function openDropdown() {
    if (!triggerRef.current) return
    const rect = triggerRef.current.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - 8
    const spaceAbove = rect.top - 8
    const openUpward = spaceAbove > spaceBelow && spaceBelow < 200

    setDropdownStyle(
      openUpward
        ? {
            position: 'fixed',
            bottom: window.innerHeight - rect.top + 4,
            left: rect.left,
            width: rect.width,
            maxHeight: Math.max(spaceAbove, 120),
            zIndex: 9999,
          }
        : {
            position: 'fixed',
            top: rect.bottom + 4,
            left: rect.left,
            width: rect.width,
            maxHeight: Math.max(spaceBelow, 120),
            zIndex: 9999,
          },
    )
    setOpen(true)
  }

  function closeDropdown() {
    setOpen(false)
    setSearch('')
  }

  function toggle(id: string) {
    if (selectedSet.has(id)) {
      onChange(selectedIds.filter((x) => x !== id))
    } else {
      onChange([...selectedIds, id])
    }
  }

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
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? closeDropdown() : openDropdown())}
        className={cn(
          'flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-xl border bg-white px-3 py-2 text-left transition-colors',
          open ? 'border-stone-400' : 'border-stone-200 hover:border-stone-300',
          disabled && 'cursor-not-allowed opacity-60',
        )}
      >
        {selectedPeople.length === 0 ? (
          <span className="flex-1 text-sm text-stone-400">{placeholder}</span>
        ) : (
          <div className="flex flex-1 flex-wrap gap-1">
            {selectedPeople.map((p) => (
              <span
                key={p.id}
                className="inline-flex items-center gap-0.5 rounded-full bg-teal-800/10 px-2 py-0.5 text-xs font-medium text-teal-800"
              >
                {p.displayName}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    toggle(p.id)
                  }}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-teal-800/20"
                >
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
        )}
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 text-stone-400 transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open &&
        createPortal(
          <div
            ref={dropdownRef}
            style={dropdownStyle}
            className="flex flex-col overflow-hidden rounded-xl border border-stone-200 bg-white shadow-md"
          >
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

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-1">
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-center text-xs text-stone-400">{emptyMessage}</p>
              ) : (
                filtered.map((p) => {
                  const selected = selectedSet.has(p.id)
                  return (
                    <div
                      key={p.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        toggle(p.id)
                        setSearch('')
                      }}
                      className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-2 hover:bg-stone-50"
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
                      <div className="min-w-0 flex-1">
                        <p className={cn('truncate text-sm', selected && 'font-medium text-stone-800')}>
                          {p.displayName}
                        </p>
                        {p.subtitle && (
                          <p className="truncate text-[0.65rem] text-stone-400">{p.subtitle}</p>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </div>
  )
}
