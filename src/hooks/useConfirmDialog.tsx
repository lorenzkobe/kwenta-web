import { useCallback, useMemo, useState } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'

type ConfirmVariant = 'default' | 'danger'

type ConfirmRequest = {
  title: string
  description: string
  confirmLabel: string
  cancelLabel: string
  variant: ConfirmVariant
  resolve: (ok: boolean) => void
}

export interface ConfirmDialogOptions {
  title: string
  description: string
  confirmLabel?: string
  cancelLabel?: string
  variant?: ConfirmVariant
}

export function useConfirmDialog() {
  const [request, setRequest] = useState<ConfirmRequest | null>(null)

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      setRequest({
        title: options.title,
        description: options.description,
        confirmLabel: options.confirmLabel ?? 'Continue',
        cancelLabel: options.cancelLabel ?? 'Cancel',
        variant: options.variant ?? 'default',
        resolve,
      })
    })
  }, [])

  const close = useCallback((ok: boolean) => {
    setRequest((prev) => {
      if (prev) prev.resolve(ok)
      return null
    })
  }, [])

  const dialog = useMemo(
    () => (
      <ConfirmDialog
        open={Boolean(request)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) close(false)
        }}
        title={request?.title ?? 'Confirm'}
        description={request?.description ?? ''}
        confirmLabel={request?.confirmLabel ?? 'Continue'}
        cancelLabel={request?.cancelLabel ?? 'Cancel'}
        variant={request?.variant ?? 'default'}
        onConfirm={() => close(true)}
      />
    ),
    [request, close],
  )

  return { confirm, dialog }
}
