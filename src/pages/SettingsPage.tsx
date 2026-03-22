import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, Copy, LogOut, Pencil, RefreshCcw, Shield, User } from 'lucide-react'
import { markVoluntarySignOut } from '@/lib/auth-session-flags'
import { clearKwentaLocalData } from '@/lib/clear-kwenta-local'
import { useAuth } from '@/hooks/useAuth'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useAppStore } from '@/store/app-store'
import { supabase } from '@/lib/supabase'
import { hasUnsyncedLocalDataForUser, fullSync } from '@/sync/sync-service'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function SettingsPage() {
  const navigate = useNavigate()
  const { user, isAuthenticated, updateDisplayName } = useAuth()
  const { profile, userId } = useCurrentUser()
  const isOnline = useAppStore((s) => s.isOnline)
  const syncStatus = useAppStore((s) => s.syncStatus)
  const setSyncStatus = useAppStore((s) => s.setSyncStatus)

  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState('')

  const [signOutOpen, setSignOutOpen] = useState(false)
  const [signOutHasUnsynced, setSignOutHasUnsynced] = useState<boolean | null>(null)
  const [signOutBusy, setSignOutBusy] = useState(false)

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
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-stone-600">Account and app preferences</p>
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

          {isAuthenticated && userId && (
            <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50 px-3 py-3">
              <p className="text-xs font-medium text-stone-600">Profile ID</p>
              <p className="mt-1 break-all font-mono text-[0.7rem] leading-snug text-stone-800">{userId}</p>
              <p className="mt-1.5 text-[0.65rem] text-stone-500">
                Your signed-in account id. Share it so others can link their local contact to you in People.
              </p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className="mt-2 rounded-lg"
                onClick={() => void navigator.clipboard.writeText(userId)}
              >
                <Copy className="size-3" />
                Copy ID
              </Button>
            </div>
          )}
        </div>

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
                        : 'Online — changes sync to your account when signed in'
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
