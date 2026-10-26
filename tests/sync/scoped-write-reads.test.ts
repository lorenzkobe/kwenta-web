import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { createBill, createSettlement, deleteBill, recordPersonPayment, updateBill } from '@/db/operations'
import { commitCloudFirstWrite, resetSubmissionIdSupport, submitCloudWrite } from '@/sync/cloud-write'
import { fetchPersonalBillsPage } from '@/api/balances'
import { clearPrimedReads, markReadMounted, rememberReadSpec } from '@/api/primed-reads'
import { relevantDataVersion, useAppStore } from '@/store/app-store'
import { makeBill, makeProfile, resetDb } from '../helpers/db'

/**
 * Scoped refresh on the wire (C23-C26, C28). A write asks `kwenta_write` to recompute the mounted
 * screens (p_reads) and then bumps dataVersion. A new bill cannot change payment history and a
 * payment cannot change group spending, so those families are neither requested nor refetched.
 * Everything else — edits, deletes, queued writes — stays a full refresh.
 *
 * Driven through the real submit path against tests/helpers/cloud-sync-mock.ts, so what is
 * asserted is the p_reads array the server actually received.
 *
 * Hand-made rows: none beyond the tests/helpers/db.ts factories (profiles ME and FR).
 */

const cloud = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'error' | 'drop' | 'reject' | 'transport' | 'lost' | 'inactive',
  calls: 0,
  pushes: [] as Record<string, { id: string }[]>[],
  submissionIds: [] as (string | undefined)[],
  seen: new Map<string, Record<string, string[]>>(),
  readSpecs: [] as Record<string, unknown>[][],
  readPayloads: {} as Record<string, unknown>,
  rpcNames: [] as string[],
  server: new Map<string, Map<string, unknown>>(),
}))

vi.mock('@/sync/sync-manager', () => ({ requestSyncNow: vi.fn(), triggerSync: vi.fn() }))
vi.mock('@/lib/kwenta-notifications', () => ({
  notifyAddedToGroup: vi.fn(async () => {}),
  notifyBillParticipantsCreated: vi.fn(async () => {}),
  notifyPaymentsRecorded: vi.fn(async () => {}),
  notifyProfileLinked: vi.fn(async () => {}),
  resolveRecipientProfileIdForNotify: vi.fn(async () => null),
}))
vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  return { supabase: makeSupabaseCloudMock(cloud) }
})

const PAGE_KEY = 'personal-bills-page:mine:all::date_desc'

/** The screens a user could have open, keyed exactly as src/api/balances.ts keys them. */
function mountScreens() {
  rememberReadSpec({ key: 'overview', fn: 'kwenta_balances_overview' })
  rememberReadSpec({ key: 'group:G', fn: 'kwenta_group_detail', argName: 'p_group_id', id: 'G' })
  rememberReadSpec({ key: 'group-spending:G', fn: 'kwenta_group_spending', argName: 'p_group_id', id: 'G' })
  rememberReadSpec({
    key: 'group-payments-page:G',
    fn: 'kwenta_group_settlement_history_page',
    argName: 'p_group_id',
    id: 'G',
    limit: 20,
  })
  rememberReadSpec({ key: 'bill-payments:B0', fn: 'kwenta_bill_settlement_history', argName: 'p_bill_id', id: 'B0' })
  // The Person page's payment lookup has no read spec (it rides no `kwenta_read`) and the app never
  // marks its key mounted; it is marked here only so the version checks can follow its family, and
  // it never appears in p_reads.
  for (const k of ['overview', 'group:G', 'group-spending:G', 'group-payments-page:G', 'bill-payments:B0', LOOKUP_KEY]) {
    markReadMounted(k)
  }
}

const LOOKUP_KEY = 'person-payment-items:FR'
const ALL_KEYS = ['bill-payments:B0', 'group-payments-page:G', 'group-spending:G', 'group:G', 'overview']

function lastReadKeys(): string[] {
  const last = cloud.readSpecs[cloud.readSpecs.length - 1] ?? []
  return last.map((s) => String(s.key)).sort()
}

function versions() {
  const s = useAppStore.getState()
  return Object.fromEntries([...ALL_KEYS, LOOKUP_KEY, PAGE_KEY].map((k) => [k, relevantDataVersion(s, k)]))
}

