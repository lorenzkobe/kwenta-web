import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { BellRing, CheckCheck, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteKwentaNotification,
  fetchKwentaNotifications,
  markKwentaNotificationRead,
  type KwentaNotificationRow,
} from '@/lib/kwenta-notifications'
import { captureMetric, withMetric } from '@/lib/client-metrics'
import { fullSync } from '@/sync/sync-service'
import { supabase } from '@/lib/supabase'
import { useAppStore } from '@/store/app-store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { db } from '@/db/db'

export function NotificationsBell({ userId }: { userId: string }) {
  const navigate = useNavigate()
  const isOnline = useAppStore((s) => s.isOnline)
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<KwentaNotificationRow[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<KwentaNotificationRow | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const loadListRef = useRef<() => Promise<void>>(() => Promise.resolve())
  const unreadCacheKey = `kwenta_notifications_unread:${userId}`

  const loadList = useCallback(async () => {
    if (!isOnline) return
    setListError(null)
    setLoading(true)
    try {
      const rows = await withMetric('notifications.fetchList', () => fetchKwentaNotifications(userId), { trigger: 'open_or_manual' })
      setItems(rows)
      const nextUnread = rows.filter((r) => !r.read_at).length
      setUnread(nextUnread)
      localStorage.setItem(unreadCacheKey, String(nextUnread))
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Could not load notifications')
    } finally {
      setLoading(false)
    }
  }, [userId, isOnline, unreadCacheKey])

  // Keep loadListRef current so the subscription callback can call the latest version
  // without being a reactive dependency of the subscription effect.
  useEffect(() => {
    loadListRef.current = loadList
  }, [loadList])

  useEffect(() => {
    if (!open) return
    void loadList()
  }, [open, loadList])

  // Seed the counter from localStorage immediately, then refresh from the server
  // once online so the badge is never stuck showing a stale cached count.
  useEffect(() => {
    if (initializedRef.current) return
    initializedRef.current = true
    const cached = Number(localStorage.getItem(unreadCacheKey) ?? '0')
    if (Number.isFinite(cached) && cached >= 0) {
      setUnread(cached)
    }
  }, [unreadCacheKey])

  useEffect(() => {
    if (!isOnline || !userId) return
    void loadList()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, userId]) // intentionally omit loadList — we want one fetch per online transition

  useEffect(() => {
    if (!isOnline) return
    const channel = supabase
      .channel(`kwenta_notifications:${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'kwenta_notifications',
          filter: `recipient_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.eventType === 'DELETE') {
            const prev = (payload.old ?? null) as Partial<KwentaNotificationRow> | null
            if (!prev?.id) return
            setItems((rows) => rows.filter((r) => r.id !== prev.id))
            if (!prev.read_at) setUnread((n) => Math.max(0, n - 1))
            return
          }
          const next = payload.new as KwentaNotificationRow | null
          if (!next) return
          if (payload.eventType === 'INSERT') {
            setItems((prev) => [next, ...prev.filter((p) => p.id !== next.id)].slice(0, 50))
            if (!next.read_at) {
              setUnread((n) => n + 1)
              toast(next.title, { description: next.body, id: next.id })
            }
          } else if (payload.eventType === 'UPDATE') {
            setItems((prev) => {
              const before = prev.find((p) => p.id === next.id)
              if (!before) return prev
              if (!before.read_at && next.read_at) setUnread((n) => Math.max(0, n - 1))
              if (before.read_at && !next.read_at) setUnread((n) => n + 1)
              return prev.map((p) => (p.id === next.id ? next : p))
            })
          }
        },
      )
      .subscribe((status) => {
        captureMetric('notifications.realtime.status', status !== 'CHANNEL_ERROR' && status !== 'TIMED_OUT', 0, { status })
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Realtime health degraded — fall back to a server fetch to reconcile.
          void loadListRef.current()
        }
      })

    return () => {
      void supabase.removeChannel(channel)
    }
    // loadList is intentionally excluded: keeping it stable avoids tearing down and
    // re-creating the subscription on every isOnline / loadList reference change,
    // which was causing missed INSERT events. loadListRef.current is used instead for
    // the error-recovery path so it always calls the latest version.
  }, [userId, isOnline])

  useEffect(() => {
    localStorage.setItem(unreadCacheKey, String(unread))
  }, [unread, unreadCacheKey])

  useEffect(() => {
    if (!open) return
    function onDoc(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  async function canOpenGroup(groupId: string): Promise<boolean> {
    const [group, membership] = await Promise.all([
      db.groups.get(groupId),
      db.group_members.where('[group_id+user_id]').equals([groupId, userId]).first(),
    ])
    return Boolean(group && !group.is_deleted && membership && !membership.is_deleted)
  }

  async function onPick(row: KwentaNotificationRow) {
    await withMetric('notifications.markRead', () => markKwentaNotificationRead(row.id, userId))
    setItems((prev) => prev.map((p) => (p.id === row.id ? { ...p, read_at: new Date().toISOString() } : p)))
    setUnread((n) => Math.max(0, n - (row.read_at ? 0 : 1)))
    void loadList()
    setOpen(false)
    if (row.kind === 'bill_participant' && row.entity_id) {
      navigate(`/app/bills/${row.entity_id}`)
    } else if (row.kind === 'added_to_group' && row.group_id) {
      let syncErrors: string[] = []
      if (isOnline) {
        const syncResult = await withMetric('notifications.syncBeforeGroupNav', () => fullSync(userId), {
          groupId: row.group_id,
        })
        syncErrors = syncResult.errors
      }

      const hasGroupAccess = await canOpenGroup(row.group_id)
      if (hasGroupAccess) {
        navigate(`/app/groups/${row.group_id}`)
        return
      }

      if (!isOnline) {
        toast.info('You are offline. Reconnect to load this group.')
      } else if (syncErrors.length > 0) {
        toast.info('This group is still syncing. Try again in a moment.')
      } else {
        toast.info('This group is no longer available.')
      }
      navigate('/app/groups')
    } else {
      navigate('/app/people')
    }
  }

  async function markAllRead() {
    const pending = items.filter((row) => !row.read_at)
    if (pending.length === 0) return
    await Promise.all(pending.map((row) => withMetric('notifications.markRead', () => markKwentaNotificationRead(row.id, userId))))
    setItems((prev) => prev.map((row) => ({ ...row, read_at: row.read_at ?? new Date().toISOString() })))
    setUnread(0)
    void loadList()
  }

  async function onDeleteRow(row: KwentaNotificationRow) {
    await withMetric('notifications.delete', () => deleteKwentaNotification(row.id, userId))
    setItems((prev) => prev.filter((r) => r.id !== row.id))
    if (!row.read_at) setUnread((n) => Math.max(0, n - 1))
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
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-full text-stone-500"
                aria-label="Mark all as read"
                disabled={!isOnline || loading || unread === 0}
                onClick={() => void markAllRead()}
              >
                <CheckCheck className="size-3.5" />
              </Button>
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
          </div>
          <p className="px-4 pt-2 text-[0.65rem] text-stone-400">Realtime updates when online.</p>
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
                  <div className={cn('flex items-start gap-1 px-2 py-1', !row.read_at && 'bg-teal-800/4')}>
                    <button
                      type="button"
                      className="flex-1 rounded-lg px-2 py-2 text-left text-sm transition-colors hover:bg-stone-50"
                      onClick={() => void onPick(row)}
                    >
                      <p className="font-medium text-stone-900">{row.title}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-stone-600">{row.body}</p>
                      <p className="mt-1 text-[0.65rem] text-stone-400">
                        {new Date(row.created_at).toLocaleString()}
                      </p>
                    </button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="mt-1 rounded-full text-stone-500"
                      aria-label="Delete notification"
                      onClick={() => setDeleteTarget(row)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(null)
        }}
        title="Delete notification?"
        description="This notification will be removed from your list."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={async () => {
          if (!deleteTarget) return
          await onDeleteRow(deleteTarget)
          setDeleteTarget(null)
        }}
      />
    </div>
  )
}
