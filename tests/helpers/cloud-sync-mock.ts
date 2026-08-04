/**
 * A fake `kwenta_sync` for tests of the cloud-first write path.
 *
 * Operations now submit their rows to the server and mirror only what comes back, so a stub
 * that returns `null` reads as "the server stored nothing" and every write correctly refuses.
 * This echoes the push back together with migration 044's `applied` map, which is what the
 * client treats as proof a row was stored.
 *
 * Use via `vi.hoisted` so the state is available inside the hoisted `vi.mock` factory:
 *
 *   const cloud = vi.hoisted(() => ({ mode: 'ok', refuse: new Set<string>(), calls: 0 }))
 *   vi.mock('@/lib/supabase', () => ({ supabase: makeSupabaseCloudMock(cloud) }))
 */

export const SYNC_TABLES = [
  'profiles',
  'groups',
  'group_members',
  'bills',
  'bill_items',
  'item_splits',
  'settlements',
  'activity_log',
  'profile_peer_links',
] as const

export type CloudMockState = {
  /** 'ok' stores the push; 'error' is a transport failure; 'drop' accepts the call but stores nothing. */
  mode?: 'ok' | 'error' | 'drop'
  /** Tables the fake server refuses to store, to simulate a partial server-side drop. */
  refuse?: Set<string>
  /** Incremented per kwenta_sync round trip, so tests can assert one submission per mutation. */
  calls?: number
  /** Each push payload received, in order. */
  pushes?: Record<string, { id: string }[]>[]
  /** Submission ids seen, in order (undefined when the client did not send one). */
  submissionIds?: (string | undefined)[]
  /** Simulate a server WITHOUT migration 050: reject any call carrying p_submission_id. */
  rejectSubmissionId?: boolean
  /** Submission ids already applied, so a replay returns the original outcome. */
  seen?: Map<string, Record<string, string[]>>
}

export function makeSupabaseCloudMock(state: CloudMockState) {
  return {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'ME' } } } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      if (fn !== 'kwenta_sync') return { data: null, error: null }

      const submissionId = args?.p_submission_id as string | undefined

      // A server predating migration 050 has no three-argument overload.
      if (state.rejectSubmissionId && submissionId !== undefined) {
        return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } }
      }

      state.calls = (state.calls ?? 0) + 1
      const push = (args?.p_push ?? {}) as Record<string, { id: string }[]>
      state.pushes?.push(push)
      state.submissionIds?.push(submissionId)

      if (state.mode === 'error') return { data: null, error: { message: 'network unreachable' } }

      // Replay: return the original outcome without applying anything again.
      if (submissionId !== undefined && state.seen?.has(submissionId)) {
        const bundle: Record<string, unknown> = {}
        for (const t of SYNC_TABLES) bundle[t] = []
        bundle.applied = state.seen.get(submissionId)
        bundle.replayed = true
        return { data: bundle, error: null }
      }

      const bundle: Record<string, unknown> = {}
      const applied: Record<string, string[]> = {}
      for (const t of SYNC_TABLES) bundle[t] = []
      if (state.mode !== 'drop') {
        for (const t of SYNC_TABLES) {
          if (state.refuse?.has(t)) continue
          const rows = push[t] ?? []
          bundle[t] = rows
          if (rows.length > 0) applied[t] = rows.map((r) => r.id)
        }
      }
      bundle.applied = applied
      if (submissionId !== undefined && state.mode !== 'drop') state.seen?.set(submissionId, applied)
      return { data: bundle, error: null }
    },
  }
}
