import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { createBill, updateBill } from '@/db/operations'
import * as writeQueue from '@/sync/write-queue'
import { hasUnsyncedLocalDataForUser, mayHaveStagedRows, syncRoundTrip } from '@/sync/sync-service'
import { flushQueuedKwentaNotifications } from '@/lib/kwenta-notifications'
import { useAppStore } from '@/store/app-store'
import { supabase } from '@/lib/supabase'
import { makeBill, makeItem, makeProfile, makeSplit, resetDb } from '../helpers/db'

// The ordered write queue (plan: "Writes", H1.1, H1.2, H1.7). Driven through the public
// operations so the entry shape (push, row_keys, submission_id, seq) is whatever the
// implementation writes, and asserted on Dexie + what the fake server received.
//
// Assumed names not pinned by the plan: `drainWriteQueue(actorUserId)`,
// `dismissQueuedWrite(entryId)`, `retryQueuedWrite(entryId)`.

const cloud = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'error' | 'drop' | 'reject' | 'transport' | 'lost' | 'inactive',
  status: 0,
  rejectIds: new Set<string>(),
  pushes: [] as Record<string, { id: string; title?: string }[]>[],
  submissionIds: [] as (string | undefined)[],
  rpcNames: [] as string[],
  seen: new Map<string, Record<string, string[]>>(),
  server: new Map<string, Map<string, unknown>>(),
  reconcilePayload: null as Record<string, unknown> | null,
  reconcileCalls: [] as Record<string, unknown>[],
  inserts: [] as { table: string; rows: unknown }[],
  hold: null as Promise<void> | null,
  holdIds: null as Set<string> | null,
  errorCode: undefined as string | undefined,
  errorStatus: undefined as number | undefined,
}))

vi.mock('@/sync/sync-manager', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requestSyncNow: vi.fn(),
  triggerSync: vi.fn(),
}))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  return { supabase: makeSupabaseCloudMock(cloud) }
})

const OUTBOX_KEY = 'kwenta_notification_outbox_v1'

type Entry = {
  id: string
  status: string
  seq: number
  submission_id: string
  push: Record<string, { id: string; title?: string }[]> | null
  next_attempt_at: string | number | null
  last_error_kind: string | null
}

const drain = () => (writeQueue.drainWriteQueue as unknown as (actor: string) => Promise<unknown>)('ME')
const dismiss = (id: string) =>
  (writeQueue as unknown as { dismissQueuedWrite: (id: string) => Promise<unknown> }).dismissQueuedWrite(id)
const retry = (id: string) =>
  (writeQueue as unknown as { retryQueuedWrite: (id: string) => Promise<unknown> }).retryQueuedWrite(id)

function setOnline(online: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online })
  useAppStore.getState().setOnline(online)
}

async function entries(): Promise<Entry[]> {
  const rows = (await db.pending_mutations.toArray()) as unknown as Entry[]
  return rows.sort((a, b) => a.seq - b.seq)
}

function billInput(title: string, splitTo = 'FR') {
  return {
    title,
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
          { userId: splitTo, splitType: 'equal' as const, splitValue: 1 },
        ],
      },
    ],
  }
}

const pushedBillIds = () => cloud.pushes.flatMap((p) => (p.bills ?? []).map((b) => b.id))

/** Bill ids the fake server received through one RPC (pushes and write/sync names line up 1:1). */
function billIdsVia(rpc: 'kwenta_write' | 'kwenta_sync'): string[] {
  const names = cloud.rpcNames.filter((n) => n === 'kwenta_write' || n === 'kwenta_sync')
  return cloud.pushes.flatMap((p, i) => (names[i] === rpc ? (p.bills ?? []).map((b) => b.id) : []))
}

/** A queued create whose drain the server refused: the entry ends as `conflict`. */
async function conflictedCreate(title: string): Promise<{ billId: string; entry: Entry }> {
  setOnline(false)
  const billId = await createBill(billInput(title))
  setOnline(true)
  cloud.rejectIds.add(billId)
  await drain()
  cloud.rejectIds.delete(billId)
  const entry = (await entries()).find((e) => e.push?.bills?.some((b) => b.id === billId))!
  return { billId, entry }
}

