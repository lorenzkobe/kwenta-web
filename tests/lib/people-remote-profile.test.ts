import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { fetchRemoteProfileIntoDexie } from '@/lib/people'
import { bumpSessionEpoch } from '@/sync/session-epoch'
import { makeProfile, resetDb } from '../helpers/db'

const h = vi.hoisted(() => ({
  profile: null as Record<string, unknown> | null,
  /** Runs while the RPC is in flight (e.g. a wipe landing mid-request). */
  onFetch: null as null | (() => void),
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async () => {
      h.onFetch?.()
      return { data: h.profile, error: null }
    },
  },
}))

beforeEach(async () => {
  await resetDb()
  h.onFetch = null
  h.profile = { ...makeProfile({ id: 'ACC', display_name: 'Remote Ann', is_local: false }) }
})

describe('fetchRemoteProfileIntoDexie', () => {
  it('mirrors the fetched profile as synced', async () => {
    await expect(fetchRemoteProfileIntoDexie('ACC')).resolves.toBe(true)
    const stored = await db.profiles.get('ACC')
    expect(stored?.display_name).toBe('Remote Ann')
    expect(stored?.synced_at).toBe(stored?.updated_at)
  })

  it('C27: a profile that lands after a wipe (sign-out, account switch) is not written', async () => {
    h.onFetch = () => bumpSessionEpoch()

    await expect(fetchRemoteProfileIntoDexie('ACC')).resolves.toBe(false)
    expect(await db.profiles.get('ACC')).toBeUndefined()
  })
})
