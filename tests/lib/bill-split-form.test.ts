import { describe, expect, it, vi } from 'vitest'
import {
  applyClearedSplitField,
  applySplitInputChange,
  buildSplitPayload,
  equalCustomMap,
  equalPercentMap,
  lineSplitsValid,
  parseSplitNumber,
  redistributeWithPinned,
  mergeUnlistedParticipants,
  remapLineSplits,
  resolveBillEditIds,
  splitTotalEvenly,
} from '@/lib/bill-split-form'

const sum = (vals: Record<string, string>) =>
  Math.round(Object.values(vals).reduce((a, b) => a + parseFloat(b), 0) * 100) / 100

describe('equalPercentMap', () => {
  it('returns {} for no users', () => {
    expect(equalPercentMap([])).toEqual({})
  })

  it('splits 100% evenly and reconciles the remainder to the last user', () => {
    const map = equalPercentMap(['a', 'b', 'c'])
    expect(sum(map)).toBe(100)
    expect(map.c).toBe('33.34')
  })

  it('gives a single user 100%', () => {
    expect(equalPercentMap(['a'])).toEqual({ a: '100' })
  })
})

describe('equalCustomMap', () => {
  it('returns {} for no users or non-positive amount', () => {
    expect(equalCustomMap([], 100)).toEqual({})
    expect(equalCustomMap(['a'], 0)).toEqual({})
  })

  it('splits the amount evenly with remainder on the first user', () => {
    const map = equalCustomMap(['a', 'b', 'c'], 10)
    expect(map.a).toBe('3.34')
    expect(map.b).toBe('3.33')
    expect(sum(map)).toBe(10)
  })
})

describe('splitTotalEvenly', () => {
  it('returns [] for non-positive count', () => {
    expect(splitTotalEvenly(10, 0)).toEqual([])
  })

  it('sums exactly to the total with the remainder last', () => {
    const parts = splitTotalEvenly(10, 3)
    expect(parts).toEqual([3.33, 3.33, 3.34])
    expect(parts.reduce((a, b) => a + b, 0)).toBeCloseTo(10, 10)
  })

  it('handles a single part as the whole total', () => {
    expect(splitTotalEvenly(10, 1)).toEqual([10])
  })
})

describe('parseSplitNumber', () => {
  it('treats undefined/empty as 0', () => {
    expect(parseSplitNumber(undefined)).toBe(0)
    expect(parseSplitNumber('')).toBe(0)
    expect(parseSplitNumber('   ')).toBe(0)
  })

  it('parses comma decimals', () => {
    expect(parseSplitNumber('12,5')).toBe(12.5)
  })

  it('returns 0 for non-numeric input', () => {
    expect(parseSplitNumber('abc')).toBe(0)
  })
})

describe('redistributeWithPinned', () => {
  it('keeps pinned values and splits the rest evenly', () => {
    const result = redistributeWithPinned(
      ['a', 'b', 'c'],
      { a: '40', b: '0', c: '0' },
      { a: true },
      100,
    )
    expect(result.a).toBe('40')
    expect(parseFloat(result.b) + parseFloat(result.c)).toBeCloseTo(60, 10)
  })

  it('returns unchanged when all users are pinned', () => {
    const values = { a: '50', b: '50' }
    const result = redistributeWithPinned(['a', 'b'], values, { a: true, b: true }, 100)
    expect(result).toEqual(values)
  })

  it('does not redistribute when pinned exceeds the target (negative remaining)', () => {
    const values = { a: '120', b: '5' }
    const result = redistributeWithPinned(['a', 'b'], values, { a: true }, 100)
    expect(result.b).toBe('5')
  })
})