const BILL_INPUT = {
  title: 'Lunch',
  currency: 'PHP',
  groupId: null,
  createdBy: 'ME',
  note: '',
  items: [
    {
      name: 'Pizza',
      amount: 100,
      splits: [
        { userId: 'ME', splitType: 'equal' as const, splitValue: 1 },
        { userId: 'FR', splitType: 'equal' as const, splitValue: 1 },
      ],
    },
  ],
}

const PENDING = {
  operation: 'create_bill',
  entityType: 'bill' as const,
  entityId: 'B9',
  payload: null,
  routeHint: null,
}

function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true })
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  clearPrimedReads()
  setOnline(true)
  resetSubmissionIdSupport()
  cloud.mode = 'ok'
  cloud.calls = 0
  cloud.pushes = []
  cloud.submissionIds = []
  cloud.seen = new Map()
  cloud.readSpecs = []
  cloud.readPayloads = {}
  cloud.rpcNames = []
  cloud.server = new Map()
  useAppStore.setState({ dataVersion: 0, skippedBumps: {}, isOnline: true })
  await db.profiles.bulkAdd([
    makeProfile({ id: 'ME', display_name: 'Me' }),
    makeProfile({ id: 'FR', display_name: 'Friend', is_local: true, owner_id: 'ME' }),
  ])
  mountScreens()
})

describe('creating a bill', () => {
  it('C24: sends no payment-history endpoints in p_reads; detail and spending still go', async () => {
    await createBill(BILL_INPUT)

    expect(lastReadKeys()).toEqual(['group-spending:G', 'group:G', 'overview'])
  })

  it('C24: payment-history screens do not refetch; every other screen does', async () => {
    const before = versions()
    await createBill(BILL_INPUT)
    const after = versions()

    expect(after['bill-payments:B0']).toBe(before['bill-payments:B0'])
    expect(after['group-payments-page:G']).toBe(before['group-payments-page:G'])
    expect(after[LOOKUP_KEY]).toBe(before[LOOKUP_KEY])
    expect(after['group:G']).toBe(before['group:G'] + 1)
    expect(after['group-spending:G']).toBe(before['group-spending:G'] + 1)
    expect(after.overview).toBe(before.overview + 1)
  })
})

describe('recording a payment', () => {
  it('C25: skips group-spending only, in p_reads and in the refetch', async () => {
    const before = versions()
    await recordPersonPayment({
      meId: 'ME',
      otherId: 'FR',
      direction: 'they_paid_me',
      totalAmount: 40,
      allocations: [],
      currency: 'PHP',
      markedBy: 'ME',
    })
    const after = versions()

    expect(lastReadKeys()).toEqual(['bill-payments:B0', 'group-payments-page:G', 'group:G', 'overview'])
    expect(after['group-spending:G']).toBe(before['group-spending:G'])
    for (const k of ['bill-payments:B0', 'group-payments-page:G', 'group:G', 'overview', LOOKUP_KEY]) {
      expect(after[k]).toBe(before[k] + 1)
    }
  })
})

describe('creating a single settlement', () => {
  it('C25: sends no group-spending read and leaves it unrefreshed; group detail still refreshes', async () => {
    const before = versions()
    await createSettlement(null, 'FR', 'ME', 25, 'PHP', 'ME')
    const after = versions()

    expect(lastReadKeys()).toEqual(['bill-payments:B0', 'group-payments-page:G', 'group:G', 'overview'])
    expect(after['group-spending:G']).toBe(before['group-spending:G'])
    expect(after['group:G']).toBe(before['group:G'] + 1)
  })
})

describe('editing or deleting a bill', () => {
  it('C26: updateBill asks for and refreshes every mounted screen', async () => {
    const billId = await createBill(BILL_INPUT)
    const before = versions()

    await updateBill(billId, 'ME', {
      title: 'Dinner',
      note: '',
      currency: 'PHP',
      items: [{ name: 'Pasta', amount: 500, splits: [] }],
    })

    expect(lastReadKeys()).toEqual(ALL_KEYS)
    const after = versions()
    for (const k of ALL_KEYS) expect(after[k]).toBe(before[k] + 1)
  })

  it('C26: deleteBill asks for and refreshes every mounted screen', async () => {
    const billId = await createBill(BILL_INPUT)
    const before = versions()

    await deleteBill(billId, 'ME')

    expect(lastReadKeys()).toEqual(ALL_KEYS)
    const after = versions()
    for (const k of ALL_KEYS) expect(after[k]).toBe(before[k] + 1)
  })
})

