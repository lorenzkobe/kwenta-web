import { useCallback, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import type { ProfileAccountStatus, ProfileUserType } from '@/types'
import { useAppStore } from '@/store/app-store'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

type AdminProfileRow = {
  id: string
  email: string
  display_name: string
  user_type: ProfileUserType
  account_status: ProfileAccountStatus
  updated_at: string
}

export function AdminUsersPage() {
  const currentUserId = useAppStore((s) => s.currentUserId)
  const [rows, setRows] = useState<AdminProfileRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

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

      <div className="overflow-x-auto rounded-2xl border border-stone-200 bg-white shadow-sm">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead>
            <tr className="border-b border-stone-200 bg-stone-50/80 text-xs font-semibold uppercase tracking-wide text-stone-500">
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-stone-500">
                  No users found.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isBusy = busyId === row.id
                const isSelf = row.id === currentUserId
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
                        {row.account_status}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {row.account_status !== 'active' ? (
                          <Button
                            type="button"
                            size="sm"
                            className="h-8 rounded-lg text-xs"
                            disabled={isBusy || isSelf}
                            onClick={() => void setStatus(row.id, 'active')}
                          >
                            Activate
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 rounded-lg text-xs"
                            disabled={isBusy || isSelf}
                            onClick={() => void setStatus(row.id, 'inactive')}
                          >
                            Deactivate
                          </Button>
                        )}
                      </div>
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
    </div>
  )
}
