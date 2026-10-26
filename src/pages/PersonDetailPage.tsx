import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
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
  loadProfilesIntoMirror,
  resolveFallbackIdentityForViewer,
  resolveProfileDisplay,
} from '@/lib/people'
import { buildMoneyFlowRows } from '@/lib/money-flow'
import { loadBillExportItems } from '@/lib/export-splits'
import {
  ApiError,
  fetchPersonPaymentItems,
  fetchPersonSettlementHistory,
  fetchPersonStatement,
  fetchPersonStatementPage,
  fetchPersonStatementPageMore,
  fetchPersonSummary,
  MAX_STATEMENT_PAGE_EVENTS,
  totalsToMap,
  type StatementCursor,
  type StatementEvent,
  type StatementPageEvent,
} from '@/api/balances'
import { useServerData } from '@/hooks/useServerData'
import { relevantDataVersion, useAppStore } from '@/store/app-store'
import { useKeysetMore } from '@/hooks/useKeysetMore'
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
import { DetailPageSkeleton, Skeleton } from '@/components/ui/skeleton'
import { EditSettlementDialog } from '@/components/common/EditSettlementDialog'
import {
  RecordPaymentDialog,
  type PaymentContext,
} from '@/components/common/RecordPaymentDialog'
import { PersonStatement, type StatementFilter } from '@/components/common/PersonStatement'
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

const STATEMENT_PAGE_SIZE = 20

const statementCursor = (e: StatementPageEvent): StatementCursor => ({ createdAt: e.createdAt, id: e.id })

const FULL_STATEMENT_FAILED = "Couldn't load the full statement. Check your connection and try again."
const FULL_STATEMENT_STALE = "Couldn't load every bill. Check your connection and try again."
const FULL_PAYMENTS_STALE = "Couldn't load every payment. Check your connection and try again."

// Losing access must not read as a connection problem, so a refusal keeps its own wording.
const fullStatementMessage = (error: unknown) =>
  error instanceof Error &&
  (error.message === FULL_STATEMENT_STALE ||
    error.message === FULL_PAYMENTS_STALE ||
    error.message.startsWith('You no longer have access'))
    ? error.message
    : FULL_STATEMENT_FAILED

type FullExportData = { events: StatementEvent[]; payments: SettlementHistoryItem[] }

/**
 * Every event of the statement and every payment between the two, fetched on tap: the page holds
 * one screenful of each. Only the events and payment items are taken from these answers; money on
 * screen and in a file always comes from the screen's own payloads. A saved copy of either full
 * list is refused while the screen shows fresh data, since it would disagree with the balances
 * beside it; when the screen itself is a saved copy, the saved lists match it.
 */
async function loadFullExport(userId: string, personId: string, screenIsCopy: boolean): Promise<FullExportData> {
  const [statement, history] = await Promise.all([
    fetchPersonStatement(userId, personId),
    fetchPersonSettlementHistory(userId, personId),
  ])
  if (statement.fromCache && !screenIsCopy) throw new Error(FULL_STATEMENT_STALE)
  if (history.fromCache && !screenIsCopy) throw new Error(FULL_PAYMENTS_STALE)
  return { events: statement.data, payments: history.data }
}

