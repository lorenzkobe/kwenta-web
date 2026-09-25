import { describe, expect, it } from 'vitest'
import Dexie from 'dexie'

// C17: a device upgrading from Dexie v14 keeps its queued offline writes. The v14 schema below is
// copied from src/db/db.ts's `this.version(14).stores({...})` block as it shipped; the legacy row
// shape from `PendingMutation` in src/types/index.ts before v15 (idempotency_key, no seq/push).
//
// `@/db/db` is imported only AFTER the v14 database exists, so the app's db opens it and runs the
// v15 upgrade on real v14 data.

const V14 = {
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
  pending_mutations: 'id, actor_user_id, status, entity_type, entity_id, created_at, updated_at',
  not_applied_changes:
    'id, actor_user_id, resolution, entity_type, entity_id, [entity_type+entity_id], created_at, resolved_at, pending_mutation_id',
}

function legacy(id: string, createdAt: string, idempotencyKey: string, status = 'pending') {
  return {
    id,
    actor_user_id: 'ME',
    operation: 'createBill',
    entity_type: 'bill',
    entity_id: `B-${id}`,
    payload_json: '{}',
    status,
    retry_count: 0,
    last_error: null,
    idempotency_key: idempotencyKey,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

describe('C17: Dexie v14 -> v15 upgrade', () => {
  it('C17: backfills legacy pending_mutations: push null, seq by created_at, submission_id from idempotency_key', async () => {
    await Dexie.delete('kwenta')
    const old = new Dexie('kwenta')
    old.version(14).stores(V14)
    await old.open()
    // Inserted out of created_at order on purpose: seq must follow created_at, not insertion.
    await old.table('pending_mutations').bulkAdd([
      legacy('P2', '2026-09-02T00:00:00.000Z', 'IK-2'),
      legacy('P1', '2026-09-01T00:00:00.000Z', 'IK-1'),
      legacy('P3', '2026-09-03T00:00:00.000Z', 'IK-3'),
    ])
    await old.table('bills').add({
      id: 'KEEP', group_id: null, created_by: 'ME', paid_by: 'ME', title: 'Kept', total_amount: 1,
      currency: 'PHP', note: '', created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-01T00:00:00.000Z',
      synced_at: null, is_deleted: false, device_id: 'd',
    })
    old.close()

    const { db } = await import('@/db/db')
    await db.open()

    expect(db.verno).toBe(15)
    const rows = (await db.pending_mutations.toArray()) as unknown as {
      id: string
      seq: number
      submission_id: string
      push: unknown
      status: string
    }[]
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(rows).toHaveLength(3)
    for (const r of rows) expect(r.push).toBeNull()
    expect(byId.get('P1')!.submission_id).toBe('IK-1')
    expect(byId.get('P2')!.submission_id).toBe('IK-2')
    expect(byId.get('P3')!.submission_id).toBe('IK-3')
    expect(byId.get('P1')!.seq).toBeLessThan(byId.get('P2')!.seq)
    expect(byId.get('P2')!.seq).toBeLessThan(byId.get('P3')!.seq)
    expect(rows.every((r) => r.status === 'pending')).toBe(true)

    // The staged row the legacy entry stands for survives the upgrade untouched.
    expect((await db.bills.get('KEEP'))?.synced_at).toBeNull()

    // The v15 index the drain reads in order.
    const ordered = await db.pending_mutations
      .where('[actor_user_id+status+seq]')
      .between(['ME', 'pending', Dexie.minKey], ['ME', 'pending', Dexie.maxKey])
      .toArray()
    expect(ordered.map((r) => r.id)).toEqual(['P1', 'P2', 'P3'])
    db.close()
  })
})
