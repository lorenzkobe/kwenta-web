import { supabase } from '@/lib/supabase'
import { now } from '@/lib/utils'
import { refreshOnlineStatus } from '@/lib/online-status'
import { toCurrencyCode } from '@/lib/currency-conversion'
import { readCache, writeCache } from '@/api/cache'
import { currentSessionEpoch } from '@/sync/session-epoch'
import { consumePrimedRead, rememberReadSpec, rpcArgs, type ReadSpec } from '@/api/primed-reads'
import type { SettlementMovementLeg } from '@/lib/settlement'

/**
 * Server-computed balance reads.
 *
 * These replace the client-side money math that had to scan the whole dataset. A balance arrives
 * as a number rather than as every bill that produced it, which is what allows Dexie to stop
 * holding everything (CLAUDE.md rules 7 and 8).
 */

export type CurrencyTotals = Record<string, number>

export type ContactBalanceRow = {
  peerId: string
  displayName: string
  /** "Linked · <account>" / "Local contact", or undefined when there is nothing to add. */
  subtitle?: string
  /** Combined net per currency: `+` they owe you, `-` you owe them. */
  net: CurrencyTotals
}

export type BalancesOverview = {
  personalReceive: CurrencyTotals
  personalPay: CurrencyTotals
  combinedReceive: CurrencyTotals
  combinedPay: CurrencyTotals
  /**
   * Bucketed per group, NOT `combined - personal`: the combined bucket nets a person's personal
   * and group standings before choosing a side, so the difference is not a quantity anyone was
   * shown. See the migration 058 header.
   */
  groupReceive: CurrencyTotals
  groupPay: CurrencyTotals
}

export type RecentBill = {
  id: string
  title: string
  amount: number
  currency: string
  createdAt: string
  groupName?: string
  /** Paid-in currency and amount of a converted bill; null when entered in `currency`. */
  originalCurrency: string | null
  originalTotal: number | null
}

/** Conversion keys are absent from a server older than 079, which must read as unconverted. */
function nullableNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** One unreadable currency code makes the whole bill read as unconverted, never a crash in a screen. */
function toConversionFields(row: Record<string, unknown>) {
  const originalCurrency = toCurrencyCode(row.originalCurrency)
  return {
    originalCurrency,
    originalTotal: originalCurrency ? nullableNumber(row.originalTotal) : null,
    exchangeRate: originalCurrency ? nullableNumber(row.exchangeRate) : null,
  }
}

function toRateSource(v: unknown): 'online' | 'manual' | null {
  return v === 'online' || v === 'manual' ? v : null
}

export type PersonSummary = {
  personal: CurrencyTotals
  groups: {
    groupId: string
    groupName: string
    currency: string
    /** Pairwise net between the viewer and this person in this group. */
    net: number
    /** That person's net against the group POOL — a different quantity; see migration 063. */
    theirNet: number
  }[]
  total: CurrencyTotals
}

export class ApiError extends Error {
  /** Parameter properties are not allowed under `erasableSyntaxOnly`; assign explicitly. */
  readonly reason: unknown

  constructor(message: string, reason?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.reason = reason
  }
}

/**
 * The server DECLINED to answer, as opposed to answering "nothing".
 *
 * `kwenta_group_member_breakdown` RETURNs NULL when the caller is not an active member of the
 * group, or cannot see it at all (migration 064). Resolving that NULL to a value makes every
 * consumer read a refusal as a fact about money: the member dialog rendered "is all settled up in
 * this group", the payment dialog rendered a loaded form claiming the payer owed nobody, and
 * `removeGroupMember` skipped the guard that blocks removing a member who still owes. A refusal
 * is a failure, so it throws.
 */
export class ServerDeclinedError extends ApiError {
  constructor(message: string, reason?: unknown) {
    super(message, reason)
    this.name = 'ServerDeclinedError'
  }
}

const GROUP_MEMBERSHIP_DECLINED =
  'Kwenta could not confirm the balances in this group. You may no longer be a member of it.'

/**
 * A human name per endpoint family.
 *
 * The cache key is an internal identifier (`person:<uuid>`, `group-breakdown:<uuid>:<uuid>`) and
 * these messages are rendered verbatim inside user-facing alerts, so interpolating the key showed
 * people raw UUIDs as an explanation.
 */
const ENDPOINT_LABELS: Record<string, string> = {
  contacts: 'your contacts',
  overview: 'your balances',
  'statement-page': 'this statement',
  'statement-full': 'this statement',
  group: 'this group',
  'group-full': 'this group',
  'group-bills': "this group's bills",
  'group-payments': "this group's payments",
  'group-breakdown': "this member's balances",
  'group-spending': "this group's spending",
  groups: 'your groups',
  bill: 'this bill',
  'bill-payments': "this bill's payments",
  bills: 'your bills',
  'personal-bills': 'your bills',
  'personal-bills-page': 'your bills',
  'recent-bills': 'your recent bills',
  person: 'this person',
  'person-payments': "this person's payments",
}

function describeEndpoint(endpoint: string): string {
  return ENDPOINT_LABELS[endpoint.split(':')[0]] ?? 'this screen'
}

/**
 * True for "you are not allowed to have this", as distinct from "the network failed".
 *
 * The cache exists so a screen still renders when the network is unavailable. Serving it after an
 * authorization failure means a user who was removed from a group, or whose session ended, keeps
 * reading balances and counterparty names they are no longer entitled to — behind a "saved copy"
 * note that reads as a staleness hint, not as a loss of access.
 */