beforeEach(async () => {
  await resetDb()
  localStorage.clear()
  cloud.mode = 'ok'
  cloud.status = 0
  cloud.rejectIds = new Set()
  cloud.pushes = []
  cloud.submissionIds = []
  cloud.rpcNames = []
  cloud.seen = new Map()
  cloud.server = new Map()
  cloud.reconcilePayload = null
  cloud.reconcileCalls = []
  cloud.inserts = []
  cloud.hold = null
  cloud.holdIds = null
  cloud.errorCode = undefined
  cloud.errorStatus = undefined
  writeQueue.cancelScheduledDrainRetry()
  setOnline(true)
  await db.profiles.bulkAdd([
    makeProfile({ id: 'ME', display_name: 'Me' }),
    makeProfile({ id: 'FR', display_name: 'Friend', is_local: true, owner_id: 'ME' }),
    makeProfile({ id: 'LK', display_name: 'Linked', is_local: true, owner_id: 'ME', linked_profile_id: 'ACC-L' }),
    makeProfile({ id: 'ACC-L', display_name: 'Linked account', email: 'l@example.com' }),
  ])
})

afterEach(() => setOnline(true))

describe('C13: the queue drains in seq order', () => {
  it('C13: entries replay oldest first, one kwenta_write each, and are deleted once applied', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    const b = await createBill(billInput('B'))
    const queued = await entries()
    expect(queued.map((e) => e.push?.bills?.[0]?.id)).toEqual([a, b])
    expect(queued[0].seq).toBeLessThan(queued[1].seq)

    setOnline(true)
    await drain()

    expect(cloud.rpcNames.filter((n) => n === 'kwenta_write')).toHaveLength(2)
    expect(pushedBillIds()).toEqual([a, b])
    expect(cloud.submissionIds).toEqual(queued.map((e) => e.submission_id))
    expect(await db.pending_mutations.count()).toBe(0)
    expect((await db.bills.get(a))?.synced_at).not.toBeNull()
    expect((await db.bills.get(b))?.synced_at).not.toBeNull()
  })

  it('C13: a drain bumps dataVersion exactly once however many entries it applies', async () => {
    setOnline(false)
    await createBill(billInput('A'))
    await createBill(billInput('B'))
    await createBill(billInput('C'))
    setOnline(true)
    const before = useAppStore.getState().dataVersion

    await drain()

    expect(useAppStore.getState().dataVersion - before).toBe(1)
  })

  it('C13: a transport failure at the head blocks every later entry', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    await createBill(billInput('B'))
    setOnline(true)
    cloud.mode = 'transport'

    await drain()

    expect(pushedBillIds()).toEqual([a])
    const after = await entries()
    expect(after.map((e) => e.status)).toEqual(['pending', 'pending'])
    expect(after[0].last_error_kind).toBe('transport')
    expect(after[0].next_attempt_at).not.toBeNull()
  })

  it('C13: a head in backoff is not re-sent by an immediate second drain', async () => {
    setOnline(false)
    await createBill(billInput('A'))
    setOnline(true)
    cloud.mode = 'transport'
    await drain()
    const callsAfterFirst = cloud.pushes.length

    await drain()

    expect(cloud.pushes.length).toBe(callsAfterFirst)
  })

  it('C13: a rejection marks the entry conflict, blocks dependents sharing its rows, and lets independent entries apply', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    await updateBill(a, 'ME', {
      title: 'A2',
      note: '',
      currency: 'PHP',
      items: [{ name: 'Pasta', amount: 200, splits: [] }],
    })
    const c = await createBill(billInput('C'))
    const queued = await entries()
    expect(queued).toHaveLength(3)
    setOnline(true)
    cloud.rejectIds = new Set([a])

    await drain()

    const byId = new Map((await entries()).map((e) => [e.id, e]))
    expect(byId.get(queued[0].id)?.status).toBe('conflict')
    expect(byId.get(queued[1].id)?.status).toBe('blocked_by_earlier')
    expect(byId.has(queued[2].id)).toBe(false)
    expect(cloud.pushes.flatMap((p) => p.bills ?? []).filter((b) => b.title === 'A2')).toHaveLength(0)
    expect((await db.bills.get(c))?.synced_at).not.toBeNull()

    const notApplied = await db.not_applied_changes.toArray()
    expect(notApplied).toHaveLength(1)
    expect(notApplied[0].pending_mutation_id).toBe(queued[0].id)
    expect(notApplied[0].resolution).toBe('pending')
  })
})

