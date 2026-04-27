import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownAZ, ArrowUpAZ, Loader2, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { supabase } from '@/lib/supabase'
import type { ProfileAccountStatus, ProfileUserType } from '@/types'
import { useAppStore } from '@/store/app-store'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

type AdminProfileRow = {
  id: string
  email: string
  display_name: string
  user_type: ProfileUserType
  account_status: ProfileAccountStatus
  created_at: string
  updated_at: string
}

function accountStatusTitleCase(status: ProfileAccountStatus): string {
  if (status === 'active') return 'Active'
  if (status === 'inactive') return 'Inactive'
  return 'Unconfirmed'
}

function formatCreatedAt(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return '—'
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  } catch {
    return '—'
  }
}

export function AdminUsersPage() {
  const currentUserId = useAppStore((s) => s.currentUserId)
  const [rows, setRows] = useState<AdminProfileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [sortNewestFirst, setSortNewestFirst] = useState(true)
  const [deleteTarget, setDeleteTarget] = useState<AdminProfileRow | null>(null)
  const [deleteCountdown, setDeleteCountdown] = useState(5)

  const load = useCallback(async () => {
    setError(null)
    const { data, error: rpcError } = await supabase.rpc('admin_list_profiles')
    if (rpcError) {
      setError(rpcError.message)
      setRows([])
      return
    }
    const list = (data ?? []) as AdminProfileRow[]
    setRows(list)
  }, [])

  useEffect(() => {
    void (async () => {
      setLoading(true)
      await load()
      setLoading(false)
    })()
  }, [load])

  useEffect(() => {
    if (!deleteTarget) return
    setDeleteCountdown(5)
    const timer = window.setInterval(() => {
      setDeleteCountdown((current) => {
        if (current <= 1) {
          window.clearInterval(timer)
          return 0
        }
        return current - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [deleteTarget])

  const filteredSortedRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    let list = q.length === 0 ? rows : rows.filter((r) => r.email.toLowerCase().includes(q))
    list = [...list].sort((a, b) => {
      const cmp = a.created_at.localeCompare(b.created_at)
      return sortNewestFirst ? -cmp : cmp
    })
    return list
  }, [rows, searchQuery, sortNewestFirst])

  async function setStatus(userId: string, status: ProfileAccountStatus) {
    setBusyId(userId)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('admin_set_account_status', {
        p_user_id: userId,
        p_status: status,
      })
      if (rpcError) {
        setError(rpcError.message)
        return
      }
      await load()
    } finally {
      setBusyId(null)
    }
  }

  async function setRole(userId: string, role: ProfileUserType) {
    setBusyId(userId)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('admin_set_user_type', {
        p_user_id: userId,
        p_user_type: role,
      })
      if (rpcError) {
        setError(rpcError.message)
        return
      }
      await load()
    } finally {
      setBusyId(null)
    }
  }

  async function deleteUser() {
    if (!deleteTarget) return
    setBusyId(deleteTarget.id)
    setError(null)
    try {
      const { error: rpcError } = await supabase.rpc('admin_delete_user', {
        p_user_id: deleteTarget.id,
      })
      if (rpcError) {
        setError(rpcError.message)
        return
      }
      toast.success('User deleted', {
        description: deleteTarget.email || deleteTarget.display_name || 'The user was permanently removed.',
      })
      await load()
    } finally {
      setBusyId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <Loader2 className="size-8 animate-spin text-teal-800" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight text-stone-900">Users</h1>
        <p className="mt-1 text-sm text-stone-600">
          Manage account access and roles. Only active accounts can sign in to the app.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{error}</div>
      )}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-md flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-stone-400"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Search by email…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-10 rounded-xl border-stone-200 bg-white pl-10"
            autoComplete="off"
            aria-label="Search users by email"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-10 shrink-0 gap-2 rounded-xl border-stone-300"
          onClick={() => setSortNewestFirst((v) => !v)}
        >
          {sortNewestFirst ? (
            <>
              <ArrowDownAZ className="size-4" aria-hidden />
              Newest first
            </>
          ) : (
            <>
              <ArrowUpAZ className="size-4" aria-hidden />
              Oldest first
            </>
          )}
        </Button>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50/80 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Created</th>
              <th className="px-4 py-3">Access</th>
              <th className="px-4 py-3 text-right">Delete</th>
            </tr>
          </thead>
          <tbody>
            {filteredSortedRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-stone-500">
                  {rows.length === 0 ? 'No users found.' : 'No users match your search.'}
                </td>
              </tr>
            ) : (
              filteredSortedRows.map((row) => {
                const isBusy = busyId === row.id
                const isSelf = row.id === currentUserId
                const isActive = row.account_status === 'active'
                const isUnconfirmed = row.account_status === 'unconfirmed'
                return (
                  <tr key={row.id} className="border-b border-stone-100 last:border-0">
                    <td className="max-w-[200px] truncate px-4 py-3 font-mono text-xs text-stone-700">
                      {row.email || '—'}
                    </td>
                    <td className="px-4 py-3 text-stone-800">
                      {row.display_name}
                      {isSelf && (
                        <span className="ml-2 rounded-full bg-teal-100 px-2 py-0.5 text-[0.65rem] font-medium text-teal-800">
                          You
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Select
                        value={row.user_type}
                        onValueChange={(v) => void setRole(row.id, v as ProfileUserType)}
                        disabled={isBusy || isSelf}
                      >
                        <SelectTrigger className="h-9 w-[120px] text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="user">User</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          'inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium',
                          row.account_status === 'active' && 'bg-emerald-100 text-emerald-900',
                          row.account_status === 'inactive' && 'bg-stone-200 text-stone-800',
                          row.account_status === 'unconfirmed' && 'bg-amber-100 text-amber-950',
                        )}
                      >
                        {accountStatusTitleCase(row.account_status)}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs tabular-nums text-stone-600">
                      {formatCreatedAt(row.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <Switch
                        checked={isActive}
                        disabled={isBusy || isSelf || isUnconfirmed}
                        onCheckedChange={(checked) =>
                          void setStatus(row.id, checked ? 'active' : 'inactive')
                        }
                        aria-label={
                          isUnconfirmed
                            ? 'Email not verified — activate after confirmation'
                            : isActive
                              ? 'Deactivate account access'
                              : 'Activate account access'
                        }
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="size-9 rounded-xl border-red-200 text-red-700 hover:bg-red-50 hover:text-red-800"
                        disabled={isBusy || isSelf}
                        onClick={() => setDeleteTarget(row)}
                        aria-label={isSelf ? 'You cannot delete your own account' : `Delete ${row.email || row.display_name}`}
                        title={isSelf ? 'You cannot delete your own account' : 'Delete user'}
                      >
                        <Trash2 className="size-4" aria-hidden />
                      </Button>
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-stone-500">
        Unconfirmed = email not verified yet. Inactive = confirmed but cannot use the app until activated.
      </p>

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null)
        }}
        title="Permanently delete user?"
        description={
          deleteTarget
            ? `${deleteTarget.email || deleteTarget.display_name} and all related app data will be hard deleted. This cannot be undone.`
            : ''
        }
        confirmLabel={deleteCountdown > 0 ? `Delete in ${deleteCountdown}s` : 'Delete user'}
        confirmDisabled={deleteCountdown > 0}
        cancelLabel="Keep user"
        variant="danger"
        onConfirm={deleteUser}
      />
    </div>
  )
}