function isAccessError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { code?: unknown; status?: unknown; message?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const status = typeof e.status === 'number' ? e.status : 0
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  if (status === 401 || status === 403) return true
  // 42501 = insufficient_privilege; PGRST301/302 = missing or expired JWT.
  if (code === '42501' || code === 'PGRST301' || code === 'PGRST302') return true
  return (
    message.includes('jwt') ||
    message.includes('not authenticated') ||
    message.includes('permission denied')
  )
}

/** Postgres `numeric` arrives as a string over PostgREST; coerce without trusting the shape. */
function toTotals(value: unknown): CurrencyTotals {
  const out: CurrencyTotals = {}
  if (!value || typeof value !== 'object') return out
  for (const [currency, raw] of Object.entries(value as Record<string, unknown>)) {
    // `Number(null)` and `Number('')` are both 0 and both finite, so a null total would arrive as
    // a genuine zero balance. Reject the non-numeric shapes before coercing.
    if (raw === null || raw === undefined) continue
    if (typeof raw !== 'number' && typeof raw !== 'string') continue
    if (typeof raw === 'string' && raw.trim() === '') continue
    const n = Number(raw)
    if (Number.isFinite(n)) out[currency] = n
  }
  return out
}

/**
 * Call a read endpoint, caching the result for offline use.
 *
 * Offline (or on failure) it falls back to the last good copy and flags it, so a screen can say
 * "showing saved data" instead of rendering an empty state that looks like "you have nothing".
 *
 * The RPC and the mapper are separate arguments rather than one closure so that a payload arriving
 * by another route — `kwenta_write` returning this endpoint already recomputed — runs through the
 * SAME mapper. Those mappers encode real rules (`numeric` as a string, a null total that must be
 * dropped rather than read as zero); a second copy for the priming path would drift from this one.
 */
async function fetchEndpoint<T>(
  endpoint: string,
  userId: string,
  spec: Omit<ReadSpec, 'key'>,
  map: (raw: unknown) => T,
): Promise<{ data: T; fromCache: boolean; fetchedAt: string }> {
  rememberReadSpec({ ...spec, key: endpoint })
  const epoch = currentSessionEpoch()

  // A write that carried this endpoint already asked the server for it, after applying the
  // mutation and in the same transaction. Serving that is not a cache hit — it is a server answer
  // that is strictly newer than anything a fetch started now could return.
  const primedHit = consumePrimedRead(endpoint)
  if (primedHit) {
    try {
      const data = map(primedHit.raw)
      const at = now()
      writeCache(endpoint, userId, data, at, epoch)
      return { data, fromCache: false, fetchedAt: at }
    } catch {
      // An unexpected shape must not break the screen; fall through and fetch it properly.
    }
  }

  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  if (!offline) {
    try {
      const { data: raw, error } = await supabase.rpc(spec.fn, rpcArgs(spec))
      if (error) throw error
      const data = map(raw)
      const at = now()
      writeCache(endpoint, userId, data, at, epoch)
      refreshOnlineStatus()
      return { data, fromCache: false, fetchedAt: at }
    } catch (err) {
      // A refusal is the server's ANSWER, not a transport failure; falling back to a cached copy
      // would answer a question the server just declined to answer.
      if (err instanceof ServerDeclinedError) throw err
      if (isAccessError(err)) {
        throw new ApiError(`You no longer have access to ${describeEndpoint(endpoint)}.`, err)
      }
      const cached = readCache<T>(endpoint, userId)
      if (cached) return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt }
      throw new ApiError(`Could not load ${describeEndpoint(endpoint)}.`, err)
    }
  }
  const cached = readCache<T>(endpoint, userId)
  if (cached) return { data: cached.data, fromCache: true, fetchedAt: cached.fetchedAt }
  throw new ApiError(`You're offline and ${describeEndpoint(endpoint)} has not been loaded yet.`)
}

export async function fetchContactsWithBalances(userId: string) {
  return fetchEndpoint<ContactBalanceRow[]>(
    'contacts',
    userId,
    { fn: 'kwenta_contacts_with_balances' },
    (data) => {
      if (!Array.isArray(data)) throw new Error('unexpected response shape')
      return (data as Record<string, unknown>[]).map((row) => ({
        peerId: String(row.peerId ?? ''),
        displayName: String(row.displayName ?? 'Unknown'),
        subtitle: typeof row.subtitle === 'string' && row.subtitle ? row.subtitle : undefined,
        net: toTotals(row.net),
      }))
    },
  )
}

export async function fetchBalancesOverview(userId: string) {
  return fetchEndpoint<BalancesOverview>(
    'overview',
    userId,
    { fn: 'kwenta_balances_overview' },
    (data) => {
      const o = (data ?? {}) as Record<string, unknown>
      return {
        personalReceive: toTotals(o.personalReceive),
        personalPay: toTotals(o.personalPay),
        combinedReceive: toTotals(o.combinedReceive),
        combinedPay: toTotals(o.combinedPay),
        groupReceive: toTotals(o.groupReceive),
        groupPay: toTotals(o.groupPay),
      }
    },
  )
}

export type GroupBalanceRow = {
  groupId: string
  name: string
  currency: string
  memberCount: number
  updatedAt: string
  totalToReceive: number
  totalToPay: number
}

export type PersonalBillRow = {
  id: string
  title: string
  currency: string
  totalAmount: number
  createdAt: string
  createdBy: string
  payorName: string
  itemCount: number
  settled: boolean
  category: string | null
  participants: { id: string; label: string }[]
  originalCurrency: string | null
  originalTotal: number | null
  exchangeRate: number | null
}

export type PersonalBillBuckets = { mine: PersonalBillRow[]; shared: PersonalBillRow[] }

/** The most rows one `kwenta_personal_bills_page` or `kwenta_group_bills_page` call returns: 083 and 085 clamp `p_limit` to 1..500. */
export const MAX_BILLS_PAGE_ROWS = 500