describe('C15: a network blip is not a refusal', () => {
  it('C15: a transport failure during a drain marks nothing as not applied', async () => {
    setOnline(false)
    await createBill(billInput('A'))
    await createBill(billInput('B'))
    setOnline(true)
    cloud.mode = 'transport'

    await drain()

    expect(await db.not_applied_changes.count()).toBe(0)
    expect((await entries()).every((e) => e.status === 'pending')).toBe(true)
  })

  it('C15: a failing full sync leaves queued entries pending', async () => {
    setOnline(false)
    await createBill(billInput('A'))
    setOnline(true)
    cloud.mode = 'transport'

    await syncRoundTrip('ME')

    expect(await db.not_applied_changes.count()).toBe(0)
    expect((await entries()).map((e) => e.status)).toEqual(['pending'])
  })
})

describe('C11: a lost response replays with the same submission id', () => {
  it('C11: server applied, client saw a transport error, then drain: exactly one bill on the server', async () => {
    cloud.mode = 'lost'
    const billId = await createBill(billInput('A'))

    expect(cloud.server.get('bills')?.size).toBe(1)
    const [entry] = await entries()
    expect(entry.status).toBe('pending')
    expect(entry.submission_id).toBe(cloud.submissionIds[0])

    cloud.mode = 'ok'
    await drain()

    expect(cloud.server.get('bills')?.size).toBe(1)
    expect([...cloud.server.get('bills')!.keys()]).toEqual([billId])
    expect(cloud.submissionIds).toHaveLength(2)
    expect(cloud.submissionIds[1]).toBe(cloud.submissionIds[0])
    expect(await db.pending_mutations.count()).toBe(0)
    expect(await db.bills.count()).toBe(1)
    expect((await db.bills.get(billId))?.synced_at).not.toBeNull()
  })
})

describe('C14: Dismiss and Retry', () => {
  it('C14: Dismiss refuses a pending (never refused) entry', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    setOnline(true)
    const [entry] = await entries()

    await dismiss(entry.id).catch(() => undefined)

    expect((await entries()).map((e) => e.id)).toEqual([entry.id])
    expect(await db.bills.get(a)).toBeTruthy()
  })

  it('C14: Dismiss refuses while offline, even for a conflict entry', async () => {
    const { billId, entry } = await conflictedCreate('A')
    setOnline(false)

    await dismiss(entry.id).catch(() => undefined)

    expect((await db.pending_mutations.get(entry.id)) as unknown as Entry).toMatchObject({ status: 'conflict' })
    expect(await db.bills.get(billId)).toBeTruthy()
  })

  it('C14: dismissing a refused create deletes the never-synced rows it created and its blocked dependents', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    await updateBill(a, 'ME', { title: 'A2', note: '', currency: 'PHP', items: [{ name: 'Pasta', amount: 200, splits: [] }] })
    setOnline(true)
    cloud.rejectIds = new Set([a])
    await drain()
    const [head] = await entries()
    expect(head.status).toBe('conflict')

    await dismiss(head.id)

    expect(await db.bills.get(a)).toBeUndefined()
    expect(await db.bill_items.where('bill_id').equals(a).count()).toBe(0)
    expect(await db.item_splits.count()).toBe(0)
    expect(await db.pending_mutations.count()).toBe(0)
    expect((await db.not_applied_changes.toArray()).filter((c) => c.resolution === 'pending')).toHaveLength(0)
  })

  it('C14: dismissing a refused edit restores the edited rows from the server', async () => {
    const bill = makeBill({ id: 'E', created_by: 'ME', paid_by: 'ME', group_id: null, title: 'Lunch', total_amount: 100 })
    const item = makeItem({ id: 'EI', bill_id: 'E', name: 'Pizza', amount: 100 })
    const s1 = makeSplit({ id: 'ES1', item_id: 'EI', user_id: 'ME', computed_amount: 50 })
    const s2 = makeSplit({ id: 'ES2', item_id: 'EI', user_id: 'FR', computed_amount: 50 })
    const synced = <T extends { updated_at: string }>(r: T) => ({ ...r, synced_at: r.updated_at })
    await db.bills.add(synced(bill))
    await db.bill_items.add(synced(item))
    await db.item_splits.bulkAdd([synced(s1), synced(s2)])

    setOnline(false)
    await updateBill('E', 'ME', { title: 'Dinner', note: '', currency: 'PHP', items: [{ name: 'Pasta', amount: 500, splits: [] }] })
    expect((await db.bills.get('E'))?.title).toBe('Dinner')
    setOnline(true)
    cloud.rejectIds = new Set(['E'])
    await drain()
    const [entry] = await entries()
    expect(entry.status).toBe('conflict')

    cloud.reconcilePayload = { bills: [bill], bill_items: [item], item_splits: [s1, s2] }
    await dismiss(entry.id)

    // 028's kwenta_reconcile_user_event takes the TABLE name ('bills'); 'bill' returns an empty bundle.
    expect(cloud.reconcileCalls[0]).toMatchObject({ p_entity_type: 'bills', p_entity_id: 'E' })
    const restored = await db.bills.get('E')
    expect(restored?.title).toBe('Lunch')
    expect(restored?.total_amount).toBe(100)
    expect(restored?.synced_at).not.toBeNull()
    const live = (await db.bill_items.where('bill_id').equals('E').toArray()).filter((i) => !i.is_deleted)
    expect(live.map((i) => i.name)).toEqual(['Pizza'])
    expect(await db.pending_mutations.count()).toBe(0)
  })

  it('C14: Retry resets a refused entry and drains it', async () => {
    const { billId, entry } = await conflictedCreate('A')

    await retry(entry.id)

    expect(await db.pending_mutations.count()).toBe(0)
    expect((await db.bills.get(billId))?.synced_at).not.toBeNull()
    expect(cloud.submissionIds.at(-1)).toBe(entry.submission_id)
    expect((await db.not_applied_changes.toArray()).filter((c) => c.resolution === 'pending')).toHaveLength(0)
  })
})