describe('applyClearedSplitField', () => {
  it('gives the whole target to the sole remaining non-empty user', () => {
    const { values } = applyClearedSplitField(
      ['a', 'b'],
      { a: '60', b: '40' },
      {},
      'a',
      'custom',
      100,
    )
    expect(values.a).toBe('')
    expect(values.b).toBe('100')
  })

  it('resets to an equal percentage map when nothing else has a value', () => {
    const { values, pinned } = applyClearedSplitField(
      ['a', 'b'],
      { a: '100', b: '' },
      { a: true },
      'a',
      'percentage',
      100,
    )
    expect(sum(values)).toBe(100)
    expect(pinned).toEqual({})
  })

  it('resets to an equal custom map (currency) when nothing else has a value', () => {
    const { values } = applyClearedSplitField(
      ['a', 'b'],
      { a: '50', b: '' },
      {},
      'a',
      'custom',
      80,
    )
    expect(sum(values)).toBe(80)
  })

  it('leaves other values intact when 2+ remain', () => {
    const { values } = applyClearedSplitField(
      ['a', 'b', 'c'],
      { a: '40', b: '30', c: '30' },
      {},
      'a',
      'custom',
      100,
    )
    expect(values.a).toBe('')
    expect(values.b).toBe('30')
    expect(values.c).toBe('30')
  })

  it('no-ops on a non-positive target', () => {
    const { values } = applyClearedSplitField(['a'], { a: '5' }, {}, 'a', 'custom', 0)
    expect(values.a).toBe('')
  })
})

describe('lineSplitsValid', () => {
  it('is valid with no selected users', () => {
    expect(lineSplitsValid('custom', 100, [], {})).toBe(true)
  })

  it('equal splits are always valid', () => {
    expect(lineSplitsValid('equal', 100, ['a', 'b'], {})).toBe(true)
  })

  it('percentage must sum near 100', () => {
    expect(lineSplitsValid('percentage', 100, ['a', 'b'], { a: '50', b: '50' })).toBe(true)
    expect(lineSplitsValid('percentage', 100, ['a', 'b'], { a: '50', b: '40' })).toBe(false)
  })

  it('custom must sum near the line amount (within epsilon)', () => {
    expect(lineSplitsValid('custom', 100, ['a', 'b'], { a: '60', b: '40' })).toBe(true)
    expect(lineSplitsValid('custom', 100, ['a', 'b'], { a: '60', b: '39.96' })).toBe(true)
    expect(lineSplitsValid('custom', 100, ['a', 'b'], { a: '60', b: '30' })).toBe(false)
  })

  it('quantity requires positive integers', () => {
    expect(lineSplitsValid('quantity', 10, ['a', 'b'], { a: '1', b: '2' })).toBe(true)
    expect(lineSplitsValid('quantity', 10, ['a', 'b'], { a: '1.5', b: '2' })).toBe(false)
    expect(lineSplitsValid('quantity', 10, ['a', 'b'], { a: '0', b: '2' })).toBe(false)
  })
})

describe('applySplitInputChange', () => {
  it('quantity: stores the typed value on only the edited user, leaving others untouched', () => {
    const { values, pinned } = applySplitInputChange(
      ['a', 'b', 'c'],
      'quantity',
      30,
      { a: '1', b: '1', c: '1' },
      {},
      'a',
      '4',
    )
    expect(values).toEqual({ a: '4', b: '1', c: '1' })
    expect(pinned).toEqual({})
  })

  it('quantity: never redistributes even when a line amount is set', () => {
    const { values } = applySplitInputChange(
      ['a', 'b'],
      'quantity',
      100,
      { a: '1', b: '1' },
      {},
      'b',
      '3',
    )
    expect(values).toEqual({ a: '1', b: '3' })
  })

  it('percentage: pins the edited user and redistributes the rest to ~100', () => {
    const { values, pinned } = applySplitInputChange(
      ['a', 'b', 'c'],
      'percentage',
      0,
      equalPercentMap(['a', 'b', 'c']),
      {},
      'a',
      '40',
    )
    expect(values.a).toBe('40')
    expect(pinned.a).toBe(true)
    expect(sum(values)).toBeCloseTo(100, 2)
  })

  it('custom: pins the edited user and redistributes the rest to the line amount', () => {
    const { values, pinned } = applySplitInputChange(
      ['a', 'b'],
      'custom',
      100,
      { a: '50', b: '50' },
      {},
      'a',
      '70',
    )
    expect(values.a).toBe('70')
    expect(pinned.a).toBe(true)
    expect(sum(values)).toBeCloseTo(100, 2)
  })

  it('custom: clearing a field delegates to applyClearedSplitField', () => {
    const { values } = applySplitInputChange(
      ['a', 'b'],
      'custom',
      100,
      { a: '60', b: '40' },
      {},
      'a',
      '',
    )
    expect(values.a).toBe('')
    expect(values.b).toBe('100')
  })
})