/** The last row a reader holds: the next page starts strictly after it in the chosen sort. */
export type PersonalBillCursor = { id: string; createdAt: string; title: string }

export type PersonalBillsPageQuery = {
  bucket: 'mine' | 'shared'
  limit: number
  after?: PersonalBillCursor
  settled: 'all' | 'settled' | 'unsettled'
  category: string | null
  sort: 'date_desc' | 'date_asc' | 'title_asc' | 'title_desc'
}

/** `matching` counts the filtered bucket; `mine`/`shared` are the unfiltered tab totals. */
export type PersonalBillsPage = {
  rows: PersonalBillRow[]
  matching: number
  mine: number
  shared: number
  /** Categories present in the unfiltered `mine` bucket, for the filter chips. */
  categories: string[]
}

function toBillRow(row: Record<string, unknown>): PersonalBillRow {
  const participants = Array.isArray(row.participants)
    ? (row.participants as Record<string, unknown>[]).map((p) => ({
        id: String(p.id ?? ''),
        label: String(p.label ?? 'Unknown'),
      }))
    : []
  return {
    id: String(row.id ?? ''),
    title: String(row.title ?? ''),
    currency: String(row.currency ?? ''),
    totalAmount: Number(row.totalAmount ?? 0),
    createdAt: String(row.createdAt ?? ''),
    createdBy: String(row.createdBy ?? ''),
    payorName: String(row.payorName ?? 'Someone'),
    itemCount: Number(row.itemCount ?? 0),
    settled: row.settled === true,
    category: typeof row.category === 'string' && row.category ? row.category : null,
    participants,
    ...toConversionFields(row),
  }
}

export type StatementEvent = {
  id: string
  type: 'personal_bill' | 'group_bill' | 'payment'
  createdAt: string
  currency: string
  groupId: string | null
  bundleId: string | null
  contextLabel: string
  title: string
  rawAmount: number
  delta: number
  /**
   * The bill's category; always null on a payment event.
   *
   * Added by migration 065. An older server omits the key and this stays null, which is exactly
   * how the export renders an uncategorised bill — so the client works against either.
   */
  category: string | null
}

function toStatementEvent(e: Record<string, unknown>): StatementEvent {
  return {
    id: String(e.id ?? ''),
    type: (e.type === 'group_bill' || e.type === 'payment' ? e.type : 'personal_bill') as StatementEvent['type'],
    createdAt: String(e.createdAt ?? ''),
    currency: String(e.currency ?? ''),
    groupId: typeof e.groupId === 'string' ? e.groupId : null,
    bundleId: typeof e.bundleId === 'string' ? e.bundleId : null,
    contextLabel: String(e.contextLabel ?? ''),
    title: String(e.title ?? ''),
    category: typeof e.category === 'string' && e.category ? e.category : null,
    rawAmount: Number(e.rawAmount ?? 0),
    delta: Number(e.delta ?? 0),
  }
}

/**
 * The FULL statement, oldest first and without running numbers, for an export fetched on tap.
 *
 * It has its own key: it is never mounted, so a write never recomputes it, and it can neither
 * replace the page's read spec nor consume the page's primed answer. `statement:<id>` is retired
 * rather than reused, because devices hold a saved copy of this array under it that the paged view
 * must never read.
 */
export async function fetchPersonStatement(userId: string, personId: string) {
  return fetchEndpoint<StatementEvent[]>(
    `statement-full:${personId}`,
    userId,
    { fn: 'kwenta_person_statement', argName: 'p_person_id', id: personId },
    (data) => {
      if (!Array.isArray(data)) throw new Error('unexpected response shape')
      return (data as Record<string, unknown>[]).map(toStatementEvent)
    },
  )
}

/** The most events one `kwenta_person_statement_page` call returns: 086 clamps `p_limit` to 1..500. */
export const MAX_STATEMENT_PAGE_EVENTS = 500

/** A statement event with the tab on either side of it, per currency, over ALL events (086). */
export type StatementPageEvent = StatementEvent & { runningNet: number; prevRunning: number }

/** `matching` counts the events of the requested kind; the page itself is newest first. */
export type PersonStatementPage = {
  events: StatementPageEvent[]
  matching: number
  /** Currency of the newest personal bill over the whole history; null when there is none. */
  latestPersonalCurrency: string | null
}

/** The last event a reader holds: the next page starts strictly before it (created_at, id). */
export type StatementCursor = { createdAt: string; id: string }

export type PersonStatementPageQuery = {
  limit: number
  kind: 'all' | 'payments'
  before?: StatementCursor
}

function toPersonStatementPage(data: unknown): PersonStatementPage {
  // NULL is the server declining (the person is not yours to read), not an empty statement:
  // mapping it to no events would read as "No bills or payments between you yet" and be cached so.
  if (data === null || data === undefined) {
    throw Object.assign(new Error('permission denied for this statement'), { code: '42501' })
  }
  const o = data as Record<string, unknown>
  const matching = Number(o.matching)
  return {
    events: asRecords(o.events).map((e) => ({
      ...toStatementEvent(e),
      runningNet: Number(e.runningNet ?? 0),
      prevRunning: Number(e.prevRunning ?? 0),
    })),
    matching: Number.isFinite(matching) ? matching : 0,
    latestPersonalCurrency: typeof o.latestPersonalCurrency === 'string' && o.latestPersonalCurrency
      ? o.latestPersonalCurrency
      : null,
  }
}

/**
 * The Person screen's statement: the newest `limit` events of every kind, each with the running
 * balance the server computed over the WHOLE history (the walk is SQL, since the client no longer
 * holds the whole list).
 *
 * It owns the `statement-page:<id>` key, so a write recomputes it through `kwenta_read` with the
 * limit and the re-read costs no request.
 */