describe('C16: notifications follow their queue entry', () => {
  function outbox(): { submissionId?: string; rows: unknown[] }[] {
    return JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]')
  }

  it('C16: a queued write’s notification carries its submission id and is held until the entry applies', async () => {
    setOnline(false)
    await createBill(billInput('A', 'LK'))
    const [entry] = await entries()
    await vi.waitFor(() => expect(outbox()).toHaveLength(1))
    expect(outbox()[0].submissionId).toBe(entry.submission_id)

    setOnline(true)
    cloud.mode = 'transport'
    await flushQueuedKwentaNotifications()
    expect(cloud.inserts.filter((i) => i.table === 'kwenta_notifications')).toHaveLength(0)

    cloud.mode = 'ok'
    await drain()
    await flushQueuedKwentaNotifications()
    const sent = cloud.inserts.filter((i) => i.table === 'kwenta_notifications').flatMap((i) => i.rows as { recipient_id: string }[])
    expect(sent.map((r) => r.recipient_id)).toEqual(['ACC-L'])
  })

  it('C16: a rejected entry’s notification is dropped, never sent', async () => {
    setOnline(false)
    const a = await createBill(billInput('A', 'LK'))
    const [entry] = await entries()
    await vi.waitFor(() => expect(outbox()).toHaveLength(1))

    setOnline(true)
    cloud.rejectIds = new Set([a])
    await drain()
    await flushQueuedKwentaNotifications()

    expect(outbox().filter((e) => e.submissionId === entry.submission_id)).toHaveLength(0)
    expect(cloud.inserts.filter((i) => i.table === 'kwenta_notifications')).toHaveLength(0)
  })
})