describe('buildSplitPayload', () => {
  it('uses splitValue 1 for equal regardless of entered values', () => {
    const payload = buildSplitPayload(['a', 'b'], 'equal', { a: '99', b: '1' })
    expect(payload).toEqual([
      { userId: 'a', splitType: 'equal', splitValue: 1 },
      { userId: 'b', splitType: 'equal', splitValue: 1 },
    ])
  })

  it('parses entered values for non-equal types', () => {
    const payload = buildSplitPayload(['a', 'b'], 'custom', { a: '60', b: '40' })
    expect(payload).toEqual([
      { userId: 'a', splitType: 'custom', splitValue: 60 },
      { userId: 'b', splitType: 'custom', splitValue: 40 },
    ])
  })
})

/**
 * Edit-form hydration. `item_splits.user_id` holds the canonical ACCOUNT id (the push rewrites a
 * linked contact to its account, and the server row is what gets mirrored), while the personal
 * picker lists the same person under the owned LOCAL contact id. Copying stored ids verbatim into
 * the selection made the person invisible in the chips while still being counted, validated and
 * saved — so re-adding them split the line twice.
 *
 * `remapLineSplits` is the pure half: it takes the id mapper the page resolved from Dexie and
 * turns stored rows into a picker selection. The mapper is passed in so the transform itself
 * never touches the database.
 */
describe('remapLineSplits', () => {
  // The mapper the page would build for one linked contact: account id -> owned contact id.
  const picker = (id: string) => (id === 'REMOTE' ? 'LOCAL' : id)

  it('C2: maps an account id to the picker id, passes unknown ids through, preserves order', () => {
    const out = remapLineSplits(
      [
        { user_id: 'ME', split_type: 'custom', split_value: 40 },
        { user_id: 'REMOTE', split_type: 'custom', split_value: 35 },
        { user_id: 'STRANGER', split_type: 'custom', split_value: 25 },
      ],
      picker,
    )
    expect(out.selectedUserIds).toEqual(['ME', 'LOCAL', 'STRANGER'])
    expect(out.splitValues).toEqual({ ME: '40', LOCAL: '35', STRANGER: '25' })
  })

  it('C2: keys the value map by the PICKER id, never by the stored id', () => {
    const out = remapLineSplits([{ user_id: 'REMOTE', split_type: 'percentage', split_value: 100 }], picker)
    expect(out.splitValues).toEqual({ LOCAL: '100' })
    expect(out.splitValues).not.toHaveProperty('REMOTE')
  })

  it('C2: stringifies split_value the way the form stores it', () => {
    const out = remapLineSplits([{ user_id: 'A', split_type: 'custom', split_value: 12.5 }], (id) => id)
    expect(out.splitValues.A).toBe('12.5')
    expect(typeof out.splitValues.A).toBe('string')
  })

  it('C2: an identity mapper leaves everything untouched', () => {
    const out = remapLineSplits(
      [
        { user_id: 'B', split_type: 'equal', split_value: 1 },
        { user_id: 'A', split_type: 'equal', split_value: 1 },
      ],
      (id) => id,
    )
    expect(out.selectedUserIds).toEqual(['B', 'A'])
    expect(out.splitValues).toEqual({ B: '1', A: '1' })
  })

  it('C2: empty input yields an empty selection and an empty value map', () => {
    expect(remapLineSplits([], picker)).toEqual({ selectedUserIds: [], splitValues: {} })
  })

  it('C3: two stored rows that resolve to one person become ONE selection; the first row wins', () => {
    // A legacy row under the contact id next to a canonical row under the account id.
    const out = remapLineSplits(
      [
        { user_id: 'ME', split_type: 'custom', split_value: 50 },
        { user_id: 'LOCAL', split_type: 'custom', split_value: 30 },
        { user_id: 'REMOTE', split_type: 'custom', split_value: 20 },
      ],
      picker,
    )
    expect(out.selectedUserIds).toEqual(['ME', 'LOCAL'])
    expect(out.splitValues).toEqual({ ME: '50', LOCAL: '30' })
  })

  it('C3: dedupes when the duplicate is the FIRST row too (account id first, contact id second)', () => {
    const out = remapLineSplits(
      [
        { user_id: 'REMOTE', split_type: 'custom', split_value: 20 },
        { user_id: 'LOCAL', split_type: 'custom', split_value: 30 },
      ],
      picker,
    )
    expect(out.selectedUserIds).toEqual(['LOCAL'])
    expect(out.splitValues).toEqual({ LOCAL: '20' })
  })

  it('C3: does not mutate the input rows', () => {
    const rows = [{ user_id: 'REMOTE', split_type: 'equal' as const, split_value: 1 }]
    const snapshot = JSON.stringify(rows)
    remapLineSplits(rows, picker)
    expect(JSON.stringify(rows)).toBe(snapshot)
  })
})