export async function fetchPersonStatementPage(userId: string, personId: string, opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 20
  return fetchEndpoint<PersonStatementPage>(
    `statement-page:${personId}`,
    userId,
    { fn: 'kwenta_person_statement_page', argName: 'p_person_id', id: personId, limit },
    toPersonStatementPage,
  )
}

/**
 * The statement's other pages. The first Payments page is an ordinary cached read (its arguments
 * ride `extraArgs`, so a write never asks `kwenta_read` to recompute it, and the next write costs
 * that filter one refetch); a page `before` an event is a "Show older" step, live only.
 */
export async function fetchPersonStatementPageMore(userId: string, personId: string, query: PersonStatementPageQuery) {
  const args: Record<string, unknown> = { p_person_id: personId, p_limit: query.limit, p_kind: query.kind }
  if (query.before) {
    return fetchCursorPage(
      'kwenta_person_statement_page',
      { ...args, p_before: query.before },
      'statement-page',
      toPersonStatementPage,
    )
  }
  return fetchEndpoint<PersonStatementPage>(
    `statement-page:${personId}:${query.kind}`,
    userId,
    { fn: 'kwenta_person_statement_page', extraArgs: args },
    toPersonStatementPage,
  )
}

export type SearchResults = {
  bills: { id: string; title: string; amount: number; currency: string; groupId: string | null }[]
  groups: { id: string; name: string; currency: string }[]
  profiles: { id: string; displayName: string; email: string }[]
}

/**
 * Global search. Not cached: a search is a question about right now, and serving a stale answer
 * to a fresh query is worse than saying nothing.
 */
export async function searchEverything(query: string): Promise<SearchResults> {
  const { data, error } = await supabase.rpc('kwenta_search', { p_query: query })
  if (error) throw new ApiError('Search is unavailable right now.', error)
  const o = (data ?? {}) as Record<string, unknown>
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
  return {
    bills: arr(o.bills).map((b) => ({
      id: String(b.id ?? ''),
      title: String(b.title ?? ''),
      amount: Number(b.amount ?? 0),
      currency: String(b.currency ?? ''),
      groupId: typeof b.groupId === 'string' ? b.groupId : null,
    })),
    groups: arr(o.groups).map((g) => ({
      id: String(g.id ?? ''),
      name: String(g.name ?? ''),
      currency: String(g.currency ?? ''),
    })),
    profiles: arr(o.profiles).map((p) => ({
      id: String(p.id ?? ''),
      displayName: String(p.displayName ?? 'Unknown'),
      email: String(p.email ?? ''),
    })),
  }
}

export type GroupDetail = {
  group: {
    id: string
    name: string
    currency: string
    createdBy: string
    inviteCode: string
    updatedAt: string
  }
  members: { id: string; userId: string; profileName: string; isCurrentUser: boolean }[]
  bills: {
    id: string
    title: string
    note: string
    currency: string
    totalAmount: number
    createdAt: string
    createdBy: string
    paidBy: string
    groupId: string
    category: string | null
    payorName: string
    originalCurrency: string | null
    originalTotal: number | null
    exchangeRate: number | null
  }[]
  /** What each OTHER member owes the viewer. Never involves a third party. */
  pairwise: { memberUserId: string; displayName: string; net: number }[]
  totalToReceive: number
  totalToPay: number
  /** Each member against the group POOL — a different quantity from `pairwise`. */
  memberBalances: { userId: string; displayName: string; amount: number }[]
  /** The directed debt graph; the settle-up decomposition stays in TypeScript. */
  rawDebts: { from: string; to: string; amount: number }[]
}

export type GroupBillRow = GroupDetail['bills'][number]

/** The group screen's first page: the newest bills, plus counts over ALL live bills (085). */
export type GroupDetailPaged = GroupDetail & {
  billCount: number
  /** Who paid how many of the live bills, removed members included; the screen keeps the roster. */
  billPayers: { userId: string; count: number }[]
}

/** The last bill a reader holds: the next page starts strictly after it (created_at DESC, id). */
export type GroupBillsCursor = { id: string; createdAt: string }

export type GroupBillsPageQuery = {
  limit: number
  payer: string | null
  after?: GroupBillsCursor
}

export type GroupBillsPage = { rows: GroupBillRow[]; matching: number }

const asRecords = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])

function toGroupBill(b: Record<string, unknown>): GroupBillRow {
  return {
    id: String(b.id ?? ''),
    title: String(b.title ?? ''),
    note: String(b.note ?? ''),
    currency: String(b.currency ?? ''),
    totalAmount: Number(b.totalAmount ?? 0),
    createdAt: String(b.createdAt ?? ''),
    createdBy: String(b.createdBy ?? ''),
    paidBy: String(b.paidBy ?? ''),
    groupId: String(b.groupId ?? ''),
    category: typeof b.category === 'string' && b.category ? b.category : null,
    payorName: String(b.payorName ?? 'Unknown'),
    ...toConversionFields(b),
  }
}