type ExportStatement =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | ({ status: 'ready' } & FullExportData)

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
  // The share card and the PDF/CSV list every bill, but the page holds one screenful: opening the
  // dialog asks for the full statement once and the personal-bill list is built only from that.
  const [exportStatement, setExportStatement] = useState<ExportStatement>({ status: 'loading' })
  const [exportRetry, setExportRetry] = useState(0)
  const exportFetch = useRef<Promise<FullExportData> | null>(null)
  const screenIsCopy = useRef(false)
  const [statementFilter, setStatementFilter] = useState<StatementFilter>('all')
  // This component is reused when a search or a notification opens another person in place;
  // nothing chosen for one person (a filter, an open export) carries over to the next. Reset
  // during render, so the new person's first render never asks for the old filter's page.
  const [shownPersonId, setShownPersonId] = useState(personId)
  if (shownPersonId !== personId) {
    setShownPersonId(personId)
    setStatementFilter('all')
    setExportOpen(false)
  }

  const profile = useLiveQuery(
    async (): Promise<Profile | null | undefined> => {
      if (!personId) return null
      const p = await db.profiles.get(personId)
      return p && !p.is_deleted ? p : null
    },
    [personId],
  )

  // The server's answer for a person this device does not hold. It runs here, not in a live
  // query: the fetch writes the profile into Dexie, which a live query's read-only transaction
  // refuses (the page stayed blank when the server returned the profile).
  const [lookup, setLookup] = useState<{ personId: string; outcome: 'present' | 'not_found' | 'unreachable' } | null>(null)
  const [lookupAttempt, setLookupAttempt] = useState(0)
  useEffect(() => {
    if (!personId) return
    let cancelled = false
    void (async () => {
      // A contact deleted on this device stays deleted: asking the server would put its live copy
      // back over a delete that may still be queued.
      const held = await db.profiles.get(personId)
      let outcome: 'present' | 'not_found' | 'unreachable' = held?.is_deleted
        ? 'not_found'
        : await fetchRemoteProfileIntoDexie(personId)
      if (outcome === 'present') {
        const stored = await db.profiles.get(personId)
        if (!stored || stored.is_deleted) outcome = 'not_found'
      }
      if (!cancelled) setLookup({ personId, outcome })
    })().catch(() => {
      if (!cancelled) setLookup({ personId, outcome: 'unreachable' })
    })
    return () => {
      cancelled = true
    }
  }, [personId, lookupAttempt])
  const lookupOutcome = lookup && lookup.personId === personId ? lookup.outcome : null

  // A profile that went away after the lookup said it was here (a realtime delete, or deleting
  // this person) would otherwise leave the spinner up for good.
  useEffect(() => {
    if (!personId || profile !== null || lookupOutcome !== 'present') return
    let cancelled = false
    void db.profiles
      .get(personId)
      .then((p) => {
        if (!cancelled && (!p || p.is_deleted)) setLookup({ personId, outcome: 'not_found' })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [personId, profile, lookupOutcome])

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

  // The newest events come from the server (migration 062), each with the running balance the
  // server computed over the whole history (086): the page holds a window, so it cannot walk the
  // list. The newest number has to equal the hero above it — the SQL suite pins that invariant.
  const loadStatement = useCallback(
    () =>
      userId && personId
        ? fetchPersonStatementPage(userId, personId, { limit: STATEMENT_PAGE_SIZE })
        : Promise.reject(new Error('no user')),
    [userId, personId],
  )
  const statementQuery = useServerData(
    userId && personId ? loadStatement : null,
    [userId, personId, loadStatement],
    personId ? `statement-page:${personId}` : undefined,
  )
  screenIsCopy.current = statementQuery.fromCache && !statementQuery.revalidating

  // Payments only is asked of the server: the bills between two payments still count towards each
  // payment's balance, which a slice of the loaded rows could not know.
  const paymentsOnly = statementFilter === 'payments'
  const loadPaymentsStatement = useCallback(
    () =>
      userId && personId
        ? fetchPersonStatementPageMore(userId, personId, { limit: STATEMENT_PAGE_SIZE, kind: 'payments' })
        : Promise.reject(new Error('no user')),
    [userId, personId],
  )
  const paymentsStatementQuery = useServerData(
    userId && personId && paymentsOnly ? loadPaymentsStatement : null,
    [userId, personId, paymentsOnly],
    personId && paymentsOnly ? `statement-page:${personId}:payments` : undefined,
  )
  const shownStatement = paymentsOnly ? paymentsStatementQuery : statementQuery
  const statementFirstPage = useMemo(
    () => (shownStatement.data ? { rows: shownStatement.data.events, matching: shownStatement.data.matching } : undefined),
    [shownStatement.data],
  )
  const statementKeyset = useKeysetMore({
    userId,
    listKey: `${personId ?? ''}:${statementFilter}`,
    page: statementFirstPage,
    pageFromCache: shownStatement.fromCache,
    pageSize: STATEMENT_PAGE_SIZE,
    maxPerCall: MAX_STATEMENT_PAGE_EVENTS,
    cursorOf: statementCursor,
    fetchAfter: async (before, limit) => {
      const { data } = await fetchPersonStatementPageMore(userId!, personId!, { limit, kind: statementFilter, before })
      return { rows: data.events, matching: data.matching }
    },
    errorMessage: 'Could not load older activity.',
  })
  const statement = useMemo(
    () => (statementFirstPage ? buildMoneyFlowRows(statementKeyset.rows) : undefined),
    [statementFirstPage, statementKeyset.rows],
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

  // The payments behind the statement rows loaded so far (edit, note, method), asked for in ONE
  // call over the whole loaded set, whatever the number of pages. It runs once the statement
  // answer has settled (first page, any reload of the rows held past it, any Show older), so a
  // write costs one lookup instead of one per intermediate leg set; a new bill's write skips the
  // `person-payment-items` bump and costs none. Rows are replaced only when the answer lands, so
  // Show older never blanks the edit buttons already on screen, and a failed lookup keeps them.
  // The lookup is saved per person (see `fetchPersonPaymentItems`), so offline rows stay editable.
  const paymentLegKey = useMemo(
    () =>
      statementKeyset.rows
        .filter((e) => e.type === 'payment')
        .map((e) => e.id)
        .sort()
        .join(','),
    [statementKeyset.rows],
  )
  const paymentItemsVersion = useAppStore((s) =>
    relevantDataVersion(s, personId ? `person-payment-items:${personId}` : undefined),
  )
  const statementSettled = !shownStatement.loading && !statementKeyset.reloading && !statementKeyset.loadingMore
  // The gate opens for a statement ANSWER (the first page's object identity), not on a loading
  // edge: a primed answer after an online write lands in the same render that would show
  // `loading`, so no edge is ever seen. It is opened from an effect and bound to that answer, which
  // keeps the lookup out of two gaps: the render where a new first page sits beside the rows still
  // held past the old one (the hook flags its reload one render later), and the render where the
  // version bump has arrived but the statement has not been refetched. The version is read when
  // the gate opens, so the lookup is keyed on the write that produced this answer.
  const paymentItemsVersionNow = useRef(paymentItemsVersion)
  paymentItemsVersionNow.current = paymentItemsVersion
  const [lookupGate, setLookupGate] = useState<{ open: boolean; answer: unknown; version: number }>({
    open: false,
    answer: undefined,
    version: paymentItemsVersion,
  })
  useEffect(
    () => setLookupGate({ open: statementSettled, answer: shownStatement.data, version: paymentItemsVersionNow.current }),
    [statementSettled, shownStatement.data],
  )
  const lookupReady = statementSettled && lookupGate.open && lookupGate.answer === shownStatement.data
  const [paymentItems, setPaymentItems] = useState<{ personId: string; items: SettlementHistoryItem[] } | null>(null)
  const askedLookup = useRef<string | null>(null)
  useEffect(() => {
    if (!userId || !personId || paymentLegKey === '' || !lookupReady) return
    const asked = `${userId}|${personId}|${paymentLegKey}|${lookupGate.version}`
    if (askedLookup.current === asked) return
    askedLookup.current = asked
    let cancelled = false
    let answered = false
    fetchPersonPaymentItems(userId, personId, paymentLegKey.split(',')).then(
      ({ data }) => {
        answered = true
        if (!cancelled) setPaymentItems({ personId, items: data })
      },
      (error: unknown) => {
        answered = true
        if (cancelled) return
        askedLookup.current = null
        if (error instanceof ApiError && error.message.startsWith('You no longer have access')) setPaymentItems(null)
      },
    )
    return () => {
      cancelled = true
      if (!answered && askedLookup.current === asked) askedLookup.current = null
    }
  }, [userId, personId, paymentLegKey, lookupGate.version, lookupReady])

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

  // A merged peer's profile may not be on this device; the label reads the mirror only.
  const peerIdsKey = (peerLinksForAnchor ?? [])
    .map((l) => l.peer_profile_id)
    .sort()
    .join(',')
  useEffect(() => {
    if (!peerIdsKey) return
    void loadProfilesIntoMirror(peerIdsKey.split(',')).catch(() => {})
  }, [peerIdsKey])

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

  // The full statement carries every bill between these two with its signed effect on the tab,
  // so the personal-bill rows and their directions come from it rather than from a second pass
  // over the local mirror — which is also what stops the two disagreeing.
  const exportEvents = exportStatement.status === 'ready' ? exportStatement.events : null
  const personalBills = useMemo(
    () =>
      (exportEvents ?? [])
        .filter((e) => e.type === 'personal_bill')
        .map((e) => ({ id: e.id, title: e.title, currency: e.currency, net: e.delta })),
    [exportEvents],
  )

  const personalBillDirection = useMemo(
    () => new Map(personalBills.map((b) => [b.id, b.net])),
    [personalBills],
  )

  const sharedGroups = useMemo(
    () => personSummary.data?.groups ?? [],
    [personSummary.data],
  )

  // Tagged with the bill list it was built from, so the card never shows an answer built from an
  // earlier list (or none) as if it were this one.
  const exportBillDetails = useLiveQuery(async () => {
    const source = personalBills
    if (!exportOpen || !userId || !personId) return { source, entries: [] as PersonBillEntry[] }
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
    const entries = unsettled.flatMap((b, i) => {
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
    return { source, entries }
  }, [exportOpen, userId, personId, personalBills, personalBillDirection, netByCurrency])
  const exportCardBills =
    exportStatement.status === 'ready' && exportBillDetails?.source === personalBills ? exportBillDetails.entries : null

  const defaultCurrency = useMemo(() => {
    // The MOST RECENT personal bill, over the whole history: the server answers it
    // (`latestPersonalCurrency`) because the loaded page may not reach it. Every balance is
    // currency-scoped, so a payment recorded under the wrong currency does not reduce the tab it
    // was meant to settle.
    const page = statementQuery.data
    if (page?.latestPersonalCurrency) return page.latestPersonalCurrency
    // No personal bill at all: the newest event's currency (a page is newest first).
    const anyEventCurrency = page?.events[0]?.currency
    if (anyEventCurrency) return anyEventCurrency
    return sharedGroups[0]?.currency ?? 'PHP'
  }, [statementQuery.data, sharedGroups])

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
    if (paymentItems && paymentItems.personId === personId) {
      for (const item of paymentItems.items) for (const id of item.settlementIds) map.set(id, item)
    }
    return map
  }, [paymentItems, personId])

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

  // An export taps the list the open dialog already asked for (or is still asking for), so one
  // open costs one request; the money in a file is the screen's own, with only the events replaced.
  async function fullExportData(): Promise<FullExportData> {
    if (!userId || !personId) throw new Error('no person')
    if (exportStatement.status === 'ready') return exportStatement
    if (exportStatement.status === 'loading' && exportFetch.current) return exportFetch.current
    return loadFullExport(userId, personId, screenIsCopy.current)
  }

  function openExport() {
    setExportStatement({ status: 'loading' })
    setExportOpen(true)
  }

  useEffect(() => {
    if (!exportOpen || !userId || !personId) return
    let cancelled = false
    const request = loadFullExport(userId, personId, screenIsCopy.current)
    exportFetch.current = request
    request.then(
      ({ events, payments }) => {
        if (!cancelled) setExportStatement({ status: 'ready', events, payments })
      },
      (error: unknown) => {
        if (!cancelled) setExportStatement({ status: 'failed', message: fullStatementMessage(error) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [exportOpen, exportRetry, userId, personId])

  if (!userId || !personId) {
    return <DetailPageSkeleton label="Loading person" />
  }

  if (personId === userId) {
    return null
  }

  if (profile === undefined) {
    return <DetailPageSkeleton label="Loading person" />
  }

  if (profile === null && (fallbackIdentity === undefined || lookupOutcome === null || lookupOutcome === 'present')) {
    return <DetailPageSkeleton label="Loading person" />
  }

  if (profile === null && !fallbackIdentity) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="rounded-full gap-1">
          <Link to="/app/people">
            <ArrowLeft className="size-4" />
            People
          </Link>
        </Button>
        {lookupOutcome === 'unreachable' ? (
          <div className="space-y-3 text-center">
            <p className="text-sm text-stone-500">
              Couldn't load this person. Check your connection and try again.
            </p>
            <Button type="button" variant="outline" className="min-h-11 rounded-lg px-5" onClick={() => setLookupAttempt((n) => n + 1)}>
              Retry
            </Button>
          </div>
        ) : (
          <p className="text-center text-sm text-stone-500">Person not found</p>
        )}
      </div>
    )
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
      const { mode } = await linkProfileToRemote(personId, remoteId, userId)
      setLinkAccountOpen(false)
      if (mode === 'queued') {
        // Until this reaches the server the contact and the account are two different people to
        // it, so /app/people shows both. Say that, rather than let it look finished.
        toast.info('Linked on this device. It will apply everywhere once you are back online.')
      } else {
        toast.success('Contact linked to their Kwenta account.')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not link this contact right now.')
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
      const { mode } = await linkProfileToRemote(personId, remoteId, userId)
      setLinkByIdInput('')
      setLinkAccountOpen(false)
      if (mode === 'queued') {
        toast.info('Linked on this device. It will apply everywhere once you are back online.')
      } else {
        toast.success('Contact linked to their Kwenta account.')
      }
    } catch (error) {
      // Previously this had no catch: `linkProfileToRemote` returned silently on every invalid
      // case, so there was nothing to catch and nothing to show. Now it says which guard failed.
      setLinkByIdError(
        error instanceof Error ? error.message : 'Could not link this contact right now.',
      )
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
            onClick={openExport}
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
        {!personSummary.data && !personSummary.error && (
          <div role="status" aria-label="Loading balance">
            <Skeleton className="mt-3 h-6 w-40" />
            <Skeleton className="mt-4 h-20 w-full rounded-2xl bg-stone-100" />
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
        {personSummary.fromCache && !personSummary.revalidating && personSummary.data && (
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
        {shownStatement.error && !shownStatement.data && (
          // An empty statement reads as "nothing has happened between you"; a failed request is
          // not that, and the running balance below the hero would be missing without saying why.
          <div
            role="alert"
            className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-950"
          >
            <p className="font-medium">Statement unavailable</p>
            <p className="mt-0.5 text-xs text-amber-900/80">{shownStatement.error}</p>
            <Button
              size="xs"
              variant="ghost"
              className="mt-2 rounded-full text-amber-900"
              onClick={shownStatement.refresh}
            >
              Try again
            </Button>
          </div>
        )}
        <PersonStatement
          result={statement}
          failed={Boolean(shownStatement.error) && !shownStatement.data}
          filter={statementFilter}
          onFilterChange={setStatementFilter}
          hasOlder={statementKeyset.remaining > 0}
          loadingOlder={statementKeyset.loadingMore || statementKeyset.reloading}
          onShowOlder={statementKeyset.showMore}
          paymentsByLegId={settlementByLegId}
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
              ? async () => {
                  const { events, payments } = await fullExportData()
                  return generatePersonPDF(personId, events, payments)
                }
              : undefined
          }
          onExportCSV={
            statementQuery.data
              ? async () => {
                  const { events, payments } = await fullExportData()
                  return exportPersonToCSV(personId, userId, events, payments)
                }
              : undefined
          }
          imageDisabled={exportCardBills === null}
          onClose={() => setExportOpen(false)}
        >
          {exportCardBills && exportStatement.status === 'ready' ? (
            <PersonExportCard
              displayName={resolvedDisplayName}
              netByCurrency={netByCurrency ?? new Map()}
              unsettledPersonalBills={exportCardBills}
              sharedGroups={sharedGroups.map((g) => ({
                groupName: g.groupName,
                currency: g.currency,
                theirNet: g.theirNet,
              }))}
              payments={exportStatement.payments}
            />
          ) : exportStatement.status === 'failed' ? (
            <div role="alert" className="space-y-3 rounded-2xl bg-white p-5 text-center text-sm text-stone-600">
              <p>{exportStatement.message}</p>
              <Button
                size="sm"
                variant="outline"
                className="rounded-full"
                onClick={() => {
                  setExportStatement({ status: 'loading' })
                  setExportRetry((n) => n + 1)
                }}
              >
                Try again
              </Button>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-stone-500">
              <Loader2 className="size-4 animate-spin" />
              Loading every bill…
            </div>
          )}
        </ExportImageDialog>
      )}
    </div>
  )
}
