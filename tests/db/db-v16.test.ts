import { describe, expect, it } from 'vitest'
import Dexie from 'dexie'

// C11: a device upgrading from Dexie v15 opens its mirror under v16 and every existing bill, item
// and split reads as UNCONVERTED: original_currency / exchange_rate / rate_source / original_total
// on bills and original_amount on bill_items / item_splits are backfilled to null (not left
// undefined, which `=== null` checks and the staged rows would read as "absent" differently).
//
// The v15 schema below is copied from src/db/db.ts's `this.version(15).stores({...})` block as it
// shipped (HEAD before this task). The rows are the shape createBill wrote before 079 (no new keys).
// `@/db/db` is imported only AFTER the v15 database exists, so the app's db runs the v16 upgrade on
// real v15 data.

const V15 = {
  profiles: 'id, email, owner_id, linked_profile_id, synced_at, is_deleted, [owner_id+is_deleted]',
  groups: 'id, created_by, invite_code, synced_at, is_deleted, [created_by+is_deleted]',
  group_members:
    'id, group_id, user_id, [group_id+user_id], synced_at, is_deleted, [group_id+is_deleted], [user_id+is_deleted]',
  bills:
    'id, group_id, created_by, paid_by, created_at, synced_at, is_deleted, [created_by+group_id], [group_id+is_deleted], [created_by+is_deleted]',
  bill_items: 'id, bill_id, synced_at, is_deleted, [bill_id+is_deleted]',
  item_splits: 'id, item_id, user_id, synced_at, is_deleted, [item_id+is_deleted], [user_id+is_deleted]',
  settlements:
    'id, group_id, bill_id, bundle_id, from_user_id, to_user_id, is_settled, synced_at, is_deleted, [group_id+is_deleted], [bill_id+is_deleted], [from_user_id+to_user_id]',
  activity_log:
    'id, group_id, user_id, entity_type, entity_id, created_at, synced_at, is_deleted, [user_id+created_at]',
  profile_peer_links:
    'id, owner_user_id, anchor_profile_id, peer_profile_id, synced_at, is_deleted, [owner_user_id+anchor_profile_id], [owner_user_id+is_deleted]',
  pending_mutations:
    'id, actor_user_id, status, entity_type, entity_id, created_at, updated_at, seq, submission_id, *row_keys, [actor_user_id+status+seq]',
  not_applied_changes:
    'id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id',
}

const AT = '2026-10-01T00:00:00.000Z'
const sync = { created_at: AT, updated_at: AT, synced_at: AT, is_deleted: false, device_id: 'd' }

describe('C11: Dexie v15 -> v16 upgrade', () => {
  it('C11: backfills the conversion fields to null on existing bills, items and splits', async () => {
    await Dexie.delete('kwenta')
    const old = new Dexie('kwenta')
    old.version(15).stores(V15)
    await old.open()
    await old.table('bills').bulkAdd([
      { id: 'B1', group_id: null, created_by: 'ME', paid_by: 'ME', title: 'Lunch', total_amount: 100,
        currency: 'PHP', note: '', category: null, ...sync },
      // An unsent row must stay unsent: the upgrade is not a sync.
      { id: 'B2', group_id: 'G1', created_by: 'ME', paid_by: 'ME', title: 'Dinner', total_amount: 50,
        currency: 'USD', note: '', category: null, ...sync, synced_at: null },
    ])
    await old.table('bill_items').add({ id: 'I1', bill_id: 'B1', name: 'Pizza', amount: 100, ...sync })
    await old.table('item_splits').bulkAdd([
      { id: 'S1', item_id: 'I1', user_id: 'ME', split_type: 'equal', split_value: 1, computed_amount: 50, ...sync },
      { id: 'S2', item_id: 'I1', user_id: 'FR', split_type: 'equal', split_value: 1, computed_amount: 50, ...sync },
    ])
    old.close()

    const { db } = await import('@/db/db')
    await db.open()

    expect(db.verno).toBe(16)

    for (const id of ['B1', 'B2']) {
      const b = (await db.bills.get(id)) as unknown as Record<string, unknown>
      expect(b, id).toBeTruthy()
      for (const k of ['original_currency', 'exchange_rate', 'rate_source', 'original_total']) {
        expect(k in b, `${id}.${k} present`).toBe(true)
        expect(b[k], `${id}.${k}`).toBeNull()
      }
    }
    const b1 = await db.bills.get('B1')
    expect(b1?.total_amount).toBe(100)
    expect(b1?.currency).toBe('PHP')
    expect((await db.bills.get('B2'))?.synced_at).toBeNull()
    expect((await db.bills.get('B1'))?.synced_at).toBe(AT)

    const item = (await db.bill_items.get('I1')) as unknown as Record<string, unknown>
    expect('original_amount' in item).toBe(true)
    expect(item.original_amount).toBeNull()
    expect(item.amount).toBe(100)

    for (const id of ['S1', 'S2']) {
      const s = (await db.item_splits.get(id)) as unknown as Record<string, unknown>
      expect('original_amount' in s, id).toBe(true)
      expect(s.original_amount, id).toBeNull()
      expect(s.computed_amount).toBe(50)
    }
    db.close()
  })
})