function toGroupDetail(data: unknown): GroupDetail | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const g = (o.group ?? {}) as Record<string, unknown>
  return {
    group: {
      id: String(g.id ?? ''),
      name: String(g.name ?? ''),
      currency: String(g.currency ?? ''),
      createdBy: String(g.createdBy ?? ''),
      inviteCode: String(g.inviteCode ?? ''),
      updatedAt: String(g.updatedAt ?? ''),
    },
    members: asRecords(o.members).map((m) => ({
      id: String(m.id ?? ''),
      userId: String(m.userId ?? ''),
      profileName: String(m.profileName ?? 'Unknown'),
      isCurrentUser: m.isCurrentUser === true,
    })),
    bills: asRecords(o.bills).map(toGroupBill),
    pairwise: asRecords(o.pairwise).map((p) => ({
      memberUserId: String(p.memberUserId ?? ''),
      displayName: String(p.displayName ?? 'Unknown'),
      net: Number(p.net ?? 0),
    })),
    totalToReceive: Number(o.totalToReceive ?? 0),
    totalToPay: Number(o.totalToPay ?? 0),
    memberBalances: asRecords(o.memberBalances).map((m) => ({
      userId: String(m.userId ?? ''),
      displayName: String(m.displayName ?? 'Unknown'),
      amount: Number(m.amount ?? 0),
    })),
    rawDebts: asRecords(o.rawDebts).map((d) => ({
      from: String(d.from ?? ''),
      to: String(d.to ?? ''),
      amount: Number(d.amount ?? 0),
    })),
  }
}

function toGroupDetailPaged(data: unknown): GroupDetailPaged | null {
  const detail = toGroupDetail(data)
  if (!detail) return null
  const o = data as Record<string, unknown>
  const billCount = Number(o.billCount)
  return {
    ...detail,
    billCount: Number.isFinite(billCount) ? billCount : detail.bills.length,
    billPayers: asRecords(o.billPayers).map((p) => ({
      userId: String(p.userId ?? ''),
      count: Number(p.count ?? 0),
    })),
  }
}

/**
 * The group screen's read: everything kwenta_group_detail answers, with only the `limit` newest
 * bills plus `billCount` / `billPayers` over all of them (085). Resolves to null when the group is
 * missing, deleted, or the caller is not an active member.
 *
 * It owns the `group:<id>` key, so a write recomputes it through `kwenta_read` with the limit and
 * the re-read costs no request.
 */
export async function fetchGroupDetailPaged(userId: string, groupId: string, limit = 20) {
  return fetchEndpoint<GroupDetailPaged | null>(
    `group:${groupId}`,
    userId,
    { fn: 'kwenta_group_detail_paged', argName: 'p_group_id', id: groupId, limit },
    toGroupDetailPaged,
  )
}

/**
 * The group with EVERY bill, for an export or the member share card, fetched on tap.
 *
 * It has its own key: it is never mounted, so a write never recomputes it, and it can neither
 * replace the page's read spec (which would make every later write prime the full list) nor
 * consume the page's primed answer. Its saved copy is what an offline export falls back to.
 * Resolves to null when the group is missing, deleted, or the caller is not an active member.
 */
export async function fetchGroupDetail(userId: string, groupId: string) {
  return fetchEndpoint<GroupDetail | null>(
    `group-full:${groupId}`,
    userId,
    { fn: 'kwenta_group_detail', argName: 'p_group_id', id: groupId },
    toGroupDetail,
  )
}

/**
 * A live page after a row, never cached and never primed: a saved copy of "the rows after X"
 * answers nothing once X is gone, and a first-page read must not be handed rows from the middle.
 */
async function fetchCursorPage<T>(
  fn: string,
  args: Record<string, unknown>,
  family: string,
  map: (raw: unknown) => T,
): Promise<{ data: T; fromCache: false; fetchedAt: string }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new ApiError(`You're offline. Connect to load more of ${describeEndpoint(family)}.`)
  }
  try {
    const { data: raw, error } = await supabase.rpc(fn, args)
    if (error) throw error
    const data = map(raw)
    refreshOnlineStatus()
    return { data, fromCache: false, fetchedAt: now() }
  } catch (err) {
    if (isAccessError(err)) {
      throw new ApiError(`You no longer have access to ${describeEndpoint(family)}.`, err)
    }
    throw new ApiError(`Could not load more of ${describeEndpoint(family)}.`, err)
  }
}

function toGroupBillsPage(data: unknown): GroupBillsPage {
  // NULL is the server declining (not a member any more, or the group is gone), not an empty
  // list: mapping it to no rows would read as "No bills paid by X" and be cached as such.
  if (data === null || data === undefined) {
    throw Object.assign(new Error('permission denied for this group'), { code: '42501' })
  }
  const o = data as Record<string, unknown>
  const matching = Number(o.matching)
  return {
    rows: asRecords(o.rows).map(toGroupBill),
    matching: Number.isFinite(matching) ? matching : 0,
  }
}

/**
 * One page of a group's bill list, optionally only one payer's. The FIRST page is an ordinary
 * cached read per payer (its arguments ride `extraArgs`, so a write never asks `kwenta_read` to
 * recompute it); a page `after` a row is a "Show more" step, live only.
 */
export async function fetchGroupBillsPage(userId: string, groupId: string, query: GroupBillsPageQuery) {
  const args = { p_group_id: groupId, p_limit: query.limit, p_payer: query.payer }
  if (!query.after) {
    return fetchEndpoint<GroupBillsPage>(
      `group-bills:${groupId}:${query.payer ?? ''}`,
      userId,
      { fn: 'kwenta_group_bills_page', extraArgs: args },
      toGroupBillsPage,
    )
  }
  return fetchCursorPage('kwenta_group_bills_page', { ...args, p_after: query.after }, 'group-bills', toGroupBillsPage)
}

export type BillSplitRow = {
  id: string
  userId: string
  displayName: string
  splitType: string
  splitValue: number
  computedAmount: number
  originalAmount: number | null
}

