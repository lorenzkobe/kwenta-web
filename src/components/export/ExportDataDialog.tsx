import { useState } from 'react'
import { FileText, Loader2, TableProperties, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

interface Props {
  title?: string
  description?: string
  onExportPDF: () => Promise<void>
  onExportCSV: () => Promise<void>
  onClose: () => void
}

export function ExportDataDialog({
  title = 'Export',
  description,
  onExportPDF,
  onExportCSV,
  onClose,
}: Props) {
  const [pdfBusy, setPdfBusy] = useState(false)
  const [csvBusy, setCsvBusy] = useState(false)
  const anyBusy = pdfBusy || csvBusy

  async function handlePDF() {
    setPdfBusy(true)
    const id = toast.loading('Generating PDF…')
    try {
      await onExportPDF()
      toast.success('PDF downloaded', { id })
      onClose()
    } catch {
      toast.error('Could not generate PDF', { id })
    } finally {
      setPdfBusy(false)
    }
  }

  async function handleCSV() {
    setCsvBusy(true)
    const id = toast.loading('Preparing CSV…')
    try {
      await onExportCSV()
      toast.success('CSV downloaded', { id })
      onClose()
    } catch {
      toast.error('Could not export CSV', { id })
    } finally {
      setCsvBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} aria-hidden />
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white p-5 shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <Button variant="ghost" size="icon-xs" className="rounded-full" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </div>
        {description && (
          <p className="mb-4 text-sm text-stone-500">{description}</p>
        )}
        <div className="flex flex-col gap-2">
          <Button
            className="w-full rounded-xl gap-2 h-11"
            onClick={() => void handlePDF()}
            disabled={anyBusy}
          >
            {pdfBusy ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
            Export as PDF
          </Button>
          <Button
            variant="outline"
            className="w-full rounded-xl gap-2 h-11"
            onClick={() => void handleCSV()}
            disabled={anyBusy}
          >
            {csvBusy ? <Loader2 className="size-4 animate-spin" /> : <TableProperties className="size-4" />}
            Export as CSV
          </Button>
        </div>
      </div>
    </div>
  )
}