describe('C31: a full sync never pushes queue-owned rows (H1.1)', () => {
  it('C31: only the untracked unsynced row rides kwenta_sync; the pending entry’s rows do not', async () => {
    setOnline(false)
    const queuedId = await createBill(billInput('A'))
    await db.bills.add({ ...makeBill({ id: 'U', created_by: 'ME', paid_by: 'ME', group_id: null }), synced_at: null })
    setOnline(true)

    await syncRoundTrip('ME')

    const ids = billIdsVia('kwenta_sync')
    expect(ids).toContain('U')
    expect(ids).not.toContain(queuedId)
  })

  it('C31: rows of a conflict entry and of its blocked dependent are not pushed either', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    await updateBill(a, 'ME', { title: 'A2', note: '', currency: 'PHP', items: [{ name: 'Pasta', amount: 200, splits: [] }] })
    setOnline(true)
    cloud.rejectIds = new Set([a])
    await drain()
    cloud.rejectIds = new Set()
    cloud.pushes = []
    cloud.rpcNames = []

    await syncRoundTrip('ME')

    expect(cloud.pushes.flatMap((p) => (p.bills ?? []).map((b) => b.id))).not.toContain(a)
  })
})

describe('C32: queue-owned rows are not "staged for a full sync" (H1.2)', () => {
  it('C32: a conflict entry makes neither gate want a full sync', async () => {
    await conflictedCreate('A')

    expect(await hasUnsyncedLocalDataForUser('ME')).toBe(false)
    expect(await mayHaveStagedRows()).toBe(false)
  })

  it('C32: a pending entry with an exact push is a drain, not a full sync', async () => {
    setOnline(false)
    await createBill(billInput('A'))
    setOnline(true)

    expect(await hasUnsyncedLocalDataForUser('ME')).toBe(false)
  })

  it('C32: an untracked unsynced row still counts', async () => {
    await conflictedCreate('A')
    await db.bills.add({ ...makeBill({ id: 'U', created_by: 'ME', paid_by: 'ME', group_id: null }), synced_at: null })

    expect(await hasUnsyncedLocalDataForUser('ME')).toBe(true)
    expect(await mayHaveStagedRows()).toBe(true)
  })
})

describe('C37: only pending entries block a direct submit (H1.7)', () => {
  it('C37: with only a conflict entry queued, an online save submits directly', async () => {
    const { billId: a } = await conflictedCreate('A')
    cloud.pushes = []

    const b = await createBill(billInput('B'))

    expect(pushedBillIds()).toEqual([b])
    expect((await db.bills.get(b))?.synced_at).not.toBeNull()
    const left = await entries()
    expect(left).toHaveLength(1)
    expect(left[0].status).toBe('conflict')
    expect(left[0].push?.bills?.[0]?.id).toBe(a)
  })

  it('C37: with only a conflict entry queued, a rejected online save throws to the form', async () => {
    await conflictedCreate('A')
    const before = await db.bills.count()
    cloud.mode = 'reject'

    await expect(createBill(billInput('B'))).rejects.toThrow()

    expect(await db.bills.count()).toBe(before)
    expect(await db.pending_mutations.count()).toBe(1)
  })

  it('C37: a pending head keeps order — a new save queues behind it and is never sent ahead of it', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    setOnline(true)
    cloud.mode = 'transport'

    const b = await createBill(billInput('B'))

    expect(pushedBillIds()).not.toContain(b)
    const queued = await entries()
    expect(queued.map((e) => e.push?.bills?.[0]?.id)).toEqual([a, b])
  })
})

describe('C17: legacy (push = null) entries use the row-scan safety net', () => {
  it('C17: a drain sends no kwenta_write for a legacy entry; its staged row still rides kwenta_sync', async () => {
    await db.bills.add({ ...makeBill({ id: 'L', created_by: 'ME', paid_by: 'ME', group_id: null }), synced_at: null })
    await db.pending_mutations.add({
      id: 'LEG', actor_user_id: 'ME', operation: 'createBill', entity_type: 'bill', entity_id: 'L',
      payload_json: '{}', status: 'pending', retry_count: 0, last_error: null,
      seq: 1, submission_id: 'IK-LEG', push: null, row_keys: [], next_attempt_at: null, last_error_kind: null,
      created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
    } as never)

    await drain()
    expect(billIdsVia('kwenta_write')).not.toContain('L')

    await syncRoundTrip('ME')
    expect(billIdsVia('kwenta_sync')).toContain('L')
  })
})

