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
  Share2,
  Trash2,
  Unlink,
  Users,
} from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import {
  buildManualGeneralCreditSelectionPlan,
  buildPersonalBillAllocationPlan,
  computePairwiseNetForBill,
  computePairwiseNet,
  fetchRemoteProfileIntoDexie,
  findRemoteProfileIdForLinking,
  formatPairwiseSummary,
  listBillsInvolvingPair,
  listEligibleSharedGroupsForGeneralCredit,
  listPairwiseSettlementsBetween,
  resolveFallbackIdentityForViewer,
  listSharedGroupsWithBalance,
  resolveProfileDisplay,
} from '@/lib/people'
import {
  addProfilePeerLink,
  applyGeneralCreditToSelection,
  createPersonalPaymentWithDistribution,
  deletePerson,
  getBillWithDetails,
  linkProfileToRemote,
  removeProfilePeerLink,
} from '@/db/operations'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useConfirmDialog } from '@/hooks/useConfirmDialog'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { withBillBackQuery } from '@/lib/bill-navigation'
import { cn, formatCurrency } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettlementHistoryList } from '@/components/common/SettlementHistoryList'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import { RecordSettlementDialog } from '@/components/common/RecordSettlementDialog'
import { ApplyGeneralCreditDialog } from '@/components/common/ApplyGeneralCreditDialog'
import { ExportImageDialog } from '@/components/export/ExportImageDialog'
import { PersonExportCard, type PersonBillEntry } from '@/components/export/PersonExportCard'
import { exportPersonToCSV } from '@/lib/export-csv'
import { generatePersonPDF } from '@/lib/export-pdf'
import { makeExportFilename } from '@/lib/export-utils'
import type { SettlementHistoryItem } from '@/lib/settlement'
import type { Profile, ProfilePeerLink } from '@/types'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { toast } from 'sonner'

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

function PeerLinkRowLabel({
  peerId,
  viewerId,
  isPrimaryAccount,
}: {
  peerId: string
  viewerId: string
  isPrimaryAccount: boolean
}) {
  const label = useLiveQuery(
    async () => resolveProfileDisplay(peerId, viewerId),
    [peerId, viewerId],
  )
  return (
    <div className="min-w-0">
      <p className="truncate text-sm font-medium text-stone-900">{label?.displayName ?? '…'}</p>
      <p className="truncate text-xs text-stone-500">
        {isPrimaryAccount ? 'Kwenta account (primary link)' : (label?.subtitle ?? 'Linked profile')}
      </p>
    </div>
  )
}

