import { WifiOff } from 'lucide-react'
import { useAppStore } from '@/store/app-store'

export function OfflineBanner() {
  const isOnline = useAppStore((s) => s.isOnline)

  if (isOnline) return null

  return (
    <div className="fixed inset-x-0 top-0 z-50 bg-amber-500/95 px-4 py-2 text-center text-xs font-medium text-white backdrop-blur">
      <WifiOff className="mr-1.5 inline-block size-3.5" />
      You&apos;re offline — changes are saved locally and will sync when you reconnect
    </div>
  )
}