describe('commitCloudFirstWrite with unaffectedReads', () => {
  it('C24: online, drops those families from p_reads and from the bump', async () => {
    const before = versions()
    const { mode } = await commitCloudFirstWrite({
      actorUserId: 'ME',
      payload: { bills: [makeBill({ id: 'B9', group_id: null, created_by: 'ME', paid_by: 'ME' })] },
      pending: PENDING,
      unaffectedReads: ['bill-payments', 'group-payments-page'],
    })
    expect(mode).toBe('cloud')
    expect(lastReadKeys()).toEqual(['group-spending:G', 'group:G', 'overview'])
    const after = versions()
    expect(after['bill-payments:B0']).toBe(before['bill-payments:B0'])
    expect(after['group-payments-page:G']).toBe(before['group-payments-page:G'])
    expect(after[LOOKUP_KEY]).toBe(before[LOOKUP_KEY] + 1)
  })

  it('C28: a queued (offline) write invalidates every screen, skip list or not', async () => {
    setOnline(false)
    const before = versions()
    const { mode } = await commitCloudFirstWrite({
      actorUserId: 'ME',
      payload: { bills: [makeBill({ id: 'B9', group_id: null, created_by: 'ME', paid_by: 'ME' })] },
      pending: PENDING,
      unaffectedReads: ['bill-payments', 'group-payments-page', 'person-payment-items'],
    })
    setOnline(true)
    expect(mode).toBe('queued')
    const after = versions()
    for (const k of [...ALL_KEYS, PAGE_KEY]) expect(after[k]).toBe(before[k] + 1)
  })

  it('C28: a transport failure that queues the write invalidates every screen', async () => {
    cloud.mode = 'transport'
    const before = versions()
    const { mode } = await commitCloudFirstWrite({
      actorUserId: 'ME',
      payload: { bills: [makeBill({ id: 'B9', group_id: null, created_by: 'ME', paid_by: 'ME' })] },
      pending: PENDING,
      unaffectedReads: ['bill-payments'],
    })
    expect(mode).toBe('queued')
    expect(versions()['bill-payments:B0']).toBe(before['bill-payments:B0'] + 1)
  })
})

describe('submitCloudWrite with unaffectedReads', () => {
  it('C24: leaves the named families out of p_reads only', async () => {
    await submitCloudWrite({
      actorUserId: 'ME',
      payload: { bills: [makeBill({ id: 'B9', group_id: null, created_by: 'ME', paid_by: 'ME' })] },
      unaffectedReads: ['group-spending'],
    })
    expect(lastReadKeys()).toEqual(['bill-payments:B0', 'group-payments-page:G', 'group:G', 'overview'])
  })

  it('C29: without the field, p_reads is every mounted screen', async () => {
    await submitCloudWrite({
      actorUserId: 'ME',
      payload: { bills: [makeBill({ id: 'B9', group_id: null, created_by: 'ME', paid_by: 'ME' })] },
    })
    expect(lastReadKeys()).toEqual(ALL_KEYS)
  })
})

describe('the Bills page endpoint during a write', () => {
  it('C23: is never requested in p_reads, and its screen refetches once after the write', async () => {
    await fetchPersonalBillsPage('ME', {
      bucket: 'mine',
      limit: 40,
      settled: 'all',
      category: null,
      sort: 'date_desc',
    }).catch(() => undefined)
    markReadMounted(PAGE_KEY)
    const before = versions()

    await createBill(BILL_INPUT)
    await recordPersonPayment({
      meId: 'ME',
      otherId: 'FR',
      direction: 'they_paid_me',
      totalAmount: 10,
      allocations: [],
      currency: 'PHP',
      markedBy: 'ME',
    })

    for (const reads of cloud.readSpecs) {
      expect(reads.map((r) => String(r.key))).not.toContain(PAGE_KEY)
      expect(reads.map((r) => String(r.fn))).not.toContain('kwenta_personal_bills_page')
    }
    expect(versions()[PAGE_KEY]).toBe(before[PAGE_KEY] + 2)
  })
})
