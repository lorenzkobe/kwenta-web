import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import {
  ArrowUpRight,
  CircleAlert,
  Check,
  Copy,
  LogOut,
  Pencil,
  RefreshCcw,
  RotateCcw,
  Shield,
  User,
  X,
} from 'lucide-react'
import { db } from '@/db/db'
import { markVoluntarySignOut } from '@/lib/auth-session-flags'
import { clearKwentaLocalData } from '@/lib/clear-kwenta-local'
import {
  dismissNotAppliedChange,
  listPendingConflictsForActor,
  markNotAppliedChangeReapplied,
} from '@/sync/cloud-first-mutations'
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
  const pendingConflicts = useLiveQuery(
    async () => (userId ? listPendingConflictsForActor(userId) : []),
    [userId],
  )

  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState('')

  const [signOutOpen, setSignOutOpen] = useState(false)
  const [signOutHasUnsynced, setSignOutHasUnsynced] = useState<boolean | null>(null)
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [activityOpen, setActivityOpen] = useState(false)
  const recentActivityLoading = recentActivity === undefined

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

  async function runSignOutAndClearLocal(options?: { skipFinalSync?: boolean }) {
    if (!options?.skipFinalSync && navigator.onLine && user?.id) {
      try {
        const result = await fullSync(user.id)
        if (result.errors.length > 0) {
          console.warn('[sign-out] push sync failed', result.errors)
        }
      } catch (e) {
        console.warn('[sign-out] push sync failed', e)
      }
    }
    markVoluntarySignOut()
    await supabase.auth.signOut()
    await clearKwentaLocalData()
    useAppStore.getState().setCurrentUserId(null)
    setSignOutOpen(false)
    navigate('/login', { replace: true })
  }

  async function handleReset() {
    if (!userId) return
    setResetBusy(true)
    try {
      await clearKwentaLocalData()
      await fullSync(userId)
    } finally {
      setResetBusy(false)
      setResetOpen(false)
    }
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
        await runSignOutAndClearLocal({ skipFinalSync: true })
      }
    } finally {
      setSignOutBusy(false)
    }
  }

  function fallbackRouteForConflict(entityType: string, entityId: string | null): string {
    if (!entityId) return '/app/settings'
    if (entityType === 'bill') return `/app/bills/${entityId}`
    if (entityType === 'group') return `/app/groups/${entityId}`
    if (entityType === 'settlement') return '/app/settings'
    if (entityType === 'profile') return `/app/people/${entityId}`
    return '/app/settings'
  }

  async function handleDismissConflict(changeId: string) {
    await dismissNotAppliedChange(changeId)
  }

  async function handleApplyAgain(changeId: string, routeHint: string | null, entityType: string, entityId: string | null) {
    await markNotAppliedChangeReapplied(changeId)
    navigate(routeHint ?? fallbackRouteForConflict(entityType, entityId))
  }

  return (
    <>
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Profile</h1>
          <p className="mt-1 text-sm text-stone-600">Activity, account, and preferences</p>
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

        {recentActivityLoading ? (
          <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
            <div className="h-4 w-36 animate-pulse rounded bg-stone-200" />
            <div className="mt-2 h-3 w-52 animate-pulse rounded bg-stone-100" />
          </div>
        ) : (recentActivity?.length ?? 0) > 0 && (
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

        {(pendingConflicts?.length ?? 0) > 0 && (
          <div className="rounded-3xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm">
            <div className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-4 text-amber-700" />
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-amber-900">Not applied changes</h2>
                <p className="mt-1 text-xs text-amber-800">
                  These changes were not applied after sync conflict checks. Review each one.
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {pendingConflicts!.map((change) => (
                <div key={change.id} className="rounded-xl border border-amber-200 bg-white px-4 py-3">
                  <p className="text-sm font-medium text-stone-900">{change.operation.replaceAll('_', ' ')}</p>
                  <p className="mt-1 text-xs text-stone-600">{change.reason_message}</p>
                  <p className="mt-1 text-[0.7rem] text-stone-400">{timeAgo(change.created_at)}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="rounded-lg"
                      onClick={() =>
                        handleApplyAgain(change.id, change.route_hint, change.entity_type, change.entity_id)
                      }
                    >
                      Apply again
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="rounded-lg"
                      onClick={() =>
                        navigate(change.route_hint ?? fallbackRouteForConflict(change.entity_type, change.entity_id))
                      }
                    >
                      View current
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="rounded-lg text-stone-600"
                      onClick={() => void handleDismissConflict(change.id)}
                    >
                      Dismiss
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
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
                onClick={() => setResetOpen(true)}
                className="flex w-full items-center gap-3 px-5 py-4 text-left text-amber-700 transition-colors hover:bg-amber-500/5"
              >
                <RotateCcw className="size-4" />
                <div className="flex-1">
                  <p className="text-sm font-medium">Reset local data</p>
                  <p className="text-xs text-amber-700/70">
                    Clears local cache and re-downloads everything from the server
                  </p>
                </div>
              </button>
            )}

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

      {resetOpen && (
        <div className="fixed inset-0 z-70 flex items-end justify-center p-4 sm:items-center">
          <div
            className="fixed inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => !resetBusy && setResetOpen(false)}
            aria-hidden
          />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="reset-title"
            className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white p-5 shadow-[0_20px_60px_rgba(28,25,23,0.18)]"
          >
            <h2 id="reset-title" className="text-base font-semibold text-stone-900">
              Reset local data?
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-stone-600">
              Clears all data stored in this browser and re-downloads everything fresh from the server.
              Your account and all data stay on the server — nothing is deleted. Use this if you're
              seeing stale or incorrect data after a refresh.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              <Button
                type="button"
                className="w-full rounded-xl"
                disabled={resetBusy}
                onClick={() => void handleReset()}
              >
                {resetBusy ? 'Resetting…' : 'Reset & reload'}
              </Button>
              <Button
                type="button"
                variant="outline"
                className="w-full rounded-xl"
                disabled={resetBusy}
                onClick={() => setResetOpen(false)}
              >
                Cancel
              </Button>
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
