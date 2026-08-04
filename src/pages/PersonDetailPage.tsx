import { useState, useMemo, useEffect, useCallback } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Banknote,
  Link2,
  Loader2,
  MoreVertical,
  Share2,
  Trash2,
  Unlink,
  Users,
} from 'lucide-react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db } from '@/db/db'
import {
  fetchRemoteProfileIntoDexie,
  findRemoteProfileIdForLinking,
  formatPairwiseSummary,
  resolveFallbackIdentityForViewer,
  resolveProfileDisplay,
} from '@/lib/people'
import { buildMoneyFlowRows } from '@/lib/money-flow'
import { loadBillExportItems } from '@/lib/export-splits'
import {
  fetchPersonSettlementHistory,
  fetchPersonStatement,
  fetchPersonSummary,
  totalsToMap,
} from '@/api/balances'
import { useServerData } from '@/hooks/useServerData'
import {
  addProfilePeerLink,
  deletePerson,
  linkProfileToRemote,
  removeProfilePeerLink,
} from '@/db/operations'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { SavedCopyNotice } from '@/components/common/SavedCopyNotice'
import { useCurrentUser } from '@/hooks/useCurrentUser'
import { cn, formatCurrency, MONEY_EPSILON } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import {
  RecordPaymentDialog,
  type PaymentContext,
} from '@/components/common/RecordPaymentDialog'
import { PersonStatement } from '@/components/common/PersonStatement'
import { BillDetailModal } from '@/components/common/BillDetailModal'
import { ExportImageDialog } from '@/components/export/ExportImageDialog'
import { PersonExportCard, type PersonBillEntry } from '@/components/export/PersonExportCard'
import { exportPersonToCSV } from '@/lib/export-csv'
import { generatePersonPDF } from '@/lib/export-pdf'
import { makeExportFilename } from '@/lib/export-utils'
import type { SettlementHistoryItem } from '@/api/balances'
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
  const [paymentOpen, setPaymentOpen] = useState(false)
  const [openBillId, setOpenBillId] = useState<string | null>(null)
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
  const [exportOpen, setExportOpen] = useState(false)

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

  // Personal net + net in every shared group, computed by the server (053/063). The counterparty
  // is resolved through the peer-link cluster there, so this hero agrees with the People list,
  // exports and bill status instead of dropping peer-linked-only groups.
  const loadSummary = useCallback(
    () =>
      userId && personId
        ? fetchPersonSummary(userId, personId)
        : Promise.reject(new Error('no user')),
    [userId, personId],
  )
  const personSummary = useServerData(
    userId && personId ? loadSummary : null,
    [userId, personId, loadSummary],
    personId ? `person:${personId}` : undefined,
  )

  // The events come from the server (migration 062); the running-balance walk stays local. The
  // last running number has to equal the hero above it — the SQL suite pins that invariant.
  const loadStatement = useCallback(
    () =>
      userId && personId
        ? fetchPersonStatement(userId, personId)
        : Promise.reject(new Error('no user')),
    [userId, personId],
  )
  const statementQuery = useServerData(
    userId && personId ? loadStatement : null,
    [userId, personId, loadStatement],
    personId ? `statement:${personId}` : undefined,
  )
  const statement = useMemo(
    () => (statementQuery.data ? buildMoneyFlowRows(statementQuery.data) : undefined),
    [statementQuery.data],
  )

  const breakdown = useMemo(() => {
    if (!personSummary.data) return null
    const { personal, groups, total } = personSummary.data
    const sources: { key: string; label: string; net: number; currency: string }[] = []
    for (const [currency, net] of Object.entries(personal)) {
      if (Math.abs(net) > MONEY_EPSILON) {
        sources.push({ key: `personal-${currency}`, label: 'Personal', net, currency })
      }
    }
    // Effectively-zero groups are already dropped server-side (kwenta_pairwise_breakdown).
    for (const g of groups) {
      sources.push({ key: `group-${g.groupId}`, label: g.groupName, net: g.net, currency: g.currency })
    }
    return { sources, overall: totalsToMap(total) }
  }, [personSummary.data])

  // Overall standing (personal + every shared group) as a plain signed sum. Single source of
  // truth for the headline, export card, and per-bill "covered" hint so they never disagree.
  const netByCurrency = useMemo(
    () => breakdown?.overall ?? new Map<string, number>(),
    [breakdown],
  )

  // Every payment between the two of you, across personal and each shared group (migration 064).
  // Deliberately per-row rather than bundled: a settle-up spanning several people is not one
  // payment *to this person*, and its total would credit them money that went elsewhere.
  const loadPayments = useCallback(
    () =>
      userId && personId
        ? fetchPersonSettlementHistory(userId, personId)
        : Promise.reject(new Error('no user')),
    [userId, personId],
  )
  const paymentsQuery = useServerData(
    userId && personId ? loadPayments : null,
    [userId, personId],
    personId ? `person-payments:${personId}` : undefined,
  )
  const settlements = useMemo(
    () =>
      paymentsQuery.loading && !paymentsQuery.data ? undefined : (paymentsQuery.data ?? []),
    [paymentsQuery.loading, paymentsQuery.data],
  )

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
    if (!breakdown) return null
    return formatPairwiseSummary(breakdown.overall)
  }, [breakdown])

  // The statement already carries every bill between these two with its signed effect on the
  // tab, so the personal-bill rows and their directions come from it rather than from a second
  // pass over the local mirror — which is also what stops the two disagreeing.
  const personalBills = useMemo(
    () =>
      (statementQuery.data ?? [])
        .filter((e) => e.type === 'personal_bill')
        .map((e) => ({ id: e.id, title: e.title, currency: e.currency, net: e.delta })),
    [statementQuery.data],
  )

  const personalBillDirection = useMemo(
    () => new Map(personalBills.map((b) => [b.id, b.net])),
    [personalBills],
  )

  const sharedGroups = useMemo(
    () => personSummary.data?.groups ?? [],
    [personSummary.data],
  )

  const exportBillDetails = useLiveQuery(async () => {
    if (!exportOpen || !userId || !personId) return [] as PersonBillEntry[]
    // A personal bill is "open" only when you're not square in its currency (tab-derived,
    // matching the hero). Untagged settle-ups clear the whole tab, not individual bills, so a
    // per-bill net never reflects a payment on its own — gate on the overall standing so a
    // settled person never exports bills as still outstanding (which contradicts the header).
    const unsettled = personalBills.filter((b) => {
      if (Math.abs(personalBillDirection?.get(b.id) ?? 0) <= 0.005) return false
      return Math.abs(netByCurrency.get(b.currency) ?? 0) > 0.005
    })
    // Two queries plus one name lookup per distinct person, rather than a full
    // getBillWithDetails fan-out per bill.
    const itemsByBill = await loadBillExportItems(
      unsettled.map((b) => b.id),
      userId,
    )
    const bills = await db.bills.bulkGet(unsettled.map((b) => b.id))
    return unsettled.flatMap((b, i) => {
      const row = bills[i]
      if (!row || row.is_deleted) return []
      return [
        {
          title: row.title,
          note: row.note ?? null,
          currency: row.currency,
          net: personalBillDirection?.get(b.id) ?? 0,
          items: itemsByBill.get(b.id) ?? [],
        },
      ]
    })
  }, [exportOpen, userId, personId, personalBills, personalBillDirection, netByCurrency])

  const defaultCurrency = useMemo(() => {
    // The MOST RECENT personal bill. `personalBills` comes from `kwenta_person_statement`, whose
    // events are ordered ASCENDING, while the query this replaced sorted descending — so `[0]`
    // silently became the oldest bill and prefilled the payment dialog with a currency the user
    // last used years ago. Every balance is currency-scoped, so a payment recorded under the
    // wrong one does not reduce the tab it was meant to settle.
    const pb = personalBills[personalBills.length - 1]
    if (pb) return pb.currency
    // Also the newest, for the same reason: statement events are ascending.
    const events = statementQuery.data ?? []
    const anyEventCurrency = events[events.length - 1]?.currency
    if (anyEventCurrency) return anyEventCurrency
    const settlementCurrency = settlements?.[0]?.currency
    if (settlementCurrency) return settlementCurrency
    return sharedGroups[0]?.currency ?? 'PHP'
  }, [personalBills, statementQuery.data, settlements, sharedGroups])

  const meName = meProfile?.display_name?.trim() || 'You'

  // Personal + each shared group (for the chosen currency) as payment "apply to" buckets.
  const paymentContexts = useMemo<PaymentContext[]>(() => {
    if (!breakdown) return []
    return breakdown.sources
      .filter((s) => s.currency === defaultCurrency)
      .map((s) => ({
        key: s.key.startsWith('group-') ? s.key.slice('group-'.length) : 'personal',
        label: s.label,
        net: s.net,
      }))
  }, [breakdown, defaultCurrency])

  // Any settlement leg id → its (possibly bundled) history item, so statement rows can edit.
  const settlementByLegId = useMemo(() => {
    const map = new Map<string, SettlementHistoryItem>()
    for (const item of settlements ?? []) for (const id of item.settlementIds) map.set(id, item)
    return map
  }, [settlements])
  const editableSettlementIds = useMemo(() => new Set(settlementByLegId.keys()), [settlementByLegId])

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
    try {
      await linkProfileToRemote(personId, remoteId, userId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not link this contact right now.')
      return
    }
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
    try {
      await deletePerson(personId, userId)
      navigate('/app/people', { replace: true })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove this contact right now.')
    }
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
        {personSummary.error && !personSummary.data && (
          // A missing hero must not read as "settled". Say the number is unavailable and offer a
          // retry rather than leaving the space blank, which looks like a zero balance.
          <div
            role="alert"
            className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950"
          >
            <p className="font-medium">Balance unavailable</p>
            <p className="mt-0.5 text-xs text-amber-900/80">{personSummary.error}</p>
            <Button
              size="xs"
              variant="ghost"
              className="mt-2 rounded-full text-amber-900"
              onClick={personSummary.refresh}
            >
              Try again
            </Button>
          </div>
        )}
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
        {breakdown && breakdown.sources.length > 0 && (
          <div className="mt-4 rounded-2xl border border-stone-200 bg-stone-50/60 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-stone-400">Right now</p>
            <ul className="mt-2 space-y-1.5">
              {breakdown.sources.map((s) => (
                <li key={s.key} className="flex items-center justify-between text-sm">
                  <span className="text-stone-600">{s.label}</span>
                  <span
                    className={cn(
                      'font-medium tabular-nums',
                      s.net > 0 ? 'text-emerald-600' : 'text-amber-600',
                    )}
                  >
                    {s.net > 0 ? 'owes you ' : 'you owe '}
                    {formatCurrency(Math.abs(s.net), s.currency)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <p className="mt-2 text-xs text-stone-500">
          Totals include bills where one of you paid or the other paid (not when a third person paid for
          both). All recorded payments with this person are included.
        </p>
        {personSummary.fromCache && personSummary.data && (
          <SavedCopyNotice fetchedAt={personSummary.fetchedAt} className="mt-1" />
        )}

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

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="rounded-full"
            type="button"
            onClick={() => setPaymentOpen(true)}
          >
            Record a payment
          </Button>
        </div>
      </div>

      <div className="rounded-3xl border border-stone-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-2">
          <Banknote className="size-4 text-teal-800" />
          <h2 className="text-lg font-semibold">Statement</h2>
        </div>
        <p className="mt-1 text-xs text-stone-500">
          Every bill and payment between you, in order, with a running balance.
        </p>
        {statementQuery.error && !statementQuery.data && (
          // An empty statement reads as "nothing has happened between you"; a failed request is
          // not that, and the running balance below the hero would be missing without saying why.
          <div
            role="alert"
            className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950"
          >
            <p className="font-medium">Statement unavailable</p>
            <p className="mt-0.5 text-xs text-amber-900/80">{statementQuery.error}</p>
            <Button
              size="xs"
              variant="ghost"
              className="mt-2 rounded-full text-amber-900"
              onClick={statementQuery.refresh}
            >
              Try again
            </Button>
          </div>
        )}
        <PersonStatement
          result={statement}
          editableSettlementIds={editableSettlementIds}
          onEditPayment={(id) => {
            const item = settlementByLegId.get(id)
            if (item) setEditing(item)
          }}
          onOpenBill={(id) => setOpenBillId(id)}
        />
      </div>

      {paymentOpen && userId && personId && (
        <RecordPaymentDialog
          open
          onOpenChange={(o) => {
            if (!o) setPaymentOpen(false)
          }}
          meId={userId}
          otherId={personId}
          meName={meName}
          otherName={resolvedDisplayName}
          currency={defaultCurrency}
          markedBy={userId}
          contexts={paymentContexts}
          onRecorded={() => setPaymentOpen(false)}
        />
      )}

      {openBillId && userId && (
        <BillDetailModal
          billId={openBillId}
          currentUserId={userId}
          onClose={() => setOpenBillId(null)}
          onUpdated={() => {}}
          onEdit={(id) => {
            setOpenBillId(null)
            navigate(`/app/bills/${id}`)
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

      <ConfirmDialog
        open={deleteConfirmOpen}
        onOpenChange={setDeleteConfirmOpen}
        title="Delete this person?"
        description="All payments with them will be removed. They will be removed from every group. Personal bills that only involved you and them will be deleted. Personal bills that also include other people will stay: their share is removed and equal splits are redistributed among whoever remains. This cannot be undone here."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDeletePerson}
      />

      {exportOpen && userId && personId && (
        <ExportImageDialog
          filename={makeExportFilename('Person', 'png').replace('.png', '')}
          // Gated on the statement having actually loaded. `?? []` produced a file with an empty
          // Bills and Payments section whenever the fetch had failed — which reads as "you have
          // never shared an expense with this person" and understates the tab to zero.
          onExportPDF={
            statementQuery.data
              ? () => generatePersonPDF(personId, statementQuery.data!, settlements ?? [])
              : undefined
          }
          onExportCSV={
            statementQuery.data
              ? () => exportPersonToCSV(personId, userId, statementQuery.data!, settlements ?? [])
              : undefined
          }
          onClose={() => setExportOpen(false)}
        >
          <PersonExportCard
            displayName={resolvedDisplayName}
            netByCurrency={netByCurrency ?? new Map()}
            unsettledPersonalBills={exportBillDetails ?? []}
            sharedGroups={sharedGroups.map((g) => ({
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