export type BillDetail = {
  bill: {
    id: string
    title: string
    note: string
    currency: string
    totalAmount: number
    createdAt: string
    createdBy: string
    paidBy: string
    groupId: string | null
    category: string | null
    creatorName: string
    payorName: string
    originalCurrency: string | null
    exchangeRate: number | null
    rateSource: 'online' | 'manual' | null
    originalTotal: number | null
  }
  groupName: string | null
  items: { id: string; name: string; amount: number; originalAmount: number | null; splits: BillSplitRow[] }[]
  /** Personal bills only — null on a group bill, where the screen does not show it. */
  mySplitTotal: number | null
  pairs: { otherId: string; displayName: string; net: number; squareOverall: boolean }[]
}

/** Resolves to null when the bill is not readable — deleted and not-yours are indistinguishable. */
export async function fetchBillDetail(userId: string, billId: string) {
  return fetchEndpoint<BillDetail | null>(
    `bill:${billId}`,
    userId,
    { fn: 'kwenta_bill_detail', argName: 'p_bill_id', id: billId },
    (data) => {
    if (!data || typeof data !== 'object') return null
    const o = data as Record<string, unknown>
    const b = (o.bill ?? {}) as Record<string, unknown>
    const items = Array.isArray(o.items) ? (o.items as Record<string, unknown>[]) : []
    const pairs = Array.isArray(o.pairs) ? (o.pairs as Record<string, unknown>[]) : []
    const conversion = toConversionFields(b)
    const paidIn = (v: unknown) => (conversion.originalCurrency ? nullableNumber(v) : null)
    return {
      bill: {
        id: String(b.id ?? ''),
        title: String(b.title ?? ''),
        note: String(b.note ?? ''),
        currency: String(b.currency ?? ''),
        totalAmount: Number(b.totalAmount ?? 0),
        createdAt: String(b.createdAt ?? ''),
        createdBy: String(b.createdBy ?? ''),
        paidBy: String(b.paidBy ?? ''),
        groupId: typeof b.groupId === 'string' ? b.groupId : null,
        category: typeof b.category === 'string' && b.category ? b.category : null,
        creatorName: String(b.creatorName ?? 'Unknown'),
        payorName: String(b.payorName ?? 'Unknown'),
        ...conversion,
        rateSource: conversion.originalCurrency ? toRateSource(b.rateSource) : null,
      },
      groupName: typeof o.groupName === 'string' ? o.groupName : null,
      items: items.map((it) => ({
        id: String(it.id ?? ''),
        name: String(it.name ?? ''),
        amount: Number(it.amount ?? 0),
        originalAmount: paidIn(it.originalAmount),
        splits: (Array.isArray(it.splits) ? (it.splits as Record<string, unknown>[]) : []).map(
          (sp) => ({
            id: String(sp.id ?? ''),
            userId: String(sp.userId ?? ''),
            displayName: String(sp.displayName ?? 'Unknown'),
            splitType: String(sp.splitType ?? 'equal'),
            splitValue: Number(sp.splitValue ?? 0),
            computedAmount: Number(sp.computedAmount ?? 0),
            originalAmount: paidIn(sp.originalAmount),
          }),
        ),
      })),
      mySplitTotal: o.mySplitTotal === null || o.mySplitTotal === undefined
        ? null
        : Number(o.mySplitTotal),
      pairs: pairs.map((p) => ({
        otherId: String(p.otherId ?? ''),
        displayName: String(p.displayName ?? 'Unknown'),
        net: Number(p.net ?? 0),
        squareOverall: p.squareOverall === true,
      })),
    }
    },
  )
}

export async function fetchGroupsWithBalances(userId: string) {
  return fetchEndpoint<GroupBalanceRow[]>(
    'groups',
    userId,
    { fn: 'kwenta_groups_with_balances' },
    (data) => {
      if (!Array.isArray(data)) throw new Error('unexpected response shape')
      return (data as Record<string, unknown>[]).map((row) => ({
        groupId: String(row.groupId ?? ''),
        name: String(row.name ?? ''),
        currency: String(row.currency ?? ''),
        memberCount: Number(row.memberCount ?? 0),
        updatedAt: String(row.updatedAt ?? ''),
        totalToReceive: Number(row.totalToReceive ?? 0),
        totalToPay: Number(row.totalToPay ?? 0),
      }))
    },
  )
}

export async function fetchPersonalBills(userId: string) {
  return fetchEndpoint<PersonalBillBuckets>(
    'personal-bills',
    userId,
    { fn: 'kwenta_personal_bills' },
    (data) => {
      const o = (data ?? {}) as Record<string, unknown>
      const bucket = (v: unknown) =>
        Array.isArray(v) ? (v as Record<string, unknown>[]).map(toBillRow) : []
      return { mine: bucket(o.mine), shared: bucket(o.shared) }
    },
  )
}

export function personalBillsPageKey(q: Omit<PersonalBillsPageQuery, 'limit' | 'after'>): string {
  return `personal-bills-page:${q.bucket}:${q.settled}:${q.category ?? ''}:${q.sort}`
}

function toBillsPage(data: unknown): PersonalBillsPage {
  const o = (data ?? {}) as Record<string, unknown>
  const count = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  return {
    rows: Array.isArray(o.rows) ? (o.rows as Record<string, unknown>[]).map(toBillRow) : [],
    matching: count(o.matching),
    mine: count(o.mine),
    shared: count(o.shared),
    categories: Array.isArray(o.categories)
      ? o.categories.filter((c): c is string => typeof c === 'string')
      : [],
  }
}

/**
 * One page of the Bills list.
 *
 * The FIRST page (no `after`) is an ordinary cached read: the key leaves the limit out, so a
 * saved copy answers offline whatever the limit, and every argument rides `extraArgs` because
 * `kwenta_write` recomputes by id/limit only — a write must never be asked to restate this
 * endpoint, the page refetches itself.
 *
 * A page `after` a row is a "Show more" step: always live, never cached and never primed. Caching
 * it would hand a later first-page read rows from the middle of the list, and a saved copy of
 * "the rows after X" answers nothing once X is gone.
 */
