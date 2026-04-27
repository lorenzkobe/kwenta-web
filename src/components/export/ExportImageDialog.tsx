import { type ReactNode, useEffect } from 'react'
import { Copy, Download, Loader2, Share2, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useExportImage } from '@/hooks/useExportImage'

interface Props {
  children: ReactNode
  filename?: string
  onClose: () => void
}

export function ExportImageDialog({ children, filename = 'kwenta-export.png', onClose }: Props) {
  const { ref: cardRef, busy, capture } = useExportImage()

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  async function handleSave() {
    const result = await capture()
    if (!result) { toast.error('Could not generate image.'); return }
    const a = document.createElement('a')
    a.href = result.dataUrl
    a.download = filename
    a.click()
  }

  async function handleCopy() {
    const result = await capture()
    if (!result) { toast.error('Could not generate image.'); return }
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': result.blob }),
      ])
      toast.success('Image copied to clipboard.')
    } catch {
      toast.info('Copy not supported on this browser — use Save instead.')
    }
  }

  async function handleShare() {
    const result = await capture()
    if (!result) { toast.error('Could not generate image.'); return }
    const file = new File([result.blob], filename, { type: 'image/png' })
    try {
      await navigator.share({ files: [file] })
    } catch {
      // user cancelled
    }
  }

  const canShare =
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div className="relative flex max-h-[min(92dvh,700px)] w-full max-w-sm animate-[slideUp_0.25s_ease-out] flex-col overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex shrink-0 items-center justify-between border-b border-stone-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Share2 className="size-4 text-teal-800" />
            <h2 className="text-base font-semibold">Share summary</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        {/* Card preview — rendered live, captured on button tap */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-stone-100/80 p-4">
          <div ref={cardRef} className="w-full">
            {children}
          </div>
        </div>

        <div className="shrink-0 border-t border-stone-100 p-4">
          <div className="flex gap-2">
            {canShare && (
              <Button
                className="flex-1 rounded-xl gap-1.5"
                onClick={() => void handleShare()}
                disabled={busy}
              >
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Share2 className="size-3.5" />}
                Share
              </Button>
            )}
            <Button
              variant={canShare ? 'outline' : 'default'}
              className="flex-1 rounded-xl gap-1.5"
              onClick={() => void handleSave()}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
              Save
            </Button>
            <Button
              variant="outline"
              className="flex-1 rounded-xl gap-1.5"
              onClick={() => void handleCopy()}
              disabled={busy}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3.5" />}
              Copy
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
