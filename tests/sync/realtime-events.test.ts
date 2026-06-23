import { beforeEach, describe, expect, it, vi } from 'vitest'

const supa = vi.hoisted(() => ({
  rpcError: { message: 'boom' } as { message: string } | null,
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: null, error: supa.rpcError })),
    from: () => ({
      select: () => ({
        eq: () => ({
          gt: () => ({
            order: () => ({
              limit: async () => ({ data: [], error: null }),
            }),
          }),
          eq: () => ({
            gt: () => ({
              order: () => ({
                limit: async () => ({ data: [], error: null }),
              }),
            }),
          }),
        }),
      }),
    }),
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: vi.fn(),
  },
}))

const svc = vi.hoisted(() => ({
  pull: vi.fn(async () => ({ pulled: 0, errors: [] as string[] })),
}))

vi.mock('@/sync/sync-service', () => ({
  pullChanges: svc.pull,
  syncRoundTrip: vi.fn(async () => ({ pushed: 0, pulled: 0, errors: [] })),
  KWENTA_LAST_PULL_STORAGE_KEY: 'kwenta_last_pull',
}))

vi.mock('@/lib/runtime-flags', () => ({ isRuntimeFlagEnabled: () => false }))

vi.mock('@/lib/client-metrics', () => ({
  captureMetric: vi.fn(),
  withMetric: (_n: string, fn: () => unknown) => fn(),
}))

// Stub @/lib/utils so `now()` works without full module
vi.mock('@/lib/utils', () => ({
  now: () => new Date().toISOString(),
  generateId: () => 'test-id',
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  formatCurrency: (n: number) => String(n),
  getDeviceId: () => 'device-id',
  timeAgo: () => 'just now',
}))

// Stub @/db/db — realtime-events uses db inside upsertRemoteRow, but our
// test drives processEvent with a bills entity_type where the RPC errors out
// before any DB write occurs, so a minimal stub is enough.
vi.mock('@/db/db', () => ({
  db: {
    bills: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
    bill_items: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
    item_splits: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
    groups: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
    group_members: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
    settlements: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
    profiles: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
    activity_log: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
    profile_peer_links: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
    pending_mutations: { get: vi.fn(async () => undefined), add: vi.fn(), update: vi.fn() },
  },
}))

import { processEvent } from '@/sync/realtime-events'

const makeEvent = (overrides: Partial<{
  id: string
  user_id: string
  entity_type: string
  entity_id: string
  op: string
  payload: Record<string, unknown>
  created_at: string
}> = {}) => ({
  id: 'e1',
  user_id: 'ME',
  entity_type: 'bills',
  entity_id: 'B1',
  op: 'UPDATE',
  payload: {},
  created_at: '2026-01-01T00:00:00Z',
  event_type: 'entity_changed',
  ...overrides,
} as never)

describe('processEvent recovers on bundle-fetch failure', () => {
  beforeEach(() => {
    svc.pull.mockClear()
    supa.rpcError = { message: 'boom' }
    localStorage.clear()
  })

  it('throws when the bill bundle fetch errors, so the change is not silently lost', async () => {
    await expect(
      processEvent('ME', makeEvent({ entity_type: 'bills', entity_id: 'B1' })),
    ).rejects.toThrow()
  })

  it('throws when the group bundle fetch errors', async () => {
    await expect(
      processEvent('ME', makeEvent({ entity_type: 'groups', entity_id: 'G1' })),
    ).rejects.toThrow()
  })

  it('throws when the group_members bundle fetch errors (with group_id in payload)', async () => {
    await expect(
      processEvent('ME', makeEvent({ entity_type: 'group_members', entity_id: 'GM1', payload: { group_id: 'G1' } })),
    ).rejects.toThrow()
  })

  it('throws when the settlement fetch errors', async () => {
    await expect(
      processEvent('ME', makeEvent({ entity_type: 'settlements', entity_id: 'S1' })),
    ).rejects.toThrow()
  })

  it('does NOT throw when the bill bundle fetch succeeds', async () => {
    supa.rpcError = null
    await expect(
      processEvent('ME', makeEvent({ entity_type: 'bills', entity_id: 'B1' })),
    ).resolves.toBeUndefined()
  })
})