function LinkPeerProfileSheet({
  onClose,
  candidates,
  onPick,
}: {
  onClose: () => void
  candidates: { id: string; displayName: string; subtitle: string }[] | undefined
  onPick: (peerId: string) => void | Promise<void>
}) {
  const [q, setQ] = useState('')
  const filtered = useMemo(() => {
    const list = candidates ?? []
    const n = q.trim().toLowerCase()
    if (!n) return list
    return list.filter(
      (c) =>
        c.displayName.toLowerCase().includes(n) ||
        c.subtitle.toLowerCase().includes(n) ||
        c.id.toLowerCase().includes(n),
    )
  }, [candidates, q])

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center">
      {sheetBackdrop(onClose)}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="link-peer-title"
        className="relative z-1 flex max-h-[min(90vh,560px)] w-full max-w-sm animate-[slideUp_0.25s_ease-out] flex-col overflow-hidden rounded-3xl border border-stone-200 bg-white shadow-[0_20px_60px_rgba(28,25,23,0.18)]"
      >
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="flex items-start gap-2">
            <Users className="mt-0.5 size-4 shrink-0 text-teal-800" />
            <div className="min-w-0 space-y-1">
              <p id="link-peer-title" className="text-sm font-medium text-stone-800">
                Link another profile
              </p>
              <p className="text-xs text-stone-500">
                Choose someone from your groups who is the same person as this contact. Bills and balances
                that involve that profile will show here too.
              </p>
            </div>
          </div>
          <Input
            placeholder="Search by name or group…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="rounded-lg text-sm"
            autoComplete="off"
          />
          {candidates === undefined ? (
            <div className="flex items-center gap-2 text-xs text-stone-500">
              <Loader2 className="size-3.5 animate-spin text-teal-800" />
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <p className="text-xs text-stone-500">
              {candidates.length === 0
                ? 'Join a group with the other person first, or they’re already linked.'
                : 'No matches — try another search.'}
            </p>
          ) : (
            <ul className="space-y-1">
              {filtered.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="flex w-full flex-col rounded-xl border border-stone-200 bg-stone-50/80 px-3 py-2.5 text-left text-sm transition-colors hover:bg-stone-100"
                    onClick={() => void onPick(c.id)}
                  >
                    <span className="font-medium text-stone-900">{c.displayName}</span>
                    <span className="text-xs text-stone-500">{c.subtitle}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
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
          {linkableRemotes === undefined ? (
            <div className="flex items-center gap-2 text-xs text-stone-500">
              <Loader2 className="size-3.5 animate-spin text-teal-800" />
              Loading people from your groups…
            </div>
          ) : linkableRemotes.length > 0 ? (
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
  const [paymentMode, setPaymentMode] = useState<'general' | 'distributed'>('general')
  const [applyingGeneralCredit, setApplyingGeneralCredit] = useState(false)
  const [applyCreditOpen, setApplyCreditOpen] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const [linkByIdInput, setLinkByIdInput] = useState('')
  const [linkByIdError, setLinkByIdError] = useState<string | null>(null)
  const [linkByIdPending, setLinkByIdPending] = useState(false)
  const [linkAccountOpen, setLinkAccountOpen] = useState(false)
  const [linkPeerOpen, setLinkPeerOpen] = useState(false)
  const [peerToLinkConfirm, setPeerToLinkConfirm] = useState<{ id: string; displayName: string } | null>(
    null,
  )
  const [peerLinkToUnlink, setPeerLinkToUnlink] = useState<ProfilePeerLink | null>(null)
  const [billsScope, setBillsScope] = useState<'personal' | 'groups'>('personal')
  const [exportOpen, setExportOpen] = useState(false)
  const { confirm: confirmFlow, dialog: flowConfirmDialog } = useConfirmDialog()

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
    return resolveProfileDisplay(personId, userId ?? undefined)
  }, [personId, userId])

  const fallbackIdentity = useLiveQuery(async () => {
    if (!userId || !personId) return null
    return resolveFallbackIdentityForViewer(userId, personId)
  }, [userId, personId])

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
  const billsLoading = bills === undefined
  const sharedGroupsLoading = sharedGroups === undefined
  const settlementsLoading = settlements === undefined

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

  const peerLinksForAnchor = useLiveQuery(async () => {
    if (!userId || !personId) return []
    return db.profile_peer_links
      .where('[owner_user_id+anchor_profile_id]')
      .equals([userId, personId])
      .filter((l) => !l.is_deleted)
      .toArray()
  }, [userId, personId])

  const peerLinkCandidates = useLiveQuery(async () => {
    if (!userId || !personId) return []
    const anchor = await db.profiles.get(personId)
    if (!anchor || anchor.is_deleted || !anchor.is_local || anchor.owner_id !== userId) return []

    // Collect all peer_profile_ids already linked to any anchor owned by this user, so we
    // don't show a profile that would end up mapped to two different anchors.
    const allLinks = await db.profile_peer_links
      .where('owner_user_id')
      .equals(userId)
      .filter((l) => !l.is_deleted)
      .toArray()
    const linkedPeerIds = new Set(allLinks.map((l) => l.peer_profile_id))
    // Also exclude the anchor's primary account link so it doesn't appear as a duplicate candidate.
    if (anchor.linked_profile_id) linkedPeerIds.add(anchor.linked_profile_id)

    const memberships = await db.group_members.where('user_id').equals(userId).toArray()
    const groupIds = memberships.filter((m) => !m.is_deleted).map((m) => m.group_id)
    const seen = new Set<string>()
    const out: { id: string; displayName: string; subtitle: string }[] = []
    for (const gid of groupIds) {
      const g = await db.groups.get(gid)
      const gname = g && !g.is_deleted ? g.name : 'Group'
      const members = await db.group_members.where('group_id').equals(gid).toArray()
      for (const m of members) {
        if (m.is_deleted) continue
        // Exclude the anchor (by local id and by rewritten linked_profile_id after linkProfileToRemote).
        if (m.user_id === personId || m.user_id === anchor.linked_profile_id) continue
        if (m.user_id === userId) continue
        if (linkedPeerIds.has(m.user_id)) continue
        if (seen.has(m.user_id)) continue
        seen.add(m.user_id)
        const p = await db.profiles.get(m.user_id)
        const name = (p?.display_name ?? m.display_name).trim() || 'Unknown'
        out.push({ id: m.user_id, displayName: name, subtitle: `Group · ${gname}` })
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

  const exportBillDetails = useLiveQuery(async () => {
    if (!exportOpen || !userId || !personId) return [] as PersonBillEntry[]
    const unsettled = personalBills.filter(
      (b) => Math.abs(personalBillDirection?.get(b.id) ?? 0) > 0.005,
    )
    const results = await Promise.all(
      unsettled.map(async (b) => {
        const details = await getBillWithDetails(b.id)
        if (!details) return null
        return {
          title: details.title,
          note: details.note ?? null,
          currency: details.currency,
          net: personalBillDirection?.get(b.id) ?? 0,
          items: details.items,
        }
      }),
    )
    return results.filter((r) => r !== null) as PersonBillEntry[]
  }, [exportOpen, userId, personId, personalBills, personalBillDirection])

  const defaultCurrency = useMemo(() => {
    const pb = personalBills[0]
    if (pb) return pb.currency
    const anyBillCurrency = bills?.[0]?.currency
    if (anyBillCurrency) return anyBillCurrency
    const settlementCurrency = settlements?.[0]?.currency
    if (settlementCurrency) return settlementCurrency
    const sharedGroupCurrency = sharedGroups?.[0]?.currency
    return sharedGroupCurrency ?? 'PHP'
  }, [personalBills, bills, settlements, sharedGroups])

  const manualGeneralCreditPlan = useLiveQuery(async () => {
    if (!userId || !personId) return null
    const candidateCurrencies = [
      ...new Set(
        [
          ...personalBills.map((bill) => bill.currency),
          ...(bills ?? []).map((bill) => bill.currency),
          ...(settlements ?? []).map((settlement) => settlement.currency),
          ...(sharedGroups ?? []).map((group) => group.currency),
        ].filter(Boolean),
      ),
    ]

    const currencies = candidateCurrencies.length > 0 ? candidateCurrencies : [defaultCurrency]
    const plans = await Promise.all(
      currencies.map((currency) =>
        buildManualGeneralCreditSelectionPlan({
          meId: userId,
          otherId: personId,
          currency,
        }),
      ),
    )
    return plans
      .filter((plan): plan is NonNullable<typeof plan> => Boolean(plan))
      .sort((a, b) => b.maxApplicableAmount - a.maxApplicableAmount)[0] ?? null
  }, [userId, personId, defaultCurrency, bills, settlements, sharedGroups, personalBills, personalBillDirection])

  const settlementParties = useMemo((): { id: string; label: string }[] | undefined => {
    if (!userId || !personId) return undefined
    return [
      { id: userId, label: meProfile?.display_name?.trim() || 'You' },
      {
        id: personId,
        label:
          (display?.displayName ?? profile?.display_name ?? fallbackIdentity?.displayName ?? 'Contact')
            .trim() || 'Contact',
      },
    ]
  }, [
    userId,
    personId,
    meProfile?.display_name,
    display?.displayName,
    profile?.display_name,
    fallbackIdentity?.displayName,
  ])

  useEffect(() => {
    if (personId && userId && personId === userId) {
      navigate('/app/people', { replace: true })
    }
  }, [personId, userId, navigate])

  useEffect(() => {
    setLinkAccountOpen(false)
    setLinkPeerOpen(false)
    setPeerToLinkConfirm(null)
    setPeerLinkToUnlink(null)
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

  if (profile === null && fallbackIdentity === undefined) {
    return (
      <div className="flex justify-center py-20">
        <Loader2 className="size-5 animate-spin text-teal-800" />
      </div>
    )
  }

  if (profile === null) {
    if (fallbackIdentity) {
      // Render fallback identity state below.
    } else {
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
  }

  const canLink = Boolean(profile?.is_local && !profile.linked_profile_id)
  const isLinked = Boolean(profile?.linked_profile_id)
  const isMyLocal = Boolean(profile?.is_local && profile.owner_id === userId)
  const resolvedDisplayName =
    display?.displayName ?? profile?.display_name ?? fallbackIdentity?.displayName ?? 'Contact'
  const resolvedSubtitle = display?.subtitle ?? fallbackIdentity?.subtitle

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

  function handlePickPeerProfile(peerId: string) {
    const c = peerLinkCandidates?.find((x) => x.id === peerId)
    setPeerToLinkConfirm({
      id: peerId,
      displayName: c?.displayName ?? 'Profile',
    })
    setLinkPeerOpen(false)
  }

  async function handleConfirmPeerLink() {
    if (!userId || !personId || !peerToLinkConfirm) return
    try {
      await addProfilePeerLink(personId, peerToLinkConfirm.id, userId)
      toast.success('Profiles linked.')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not save the link.'
      toast.error(msg)
      throw e
    }
  }

  async function handleConfirmUnlinkPeer() {
    if (!userId || !peerLinkToUnlink) return
    try {
      await removeProfilePeerLink(peerLinkToUnlink.id, userId)
      toast.success('Link removed.')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not remove the link.'
      toast.error(msg)
      throw e
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

  async function handleRecordPaymentSubmit(args: {
    groupId: string | null
    billId: string | null
    fromUserId: string
    toUserId: string
    amount: number
    currency: string
    label?: string
    markedBy: string
  }) {
    if (!userId || !personId) return
    if (paymentMode === 'general') {
      await createPersonalPaymentWithDistribution({
        fromUserId: args.fromUserId,
        toUserId: args.toUserId,
        totalAmount: args.amount,
        currency: args.currency,
        markedBy: args.markedBy,
        label: args.label,
        slices: [],
        remainderAmount: args.amount,
        routeHint: `/app/people/${personId}`,
      })
      return true
    }

    const plan = await buildPersonalBillAllocationPlan({
      meId: userId,
      otherId: personId,
      fromUserId: args.fromUserId,
      toUserId: args.toUserId,
      currency: args.currency,
      amountToApply: args.amount,
    })

    const fullSettle = plan.allocatableTotal > 0.005 && args.amount >= plan.allocatableTotal - 0.005
    if (fullSettle) {
      const ok = await confirmFlow({
        title: 'This can clear your balance',
        description: 'This payment can settle all unpaid personal bills between you two.',
        confirmLabel: 'Apply payment',
      })
      if (!ok) return false
    }

    if (plan.remainderAmount > 0.005) {
      const ok = await confirmFlow({
        title: 'This is more than unpaid bills',
        description: `${formatCurrency(plan.appliedAmount, args.currency)} will settle unpaid bills. ${formatCurrency(
          plan.remainderAmount,
          args.currency,
        )} will be saved as a general payment.`,
        confirmLabel: 'Continue',
      })
      if (!ok) return false
    }

    await createPersonalPaymentWithDistribution({
      fromUserId: args.fromUserId,
      toUserId: args.toUserId,
      totalAmount: args.amount,
      currency: args.currency,
      markedBy: args.markedBy,
      label: args.label,
      slices: plan.slices.map((s) => ({ billId: s.billId, amount: s.amount })),
      remainderAmount: plan.remainderAmount,
      routeHint: `/app/people/${personId}`,
    })
    return true
  }

  async function handleApplyGeneralCredit() {
    if (!manualGeneralCreditPlan || !userId || !personId) return
    if (manualGeneralCreditPlan.maxApplicableAmount <= 0.005) {
      toast.info('No eligible bills or groups to apply credit to.')
      return
    }
    setApplyCreditOpen(true)
  }

  async function handleApplyGeneralCreditSubmit(args: {
    appliedAmount: number
    personalAmount: number
    groupAllocations: { groupId: string; amount: number }[]
  }) {
    if (!manualGeneralCreditPlan || !userId || !personId) return
    setApplyingGeneralCredit(true)
    try {
      let personalSlices: { billId: string; amount: number }[] = []
      if (args.personalAmount > 0.005) {
        const personalPlan = await buildPersonalBillAllocationPlan({
          meId: userId,
          otherId: personId,
          fromUserId: manualGeneralCreditPlan.fromUserId,
          toUserId: manualGeneralCreditPlan.toUserId,
          currency: manualGeneralCreditPlan.currency,
          amountToApply: args.personalAmount,
        })
        if (personalPlan.appliedAmount + 0.005 < args.personalAmount) {
          throw new Error('Personal bill balances changed. Refresh and try again.')
        }
        personalSlices = personalPlan.slices.map((slice) => ({ billId: slice.billId, amount: slice.amount }))
      }

      if (args.groupAllocations.length > 0) {
        const currentEligibleGroups = await listEligibleSharedGroupsForGeneralCredit({
          meId: userId,
          otherId: personId,
          fromUserId: manualGeneralCreditPlan.fromUserId,
          toUserId: manualGeneralCreditPlan.toUserId,
          currency: manualGeneralCreditPlan.currency,
        })
        const currentAmountByGroupId = new Map(
          currentEligibleGroups.map((group) => [group.groupId, group.allocatableAmount]),
        )
        for (const group of args.groupAllocations) {
          const currentAmount = currentAmountByGroupId.get(group.groupId) ?? 0
          if (group.amount > currentAmount + 0.005) {
            throw new Error('A selected group balance changed. Refresh and try again.')
          }
        }
      }

      await applyGeneralCreditToSelection({
        fromUserId: manualGeneralCreditPlan.fromUserId,
        toUserId: manualGeneralCreditPlan.toUserId,
        currency: manualGeneralCreditPlan.currency,
        markedBy: userId,
        appliedAmount: args.appliedAmount,
        personalSlices,
        groupAllocations: args.groupAllocations,
        routeHint: `/app/people/${personId}`,
      })
      setApplyCreditOpen(false)
      toast.success('Applied available general credit.')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not apply credit right now.'
      toast.error(message)
    } finally {
      setApplyingGeneralCredit(false)
    }
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
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            className="rounded-full"
            aria-label="Share person summary"
            type="button"
            onClick={() => setExportOpen(true)}
          >
            <Share2 className="size-4" />
          </Button>
          {profile && (
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
          )}
        </div>
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">
              {resolvedDisplayName}
            </h1>
            {resolvedSubtitle && <p className="mt-1 text-sm text-stone-500">{resolvedSubtitle}</p>}
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

        {isMyLocal && (
          <div className="mt-5 rounded-2xl border border-stone-200 bg-stone-50/80 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-stone-800">Linked identities</p>
                <p className="text-xs text-stone-500">
                  Group placeholders and other profiles you merge with this contact.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="shrink-0 rounded-full border-stone-300 text-xs font-medium text-stone-600 hover:bg-stone-50"
                onClick={() => setLinkPeerOpen(true)}
              >
                Link another profile
              </Button>
            </div>
            {peerLinksForAnchor && peerLinksForAnchor.length > 0 && (
              <ul className="mt-3 space-y-2">
                {peerLinksForAnchor.map((row) => {
                  const isPrimaryAccount = Boolean(profile?.linked_profile_id === row.peer_profile_id)
                  return (
                    <li
                      key={row.id}
                      className="flex items-center justify-between gap-2 rounded-xl border border-stone-200 bg-white px-3 py-2.5"
                    >
                      <PeerLinkRowLabel peerId={row.peer_profile_id} viewerId={userId} isPrimaryAccount={isPrimaryAccount} />
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="shrink-0 rounded-full text-stone-500"
                        disabled={isPrimaryAccount}
                        title={
                          isPrimaryAccount
                            ? 'Unlink the Kwenta account from “Link account” first (coming soon).'
                            : 'Unlink this profile'
                        }
                        onClick={() => setPeerLinkToUnlink(row)}
                      >
                        <Unlink className="size-4" />
                        <span className="sr-only">Unlink</span>
                      </Button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}

        <div className="mt-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="rounded-full"
              type="button"
              onClick={() => {
                setPaymentMode('general')
                setRecord({ currency: defaultCurrency })
              }}
            >
              Add payment
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="rounded-full"
              type="button"
              disabled={
                applyingGeneralCredit ||
                !manualGeneralCreditPlan ||
                manualGeneralCreditPlan.maxApplicableAmount <= 0.005
              }
              onClick={() => void handleApplyGeneralCredit()}
            >
              {applyingGeneralCredit ? 'Applying…' : 'Apply available general credit'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-stone-500">
            General payments reduce your total balance only. Distributed payments are split to your oldest
            unpaid bills. Applied credit can go to personal bills, selected groups, or both.
          </p>
          {manualGeneralCreditPlan && manualGeneralCreditPlan.maxApplicableAmount > 0.005 && (
            <p className="mt-1 text-xs text-stone-500">
              Available general credit you can apply now:{' '}
              {formatCurrency(manualGeneralCreditPlan.maxApplicableAmount, manualGeneralCreditPlan.currency)}
              {manualGeneralCreditPlan.personalPlan.affectedBillCount > 0 &&
                ` across ${manualGeneralCreditPlan.personalPlan.affectedBillCount} bill${
                  manualGeneralCreditPlan.personalPlan.affectedBillCount === 1 ? '' : 's'
                }`}
              {manualGeneralCreditPlan.eligibleGroups.length > 0 &&
                `${manualGeneralCreditPlan.personalPlan.affectedBillCount > 0 ? ' and ' : ' across '}${
                  manualGeneralCreditPlan.eligibleGroups.length
                } group${manualGeneralCreditPlan.eligibleGroups.length === 1 ? '' : 's'}`}
              .
            </p>
          )}
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
            {!billsLoading && personalBills.length > 0 && (
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
            {!sharedGroupsLoading && (sharedGroups?.length ?? 0) > 0 && (
              <span className="rounded-full bg-stone-200/80 px-1.5 text-[0.65rem] font-semibold text-stone-600">
                {sharedGroups?.length}
              </span>
            )}
          </button>
        </div>

        {billsScope === 'personal' && (
          <>
            {billsLoading ? (
              <div className="mt-3 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={`person-personal-skeleton-${i}`}
                    className="rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3"
                  >
                    <div className="h-4 w-40 animate-pulse rounded bg-stone-200" />
                    <div className="mt-2 h-3 w-24 animate-pulse rounded bg-stone-100" />
                  </div>
                ))}
              </div>
            ) : personalBills.length === 0 ? (
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
                      const globalNet = netByCurrency?.get(bill.currency) ?? 0
                      const autoOffset = net < 0 && globalNet >= 0
                      const direction = net > 0 ? 'Receive' : autoOffset ? 'Covered' : 'Pay'
                      const amountForDisplay = settled ? 0 : Math.abs(net)
                      const badgeClass = settled
                        ? 'bg-stone-200 text-stone-600'
                        : net > 0
                          ? 'bg-emerald-100 text-emerald-800'
                          : autoOffset
                            ? 'bg-stone-200 text-stone-600'
                            : 'bg-amber-100 text-amber-800'
                      return (
                    <Link
                      to={withBillBackQuery(`/app/bills/${bill.id}`, `/app/people/${personId}`)}
                      className="flex items-center justify-between rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3 transition-colors hover:bg-stone-100"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-stone-800">{bill.title}</p>
                        <p className="mt-0.5 flex items-center gap-2 text-xs text-stone-500">
                          <span>Personal · Paid by {bill.payorName}</span>
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
            {sharedGroupsLoading ? (
              <div className="mt-3 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={`person-groups-skeleton-${i}`}
                    className="rounded-xl border border-stone-200 bg-stone-100/60 px-4 py-3"
                  >
                    <div className="h-4 w-36 animate-pulse rounded bg-stone-200" />
                    <div className="mt-2 h-3 w-52 animate-pulse rounded bg-stone-100" />
                  </div>
                ))}
              </div>
            ) : !sharedGroups || sharedGroups.length === 0 ? (
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
                                {resolvedDisplayName} gets {formatCurrency(g.theirNet, g.currency)} in this
                                group
                              </span>
                            ) : (
                              <span className="font-medium text-amber-700">
                                {resolvedDisplayName} needs to pay{' '}
                                {formatCurrency(Math.abs(g.theirNet), g.currency)} in this group
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
                              {g.theirNet > 0 ? 'Gets' : 'Needs to pay'}
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
        {settlementsLoading ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-stone-500">
            <Loader2 className="size-4 animate-spin text-teal-800" />
            Loading payments…
          </div>
        ) : (!settlements || settlements.length === 0) ? (
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
          toName={resolvedDisplayName}
          partyPicker={settlementParties}
          markedBy={userId}
          showPaymentModeToggle
          paymentMode={paymentMode}
          onPaymentModeChange={setPaymentMode}
          helperLines={
            paymentMode === 'distributed'
              ? ['We split this payment to your oldest unpaid bills first.']
              : ['General payments reduce your total balance only.']
          }
          onSubmit={handleRecordPaymentSubmit}
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

      {showOptionsMenu && profile && (
        <PersonOptionsMenu
          onClose={() => setShowOptionsMenu(false)}
          onRemoveContact={openDeleteFromMenu}
        />
      )}

      {linkPeerOpen && isMyLocal && (
        <LinkPeerProfileSheet
          onClose={() => setLinkPeerOpen(false)}
          candidates={peerLinkCandidates}
          onPick={(peerId) => handlePickPeerProfile(peerId)}
        />
      )}

      <ConfirmDialog
        open={peerToLinkConfirm !== null}
        onOpenChange={(o) => {
          if (!o) setPeerToLinkConfirm(null)
        }}
        title="Link this profile?"
        description={`Activity involving ${peerToLinkConfirm?.displayName ?? 'them'} will show on this contact.`}
        confirmLabel="Link"
        onConfirm={() => handleConfirmPeerLink()}
      />

      <ConfirmDialog
        open={peerLinkToUnlink !== null}
        onOpenChange={(o) => {
          if (!o) setPeerLinkToUnlink(null)
        }}
        title="Unlink this profile?"
        description="They’ll no longer be treated as the same person as this contact. Balances and bills won’t be combined here until you link them again."
        confirmLabel="Unlink"
        variant="danger"
        onConfirm={() => handleConfirmUnlinkPeer()}
      />

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

      {applyCreditOpen && manualGeneralCreditPlan && (
        <ApplyGeneralCreditDialog
          open
          onOpenChange={setApplyCreditOpen}
          plan={manualGeneralCreditPlan}
          saving={applyingGeneralCredit}
          onSubmit={handleApplyGeneralCreditSubmit}
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
      {flowConfirmDialog}

      {exportOpen && userId && personId && (
        <ExportImageDialog
          filename={makeExportFilename('Person', 'png').replace('.png', '')}
          onExportPDF={() => generatePersonPDF(personId, userId)}
          onExportCSV={() => exportPersonToCSV(personId, userId)}
          onClose={() => setExportOpen(false)}
        >
          <PersonExportCard
            displayName={resolvedDisplayName}
            netByCurrency={netByCurrency ?? new Map()}
            unsettledPersonalBills={exportBillDetails ?? []}
            sharedGroups={(sharedGroups ?? []).map((g) => ({
              groupName: g.groupName,
              currency: g.currency,
              theirNet: g.theirNet,
            }))}
            payments={settlements ?? []}
          />
        </ExportImageDialog>
      )}
    </div>
  )
}
