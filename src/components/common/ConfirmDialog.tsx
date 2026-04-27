import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'default',
  confirmDisabled = false,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: 'default' | 'danger'
  confirmDisabled?: boolean
  onConfirm: () => void | Promise<void>
}) {
  const [pending, setPending] = useState(false)

  if (!open) return null

  async function handleConfirm() {
    if (pending) return
    setPending(true)
    try {
      await Promise.resolve(onConfirm())
      onOpenChange(false)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={() => !pending && onOpenChange(false)}
        aria-hidden
      />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-desc"
        className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white p-5 shadow-[0_20px_60px_rgba(28,25,23,0.18)]"
      >
        <div className="flex gap-3">
          {variant === 'danger' && (
            <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-red-500/15 text-red-600">
              <AlertTriangle className="size-5" aria-hidden />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <h2 id="confirm-dialog-title" className="text-base font-semibold text-stone-900">
              {title}
            </h2>
            <p id="confirm-dialog-desc" className="mt-1.5 text-sm leading-relaxed text-stone-600">
              {description}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            variant="outline"
            className="rounded-xl sm:min-w-24"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            className={cn(
              'rounded-xl sm:min-w-24',
              variant === 'danger' && 'bg-red-600 text-white shadow-sm hover:bg-red-700',
            )}
            disabled={pending || confirmDisabled}
            onClick={handleConfirm}
          >
            {pending ? '…' : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
