import { beforeEach, describe, expect, it } from 'vitest'
import { db } from '@/db/db'
import { searchLocalMirror } from '@/lib/local-search'
import { makeBill, makeGroup, makeProfile, resetDb } from '../helpers/db'

/**
 * The offline half of global search. `kwenta_search` (056) is authoritative and scopes results to
 * what the caller may read; this only runs when that call cannot be made, and it can only ever be
 * NARROWER, because the mirror holds rows the pull bundle already delivered to this user.
 */

const ME = 'me'

beforeEach(async () => {
  await resetDb()
  await db.profiles.add(makeProfile({ id: ME, display_name: 'Me' }))
})

describe('searchLocalMirror', () => {
  it('matches bills, groups and people case-insensitively on a substring', async () => {
    await db.bills.add(makeBill({ id: 'B1', title: 'Sushi Night', total_amount: 400 }))
    await db.groups.add(makeGroup({ id: 'G1', name: 'Sushi Club' }))
    await db.profiles.add(makeProfile({ id: 'P1', display_name: 'Sushi Sam' }))

    const results = await searchLocalMirror('sUsHi', ME)

    expect(results.bills.map((b) => b.title)).toEqual(['Sushi Night'])
    expect(results.groups.map((g) => g.name)).toEqual(['Sushi Club'])
    expect(results.profiles.map((p) => p.displayName)).toEqual(['Sushi Sam'])
  })

  it('finds a bill by email on a person', async () => {
    await db.profiles.add(makeProfile({ id: 'P1', display_name: 'Pat', email: 'pat@example.com' }))
    const results = await searchLocalMirror('pat@exam', ME)
    expect(results.profiles.map((p) => p.id)).toEqual(['P1'])
  })

  it('excludes deleted rows and the viewer themselves', async () => {
    await db.bills.add(makeBill({ id: 'B1', title: 'Ghost dinner', is_deleted: true }))
    await db.groups.add(makeGroup({ id: 'G1', name: 'Ghost group', is_deleted: true }))
    await db.profiles.update(ME, { display_name: 'Ghost me' })

    const results = await searchLocalMirror('ghost', ME)

    expect(results.bills).toEqual([])
    expect(results.groups).toEqual([])
    expect(results.profiles).toEqual([])
  })

  it('returns nothing for a blank query rather than everything', async () => {
    await db.bills.add(makeBill({ id: 'B1', title: 'Anything' }))
    expect(await searchLocalMirror('   ', ME)).toEqual({ bills: [], groups: [], profiles: [] })
  })

  it('caps each kind so a broad query cannot flood the sheet', async () => {
    await db.bills.bulkAdd(
      Array.from({ length: 25 }, (_, i) =>
        makeBill({ id: `B${i}`, title: `Lunch ${i}`, created_at: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
      ),
    )
    const results = await searchLocalMirror('lunch', ME)
    expect(results.bills).toHaveLength(10)
    // Newest first, so the cap keeps what the user most likely wants.
    expect(results.bills[0].title).toBe('Lunch 24')
  })
})
