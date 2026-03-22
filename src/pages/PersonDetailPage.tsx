import { useState, useMemo, useEffect } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Banknote,
  ChevronRight,
  Link2,
  Loader2,
  MoreVertical,
  ReceiptText,
  Trash2,
} from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import {
  computePairwiseNet,
  formatPairwiseSummary,
  listBillsInvolvingPair,
  listPairwiseSettlementsBetween,
  resolveProfileDisplay,
} from '@/lib/people'
import { deletePerson, linkProfileToRemote } from '@/db/operations'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettlementHistoryList } from '@/components/common/SettlementHistoryList'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import { RecordSettlementDialog } from '@/components/common/RecordSettlementDialog'
import type { SettlementHistoryItem } from '@/lib/settlement'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function sheetBackdrop(onClose: () => void) {
  return (
    <div
      className="fixed inset-0 bg-black/30 backdrop-blur-sm"
      onClick={onClose}
      aria-hidden
    />
  )
}

function PersonOptionsMenu({
  onRemoveContact,
  onClose,
}: {
  onRemoveContact: () => void
  onClose: () => void
}) {
  const itemClass =
    'flex w-full items-center gap-3 rounded-xl px-4 py-3.5 text-left text-sm font-medium text-stone-800 transition-colors hover:bg-stone-100'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div className="relative w-full max-w-sm animate-[slideUp_0.25s_ease-out] rounded-3xl border border-stone-200 bg-white p-2 shadow-[0_20px_60px_rgba(28,25,23,0.18)]">
        <p className="px-3 pb-2 pt-1 text-center text-xs font-medium uppercase tracking-wide text-stone-400">
          Options
        </p>
        <button
          type="button"
          className={cn(itemClass, 'text-red-600 hover:bg-red-50')}
          onClick={onRemoveContact}
        >
          <Trash2 className="size-4" />
          Remove contact
        </button>
        <Button variant="ghost" className="mt-1 w-full rounded-xl text-stone-500" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function LinkAccountSheet({
  onClose,
  linkableRemotes,
  onPickRemote,
  linkByIdInput,
  onLinkByIdInputChange,
  linkByIdError,
  linkByIdPending,
  onLinkByProfileId,
}: {
  onClose: () => void
  linkableRemotes: { id: string; displayName: string }[] | undefined
  onPickRemote: (remoteId: string) => void | Promise<void>
  linkByIdInput: string
  onLinkByIdInputChange: (value: string) => void
  linkByIdError: string | null
  linkByIdPending: boolean
  onLinkByProfileId: () => void | Promise<void>
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-account-title"
        id="link-account-dialog"
        className="relative z-1 flex max-h-[min(90vh,560px)] w-full max-w-sm animate-[slideUp_0.25s_ease-out] flex-col overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]"
      >
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="flex items-start gap-2">
            <Link2 className="mt-0.5 size-4 shrink-0 text-teal-800" />
            <div className="min-w-0 space-y-1">
              <p id="link-account-title" className="text-sm font-medium text-stone-800">
                Link to their account
              </p>
              <p className="text-xs text-stone-500">
                Pick someone you’re in a group with, or paste their <strong>Kwenta profile ID</strong>{' '}
                (UUID from Settings if they share it). Their profile must exist on this device and have an
                email (signed-in account).
              </p>
            </div>
          </div>
          {linkableRemotes && linkableRemotes.length > 0 ? (
            <Select onValueChange={(v) => void onPickRemote(v)}>
              <SelectTrigger className="w-full rounded-lg">
                <SelectValue placeholder="Choose from your groups…" />
              </SelectTrigger>
              <SelectContent className="z-100">
                {linkableRemotes.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-xs text-stone-500">
              No signed-in people in your groups yet — use profile ID below, or share a group first.
            </p>
          )}
          <div className="border-t border-stone-200 pt-3">
            <p className="text-xs font-medium text-stone-600">Or paste profile ID</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Input
                placeholder="e.g. 8b3e2f1a-…"
                value={linkByIdInput}
                onChange={(e) => onLinkByIdInputChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void onLinkByProfileId()}
                className="rounded-lg font-mono text-sm"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                className="shrink-0 rounded-lg"
                disabled={linkByIdPending || !linkByIdInput.trim()}
                onClick={() => void onLinkByProfileId()}
              >
                {linkByIdPending ? '…' : 'Link'}
              </Button>
            </div>
            {linkByIdError && <p className="mt-2 text-xs text-red-600">{linkByIdError}</p>}
          </div>
        </div>
        <div className="shrink-0 border-t border-stone-200 p-2">
          <Button variant="ghost" className="w-full rounded-xl text-stone-500" type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  )
}

export function PersonDetailPage() {
  const { personId } = useParams<{ personId: string }>()
  const navigate = useNavigate()
  const { userId, profile: meProfile } = useCurrentUser()
  const [editing, setEditing] = useState<SettlementHistoryItem | null>(null)
  const [record, setRecord] = useState<{
    direction: 'you_pay' | 'they_pay'
    currency: string
  } | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const [linkByIdInput, setLinkByIdInput] = useState('')
  const [linkByIdError, setLinkByIdError] = useState<string | null>(null)
  const [linkByIdPending, setLinkByIdPending] = useState(false)
  const [linkAccountOpen, setLinkAccountOpen] = useState(false)

  const profile = useLiveQuery(
    () => (personId ? db.profiles.get(personId) : undefined),
    [personId],
  )

  const display = useLiveQuery(async () => {
    if (!personId) return null
    return resolveProfileDisplay(personId)
  }, [personId])

  const netByCurrency = useLiveQuery(async () => {
    if (!userId || !personId) return new Map<string, number>()
    return computePairwiseNet(userId, personId)
  }, [userId, personId])

  const bills = useLiveQuery(async () => {
    if (!userId || !personId) return []
    return listBillsInvolvingPair(userId, personId)
  }, [userId, personId])

  const settlements = useLiveQuery(async () => {
    if (!userId || !personId) return []
    return listPairwiseSettlementsBetween(userId, personId)
  }, [userId, personId])

  const linkableRemotes = useLiveQuery(async () => {
    if (!userId || !personId) return []
    const memberships = await db.group_members.where('user_id').equals(userId).toArray()
    const groupIds = memberships.filter((m) => !m.is_deleted).map((m) => m.group_id)
    const seen = new Set<string>()
    const out: { id: string; displayName: string }[] = []
    for (const gid of groupIds) {
      const members = await db.group_members.where('group_id').equals(gid).toArray()
      for (const m of members) {
        if (m.is_deleted || m.user_id === personId) continue
        const p = await db.profiles.get(m.user_id)
        if (!p || p.is_deleted || !p.email?.trim()) continue
        if (seen.has(p.id)) continue
        seen.add(p.id)
        out.push({ id: p.id, displayName: p.display_name })
      }
    }
    out.sort((a, b) => a.displayName.localeCompare(b.displayName))
    return out
  }, [userId, personId])

  const summary = useMemo(() => {
    if (!netByCurrency) return null
    return formatPairwiseSummary(netByCurrency)
  }, [netByCurrency])

  const defaultCurrency = useMemo(() => {
    const b = bills?.[0]
    return b?.currency ?? 'PHP'
  }, [bills])

  useEffect(() => {
    if (personId && userId && personId === userId) {
      navigate('/app/people', { replace: true })
    }
  }, [personId, userId, navigate])

  useEffect(() => {
    setLinkAccountOpen(false)
  }, [personId])

  if (!userId || !personId) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="size-5 animate-spin text-teal-800" />
      </div>
    )
  }

  if (personId === userId) {
    return null
  }

  if (profile === undefined) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="size-5 animate-spin text-teal-800" />
      </div>
    )
  }

  if (!profile || profile.is_deleted) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to="/app/people">
            <ArrowLeft className="size-4" />
            People
          </Link>
        </Button>
        <p className="text-center text-sm text-stone-500">Person not found</p>
      </div>
    )
  }

  const canLink = profile.is_local && !profile.linked_profile_id

  async function handleLink(remoteId: string) {
    if (!userId || !personId) return
    setLinkByIdError(null)
    await linkProfileToRemote(personId, remoteId, userId)
    const updated = await db.profiles.get(personId)
    if (updated?.linked_profile_id === remoteId) {
      setLinkAccountOpen(false)
    }
  }

  async function handleLinkByProfileId() {
    if (!userId || !personId) return
    setLinkByIdError(null)
    const raw = linkByIdInput.trim()
    if (!raw) {
      setLinkByIdError('Paste a profile ID first.')
      return
    }
    if (!UUID_RE.test(raw)) {
      setLinkByIdError('That doesn’t look like a valid profile ID (UUID).')
      return
    }
    if (raw === personId) {
      setLinkByIdError('Use a different person’s ID, not this contact’s.')
      return
    }
    setLinkByIdPending(true)
    try {
      const remote = await db.profiles.get(raw)
      if (!remote || remote.is_deleted) {
        setLinkByIdError('No profile with this ID on this device. Sync or join a group with them first.')
        return
      }
      if (!remote.email?.trim()) {
        setLinkByIdError('That profile has no email — only signed-in accounts can be linked.')
        return
      }
      await linkProfileToRemote(personId, raw, userId)
      const updated = await db.profiles.get(personId)
      if (updated?.linked_profile_id === raw) {
        setLinkByIdInput('')
        setLinkAccountOpen(false)
      }
    } finally {
      setLinkByIdPending(false)
    }
  }

  async function handleDeletePerson() {
    if (!userId || !personId) return
    await deletePerson(personId, userId)
    navigate('/app/people', { replace: true })
  }

  function openDeleteFromMenu() {
    setShowOptionsMenu(false)
    setDeleteConfirmOpen(true)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-2">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to="/app/people">
            <ArrowLeft className="size-4" />
            People
          </Link>
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          className="rounded-full"
          aria-label="Person options"
          type="button"
          onClick={() => setShowOptionsMenu(true)}
        >
          <MoreVertical className="size-4" />
        </Button>
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              {display?.displayName ?? profile.display_name}
            </h1>
            {display?.subtitle && <p className="mt-1 text-sm text-stone-500">{display.subtitle}</p>}
          </div>
          {canLink && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0 rounded-full border-stone-300 text-xs font-medium text-stone-600 hover:bg-stone-50"
              aria-haspopup="dialog"
              aria-expanded={linkAccountOpen}
              aria-controls="link-account-dialog"
              onClick={() => setLinkAccountOpen(true)}
            >
              Unlinked
            </Button>
          )}
        </div>
        {summary && (
          <p
            className={cn(
              'mt-3 text-lg font-semibold',
              summary.tone === 'balanced' && 'text-stone-500',
              summary.tone === 'collect' && 'text-emerald-600',
              summary.tone === 'pay' && 'text-amber-600',
            )}
          >
            {summary.lines.length > 0 ? summary.lines.join(' · ') : summary.primaryLabel}
          </p>
        )}
        <p className="mt-2 text-xs text-stone-500">
          Totals include bills where one of you paid or the other paid (not when a third person paid for
          both). All recorded payments with this person are included.
        </p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            size="sm"
            className="rounded-full"
            type="button"
            onClick={() =>
              setRecord({ direction: 'you_pay', currency: defaultCurrency })
            }
          >
            You paid them
          </Button>
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            type="button"
            onClick={() =>
              setRecord({ direction: 'they_pay', currency: defaultCurrency })
            }
          >
            They paid you
          </Button>
        </div>
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <ReceiptText className="size-4 text-teal-800" />
          <h2 className="text-lg font-semibold">Shared bills</h2>
        </div>
        {(!bills || bills.length === 0) ? (
          <p className="mt-3 text-sm text-stone-500">No bills yet with this person on a split.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {bills.map((bill) => (
              <li key={bill.id}>
                <Link
                  to={bill.group_id ? `/app/groups/${bill.group_id}` : `/app/bills/${bill.id}`}
                  className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 transition-colors hover:bg-stone-100"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-stone-800">{bill.title}</p>
                    <p className="text-xs text-stone-500">
                      {bill.groupName ? (
                        <span>{bill.groupName} · </span>
                      ) : (
                        <span>Personal · </span>
                      )}
                      {bill.creatorName}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-stone-800">
                      {formatCurrency(bill.total_amount, bill.currency)}
                    </span>
                    <ChevronRight className="size-4 text-stone-400" />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Banknote className="size-4 text-teal-800" />
          <h2 className="text-lg font-semibold">Payments between you</h2>
        </div>
        {(!settlements || settlements.length === 0) ? (
          <p className="mt-3 text-sm text-stone-500">No recorded payments yet.</p>
        ) : (
          <div className="mt-3">
            <SettlementHistoryList
              items={settlements}
              currentUserId={userId}
              showGroupName
              onEdit={(item) => setEditing(item)}
            />
          </div>
        )}
      </div>

      {record && (
        <RecordSettlementDialog
          open
          onOpenChange={(o) => {
            if (!o) setRecord(null)
          }}
          groupId={null}
          currency={record.currency}
          fromUserId={record.direction === 'you_pay' ? userId : personId}
          toUserId={record.direction === 'you_pay' ? personId : userId}
          defaultAmount={0}
          amountEditable
          fromName={
            record.direction === 'you_pay'
              ? (meProfile?.display_name ?? 'You')
              : (display?.displayName ?? profile.display_name)
          }
          toName={
            record.direction === 'you_pay'
              ? (display?.displayName ?? profile.display_name)
              : (meProfile?.display_name ?? 'You')
          }
          markedBy={userId}
          onRecorded={() => {
            setRecord(null)
          }}
        />
      )}

      {editing && (
        <EditSettlementDialog
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      {showOptionsMenu && (
        <PersonOptionsMenu
          onClose={() => setShowOptionsMenu(false)}
          onRemoveContact={openDeleteFromMenu}
        />
      )}

      {linkAccountOpen && canLink && (
        <LinkAccountSheet
          onClose={() => {
            setLinkAccountOpen(false)
            setLinkByIdError(null)
          }}
          linkableRemotes={linkableRemotes}
          onPickRemote={(v) => void handleLink(v)}
          linkByIdInput={linkByIdInput}
          onLinkByIdInputChange={(v) => {
            setLinkByIdInput(v)
            setLinkByIdError(null)
          }}
          linkByIdError={linkByIdError}
          linkByIdPending={linkByIdPending}
          onLinkByProfileId={() => void handleLinkByProfileId()}
        />
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete this person?"
        description="All payments with them will be removed. They will be removed from every group and personal bill; equal splits will be redistributed among remaining people. This cannot be undone here."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeletePerson}
      />
    </div>
  )
}
