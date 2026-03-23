import { useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { Link, useNavigate } from 'react-router-dom'
import {
  ArrowUpRight,
  Check,
  ChevronRight,
  Copy,
  History,
  LogOut,
  Pencil,
  RefreshCcw,
  Scale,
  Shield,
  User,
  X,
} from 'lucide-react'
import { SettlementHistoryList } from '@/components/common/SettlementHistoryList'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import { db } from '@/db/db'
import { useUserSettlementHistory } from '@/db/hooks'
import type { SettlementHistoryItem } from '@/lib/settlement'
import { markVoluntarySignOut } from '@/lib/auth-session-flags'
import { clearKwentaLocalData } from '@/lib/clear-kwenta-local'
import { useAuth } from '@/hooks/useAuth'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useAppStore } from '@/store/app-store'
import { supabase } from '@/lib/supabase'
import { hasUnsyncedLocalDataForUser, fullSync } from '@/sync/sync-service'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { timeAgo } from '@/lib/utils'

export function SettingsPage() {
  const navigate = useNavigate()
  const { user, isAuthenticated, updateDisplayName } = useAuth()
  const { profile, userId } = useCurrentUser()

  const settlementHistory = useUserSettlementHistory(userId ?? undefined)
  const [editingSettlement, setEditingSettlement] = useState<SettlementHistoryItem | null>(null)
  const paymentsInvolvingYou = useMemo(() => {
    if (!userId || !settlementHistory?.length) return []
    return settlementHistory
      .filter((h) => h.fromUserId === userId || h.toUserId === userId)
      .slice(0, 8)
  }, [userId, settlementHistory])

  const recentActivity = useLiveQuery(async () => {
    if (!userId) return []
    const logs = await db.activity_log.orderBy('created_at').reverse().limit(50).toArray()
    return logs.filter((l) => !l.is_deleted)
  }, [userId])
  const isOnline = useAppStore((s) => s.isOnline)
  const syncStatus = useAppStore((s) => s.syncStatus)
  const setSyncStatus = useAppStore((s) => s.setSyncStatus)

  const hasPendingSync = useLiveQuery(
    async () => (user?.id ? hasUnsyncedLocalDataForUser(user.id) : false),
    [user?.id],
  )

  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState('')

  const [signOutOpen, setSignOutOpen] = useState(false)
  const [signOutHasUnsynced, setSignOutHasUnsynced] = useState<boolean | null>(null)
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)

  function startEditing() {
    setDisplayName(profile?.display_name ?? '')
    setEditing(true)
  }

  async function saveName() {
    if (!displayName.trim()) return
    await updateDisplayName(displayName.trim())
    setEditing(false)
  }

  async function openSignOutDialog() {
    if (!user?.id) return
    setSignOutOpen(true)
    setSignOutHasUnsynced(null)
    setSignOutBusy(true)
    try {
      const has = await hasUnsyncedLocalDataForUser(user.id)
      setSignOutHasUnsynced(has)
    } finally {
      setSignOutBusy(false)
    }
  }

  async function runSignOutAndClearLocal() {
    markVoluntarySignOut()
    await supabase.auth.signOut()
    await clearKwentaLocalData()
    useAppStore.getState().setCurrentUserId(null)
    setSignOutOpen(false)
    navigate('/login', { replace: true })
  }

  async function handleSyncThenSignOut() {
    if (!user?.id) return
    setSignOutBusy(true)
    setSyncStatus('syncing')
    try {
      const result = await fullSync(user.id)
      if (result.errors.length > 0) {
        console.warn('[sign-out sync]', result.errors)
        setSyncStatus('error')
        return
      }
      setSyncStatus('idle')
      const stillUnsynced = await hasUnsyncedLocalDataForUser(user.id)
      setSignOutHasUnsynced(stillUnsynced)
      if (!stillUnsynced) {
        await runSignOutAndClearLocal()
      }
    } finally {
      setSignOutBusy(false)
    }
  }

  return (
    <>
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
          <p className="mt-1 text-sm text-stone-600">Balances, activity, account, and preferences</p>
        </div>

        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-4">
            <div className="flex size-14 items-center justify-center rounded-full bg-teal-800/15 text-teal-800">
              <User className="size-6" />
            </div>
            <div className="min-w-0 flex-1">
              {editing ? (
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    className="flex-1 rounded-lg"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && saveName()}
                    autoFocus
                  />
                  <Button size="icon-sm" className="rounded-full" onClick={saveName}>
                    <Check className="size-3.5" />
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <p className="font-semibold text-stone-800">
                    {profile?.display_name ?? 'Guest'}
                  </p>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="rounded-full"
                    onClick={startEditing}
                  >
                    <Pencil className="size-3" />
                  </Button>
                </div>
              )}
              <p className="mt-0.5 text-sm text-stone-500">{user?.email ?? 'Not signed in'}</p>
            </div>
          </div>

          {isAuthenticated && user?.email && (
            <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 px-4 py-4">
              <p className="text-sm font-semibold text-stone-900">Linking</p>
              <p className="mt-2 text-sm leading-relaxed text-stone-600">
                If someone has you saved as a local contact, they can link that contact to your Kwenta
                account with your email:{' '}
                <span className="font-medium text-stone-900">{user.email}</span>. They’ll use{' '}
                <span className="font-medium text-stone-800">People → Link</span> on their device. Their phone
                or browser needs your profile already (for example from a shared group and a sync).
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 rounded-lg"
                onClick={() => void navigator.clipboard.writeText(user.email!)}
              >
                <Copy className="size-3.5" />
                Copy email
              </Button>
              <p className="mt-3 border-t border-stone-200/80 pt-3 text-xs leading-relaxed text-stone-500">
                If you were added to a group as <span className="font-medium text-stone-600">name only</span>,
                sign in with this email and let the app sync so others can link you in People → Link.
              </p>
            </div>
          )}
        </div>

        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Balances</h2>
              <p className="mt-1 text-sm text-stone-600">
                Who should receive and who should pay across groups and personal bills.
              </p>
            </div>
            <Scale className="size-5 shrink-0 text-teal-800" aria-hidden />
          </div>
          <Button asChild className="mt-4 h-10 w-full rounded-xl sm:w-auto">
            <Link to="/app/balances" className="inline-flex items-center justify-center gap-2">
              Open balances
              <ChevronRight className="size-4" />
            </Link>
          </Button>
        </div>

        {paymentsInvolvingYou.length > 0 && (
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <History className="size-4 text-teal-800" aria-hidden />
              <h2 className="text-lg font-semibold">Your payments</h2>
            </div>
            <p className="mt-1 text-xs text-stone-500">
              Recorded settlements where you paid or were paid (all groups).
            </p>
            <div className="mt-4">
              <SettlementHistoryList
                items={paymentsInvolvingYou}
                currentUserId={userId}
                showGroupName
                onEdit={(item) => setEditingSettlement(item)}
              />
            </div>
          </div>
        )}

        {(recentActivity?.length ?? 0) > 0 && (
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <ArrowUpRight className="mt-0.5 size-4 shrink-0 text-teal-800" aria-hidden />
                <div>
                  <h2 className="text-lg font-semibold">Recent activity</h2>
                  <p className="mt-1 text-sm text-stone-600">
                    Bills, groups, and payments ({recentActivity!.length} recent)
                  </p>
                </div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 rounded-xl"
                onClick={() => setActivityOpen(true)}
              >
                View
              </Button>
            </div>
          </div>
        )}

        {editingSettlement && (
          <EditSettlementDialog
            item={editingSettlement}
            onClose={() => setEditingSettlement(null)}
            onSaved={() => setEditingSettlement(null)}
          />
        )}

        <div className="rounded-3xl border border-stone-200 bg-white shadow-sm">
          <div className="divide-y divide-stone-200">
            <div className="flex w-full items-center gap-3 px-5 py-4">
              <RefreshCcw className="size-4 text-stone-500" />
              <div className="flex-1">
                <p className="text-sm font-medium">Sync status</p>
                <p className="text-xs text-stone-500">
                  {isOnline
                    ? syncStatus === 'syncing'
                      ? 'Syncing…'
                      : syncStatus === 'error'
                        ? 'Online — last sync had errors'
                        : hasPendingSync === true
                          ? 'Waiting to sync — changes are saved here and will upload when the server accepts them'
                          : 'Online — changes sync to your account when signed in'
                    : hasPendingSync === true
                      ? 'Offline — you have changes not yet on the server; they’ll upload when you’re online'
                      : 'Offline — changes stay on this device until you’re online'}
                </p>
              </div>
              <div className={`size-2.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            </div>

            <div className="flex w-full items-center gap-3 px-5 py-4">
              <Shield className="size-4 text-stone-500" />
              <div className="flex-1">
                <p className="text-sm font-medium">Data storage</p>
                <p className="text-xs text-stone-500">
                  Data is stored in this browser; signing out removes Kwenta from this device (your account
                  stays on the server).
                </p>
              </div>
            </div>

            {isAuthenticated && (
              <button
                type="button"
                onClick={() => void openSignOutDialog()}
                className="flex w-full items-center gap-3 px-5 py-4 text-left text-red-600 transition-colors hover:bg-red-500/5"
              >
                <LogOut className="size-4" />
                <p className="text-sm font-medium">Sign out</p>
              </button>
            )}
          </div>
        </div>
      </div>

      {activityOpen && (recentActivity?.length ?? 0) > 0 && (
        <div className="fixed inset-0 z-70 flex items-end justify-center p-4 sm:items-center">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setActivityOpen(false)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="activity-sheet-title"
            className="relative flex max-h-[85dvh] w-full max-w-md flex-col rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)] animate-[slideUp_0.25s_ease-out]"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-stone-100 px-5 py-4">
              <h2 id="activity-sheet-title" className="text-base font-semibold text-stone-900">
                Recent activity
              </h2>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="rounded-full"
                onClick={() => setActivityOpen(false)}
                aria-label="Close"
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="max-h-[70dvh] overflow-y-auto overscroll-contain px-5 py-4">
              <ul className="space-y-2">
                {recentActivity!.map((log) => (
                  <li
                    key={log.id}
                    className="rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3"
                  >
                    <p className="text-sm text-stone-600">{log.description}</p>
                    <p className="mt-0.5 text-xs text-stone-400">{timeAgo(log.created_at)}</p>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {signOutOpen && (
        <div className="fixed inset-0 z-70 flex items-end justify-center p-4 sm:items-center">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => !signOutBusy && setSignOutOpen(false)}
            aria-hidden
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="signout-title"
            className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white p-5 shadow-[0_20px_60px_rgba(28,25,23,0.18)]"
          >
            <h2 id="signout-title" className="text-base font-semibold text-stone-900">
              Sign out on this device?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">
              {signOutHasUnsynced === null && signOutBusy
                ? 'Checking for unsynced changes…'
                : signOutHasUnsynced
                  ? 'You have changes that are not uploaded yet. Signing out removes all Kwenta data from this browser. Those changes will be lost unless you sync first.'
                  : 'Signing out removes Kwenta from this browser. Your account and cloud data stay on the server — sign in again to load them here.'}
            </p>
            <div className="mt-5 flex flex-col gap-2">
              {signOutHasUnsynced && isOnline && (
                <Button
                  type="button"
                  className="w-full rounded-xl"
                  disabled={signOutBusy}
                  onClick={() => void handleSyncThenSignOut()}
                >
                  {signOutBusy ? '…' : 'Sync now, then sign out'}
                </Button>
              )}
              <Button
                type="button"
                variant="destructive"
                className="w-full rounded-xl"
                disabled={signOutBusy || signOutHasUnsynced === null}
                onClick={() => void runSignOutAndClearLocal()}
              >
                {signOutHasUnsynced ? 'Sign out anyway' : 'Sign out'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full rounded-xl"
                disabled={signOutBusy}
                onClick={() => setSignOutOpen(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
