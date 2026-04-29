import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { Copy, Download, FileText, Loader2, Share2, TableProperties, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useExportImage } from '@/hooks/useExportImage'

interface Props {
  children: ReactNode
  filename?: string
  onExportPDF?: () => Promise<void>
  onExportCSV?: () => Promise<void>
  onClose: () => void
}

export function ExportImageDialog({
  children,
  filename = 'kwenta-export',
  onExportPDF,
  onExportCSV,
  onClose,
}: Props) {
  const { ref: cardRef, busy, capture } = useExportImage()
  const [pdfBusy, setPdfBusy] = useState(false)
  const [csvBusy, setCsvBusy] = useState(false)

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
    a.download = `${filename}.png`
    a.click()
  }

  async function handleCopy() {
    const result = await capture()
    if (!result) { toast.error('Could not generate image.'); return }
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': result.blob })])
      toast.success('Copied to clipboard.')
    } catch {
      toast.info('Copy not supported — use Save instead.')
    }
  }

  async function handleShare() {
    const result = await capture()
    if (!result) { toast.error('Could not generate image.'); return }
    const file = new File([result.blob], `${filename}.png`, { type: 'image/png' })
    try { await navigator.share({ files: [file] }) } catch { /* user cancelled */ }
  }

  async function handlePDF() {
    if (!onExportPDF) return
    setPdfBusy(true)
    const id = toast.loading('Generating PDF…')
    try {
      await onExportPDF()
      toast.success('PDF downloaded', { id })
    } catch {
      toast.error('Could not generate PDF', { id })
    } finally {
      setPdfBusy(false)
    }
  }

  async function handleCSV() {
    if (!onExportCSV) return
    setCsvBusy(true)
    const id = toast.loading('Preparing CSV…')
    try {
      await onExportCSV()
      toast.success('CSV downloaded', { id })
    } catch {
      toast.error('Could not export CSV', { id })
    } finally {
      setCsvBusy(false)
    }
  }

  // True only on real mobile browsers (iOS Safari, Android Chrome) that support
  // file sharing via the native share sheet. Desktop browsers — including Chrome
  // in responsive/mobile-emulation mode — return false from canShare({ files }).
  const canShareFiles = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    if (typeof navigator.share !== 'function') return false
    if (typeof navigator.canShare !== 'function') return false
    try {
      return navigator.canShare({ files: [new File([''], 'test.png', { type: 'image/png' })] })
    } catch {
      return false
    }
  }, [])

  const anyBusy = busy || pdfBusy || csvBusy
  const hasDataExports = onExportPDF || onExportCSV

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <div className="relative flex max-h-[min(92dvh,720px)] w-full max-w-sm animate-[slideUp_0.25s_ease-out] flex-col overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="flex shrink-0 items-center justify-between border-b border-stone-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Share2 className="size-4 text-teal-800" />
            <h2 className="text-base font-semibold">Share summary</h2>
          </div>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain bg-stone-100/80 p-4">
          <div ref={cardRef} className="w-full">
            {children}
          </div>
        </div>

        <div className="shrink-0 border-t border-stone-100 p-4 space-y-2">
          {canShareFiles ? (
            /* Real mobile: native share sheet handles save & copy */
            <Button className="w-full rounded-xl gap-1.5" onClick={() => void handleShare()} disabled={anyBusy}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Share2 className="size-3.5" />}
              Share
            </Button>
          ) : (
            /* Desktop: explicit Save + Copy */
            <div className="flex gap-2">
              <Button className="flex-1 rounded-xl gap-1.5" onClick={() => void handleSave()} disabled={anyBusy}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />}
                Save PNG
              </Button>
              <Button variant="outline" className="flex-1 rounded-xl gap-1.5" onClick={() => void handleCopy()} disabled={anyBusy}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Copy className="size-3.5" />}
                Copy
              </Button>
            </div>
          )}

          {/* Data exports — same on both */}
          {hasDataExports && (
            <div className="flex gap-2 pt-1 border-t border-stone-100">
              {onExportPDF && (
                <Button variant="outline" className="flex-1 rounded-xl gap-1.5" onClick={() => void handlePDF()} disabled={anyBusy}>
                  {pdfBusy ? <Loader2 className="size-3.5 animate-spin" /> : <FileText className="size-3.5" />}
                  Export PDF
                </Button>
              )}
              {onExportCSV && (
                <Button variant="outline" className="flex-1 rounded-xl gap-1.5" onClick={() => void handleCSV()} disabled={anyBusy}>
                  {csvBusy ? <Loader2 className="size-3.5 animate-spin" /> : <TableProperties className="size-3.5" />}
                  Export CSV
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
