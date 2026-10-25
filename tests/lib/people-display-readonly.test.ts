import { liveQuery } from 'dexie'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { getBillWithDetails } from '@/db/operations'
import { loadProfilesIntoMirror, resolveProfileDisplay } from '@/lib/people'
import { makeProfile, resetDb } from '../helpers/db'

/**
 * cloud-first-guards-and-screens, C18. `resolveProfileDisplay` runs inside `useLiveQuery` (the
 * Person page), where Dexie forbids writes: fetching a missing profile there threw ReadOnlyError and
 * blanked the screen. It reads only; loading what it needs happens first, outside any live query.
 */

const server = vi.hoisted(() => ({
  profiles: new Map<string, unknown>(),
  calls: [] as string[],
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async (_fn: string, args: { p_id: string }) => {
      server.calls.push(args.p_id)
      return { data: server.profiles.get(args.p_id) ?? null, error: null }
    },
  },
}))

function firstValue<T>(query: () => Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const sub = liveQuery(query).subscribe({
      next: (value) => {
        sub.unsubscribe()
        resolve(value)
      },
      error: reject,
    })
  })
}

beforeEach(async () => {
  await resetDb()
  server.profiles.clear()
  server.calls = []
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
  await db.profiles.add(
    makeProfile({ id: 'LOCAL', display_name: 'Remy', email: '', is_local: true, owner_id: 'ME', linked_profile_id: 'REMOTE' }),
  )
  server.profiles.set('REMOTE', makeProfile({ id: 'REMOTE', display_name: 'Remy R', email: 'r@example.com', is_local: false }))
})

describe('C18: resolveProfileDisplay is read-only', () => {
  it('in a live query, a linked contact whose account profile is missing resolves to the fallback and writes nothing', async () => {
    const label = await firstValue(() => resolveProfileDisplay('LOCAL', 'ME'))

    expect(label).toEqual({ displayName: 'Remy', subtitle: 'Linked · Loading their profile…' })
    expect(server.calls).toEqual([])
    expect(await db.profiles.get('REMOTE')).toBeUndefined()
  })

  it('in a live query, a profile that is not on the device resolves to Unknown instead of throwing', async () => {
    await expect(firstValue(() => resolveProfileDisplay('GHOST', 'ME'))).resolves.toEqual({ displayName: 'Unknown' })
    expect(server.calls).toEqual([])
  })
})

describe('C18: loadProfilesIntoMirror loads what a read-only resolve will need', () => {
  it('fetches a missing linked account once, so the next resolve shows it', async () => {
    await loadProfilesIntoMirror(['LOCAL'])

    expect(server.calls).toEqual(['REMOTE'])
    expect(await resolveProfileDisplay('LOCAL', 'ME')).toEqual({ displayName: 'Remy', subtitle: 'Linked · Remy R' })
  })

  it('fetches each missing id once, and nothing for profiles already on the device', async () => {
    server.profiles.set('X', makeProfile({ id: 'X', display_name: 'Xan', is_local: false }))

    await loadProfilesIntoMirror(['X', 'X', 'LOCAL', 'X'])

    expect([...server.calls].sort()).toEqual(['REMOTE', 'X'])
    server.calls = []
    await loadProfilesIntoMirror(['X', 'LOCAL'])
    expect(server.calls).toEqual([])
  })

  it('offline makes no request and does not throw', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false })

    await expect(loadProfilesIntoMirror(['LOCAL', 'X'])).resolves.toBeUndefined()
    expect(server.calls).toEqual([])
  })
})

describe('C20: getBillWithDetails is read-only', () => {
  const stamp = { created_at: '2026-06-18T00:00:00.000Z', updated_at: '2026-06-18T00:00:00.000Z', synced_at: '2026-06-18T00:00:00.000Z', is_deleted: false, device_id: 'd' }

  beforeEach(async () => {
    server.profiles.set('COCONTACT', makeProfile({ id: 'COCONTACT', display_name: 'Co', email: '', is_local: true, owner_id: 'OTHER' }))
    await db.profiles.add(makeProfile({ id: 'ME', display_name: 'Me', is_local: false }))
    await db.bills.add({ ...stamp, id: 'B', group_id: 'G', created_by: 'ME', paid_by: 'PAYER', title: 't', total_amount: 10, currency: 'PHP', note: null } as never)
    await db.bill_items.add({ ...stamp, id: 'I', bill_id: 'B', name: 'x', amount: 10 } as never)
    await db.item_splits.bulkAdd([
      { ...stamp, id: 'S1', item_id: 'I', user_id: 'COCONTACT', split_type: 'equal', split_value: 1, computed_amount: 5 },
      { ...stamp, id: 'S2', item_id: 'I', user_id: 'ME', split_type: 'equal', split_value: 1, computed_amount: 5 },
    ] as never)
    await db.group_members.add({ ...stamp, id: 'gm', group_id: 'G', user_id: 'COCONTACT', display_name: 'Co (roster)', joined_at: stamp.created_at } as never)
  })

  it('inside a live query, split users, creator and payer the device lacks fall back to the roster or Unknown, with no write and no request', async () => {
    const bill = await firstValue(() => getBillWithDetails('B'))

    expect(bill?.items[0].splits.map((s) => [s.user_id, s.displayName]).sort()).toEqual([
      ['COCONTACT', 'Co (roster)'],
      ['ME', 'Me'],
    ])
    expect(bill?.payorName).toBe('Unknown')
    expect(server.calls).toEqual([])
    expect(await db.profiles.get('COCONTACT')).toBeUndefined()
  })

  it('after loadProfilesIntoMirror the profile name is used', async () => {
    await loadProfilesIntoMirror(['COCONTACT'])

    const bill = await getBillWithDetails('B')

    expect(bill?.items[0].splits.find((s) => s.user_id === 'COCONTACT')?.displayName).toBe('Co')
  })
})