describe('review H1.1: a retried entry is never overtaken by its dependents', () => {
  it('Retry during the drain that refused the entry sends it before the edit built on it', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    await updateBill(a, 'ME', { title: 'A2', note: '', currency: 'PHP', items: [{ name: 'Pasta', amount: 200, splits: [] }] })
    const c = await createBill(billInput('C'))
    setOnline(true)
    cloud.rejectIds = new Set([a])
    let release!: () => void
    cloud.hold = new Promise<void>((r) => {
      release = r
    })
    cloud.holdIds = new Set([c])

    const running = drain()
    // A was refused (A2 blocked) and C is in flight: the drain is still running.
    await vi.waitFor(() => expect(pushedBillIds()).toContain(c))
    const refused = (await entries()).find((e) => e.status === 'conflict')!
    expect(refused.push?.bills?.[0]?.id).toBe(a)

    cloud.rejectIds = new Set()
    const retried = retry(refused.id)
    release()
    await running
    const ok = await retried

    expect(ok).toBe(true)
    const titlesForA = cloud.pushes.flatMap((p) => (p.bills ?? []).filter((b) => b.id === a).map((b) => b.title))
    expect(titlesForA).toEqual(['A', 'A', 'A2'])
    expect(await db.pending_mutations.count()).toBe(0)
  })
})