export async function fetchPersonalBillsPage(userId: string, query: PersonalBillsPageQuery) {
  const args = {
    p_bucket: query.bucket,
    p_limit: query.limit,
    p_settled: query.settled,
    p_category: query.category,
    p_sort: query.sort,
  }
  if (!query.after) {
    return fetchEndpoint<PersonalBillsPage>(
      personalBillsPageKey(query),
      userId,
      { fn: 'kwenta_personal_bills_page', extraArgs: args },
      toBillsPage,
    )
  }
  return fetchCursorPage('kwenta_personal_bills_page', { ...args, p_after: query.after }, 'personal-bills-page', toBillsPage)
}

export async function fetchRecentBills(userId: string, limit = 5) {
  return fetchEndpoint<RecentBill[]>(
    'recent-bills',
    userId,
    { fn: 'kwenta_recent_bills', limit },
    (data) => {
      if (!Array.isArray(data)) throw new Error('unexpected response shape')
      return (data as Record<string, unknown>[]).map((row) => {
        const { originalCurrency, originalTotal } = toConversionFields(row)
        return {
          id: String(row.id ?? ''),
          title: String(row.title ?? ''),
          amount: Number(row.amount ?? 0),
          currency: String(row.currency ?? ''),
          createdAt: String(row.createdAt ?? ''),
          groupName: typeof row.groupName === 'string' && row.groupName ? row.groupName : undefined,
          originalCurrency,
          originalTotal,
        }
      })
    },
  )
}

export async function fetchPersonSummary(userId: string, personId: string) {
  return fetchEndpoint<PersonSummary>(
    `person:${personId}`,
    userId,
    { fn: 'kwenta_person_summary', argName: 'p_person_id', id: personId },
    (data) => {
      const o = (data ?? {}) as Record<string, unknown>
      const groups = Array.isArray(o.groups) ? (o.groups as Record<string, unknown>[]) : []
      return {
        personal: toTotals(o.personal),
        total: toTotals(o.total),
        groups: groups.map((g) => ({
          groupId: String(g.groupId ?? ''),
          groupName: String(g.groupName ?? ''),
          currency: String(g.currency ?? ''),
          net: Number(g.net ?? 0),
          theirNet: Number(g.theirNet ?? 0),
        })),
      }
    },
  )
}

export type SettlementRecipient = { toUserId: string; toName: string; amount: number }

/**
 * One payment as the history list shows it (migration 064).
 *
 * A bundled settle-up is ONE item with many `legs`: `recipients` collapses the stored rows by
 * recipient, while `legs` keeps every row. The difference is the input to `buildMovementChains`,
 * so the two are not interchangeable.
 */
export type SettlementHistoryItem = {
  id: string
  settlementIds: string[]
  bundleId: string | null
  isBundled: boolean
  groupId: string | null
  /** Set only by the cross-context lists (person history), which label each row's own context. */
  groupName?: string
  billId: string | null
  billTitle: string | null
  fromUserId: string
  toUserId: string
  fromName: string
  toName: string
  amount: number
  currency: string
  label: string
  /** How the money moved (cash / GCash / …). Null when never recorded. */
  method: string | null
  createdAt: string
  recipients: SettlementRecipient[]
  legs: SettlementMovementLeg[]
  /** Who pressed "Pay" — differs from the payer when recorded on someone's behalf. */
  recordedByUserId: string | null
  recordedByName: string | null
}

function nullableString(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

function toHistoryItem(row: Record<string, unknown>): SettlementHistoryItem {
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : [])
  const groupName = nullableString(row.groupName)
  return {
    id: String(row.id ?? ''),
    settlementIds: Array.isArray(row.settlementIds) ? row.settlementIds.map(String) : [],
    bundleId: nullableString(row.bundleId),
    isBundled: row.isBundled === true,
    groupId: nullableString(row.groupId),
    ...(groupName === null ? {} : { groupName }),
    billId: nullableString(row.billId),
    billTitle: nullableString(row.billTitle),
    fromUserId: String(row.fromUserId ?? ''),
    toUserId: String(row.toUserId ?? ''),
    fromName: String(row.fromName ?? 'Someone'),
    toName: String(row.toName ?? 'Someone'),
    amount: Number(row.amount ?? 0),
    currency: String(row.currency ?? ''),
    label: typeof row.label === 'string' ? row.label : '',
    // A pre-069 server omits the key entirely; nullableString turns that (and a blank string)
    // into null, so the field degrades to "no method" rather than painting an empty tag.
    method: nullableString(row.method),
    createdAt: String(row.createdAt ?? ''),
    recipients: arr(row.recipients).map((r) => ({
      toUserId: String(r.toUserId ?? ''),
      toName: String(r.toName ?? 'Someone'),
      amount: Number(r.amount ?? 0),
    })),
    legs: arr(row.legs).map((l) => ({
      fromUserId: String(l.fromUserId ?? ''),
      fromName: String(l.fromName ?? 'Someone'),
      toUserId: String(l.toUserId ?? ''),
      toName: String(l.toName ?? 'Someone'),
      amount: Number(l.amount ?? 0),
    })),
    recordedByUserId: nullableString(row.recordedByUserId),
    recordedByName: nullableString(row.recordedByName),
  }
}

function toHistoryList(data: unknown): SettlementHistoryItem[] {
  return Array.isArray(data) ? (data as Record<string, unknown>[]).map(toHistoryItem) : []
}

