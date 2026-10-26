import { describe, expect, it } from 'vitest'
import { readsUnaffectedBy } from '@/api/read-scope'
import type { CloudWritePayload } from '@/sync/cloud-write'
import {
  makeActivity,
  makeBill,
  makeGroup,
  makeItem,
  makeMember,
  makeProfile,
  makeSettlement,
  makeSplit,
} from '../helpers/db'

/**
 * Which screen families a write cannot change, so it neither asks the server to recompute them
 * (p_reads) nor makes them refetch. Families are the cache-key prefixes in src/api/balances.ts:
 * `bill-payments:<id>`, `group-payments:<id>`, `person-payments:<id>`, `group-spending:<id>`.
 *
 * Conservative by design: a NEW bill cannot appear in payment history (history reads a payment's
 * billTitle from bills, migration 069:100, and only an existing bill can be tagged), and a payment
 * cannot move group spending (064:27 reads only groups/bills/items/splits). Anything else skips
 * nothing.
 *
 * Hand-made rows: none — every row comes from the tests/helpers/db.ts factories.
 */

const bill = makeBill({ id: 'B', group_id: 'G', created_by: 'ME', paid_by: 'ME' })
const item = makeItem({ bill_id: 'B' })
const split = makeSplit({ item_id: item.id, user_id: 'FR' })
const activity = makeActivity({ user_id: 'ME' })
const settlement = makeSettlement({ from_user_id: 'FR', to_user_id: 'ME' })

const newBill: CloudWritePayload = {
  bills: [bill],
  bill_items: [item],
  item_splits: [split],
  activity_log: [activity],
}

describe('readsUnaffectedBy', () => {
  it('C24: a new bill skips the three payment-history families', () => {
    expect([...readsUnaffectedBy(newBill, { createsBill: true })].sort()).toEqual([
      'bill-payments',
      'group-payments',
      'person-payments',
    ])
  })

  it('C24: a new bill without an activity line skips the same families', () => {
    const payload: CloudWritePayload = { bills: [bill], bill_items: [item], item_splits: [split] }
    expect([...readsUnaffectedBy(payload, { createsBill: true })].sort()).toEqual([
      'bill-payments',
      'group-payments',
      'person-payments',
    ])
  })

  it('C24: a new bill never skips group detail or group spending', () => {
    const skipped = readsUnaffectedBy(newBill, { createsBill: true })
    expect(skipped).not.toContain('group')
    expect(skipped).not.toContain('group-spending')
    expect(skipped).not.toContain('overview')
  })

  it('C25: a payment skips group-spending only', () => {
    expect(readsUnaffectedBy({ settlements: [settlement], activity_log: [activity] })).toEqual([
      'group-spending',
    ])
  })

  it('C25: a multi-leg payment (several settlement rows) skips group-spending only', () => {
    const second = makeSettlement({ from_user_id: 'FR', to_user_id: 'ME', group_id: 'G' })
    expect(readsUnaffectedBy({ settlements: [settlement, second] })).toEqual(['group-spending'])
  })

  it('C26: an updateBill-shaped payload (createsBill falsy) skips nothing', () => {
    // An edited title appears in payment history (069 reads billTitle from bills).
    expect(readsUnaffectedBy({ bills: [bill], bill_items: [item], item_splits: [split] })).toEqual([])
    expect(readsUnaffectedBy(newBill)).toEqual([])
    expect(readsUnaffectedBy(newBill, { createsBill: false })).toEqual([])
  })

  it('C26: a deleteBill-shaped payload skips nothing', () => {
    const deleted = { ...bill, is_deleted: true }
    expect(readsUnaffectedBy({ bills: [deleted], activity_log: [activity] })).toEqual([])
  })

  it('C29: createsBill with any groups/group_members/profiles/peer-link row skips nothing', () => {
    const withGroup: CloudWritePayload = { ...newBill, groups: [makeGroup({ id: 'G' })] }
    const withMember: CloudWritePayload = { ...newBill, group_members: [makeMember({ group_id: 'G' })] }
    const withProfile: CloudWritePayload = { ...newBill, profiles: [makeProfile({ id: 'FR' })] }
    const withLink: CloudWritePayload = {
      ...newBill,
      profile_peer_links: [
        {
          id: 'L',
          owner_user_id: 'ME',
          anchor_profile_id: 'C1',
          peer_profile_id: 'C2',
          created_at: '2026-06-18T00:00:00.000Z',
          updated_at: '2026-06-18T00:00:00.000Z',
          synced_at: null,
          is_deleted: false,
          device_id: 'test-device',
        } as NonNullable<CloudWritePayload['profile_peer_links']>[number],
      ],
    }
    for (const p of [withGroup, withMember, withProfile, withLink]) {
      expect(readsUnaffectedBy(p, { createsBill: true })).toEqual([])
    }
  })

  it('C29: a payment with any other table skips nothing', () => {
    expect(readsUnaffectedBy({ settlements: [settlement], bills: [bill] })).toEqual([])
    expect(readsUnaffectedBy({ settlements: [settlement], group_members: [makeMember()] })).toEqual([])
    expect(readsUnaffectedBy({ settlements: [settlement], profiles: [makeProfile()] })).toEqual([])
  })

  it('C29: a bill created together with a payment skips nothing', () => {
    expect(readsUnaffectedBy({ ...newBill, settlements: [settlement] }, { createsBill: true })).toEqual([])
  })

  it('C29: an empty payload, or only an activity line, skips nothing', () => {
    expect(readsUnaffectedBy({})).toEqual([])
    expect(readsUnaffectedBy({}, { createsBill: true })).toEqual([])
    expect(readsUnaffectedBy({ bills: [], settlements: [] })).toEqual([])
    expect(readsUnaffectedBy({ activity_log: [activity] })).toEqual([])
  })
})
