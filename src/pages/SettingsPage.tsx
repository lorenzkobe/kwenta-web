import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useNavigate } from 'react-router-dom'
import {
  ArrowUpRight,
  CircleAlert,
  Check,
  Copy,
  Loader2,
  LogOut,
  Pencil,
  RefreshCcw,
  RotateCcw,
  Shield,
  User,
  X,
} from 'lucide-react'
import { db } from '@/db/db'
import type { NotAppliedChange } from '@/types'
import { markVoluntarySignOut } from '@/lib/auth-session-flags'
import { clearKwentaLocalData } from '@/lib/clear-kwenta-local'
import { claimDeviceFor } from '@/lib/device-owner'
import {
  dismissNotAppliedChange,
  listPendingConflictsForActor,
  retryNotAppliedChange,
} from '@/sync/cloud-first-mutations'
import {
  dismissQueuedWrite,
  hasUnsentWrites,
  retryQueuedWrite,
  sendUnsentWritesBeforeWipe,
} from '@/sync/write-queue'
import { useAuth } from '@/hooks/useAuth'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useAppStore } from '@/store/app-store'
import { supabase } from '@/lib/supabase'
import { fullSync } from '@/sync/sync-service'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RepairDataPanel } from '@/components/settings/RepairDataPanel'
import { timeAgo } from '@/lib/utils'
import { toast } from 'sonner'

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
    async () => (user?.id ? hasUnsentWrites(user.id) : false),
    [user?.id],
  )
  // `queued`: the refused change is a write-queue entry, so Dismiss restores the server's version
  // and Apply again resends it. Anything else is a legacy (pre-v15) notice.
  const pendingConflicts = useLiveQuery(async () => {
    if (!userId) return []
    const changes = await listPendingConflictsForActor(userId)
    const entryIds = changes.flatMap((c) => (c.pending_mutation_id ? [c.pending_mutation_id] : []))
    const entries = await db.pending_mutations.bulkGet(entryIds)
    const refused = new Set(entries.flatMap((e) => (e && e.push != null && e.status === 'conflict' ? [e.id] : [])))
    return changes.map((change) => ({
      change,
      queued: change.pending_mutation_id !== null && refused.has(change.pending_mutation_id),
    }))
  }, [userId])

  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [savingName, setSavingName] = useState(false)

  const [signOutOpen, setSignOutOpen] = useState(false)
  const [signOutHasUnsynced, setSignOutHasUnsynced] = useState<boolean | null>(null)
  const [signOutBusy, setSignOutBusy] = useState(false)
  const [resetOpen, setResetOpen] = useState(false)
  const [resetBusy, setResetBusy] = useState(false)
  const [resetHasUnsent, setResetHasUnsent] = useState<boolean | null>(null)
  const [activityOpen, setActivityOpen] = useState(false)
  const recentActivityLoading = recentActivity === undefined

  function startEditing() {
    setDisplayName(profile?.display_name ?? '')
    setEditing(true)
  }

  async function saveName() {
    if (!displayName.trim() || savingName) return
    setSavingName(true)
    try {
      await updateDisplayName(displayName.trim())
      setEditing(false)
    } catch (err) {
      // Refused by the server (the rename is cloud-first): nothing was saved, so the editor stays
      // open with the typed name for another try.
      toast.error(err instanceof Error ? err.message : 'Could not rename you')
    } finally {
      setSavingName(false)
    }
  }

  async function openSignOutDialog() {
    if (!user?.id) return
    setSignOutOpen(true)
    setSignOutHasUnsynced(null)
    setSignOutBusy(true)
    try {
      const has = await hasUnsentWrites(user.id)
      setSignOutHasUnsynced(has)
    } finally {
      setSignOutBusy(false)
    }
  }

  async function runSignOutAndClearLocal(options?: { skipFinalSync?: boolean }) {
    if (!options?.skipFinalSync && navigator.onLine && user?.id) {
      try {
        const result = await sendUnsentWritesBeforeWipe(user.id)
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

  // A reset wipes the device exactly as a sign-out does, queued writes included, so it warns the same way.
  async function openResetDialog() {
    if (!userId) return
    setResetOpen(true)
    setResetHasUnsent(null)
    setResetBusy(true)
    try {
      setResetHasUnsent(await hasUnsentWrites(userId))
    } finally {
      setResetBusy(false)
    }
  }

  async function handleReset() {
    if (!userId) return
    setResetBusy(true)
    try {
      // The same user stays signed in, so the device stays theirs: a reset that left no owner key
      // blocked their offline open and re-ran adoption on the next start.
      await claimDeviceFor(userId)
      await fullSync(userId)
    } finally {
      setResetBusy(false)
      setResetOpen(false)
    }
  }

  async function handleSyncThenReset() {
    if (!userId) return
    setResetBusy(true)
    setSyncStatus('syncing')
    try {
      const { errors, stillUnsent } = await sendUnsentWritesBeforeWipe(userId)
      if (errors.length > 0) {
        console.warn('[reset sync]', errors)
        setSyncStatus('error')
        return
      }
      setSyncStatus('idle')
      setResetHasUnsent(stillUnsent)
      if (!stillUnsent) await handleReset()
    } finally {
      setResetBusy(false)
    }
  }

  async function handleSyncThenSignOut() {
    if (!user?.id) return
    setSignOutBusy(true)
    setSyncStatus('syncing')
    try {
      const { errors, stillUnsent } = await sendUnsentWritesBeforeWipe(user.id)
      if (errors.length > 0) {
        console.warn('[sign-out sync]', errors)
        setSyncStatus('error')
        return
      }
      setSyncStatus('idle')
      setSignOutHasUnsynced(stillUnsent)
      if (!stillUnsent) {
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

  async function handleDismissConflict(change: NotAppliedChange, queued: boolean) {
    if (!window.confirm('Dismiss this change? It will be permanently discarded.')) {
      return
    }
    if (!queued) {
      await dismissNotAppliedChange(change.id)
      return
    }
    try {
      await dismissQueuedWrite(change.pending_mutation_id!)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not discard this change')
    }
  }

  async function handleApplyAgain(change: NotAppliedChange, queued: boolean) {
    const success = queued
      ? await retryQueuedWrite(change.pending_mutation_id!).catch(() => false)
      : await retryNotAppliedChange(change)
    if (success) {
      toast.success('Change re-applied')
      navigate(change.route_hint ?? fallbackRouteForConflict(change.entity_type, change.entity_id))
    } else {
      toast.error('Still could not save — try again later')
    }
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
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-stone-500">Nickname</label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      className="flex-1 rounded-lg"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') saveName()
                        if (e.key === 'Escape' && !savingName) setEditing(false)
                      }}
                      autoFocus
                      maxLength={50}
                      disabled={savingName}
                    />
                    {savingName ? (
                      <Loader2 className="size-4 shrink-0 animate-spin text-stone-400" />
                    ) : (
                      <>
                        <Button size="icon-sm" variant="ghost" className="rounded-full" onClick={() => setEditing(false)}>
                          <X className="size-3.5" />
                        </Button>
                        <Button size="icon-sm" className="rounded-full" onClick={saveName} disabled={!displayName.trim()}>
                          <Check className="size-3.5" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div>
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
                  <p className="text-xs text-stone-400">Nickname</p>
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
                <span className="font-medium text-stone-900">{user.email}</span>. They'll use{' '}
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

        {userId && <RepairDataPanel userId={userId} />}

        {(pendingConflicts?.length ?? 0) > 0 && (
          <div className="rounded-3xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm">
            <div className="flex items-start gap-2">
              <CircleAlert className="mt-0.5 size-4 text-amber-700" />
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-amber-900">Not applied changes</h2>
                <p className="mt-1 text-xs text-amber-800">
                  The server refused these changes. Apply again to resend one, or dismiss it to go back to the
                  saved version.
                </p>
              </div>
            </div>

            <div className="mt-4 space-y-2">
              {pendingConflicts!.map(({ change, queued }) => (
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
                        void handleApplyAgain(change, queued)
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
                      disabled={queued && !isOnline}
                      title={queued && !isOnline ? 'Connect to the internet to discard this change' : undefined}
                      onClick={() => void handleDismissConflict(change, queued)}
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
                      ? 'Syncing your changes…'
                      : syncStatus === 'error'
                        ? 'Something went wrong — your changes are saved locally. Tap the sync button in the header to retry.'
                        : hasPendingSync === true
                          ? 'Changes saved — uploading to your account shortly'
                          : 'All changes synced to your account'
                    : hasPendingSync === true
                      ? "Offline — your unsaved changes will sync automatically when you're back online"
                      : 'Offline — connect to the internet to sync your data'}
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
                onClick={() => void openResetDialog()}
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
              {resetHasUnsent === null && resetBusy
                ? 'Checking for unsynced changes…'
                : resetHasUnsent
                  ? 'You have changes that are not uploaded yet. Resetting removes all Kwenta data from this browser. Those changes will be lost unless you sync first.'
                  : "Clears all data stored in this browser and re-downloads everything fresh from the server. Your account and all data stay on the server — nothing is deleted. Use this if you're seeing stale or incorrect data after a refresh."}
            </p>
            <div className="mt-5 flex flex-col gap-2">
              {resetHasUnsent && isOnline && (
                <Button
                  type="button"
                  className="w-full rounded-xl"
                  disabled={resetBusy}
                  onClick={() => void handleSyncThenReset()}
                >
                  {resetBusy ? '…' : 'Sync now, then reset'}
                </Button>
              )}
              <Button
                type="button"
                variant={resetHasUnsent ? 'destructive' : 'default'}
                className="w-full rounded-xl"
                disabled={resetBusy || resetHasUnsent === null}
                onClick={() => void handleReset()}
              >
                {resetBusy && resetHasUnsent !== null ? 'Resetting…' : resetHasUnsent ? 'Reset anyway' : 'Reset & reload'}
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
