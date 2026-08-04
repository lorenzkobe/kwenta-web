import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { createBill, deleteBill, recordPersonPayment, updateBill } from '@/db/operations'
import { makeGroup, makeMember, makeProfile, resetDb } from '../helpers/db'

// The cloud-first write contract: when the actor is ONLINE, a mutation is only visible
// locally once the server has accepted it. Here the Supabase RPC is driven directly, so
// the real `submitCloudWrite` logic is under test rather than mocked around.
//
// This is the guarantee that closes the duplicate-on-retry bug. Before the write path was
// inverted, `createBill` committed its Dexie transaction *first* and called the cloud
// afterwards, so a rejected write left a fully-formed bill on screen with `synced_at = null`.
// The user, still looking at the filled form and an error toast, pressed Save again — which
// minted a NEW bill id — and the next background sync pushed BOTH unsynced rows. A submission
// id cannot catch that: the second attempt is a genuinely different payload. Only "nothing
// lands on failure" can.

const cloud = vi.hoisted(() => ({
  /** 'ok' echoes the push back as stored; 'error' is a transport failure; 'drop' is a
   *  silent server-side rejection (accepted by the RPC, never stored). */
  mode: 'ok' as 'ok' | 'error' | 'drop',
  /** Tables the fake server refuses to store, to simulate a partial server-side drop. */
  refuse: new Set<string>(),
  pushes: [] as Record<string, { id: string }[]>[],
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

beforeEach(async () => {
  await resetDb()
  cloud.mode = 'ok'
  cloud.refuse = new Set()
  cloud.pushes = []
  await db.profiles.bulkAdd([
    makeProfile({ id: 'ME', display_name: 'Me' }),
    makeProfile({ id: 'FR', display_name: 'Friend', is_local: true, owner_id: 'ME' }),
  ])
})

describe('cloud-first write contract', () => {
  it('persists the bill when the cloud accepts it', async () => {
    const billId = await createBill(BILL_INPUT)

    const bill = await db.bills.get(billId)
    expect(bill).toBeTruthy()
    expect(await db.bill_items.where('bill_id').equals(billId).count()).toBe(1)
    expect(await db.item_splits.count()).toBe(2)
  })

  it('stores the server-confirmed row as synced, not as a pending local edit', async () => {
    const billId = await createBill(BILL_INPUT)

    // The row came back from the server, so it must not look like an unsynced local write —
    // otherwise the next round trip re-pushes a bill the server already has.
    const bill = await db.bills.get(billId)
    expect(bill?.synced_at).not.toBeNull()
  })

  it('sends the bill and its children in ONE round trip', async () => {
    await createBill(BILL_INPUT)

    expect(cloud.pushes).toHaveLength(1)
    const push = cloud.pushes[0]
    expect(push.bills).toHaveLength(1)
    expect(push.bill_items).toHaveLength(1)
    expect(push.item_splits).toHaveLength(2)
    // One RPC is one Postgres transaction, so the bill cannot land without its splits.
  })

  it('leaves Dexie untouched when the cloud rejects the write', async () => {
    cloud.mode = 'error'

    await expect(createBill(BILL_INPUT)).rejects.toThrow()

    // No orphan rows in ANY table the mutation touches. A surviving bill row is what the
    // user sees and retries against; surviving items/splits would corrupt balances even if
    // the bill itself were cleaned up.
    expect(await db.bills.count()).toBe(0)
    expect(await db.bill_items.count()).toBe(0)
    expect(await db.item_splits.count()).toBe(0)
    expect(await db.activity_log.count()).toBe(0)
  })

  it('leaves Dexie untouched when the cloud accepts the call but stores nothing', async () => {
    // Transport success, server-side drop (validator or RLS). Treating this as saved is how
    // silently-dropped writes used to look successful.
    cloud.mode = 'drop'

    await expect(createBill(BILL_INPUT)).rejects.toThrow()

    expect(await db.bills.count()).toBe(0)
    expect(await db.item_splits.count()).toBe(0)
  })

  it('still saves the bill when only the audit log row is not confirmed', async () => {
    // activity_log is an audit trail, not money. A bill that the server stored must not be
    // reported as failed because its log line could not be confirmed — that would turn a
    // cosmetic gap into a lost write, and would push the user toward a duplicate retry.
    cloud.refuse = new Set(['activity_log'])

    const billId = await createBill(BILL_INPUT)

    expect(await db.bills.get(billId)).toBeTruthy()
    expect(await db.item_splits.count()).toBe(2)
  })

  it('fails the whole write when a money row is not confirmed, even if others are', async () => {
    // The converse: splits carry the amounts. Half a bill is worse than no bill.
    cloud.refuse = new Set(['item_splits'])

    await expect(createBill(BILL_INPUT)).rejects.toThrow()

    expect(await db.bills.count()).toBe(0)
    expect(await db.bill_items.count()).toBe(0)
  })

  it('does not leave an unsynced row that a later background sync would push', async () => {
    cloud.mode = 'error'
    await expect(createBill(BILL_INPUT)).rejects.toThrow()

    // syncRoundTrip pushes every row with synced_at === null. A rejected write that stays
    // behind gets pushed later on its own, so the user's retry becomes a duplicate.
    const unsynced = (await db.bills.toArray()).filter((b) => b.synced_at === null)
    expect(unsynced).toHaveLength(0)
  })

  it('leaves the original bill intact when an update is rejected', async () => {
    const billId = await createBill(BILL_INPUT)
    cloud.mode = 'error'

    await expect(
      updateBill(billId, 'ME', {
        title: 'Dinner',
        note: 'changed',
        currency: 'PHP',
        items: [{ name: 'Pasta', amount: 500, splits: [] }],
      }),
    ).rejects.toThrow()

    // A rejected edit must not half-apply: the old title, amount and line items all stand.
    const bill = await db.bills.get(billId)
    expect(bill?.title).toBe('Lunch')
    expect(bill?.total_amount).toBe(100)
    const liveItems = (await db.bill_items.where('bill_id').equals(billId).toArray()).filter(
      (i) => !i.is_deleted,
    )
    expect(liveItems).toHaveLength(1)
    expect(liveItems[0].name).toBe('Pizza')
    expect((await db.item_splits.toArray()).filter((s) => !s.is_deleted)).toHaveLength(2)
  })

  it('leaves the bill undeleted when a delete is rejected', async () => {
    const billId = await createBill(BILL_INPUT)
    cloud.mode = 'error'

    await expect(deleteBill(billId, 'ME')).rejects.toThrow()

    expect((await db.bills.get(billId))?.is_deleted).toBe(false)
    expect((await db.item_splits.toArray()).filter((s) => !s.is_deleted)).toHaveLength(2)
  })

  it('applies an update and a delete when the cloud accepts them', async () => {
    const billId = await createBill(BILL_INPUT)

    await updateBill(billId, 'ME', {
      title: 'Dinner',
      note: '',
      currency: 'PHP',
      items: [{ name: 'Pasta', amount: 500, splits: [] }],
    })
    let bill = await db.bills.get(billId)
    expect(bill?.title).toBe('Dinner')
    expect(bill?.total_amount).toBe(500)

    await deleteBill(billId, 'ME')
    bill = await db.bills.get(billId)
    expect(bill?.is_deleted).toBe(true)
  })

  describe('multi-leg payments', () => {
    beforeEach(async () => {
      await db.groups.add(makeGroup({ id: 'G', created_by: 'ME', currency: 'PHP' }))
      await db.group_members.bulkAdd([
        makeMember({ group_id: 'G', user_id: 'ME' }),
        makeMember({ group_id: 'G', user_id: 'FR' }),
      ])
    })

    const PAYMENT = {
      meId: 'ME',
      otherId: 'FR',
      direction: 'they_paid_me' as const,
      totalAmount: 150,
      allocations: [
        { context: 'personal' as const, amount: 100 },
        { context: { groupId: 'G' }, amount: 50 },
      ],
      currency: 'PHP',
      markedBy: 'ME',
    }

    it('submits every leg in a single round trip', async () => {
      const { settlementIds, bundleId } = await recordPersonPayment(PAYMENT)

      expect(settlementIds).toHaveLength(2)
      expect(bundleId).not.toBeNull()
      // One transfer, one round trip — not one per leg.
      expect(cloud.pushes).toHaveLength(1)
      expect(cloud.pushes[0].settlements).toHaveLength(2)
      expect(await db.settlements.count()).toBe(2)
    })

    it('records no leg at all when the payment is rejected', async () => {
      cloud.mode = 'error'

      await expect(recordPersonPayment(PAYMENT)).rejects.toThrow()

      // A partial landing is the worst outcome: the group leg cleared but the personal one
      // not (or the reverse) misstates the balance in both directions at once.
      expect(await db.settlements.count()).toBe(0)
      expect(await db.activity_log.count()).toBe(0)
    })
  })

  it('a retry after a rejected write creates exactly one bill', async () => {
    cloud.mode = 'error'
    await expect(createBill(BILL_INPUT)).rejects.toThrow()

    // The user is still on the filled form; they press Save again and it succeeds.
    cloud.mode = 'ok'
    const billId = await createBill(BILL_INPUT)

    expect(await db.bills.count()).toBe(1)
    expect((await db.bills.toArray())[0].id).toBe(billId)
  })
})
