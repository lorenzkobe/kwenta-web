import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BellRing } from 'lucide-react'
import {
  fetchKwentaNotifications,
  fetchUnreadKwentaNotificationCount,
  markKwentaNotificationRead,
  type KwentaNotificationRow,
} from '@/lib/kwenta-notifications'
import { useAppStore } from '@/store/app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

const POLL_MS = 45_000

export function NotificationsBell({ userId }: { userId: string }) {
  const navigate = useNavigate()
  const isOnline = useAppStore((s) => s.isOnline)
  const syncStatus = useAppStore((s) => s.syncStatus)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<KwentaNotificationRow[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  const refreshUnread = useCallback(async () => {
    if (!isOnline) return
    const n = await fetchUnreadKwentaNotificationCount(userId)
    setUnread(n)
  }, [userId, isOnline])

  const loadList = useCallback(async () => {
    if (!isOnline) return
    setLoading(true)
    try {
      const rows = await fetchKwentaNotifications(userId)
      setItems(rows)
    } finally {
      setLoading(false)
    }
  }, [userId, isOnline])

  useEffect(() => {
    void refreshUnread()
  }, [refreshUnread, syncStatus])

  useEffect(() => {
    if (!isOnline) return
    const t = setInterval(() => void refreshUnread(), POLL_MS)
    return () => clearInterval(t)
  }, [isOnline, refreshUnread])

  useEffect(() => {
    if (!open) return
    void loadList()
  }, [open, loadList])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function onPick(row: KwentaNotificationRow) {
    await markKwentaNotificationRead(row.id, userId)
    void refreshUnread()
    void loadList()
    setOpen(false)
    if (row.kind === 'bill_participant' && row.entity_id) {
      navigate(`/app/bills/${row.entity_id}`)
    } else {
      navigate('/app/people')
    }
  }

  return (
    <div className="relative" ref={wrapRef}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="relative rounded-full"
        aria-label="Notifications"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <BellRing className="size-4" />
        {unread > 0 && (
          <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-teal-800 text-[0.6rem] font-bold text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>

      {open && (
        <div
          className="absolute right-0 top-full z-80 mt-2 w-[min(100vw-2rem,22rem)] rounded-2xl border border-stone-200 bg-white py-2 shadow-[0_20px_60px_rgba(28,25,23,0.15)]"
          role="menu"
        >
          <p className="border-b border-stone-100 px-4 pb-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
            Notifications
          </p>
          {!isOnline && (
            <p className="px-4 py-6 text-center text-sm text-stone-500">Connect to the internet to load alerts.</p>
          )}
          {isOnline && loading && items.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-stone-500">Loading…</p>
          )}
          {isOnline && !loading && items.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-stone-500">No notifications yet.</p>
          )}
          {isOnline && items.length > 0 && (
            <ul className="max-h-[min(70vh,20rem)] overflow-y-auto">
              {items.map((row) => (
                <li key={row.id} className="border-b border-stone-100 last:border-0">
                  <button
                    type="button"
                    className={cn(
                      'w-full px-4 py-3 text-left text-sm transition-colors hover:bg-stone-50',
                      !row.read_at && 'bg-teal-800/4',
                    )}
                    onClick={() => void onPick(row)}
                  >
                    <p className="font-medium text-stone-900">{row.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-stone-600">{row.body}</p>
                    <p className="mt-1 text-[0.65rem] text-stone-400">
                      {new Date(row.created_at).toLocaleString()}
                    </p>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
