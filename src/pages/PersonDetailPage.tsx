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
  Users,
} from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import {
  computePairwiseNetForBill,
  computePairwiseNet,
  fetchRemoteProfileIntoDexie,
  findRemoteProfileIdForLinking,
  formatPairwiseSummary,
  listBillsInvolvingPair,
  listPairwiseSettlementsBetween,
  listSharedGroupsWithBalance,
  resolveProfileDisplay,
} from '@/lib/people'
import { deletePerson, linkProfileToRemote } from '@/db/operations'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { withBillBackQuery } from '@/lib/bill-navigation'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettlementHistoryList } from '@/components/common/SettlementHistoryList'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import { RecordSettlementDialog } from '@/components/common/RecordSettlementDialog'
import type { SettlementHistoryItem } from '@/lib/settlement'
import type { Profile } from '@/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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
  onLinkByIdOrEmail,
}: {
  onClose: () => void
  linkableRemotes: { id: string; displayName: string }[] | undefined
  onPickRemote: (remoteId: string) => void | Promise<void>
  linkByIdInput: string
  onLinkByIdInputChange: (value: string) => void
  linkByIdError: string | null
  linkByIdPending: boolean
  onLinkByIdOrEmail: () => void | Promise<void>
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
                Pick someone you’re in a group with, or enter the <strong>email they use in Kwenta</strong>{' '}
                (same as in Settings). Their profile must already be on this device — usually after you’re in a
                group together or you’ve synced.
              </p>
              <p className="text-xs leading-relaxed text-stone-500">
                <span className="font-medium text-stone-600">Tip:</span> Name-only group placeholders can’t be
                linked until that person signs in to Kwenta and you’ve synced here—then use their email or the
                list above.
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
              No signed-in people in your groups yet — enter their email below, or share a group first.
            </p>
          )}
          <div className="border-t border-stone-200 pt-3">
            <p className="text-xs font-medium text-stone-600">Or enter email or profile ID</p>
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Input
                type="email"
                placeholder="friend@email.com"
                value={linkByIdInput}
                onChange={(e) => onLinkByIdInputChange(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void onLinkByIdOrEmail()}
                className="rounded-lg text-sm"
                autoComplete="off"
                spellCheck={false}
              />
              <Button
                type="button"
                className="shrink-0 rounded-lg"
                disabled={linkByIdPending || !linkByIdInput.trim()}
                onClick={() => void onLinkByIdOrEmail()}
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
  const [record, setRecord] = useState<{ currency: string } | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const [linkByIdInput, setLinkByIdInput] = useState('')
  const [linkByIdError, setLinkByIdError] = useState<string | null>(null)
  const [linkByIdPending, setLinkByIdPending] = useState(false)
  const [linkAccountOpen, setLinkAccountOpen] = useState(false)
  const [billsScope, setBillsScope] = useState<'personal' | 'groups'>('personal')

  const profile = useLiveQuery(
    async (): Promise<Profile | null | undefined> => {
      if (!personId) return null
      let p = await db.profiles.get(personId)
      if (p && !p.is_deleted) return p
      if (p?.is_deleted) return null
      await fetchRemoteProfileIntoDexie(personId)
      p = await db.profiles.get(personId)
      if (p && !p.is_deleted) return p
      return null
    },
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

  const sharedGroups = useLiveQuery(async () => {
    if (!userId || !personId) return []
    return listSharedGroupsWithBalance(userId, personId)
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
        if (m.is_deleted || m.user_id === personId || m.user_id === userId) continue
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

  const personalBills = useMemo(
    () => (bills ?? []).filter((b) => !b.group_id),
    [bills],
  )

  const personalBillDirection = useLiveQuery(async () => {
    if (!userId || !personId) return new Map<string, number>()
    const out = new Map<string, number>()
    for (const bill of personalBills) {
      const net = await computePairwiseNetForBill(bill.id, userId, personId)
      out.set(bill.id, net)
    }
    return out
  }, [userId, personId, personalBills])

  const defaultCurrency = useMemo(() => {
    const pb = personalBills[0]
    if (pb) return pb.currency
    return bills?.[0]?.currency ?? 'PHP'
  }, [personalBills, bills])

  const settlementParties = useMemo((): { id: string; label: string }[] | undefined => {
    if (!userId || !personId) return undefined
    return [
      { id: userId, label: meProfile?.display_name?.trim() || 'You' },
      {
        id: personId,
        label: (display?.displayName ?? profile?.display_name ?? 'Contact').trim() || 'Contact',
      },
    ]
  }, [userId, personId, meProfile?.display_name, display?.displayName, profile?.display_name])

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

  if (profile === null) {
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
  const isLinked = Boolean(profile.linked_profile_id)

  async function handleLink(remoteId: string) {
    if (!userId || !personId) return
    if (remoteId === userId) return
    setLinkByIdError(null)
    await linkProfileToRemote(personId, remoteId, userId)
    const updated = await db.profiles.get(personId)
    if (updated?.linked_profile_id === remoteId) {
      setLinkAccountOpen(false)
    }
  }

  async function handleLinkByIdOrEmail() {
    if (!userId || !personId) return
    setLinkByIdError(null)
    const raw = linkByIdInput.trim()
    if (!raw) {
      setLinkByIdError('Enter their email or profile ID.')
      return
    }
    setLinkByIdPending(true)
    try {
      const remoteId = await findRemoteProfileIdForLinking(raw)
      if (!remoteId) {
        setLinkByIdError(
          'No matching account on this device. Use the email they use in Kwenta, or join a group with them and sync.',
        )
        return
      }
      if (remoteId === personId) {
        setLinkByIdError('That’s this contact — use the other person’s email or ID.')
        return
      }
      if (remoteId === userId) {
        setLinkByIdError('You can’t link a contact to your own Kwenta account.')
        return
      }
      const remote = await db.profiles.get(remoteId)
      if (!remote?.email?.trim()) {
        setLinkByIdError('That profile has no email — only signed-in accounts can be linked.')
        return
      }
      await linkProfileToRemote(personId, remoteId, userId)
      const updated = await db.profiles.get(personId)
      if (updated?.linked_profile_id === remoteId) {
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
          {isLinked ? (
            <span className="shrink-0 rounded-full border border-emerald-200/90 bg-emerald-50 px-3 py-1.5 text-xs font-medium text-emerald-900">
              Linked
            </span>
          ) : canLink ? (
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
              Link account
            </Button>
          ) : null}
        </div>
        {summary && (
          <p
            className={cn(
              'mt-3 text-lg font-semibold',
              summary.tone === 'balanced' && 'text-stone-500',
              summary.tone === 'receive' && 'text-emerald-600',
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

        <div className="mt-4">
          <Button
            size="sm"
            className="rounded-full"
            type="button"
            onClick={() => setRecord({ currency: defaultCurrency })}
          >
            Add payment
          </Button>
        </div>
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <ReceiptText className="size-4 text-teal-800" />
            <h2 className="text-lg font-semibold">Bills &amp; groups</h2>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-1 rounded-2xl border border-stone-200 bg-stone-100/80 p-1">
          <button
            type="button"
            onClick={() => setBillsScope('personal')}
            className={cn(
              'flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
              billsScope === 'personal'
                ? 'bg-white text-stone-900 shadow-sm'
                : 'text-stone-500 hover:text-stone-800',
            )}
          >
            <ReceiptText className="size-3.5" />
            Personal
            {personalBills.length > 0 && (
              <span className="rounded-full bg-stone-200/80 px-1.5 text-[0.65rem] font-semibold text-stone-600">
                {personalBills.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setBillsScope('groups')}
            className={cn(
              'flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
              billsScope === 'groups'
                ? 'bg-white text-stone-900 shadow-sm'
                : 'text-stone-500 hover:text-stone-800',
            )}
          >
            <Users className="size-3.5" />
            Groups
            {(sharedGroups?.length ?? 0) > 0 && (
              <span className="rounded-full bg-stone-200/80 px-1.5 text-[0.65rem] font-semibold text-stone-600">
                {sharedGroups?.length}
              </span>
            )}
          </button>
        </div>

        {billsScope === 'personal' && (
          <>
            {personalBills.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">
                No personal bills yet where you’re both on the bill (selected on a line and/or as payer).
                Group trips are under <strong>Groups</strong>.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {personalBills.map((bill) => (
                  <li key={bill.id}>
                    {(() => {
                      const net = personalBillDirection?.get(bill.id) ?? 0
                      const settled = Math.abs(net) < 0.005
                      const direction = net > 0 ? 'Receive' : 'Pay'
                      const amountForDisplay = settled ? 0 : Math.abs(net)
                      const badgeClass = settled
                        ? 'bg-stone-200 text-stone-600'
                        : net > 0
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-amber-100 text-amber-800'
                      return (
                    <Link
                      to={withBillBackQuery(`/app/bills/${bill.id}`, `/app/people/${personId}`)}
                      className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 transition-colors hover:bg-stone-100"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-stone-800">{bill.title}</p>
                        <p className="mt-0.5 flex items-center gap-2 text-xs text-stone-500">
                          <span>Personal · {bill.creatorName}</span>
                          <span
                            className={cn(
                              'rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide',
                              badgeClass,
                            )}
                          >
                            {settled ? 'Even' : direction}
                          </span>
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-stone-800">
                          {formatCurrency(amountForDisplay, bill.currency)}
                        </span>
                        <ChevronRight className="size-4 text-stone-400" />
                      </div>
                    </Link>
                      )
                    })()}
                  </li>
                ))}
              </ul>
            )}
          </>
        )}

        {billsScope === 'groups' && (
          <>
            {!sharedGroups || sharedGroups.length === 0 ? (
              <p className="mt-3 text-sm text-stone-500">
                You’re not in any group with this person yet.
              </p>
            ) : (
              <ul className="mt-3 space-y-2">
                {sharedGroups.map((g) => {
                  const settled = Math.abs(g.theirNet) < 0.005
                  return (
                    <li key={g.groupId}>
                      <Link
                        to={`/app/groups/${g.groupId}`}
                        className="flex items-center justify-between gap-3 rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 transition-colors hover:bg-stone-100"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-medium text-stone-800">{g.groupName}</p>
                          <p className="mt-0.5 text-xs text-stone-500">
                            {settled ? (
                              <span className="text-stone-400">Even in this group</span>
                            ) : g.theirNet > 0 ? (
                              <span className="font-medium text-emerald-700">
                                Receive {formatCurrency(g.theirNet, g.currency)} in this group
                              </span>
                            ) : (
                              <span className="font-medium text-amber-700">
                                Pay {formatCurrency(Math.abs(g.theirNet), g.currency)} in this group
                              </span>
                            )}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {!settled && (
                            <span
                              className={cn(
                                'rounded-full px-2 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide',
                                g.theirNet > 0
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-amber-100 text-amber-800',
                              )}
                              title={
                                g.theirNet > 0
                                  ? 'On net, the group should pay them this much'
                                  : 'On net, they should pay into the group this much'
                              }
                            >
                              {g.theirNet > 0 ? 'Receive' : 'Pay'}
                            </span>
                          )}
                          <ChevronRight className="size-4 text-stone-400" />
                        </div>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            )}
            <p className="mt-3 text-xs text-stone-400">
              Their net in that group from bills and settlements—not only your balance with them.
            </p>
          </>
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

      {record && settlementParties && (
        <RecordSettlementDialog
          open
          onOpenChange={(o) => {
            if (!o) setRecord(null)
          }}
          title="Add payment"
          confirmLabel="Add payment"
          groupId={null}
          currency={record.currency}
          fromUserId={userId}
          toUserId={personId}
          defaultAmount={0}
          amountEditable
          fromName={meProfile?.display_name ?? 'You'}
          toName={display?.displayName ?? profile.display_name}
          partyPicker={settlementParties}
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
          onLinkByIdOrEmail={() => void handleLinkByIdOrEmail()}
        />
      )}

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete this person?"
        description="All payments with them will be removed. They will be removed from every group. Personal bills that only involved you and them will be deleted. Personal bills that also include other people will stay: their share is removed and equal splits are redistributed among whoever remains. This cannot be undone here."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeletePerson}
      />
    </div>
  )
}