/**
 * The other half of the same screen: a participant the picker cannot list at all — a contact
 * deleted from the phonebook, a member removed from the group — must still be visible and
 * removable, or the edit keeps silently saving a split the user cannot see.
 */
describe('mergeUnlistedParticipants', () => {
  const listed = [
    { userId: 'ME', displayName: 'You', isCurrentUser: true },
    { userId: 'LOCAL', displayName: 'Bob', isCurrentUser: false },
  ]

  it('C5: a participant already in the picker list is returned as-is, without an unlisted flag', () => {
    const out = mergeUnlistedParticipants(listed, [{ userId: 'LOCAL', displayName: 'Bob' }])
    expect(out).toEqual(listed)
    expect(out[0]).toBe(listed[0])
    expect(out[1]).toBe(listed[1])
    for (const m of out) expect(m).not.toHaveProperty('unlisted')
  })

  it('C5: an unmatched participant is appended once, flagged unlisted and never the current user', () => {
    const out = mergeUnlistedParticipants(listed, [{ userId: 'GONE', displayName: 'Gone Person' }])
    expect(out).toHaveLength(3)
    expect(out.slice(0, 2)).toEqual(listed)
    expect(out[2]).toEqual({
      userId: 'GONE',
      displayName: 'Gone Person',
      isCurrentUser: false,
      unlisted: true,
    })
  })

  it('C5: the same unmatched participant given twice is appended once', () => {
    const out = mergeUnlistedParticipants(listed, [
      { userId: 'GONE', displayName: 'Gone Person' },
      { userId: 'GONE', displayName: 'Gone Person (dup)' },
    ])
    expect(out.map((m) => m.userId)).toEqual(['ME', 'LOCAL', 'GONE'])
    expect(out[2].displayName).toBe('Gone Person')
  })

  it('C5: listed entries are never duplicated, even when every participant is also listed', () => {
    const out = mergeUnlistedParticipants(listed, [
      { userId: 'ME', displayName: 'Me' },
      { userId: 'LOCAL', displayName: 'Bob' },
      { userId: 'ME', displayName: 'Me again' },
    ])
    expect(out).toEqual(listed)
  })

  it('C5: keeps listed order first, then unlisted in participant order', () => {
    const out = mergeUnlistedParticipants(listed, [
      { userId: 'Z_GONE', displayName: 'Zed' },
      { userId: 'LOCAL', displayName: 'Bob' },
      { userId: 'A_GONE', displayName: 'Abe' },
    ])
    expect(out.map((m) => m.userId)).toEqual(['ME', 'LOCAL', 'Z_GONE', 'A_GONE'])
  })

  it('C5: no participants returns the listed array unchanged; no listed returns only unlisted entries', () => {
    expect(mergeUnlistedParticipants(listed, [])).toEqual(listed)
    expect(mergeUnlistedParticipants([], [{ userId: 'GONE', displayName: 'Gone' }])).toEqual([
      { userId: 'GONE', displayName: 'Gone', isCurrentUser: false, unlisted: true },
    ])
  })

  it('C5: does not mutate the listed array', () => {
    const copy = [...listed]
    mergeUnlistedParticipants(listed, [{ userId: 'GONE', displayName: 'Gone' }])
    expect(listed).toEqual(copy)
  })
})