export async function fetchBillSettlementHistory(userId: string, billId: string) {
  return fetchEndpoint<SettlementHistoryItem[]>(
    `bill-payments:${billId}`,
    userId,
    { fn: 'kwenta_bill_settlement_history', argName: 'p_bill_id', id: billId },
    toHistoryList,
  )
}

/** Resolves to null when the caller is not an active member of the group. */
export async function fetchGroupSettlementHistory(userId: string, groupId: string) {
  return fetchEndpoint<SettlementHistoryItem[] | null>(
    `group-payments:${groupId}`,
    userId,
    { fn: 'kwenta_group_settlement_history', argName: 'p_group_id', id: groupId },
    (data) => (data === null ? null : toHistoryList(data)),
  )
}

export async function fetchPersonSettlementHistory(userId: string, personId: string) {
  return fetchEndpoint<SettlementHistoryItem[]>(
    `person-payments:${personId}`,
    userId,
    { fn: 'kwenta_person_settlement_history', argName: 'p_person_id', id: personId },
    toHistoryList,
  )
}

export type GroupSpending = {
  currency: string
  /** Gross consumption per member, highest first. Payments do not affect it. */
  rows: { userId: string; displayName: string; amount: number }[]
}

/** Resolves to null when the caller is not an active member of the group. */
export async function fetchGroupSpending(userId: string, groupId: string) {
  return fetchEndpoint<GroupSpending | null>(
    `group-spending:${groupId}`,
    userId,
    { fn: 'kwenta_group_spending', argName: 'p_group_id', id: groupId },
    (data) => {
      if (!data || typeof data !== 'object') return null
      const o = data as Record<string, unknown>
      const rows = Array.isArray(o.rows) ? (o.rows as Record<string, unknown>[]) : []
      return {
        currency: String(o.currency ?? ''),
        rows: rows.map((r) => ({
          userId: String(r.userId ?? ''),
          displayName: String(r.displayName ?? 'Unknown'),
          amount: Number(r.amount ?? 0),
        })),
      }
    },
  )
}

export type MemberPaymentParty = { memberUserId: string; displayName: string; amount: number }

export type MemberPaymentBreakdown = {
  memberUserId: string
  displayName: string
  currency: string
  /** Positive magnitudes. Settled relationships appear in neither list. */
  pays: MemberPaymentParty[]
  receives: MemberPaymentParty[]
}

function toMemberBreakdown(data: unknown): MemberPaymentBreakdown | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const parties = (v: unknown) =>
    Array.isArray(v)
      ? (v as Record<string, unknown>[]).map((p) => ({
          memberUserId: String(p.memberUserId ?? ''),
          displayName: String(p.displayName ?? 'Unknown'),
          amount: Number(p.amount ?? 0),
        }))
      : []
  return {
    memberUserId: String(o.memberUserId ?? ''),
    displayName: String(o.displayName ?? 'Unknown'),
    currency: String(o.currency ?? ''),
    pays: parties(o.pays),
    receives: parties(o.receives),
  }
}

async function callGroupMemberBreakdown(
  groupId: string,
  memberId: string,
): Promise<MemberPaymentBreakdown | null> {
  const { data, error } = await supabase.rpc('kwenta_group_member_breakdown', {
    p_group_id: groupId,
    p_member_id: memberId,
  })
  if (error) throw error
  return toMemberBreakdown(data)
}

/** Throws `ServerDeclinedError` when the caller is not an active member of the group. */
export async function fetchGroupMemberBreakdown(
  userId: string,
  groupId: string,
  memberId: string,
): Promise<{ data: MemberPaymentBreakdown; fromCache: boolean; fetchedAt: string }> {
  const result = await fetchEndpoint<MemberPaymentBreakdown | null>(
    `group-breakdown:${groupId}:${memberId}`,
    userId,
    {
      fn: 'kwenta_group_member_breakdown',
      extraArgs: { p_group_id: groupId, p_member_id: memberId },
    },
    (raw) => {
      const data = toMemberBreakdown(raw)
      if (data === null) throw new ServerDeclinedError(GROUP_MEMBERSHIP_DECLINED)
      return data
    },
  )
  // A cached NULL from before this endpoint threw is still a refusal, never an empty answer.
  if (result.data === null) throw new ServerDeclinedError(GROUP_MEMBERSHIP_DECLINED)
  return { ...result, data: result.data }
}

/**
 * The same breakdown, uncached, for the pre-write guards.
 *
 * A guard must never read the offline cache: deciding whether a member can be removed from a
 * stale copy of their balance is the class of mistake CLAUDE.md rule 2 exists to prevent.
 */
export async function loadGroupMemberBreakdownFresh(
  groupId: string,
  memberId: string,
): Promise<MemberPaymentBreakdown> {
  const data = await callGroupMemberBreakdown(groupId, memberId)
  if (data === null) throw new ServerDeclinedError(GROUP_MEMBERSHIP_DECLINED)
  return data
}

/**
 * The most `from` can pay `to` in this group right now. Uncached, for the same reason as above.
 *
 * Null means the caller is not an active member — the caller decides what to do with that, since
 * this is an advisory cap and not a server-enforced rule (see the migration 064 header).
 */
export async function loadOwedInGroup(
  groupId: string,
  fromUserId: string,
  toUserId: string,
): Promise<number | null> {
  const { data, error } = await supabase.rpc('kwenta_owed_in_group', {
    p_group_id: groupId,
    p_from: fromUserId,
    p_to: toUserId,
  })
  if (error) throw error
  return data === null || data === undefined ? null : Number(data)
}

/** `CurrencyTotals` -> the `Map` the existing display helpers take. */
export function totalsToMap(totals: CurrencyTotals): Map<string, number> {
  return new Map(Object.entries(totals))
}
