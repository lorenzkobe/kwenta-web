import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BellRing, RefreshCw } from 'lucide-react'
import {
  fetchKwentaNotifications,
  markKwentaNotificationRead,
  type KwentaNotificationRow,
} from '@/lib/kwenta-notifications'
import { useAppStore } from '@/store/app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

export function NotificationsBell({ userId }: { userId: string }) {
  const navigate = useNavigate()
  const isOnline = useAppStore((s) => s.isOnline)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<KwentaNotificationRow[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const loadList = useCallback(async () => {
    if (!isOnline) return
    setListError(null)
    setLoading(true)
    try {
      const rows = await fetchKwentaNotifications(userId)
      setItems(rows)
      setUnread(rows.filter((r) => !r.read_at).length)
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Could not load notifications')
    } finally {
      setLoading(false)
    }
  }, [userId, isOnline])

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
          <div className="flex items-center justify-between border-b border-stone-100 px-4 pb-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
              Notifications
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="rounded-full text-stone-500"
              aria-label="Refresh notifications"
              disabled={!isOnline || loading}
              onClick={() => void loadList()}
            >
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            </Button>
          </div>
          <p className="px-4 pt-2 text-[0.65rem] text-stone-400">
            Refreshes when you open this panel — not polled in the background.
          </p>
          {!isOnline && (
            <p className="px-4 py-6 text-center text-sm text-stone-500">Connect to the internet to load alerts.</p>
          )}
          {isOnline && listError && (
            <div className="px-4 py-4">
              <p className="text-sm text-amber-800">{listError}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 rounded-lg"
                onClick={() => void loadList()}
              >
                Retry
              </Button>
            </div>
          )}
          {isOnline && !listError && loading && items.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-stone-500">Loading…</p>
          )}
          {isOnline && !listError && !loading && items.length === 0 && (
            <p className="px-4 py-8 text-center text-sm text-stone-500">No notifications</p>
          )}
          {isOnline && !listError && items.length > 0 && (
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