describe('review H1.2: a backed-off entry is retried without waiting for a focus', () => {
  it('a transport failure schedules one drain at next_attempt_at, which sends the entry', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    setOnline(true)
    cloud.mode = 'transport'
    const spy = vi.spyOn(globalThis, 'setTimeout')
    try {
      await drain()
      const [entry] = await entries()
      const delay = Number(entry.next_attempt_at) - Date.now()
      const scheduled = spy.mock.calls.filter(([, ms]) => typeof ms === 'number' && ms > 20_000 && ms <= 30_000)
      expect(delay).toBeGreaterThan(20_000)
      expect(scheduled).toHaveLength(1)

      // Time passes: the backoff is over when the timer fires.
      await db.pending_mutations.update(entry.id, { next_attempt_at: Date.now() - 1 })
      cloud.mode = 'ok'
      ;(scheduled[0][0] as () => void)()

      await vi.waitFor(async () => expect(await db.pending_mutations.count()).toBe(0))
      expect((await db.bills.get(a))?.synced_at).not.toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('a save that fails in transit schedules a retry too', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout')
    try {
      cloud.mode = 'transport'
      await createBill(billInput('A'))
      expect(spy.mock.calls.some(([, ms]) => typeof ms === 'number' && ms > 20_000 && ms <= 30_000)).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('ignoreBackoff (a user-initiated Refresh) sends a backed-off head now', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    setOnline(true)
    cloud.mode = 'transport'
    await drain()
    expect((await entries())[0].next_attempt_at).not.toBeNull()
    cloud.mode = 'ok'

    await drain()
    expect(await db.pending_mutations.count()).toBe(1)

    await writeQueue.drainWriteQueue('ME', { ignoreBackoff: true })
    expect(await db.pending_mutations.count()).toBe(0)
    expect((await db.bills.get(a))?.synced_at).not.toBeNull()
  })
})

describe('review C2.1: Dismiss waits for a later pending change to the same rows', () => {
  it('refuses while a pending entry shares rows with the refused one, and changes nothing', async () => {
    const { billId, entry } = await conflictedCreate('A')
    // An edit queued AFTER the refusal: pending, not blocked, until the drain reaches it.
    setOnline(false)
    await updateBill(billId, 'ME', { title: 'A2', note: '', currency: 'PHP', items: [{ name: 'Pasta', amount: 200, splits: [] }] })
    setOnline(true)

    await expect(dismiss(entry.id)).rejects.toThrow(/still waiting to be sent/)

    expect(await db.pending_mutations.count()).toBe(2)
    expect((await db.bills.get(billId))?.title).toBe('A2')
    expect(cloud.reconcileCalls).toHaveLength(0)
  })
})

describe('review H2.2: a PostgREST server-state error during a drain is a transport failure', () => {
  it('PGRST002 (503, schema cache loading) at the head leaves it pending with backoff, marks nothing conflict and keeps its notification', async () => {
    setOnline(false)
    await createBill(billInput('A', 'LK'))
    await createBill(billInput('B'))
    const [head] = await entries()
    await vi.waitFor(() =>
      expect(JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]')).toHaveLength(1),
    )
    setOnline(true)
    cloud.mode = 'reject'
    cloud.errorCode = 'PGRST002'
    cloud.errorStatus = 503

    await drain()

    const after = await entries()
    expect(after.map((e) => e.status)).toEqual(['pending', 'pending'])
    expect(after[0].last_error_kind).toBe('transport')
    expect(after[0].next_attempt_at).not.toBeNull()
    expect(await db.not_applied_changes.count()).toBe(0)
    const kept = (JSON.parse(localStorage.getItem(OUTBOX_KEY) ?? '[]') as { submissionId?: string }[]).filter(
      (e) => e.submissionId === head.submission_id,
    )
    expect(kept).toHaveLength(1)
  })
})

describe('review-5 H5.1: a write is sent only under its own account\'s session', () => {
  function signedInAs(userId: string) {
    return vi
      .spyOn(supabase.auth, 'getSession')
      .mockResolvedValue({ data: { session: { user: { id: userId } } } } as never)
  }

  it('a retry timer armed for A that fires while B is signed in sends nothing and leaves the entry byte-identical', async () => {
    setOnline(false)
    await createBill(billInput('A'))
    setOnline(true)
    cloud.mode = 'transport'
    const timers = vi.spyOn(globalThis, 'setTimeout')
    let session: ReturnType<typeof signedInAs> | undefined
    try {
      await drain()
      const armed = timers.mock.calls.filter(([, ms]) => typeof ms === 'number' && ms > 20_000 && ms <= 30_000)
      expect(armed).toHaveLength(1)

      // A's session ended without a wipe; B signed in on this tab. The backoff is over.
      const [entry] = await entries()
      await db.pending_mutations.update(entry.id, { next_attempt_at: Date.now() - 1 })
      const before = await db.pending_mutations.get(entry.id)
      cloud.mode = 'ok'
      session = signedInAs('B')
      const writesBefore = cloud.rpcNames.filter((n) => n === 'kwenta_write').length

      ;(armed[0][0] as () => void)()
      await new Promise((r) => setTimeout(r, 30))

      expect(cloud.rpcNames.filter((n) => n === 'kwenta_write').length).toBe(writesBefore)
      expect(await db.pending_mutations.get(entry.id)).toEqual(before)
      expect(await db.not_applied_changes.count()).toBe(0)
    } finally {
      timers.mockRestore()
      session?.mockRestore()
    }
  })

  it('a drain for A while B is signed in sends nothing, even ignoring backoff', async () => {
    setOnline(false)
    await createBill(billInput('A'))
    setOnline(true)
    const [before] = await entries()
    const session = signedInAs('B')
    try {
      await writeQueue.drainWriteQueue('ME', { ignoreBackoff: true })
    } finally {
      session.mockRestore()
    }

    expect(cloud.rpcNames).not.toContain('kwenta_write')
    expect(await db.pending_mutations.get(before.id)).toEqual(before)
  })

  it('an online save by A while B is signed in throws without sending or staging anything', async () => {
    const session = signedInAs('B')
    try {
      await expect(createBill(billInput('A'))).rejects.toThrow(/different account/)
    } finally {
      session.mockRestore()
    }

    expect(cloud.rpcNames).not.toContain('kwenta_write')
    expect(await db.bills.count()).toBe(0)
    expect(await db.pending_mutations.count()).toBe(0)
  })
})

describe('review-5 C5.2: the last send before a wipe does not inherit a background drain\'s backoff', () => {
  it('joining a running drain that stops at a backed-off entry still sends it', async () => {
    setOnline(false)
    const a = await createBill(billInput('A'))
    await createBill(billInput('B'))
    const [, second] = await entries()
    await db.pending_mutations.update(second.id, { next_attempt_at: Date.now() + 60_000 })
    setOnline(true)
    let release!: () => void
    cloud.hold = new Promise<void>((r) => {
      release = r
    })
    cloud.holdIds = new Set([a])

    const background = drain()
    await vi.waitFor(() => expect(pushedBillIds()).toContain(a))
    const wipe = writeQueue.sendUnsentWritesBeforeWipe('ME')
    release()
    await background
    const { stillUnsent } = await wipe

    expect(await db.pending_mutations.count()).toBe(0)
    expect(stillUnsent).toBe(false)
  })
})
