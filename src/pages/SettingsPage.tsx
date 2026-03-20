import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Check, LogOut, Pencil, RefreshCcw, Shield, Trash2, User } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { useAppStore } from '@/store/app-store'
import { db } from '@/db/db'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function SettingsPage() {
  const navigate = useNavigate()
  const { user, isAuthenticated, signOut, updateDisplayName } = useAuth()
  const { profile } = useCurrentUser()
  const isOnline = useAppStore((s) => s.isOnline)
  const syncStatus = useAppStore((s) => s.syncStatus)

  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState('')
  const [clearing, setClearing] = useState(false)

  function startEditing() {
    setDisplayName(profile?.display_name ?? '')
    setEditing(true)
  }

  async function saveName() {
    if (!displayName.trim()) return
    await updateDisplayName(displayName.trim())
    setEditing(false)
  }

  async function handleSignOut() {
    await signOut()
    navigate('/login')
  }

  async function handleClearData() {
    if (!confirm('This will remove all local data from this device. Are you sure?')) return
    setClearing(true)
    try {
      await db.delete()
      localStorage.clear()
      window.location.href = '/'
    } catch {
      setClearing(false)
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-1 text-sm text-slate-600">Account and app preferences</p>
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex size-14 items-center justify-center rounded-full bg-blue-600/15 text-blue-600">
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
                <p className="font-semibold text-slate-800">
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
            <p className="mt-0.5 text-sm text-slate-500">
              {isAuthenticated ? user?.email : 'Not signed in'}
            </p>
          </div>
        </div>

        {!isAuthenticated && (
          <Button
            className="mt-4 w-full rounded-xl"
            onClick={() => navigate('/login')}
          >
            Sign in to sync your data
          </Button>
        )}
      </div>

      <div className="rounded-3xl border border-slate-200 bg-white shadow-sm">
        <div className="divide-y divide-slate-200">
          <div className="flex w-full items-center gap-3 px-5 py-4">
            <RefreshCcw className="size-4 text-slate-500" />
            <div className="flex-1">
              <p className="text-sm font-medium">Sync status</p>
              <p className="text-xs text-slate-500">
                {isOnline
                  ? syncStatus === 'syncing'
                    ? 'Syncing…'
                    : isAuthenticated
                      ? 'Online — up to date'
                      : 'Online — sign in to enable sync'
                  : 'Offline — changes saved locally'}
              </p>
            </div>
            <div className={`size-2.5 rounded-full ${isOnline ? 'bg-emerald-500' : 'bg-amber-500'}`} />
          </div>

          <div className="flex w-full items-center gap-3 px-5 py-4">
            <Shield className="size-4 text-slate-500" />
            <div className="flex-1">
              <p className="text-sm font-medium">Data storage</p>
              <p className="text-xs text-slate-500">
                All data is stored locally in your browser using IndexedDB
              </p>
            </div>
          </div>

          <button
            onClick={handleClearData}
            disabled={clearing}
            className="flex w-full items-center gap-3 px-5 py-4 text-left transition-colors hover:bg-slate-100"
          >
            <Trash2 className="size-4 text-slate-500" />
            <div className="flex-1">
              <p className="text-sm font-medium">Clear local data</p>
              <p className="text-xs text-slate-500">
                Remove all offline data from this device
              </p>
            </div>
          </button>

          {isAuthenticated && (
            <button
              onClick={handleSignOut}
              className="flex w-full items-center gap-3 px-5 py-4 text-left text-red-600 transition-colors hover:bg-red-500/5"
            >
              <LogOut className="size-4" />
              <p className="text-sm font-medium">Sign out</p>
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
