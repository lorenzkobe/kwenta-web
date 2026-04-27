import { useCallback, useRef, useState } from 'react'
import { toPng } from 'html-to-image'

export function useExportImage() {
  const ref = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)

  const capture = useCallback(async (): Promise<{ dataUrl: string; blob: Blob } | null> => {
    if (!ref.current) return null
    setBusy(true)
    try {
      const dataUrl = await toPng(ref.current, { pixelRatio: 2 })
      const res = await fetch(dataUrl)
      const blob = await res.blob()
      return { dataUrl, blob }
    } catch {
      return null
    } finally {
      setBusy(false)
    }
  }, [])

  return { ref, busy, capture }
}