/**
 * The shared half of the two edit-load effects (AddBillPage/AddBillDialog): resolve every
 * distinct stored id once through the injected resolver, then derive `billParticipants`. Kept
 * Dexie-free on purpose so both `personalPickerIdFor` and `resolveGroupMemberUserId` callers can
 * share one implementation instead of two hand-copies that could drift.
 */
describe('resolveBillEditIds', () => {
  const identity = async (id: string) => id

  it('resolves each distinct stored id exactly once, however many splits repeat it', async () => {
    const resolve = vi.fn(async (id: string) => (id === 'REMOTE' ? 'LOCAL' : id))
    const detail = {
      paid_by: 'ME',
      payorName: 'Me',
      items: [
        { splits: [{ user_id: 'ME', displayName: 'Me' }, { user_id: 'REMOTE', displayName: 'Bob' }] },
        { splits: [{ user_id: 'REMOTE', displayName: 'Bob' }] },
      ],
    }
    const { pickerIdFor } = await resolveBillEditIds(detail, resolve, 'ME')
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(resolve.mock.calls.map((c) => c[0]).sort()).toEqual(['ME', 'REMOTE'])
    expect(pickerIdFor('REMOTE')).toBe('LOCAL')
  })

  it('the first displayName seen for a picker id wins', async () => {
    const detail = {
      paid_by: 'ME',
      payorName: 'Me',
      items: [
        { splits: [{ user_id: 'A', displayName: 'First' }] },
        { splits: [{ user_id: 'A', displayName: 'Second' }] },
      ],
    }
    const { billParticipants } = await resolveBillEditIds(detail, identity, 'ME')
    expect(billParticipants).toEqual([{ userId: 'A', displayName: 'First' }])
  })

  it('a payor with no split of their own on the bill gets payorName as the fallback name', async () => {
    const detail = {
      paid_by: 'PAYOR',
      payorName: 'Payor Name',
      items: [{ splits: [{ user_id: 'ME', displayName: 'Me' }] }],
    }
    const { billParticipants } = await resolveBillEditIds(detail, identity, 'ME')
    expect(billParticipants).toEqual([{ userId: 'PAYOR', displayName: 'Payor Name' }])
  })

  it('excludes the viewer from the participant list', async () => {
    const detail = {
      paid_by: 'ME',
      payorName: 'Me',
      items: [
        {
          splits: [
            { user_id: 'ME', displayName: 'Me' },
            { user_id: 'OTHER', displayName: 'Other' },
          ],
        },
      ],
    }
    const { billParticipants } = await resolveBillEditIds(detail, identity, 'ME')
    expect(billParticipants).toEqual([{ userId: 'OTHER', displayName: 'Other' }])
  })

  it('an id the resolver never saw (not on the bill) passes through pickerIdFor unchanged', async () => {
    const detail = { paid_by: 'ME', payorName: 'Me', items: [] }
    const { pickerIdFor } = await resolveBillEditIds(detail, identity, 'ME')
    expect(pickerIdFor('UNSEEN')).toBe('UNSEEN')
  })
})
