import { useEffect, useState } from 'react'
import { useAppStore } from '@/store/app-store'
import { cn } from '@/lib/utils'

const AUTO_HIDE_MS = 4000

export function RealtimeNoticeBanner() {
  const notice = useAppStore((s) => s.realtimeNotice)
  const clear = useAppStore((s) => s.setRealtimeNotice)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (!notice) {
      setVisible(false)
      return
    }
    setVisible(true)
    const t = setTimeout(() => {
      setVisible(false)
      clear(null)
    }, AUTO_HIDE_MS)
    return () => clearTimeout(t)
  }, [notice?.at, notice?.message, clear])

  if (!notice) return null

  return (
    <div
      className={cn(
        'mb-3 rounded-2xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900 shadow-sm transition-opacity',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      role="status"
      aria-live="polite"
    >
      {notice.message}
    </div>
  )
}

