import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { fetchRemoteProfileIntoDexie } from '@/lib/people'
import { bumpSessionEpoch } from '@/sync/session-epoch'
import { makeProfile, resetDb } from '../helpers/db'

const h = vi.hoisted(() => ({
  profile: null as Record<string, unknown> | null,
  /** Runs while the RPC is in flight (e.g. a wipe landing mid-request). */
  onFetch: null as null | (() => void),
  error: null as null | { message: string },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: async () => {
      h.onFetch?.()
      return { data: h.error ? null : h.profile, error: h.error }
    },
  },
}))

beforeEach(async () => {
  await resetDb()
  h.onFetch = null
  h.error = null
  h.profile = { ...makeProfile({ id: 'ACC', display_name: 'Remote Ann', is_local: false }) }
})

describe('fetchRemoteProfileIntoDexie', () => {
  it('mirrors the fetched profile as synced', async () => {
    await expect(fetchRemoteProfileIntoDexie('ACC')).resolves.toBe('present')
    const stored = await db.profiles.get('ACC')
    expect(stored?.display_name).toBe('Remote Ann')
    expect(stored?.synced_at).toBe(stored?.updated_at)
  })

  it('C27: a profile that lands after a wipe (sign-out, account switch) is not written', async () => {
    h.onFetch = () => bumpSessionEpoch()

    await expect(fetchRemoteProfileIntoDexie('ACC')).resolves.toBe('unreachable')
    expect(await db.profiles.get('ACC')).toBeUndefined()
  })

  it('not_found when the server answers with no row', async () => {
    h.profile = null

    await expect(fetchRemoteProfileIntoDexie('ACC')).resolves.toBe('not_found')
    expect(await db.profiles.get('ACC')).toBeUndefined()
  })

  it('unreachable on an RPC error', async () => {
    h.error = { message: 'Failed to fetch' }

    await expect(fetchRemoteProfileIntoDexie('ACC')).resolves.toBe('unreachable')
  })
})
