import { useState, useEffect } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { BookUser, ChevronRight, Loader2, Plus, UserPlus } from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  collectRelatedProfileIds,
  computePairwiseNet,
  formatPairwiseSummary,
  resolveProfileDisplay,
} from '@/lib/people'
import { createLocalProfile } from '@/db/operations'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function PeoplePage() {
  const navigate = useNavigate()
  const { userId } = useCurrentUser()
  const [showAdd, setShowAdd] = useState(false)
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null)

  const rows = useLiveQuery(async () => {
    if (!userId) return []
    const ids = await collectRelatedProfileIds(userId)
    ids.delete(userId)
    const out: {
      id: string
      displayName: string
      subtitle?: string
      primaryLabel: string
      tone: 'balanced' | 'collect' | 'pay'
      lines: string[]
    }[] = []
    for (const id of ids) {
      const net = await computePairwiseNet(userId, id)
      const disp = await resolveProfileDisplay(id)
      const { lines, primaryLabel, tone } = formatPairwiseSummary(net)
      out.push({
        id,
        displayName: disp.displayName,
        subtitle: disp.subtitle,
        primaryLabel,
        tone,
        lines,
      })
    }
    out.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return out
  }, [userId])

  useEffect(() => {
    if (!duplicateNotice) return
    const t = window.setTimeout(() => setDuplicateNotice(null), 6000)
    return () => window.clearTimeout(t)
  }, [duplicateNotice])

  async function handleAddContact() {
    if (!userId || !newName.trim()) return
    setDuplicateNotice(null)
    setAdding(true)
    try {
      const result = await createLocalProfile(newName.trim(), userId)
      if (result.outcome === 'already_exists') {
        const name = newName.trim()
        setDuplicateNotice(`You already have a contact named “${name}”. Choose a different name or open them from the list below.`)
        return
      }
      setNewName('')
      setShowAdd(false)
      navigate(`/app/people/${result.id}`)
    } finally {
      setAdding(false)
    }
  }

  if (!userId) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="size-5 animate-spin text-teal-800" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">People</h1>
          <p className="mt-1 text-sm text-stone-600">
            Phonebook, balances, and payments across all groups and personal bills
          </p>
        </div>
        <Button className="shrink-0 rounded-full" onClick={() => setShowAdd(true)}>
          <UserPlus className="size-4" />
          Add
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-3xl border border-teal-800/20 bg-teal-800/5 p-5 shadow-sm">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Add local contact</h2>
            <Button
              variant="ghost"
              size="icon-xs"
              className="rounded-full"
              onClick={() => {
                setShowAdd(false)
                setDuplicateNotice(null)
              }}
            >
              ×
            </Button>
          </div>
          <p className="mt-1 text-xs text-stone-600">
            Names are unique in your phonebook. You can link a contact to an online account later from
            their page.
          </p>
          <div className="mt-4 flex gap-2">
            <Input
              placeholder="Name"
              value={newName}
              onChange={(e) => {
                setNewName(e.target.value)
                setDuplicateNotice(null)
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleAddContact()}
              className="rounded-xl"
            />
            <Button className="rounded-xl" disabled={!newName.trim() || adding} onClick={handleAddContact}>
              {adding ? '…' : 'Save'}
            </Button>
          </div>
          {duplicateNotice && (
            <div
              role="status"
              className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950 shadow-sm"
            >
              {duplicateNotice}
            </div>
          )}
        </div>
      )}

      {(!rows || rows.length === 0) && !showAdd ? (
        <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col items-center py-12 text-center">
            <div className="rounded-2xl bg-stone-100 p-4">
              <BookUser className="size-6 text-stone-400" />
            </div>
            <p className="mt-3 text-sm font-medium text-stone-500">No people yet</p>
            <p className="mt-1 max-w-sm text-xs text-stone-400">
              Add group members, split personal bills, or add a local contact. Everyone you share
              expenses with appears here.
            </p>
            <Button size="sm" className="mt-4 rounded-full" onClick={() => setShowAdd(true)}>
              <Plus className="size-3.5" />
              Add contact
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {rows?.map((r) => (
            <Link
              key={r.id}
              to={`/app/people/${r.id}`}
              className="flex items-center justify-between rounded-2xl border border-stone-200 bg-white p-4 shadow-sm transition-colors hover:bg-stone-50"
            >
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-stone-800">{r.displayName}</p>
                {r.subtitle && <p className="text-xs text-stone-500">{r.subtitle}</p>}
                <p
                  className={cn(
                    'mt-0.5 text-sm font-medium',
                    r.tone === 'balanced' && 'text-stone-500',
                    r.tone === 'collect' && 'text-emerald-600',
                    r.tone === 'pay' && 'text-amber-600',
                  )}
                >
                  {r.lines.length > 0 ? r.lines.join(' · ') : r.primaryLabel}
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-stone-400" />
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
