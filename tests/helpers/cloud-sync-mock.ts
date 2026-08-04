/**
 * A fake write server for tests of the cloud-first write path.
 *
 * Operations submit their rows to the server and mirror only what comes back, so a stub that
 * returns `null` reads as "the server stored nothing" and every write correctly refuses. This
 * echoes the push back together with migration 044's `applied` map, which is what the client
 * treats as proof a row was stored.
 *
 * Answers BOTH write RPCs, because the client must work against either server generation:
 *   - `kwenta_write` (migration 066) — the current path. Echoes only the submitted rows and
 *     carries `reads`.
 *   - `kwenta_sync` — the fallback for a database without 066, which returns a pull bundle.
 * The stored-row semantics are identical; only the response envelope differs.
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
  /**
   * Simulate a server WITHOUT migration 066, so the client falls back to `kwenta_sync`.
   * Implied by `rejectSubmissionId`: a database that predates 050 cannot have 066 either.
   */
  rejectWriteRpc?: boolean
  /** Submission ids already applied, so a replay returns the original outcome. */
  seen?: Map<string, Record<string, string[]>>
  /** Payload the fake server returns per requested read key. */
  readPayloads?: Record<string, unknown>
  /** Every `p_reads` array received, in order. */
  readSpecs?: Record<string, unknown>[][]
  /** Every RPC name called, in order — including reads, so a test can prove one did NOT happen. */
  rpcNames?: string[]
}

const MISSING_FUNCTION = { code: 'PGRST202', message: 'Could not find the function' }

export function makeSupabaseCloudMock(state: CloudMockState) {
  /** Shared by both RPCs: what the fake server stores, and what it says it stored. */
  function applyPush(
    push: Record<string, { id: string }[]>,
    submissionId: string | undefined,
  ): { applied: Record<string, string[]>; storedRows: Record<string, { id: string }[]> } {
    const applied: Record<string, string[]> = {}
    const storedRows: Record<string, { id: string }[]> = {}
    for (const t of SYNC_TABLES) storedRows[t] = []
    if (state.mode !== 'drop') {
      for (const t of SYNC_TABLES) {
        if (state.refuse?.has(t)) continue
        const rows = push[t] ?? []
        storedRows[t] = rows
        if (rows.length > 0) applied[t] = rows.map((r) => r.id)
      }
    }
    if (submissionId !== undefined && state.mode !== 'drop') state.seen?.set(submissionId, applied)
    return { applied, storedRows }
  }

  function emptyTables(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const t of SYNC_TABLES) out[t] = []
    return out
  }

  return {
    auth: { getSession: async () => ({ data: { session: { user: { id: 'ME' } } } }) },
    from: () => ({ select: () => ({ eq: () => ({ data: [], error: null }) }) }),
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      state.rpcNames?.push(fn)

      if (fn === 'kwenta_write') {
        // A server predating 066 has no such function at all.
        if (state.rejectWriteRpc || state.rejectSubmissionId) {
          return { data: null, error: MISSING_FUNCTION }
        }

        // The client sends `null` rather than omitting the argument; normalise so assertions read
        // the same on both paths.
        const submissionId = (args?.p_submission_id ?? undefined) as string | undefined
        const reads = (args?.p_reads ?? []) as Record<string, unknown>[]
        state.readSpecs?.push(reads)

        state.calls = (state.calls ?? 0) + 1
        const push = (args?.p_push ?? {}) as Record<string, { id: string }[]>
        state.pushes?.push(push)
        state.submissionIds?.push(submissionId)

        if (state.mode === 'error') return { data: null, error: { message: 'network unreachable' } }

        const answered: Record<string, unknown> = {}
        for (const spec of reads) {
          const key = String(spec.key ?? '')
          if (key && state.readPayloads && key in state.readPayloads) {
            answered[key] = state.readPayloads[key]
          }
        }

        if (submissionId !== undefined && state.seen?.has(submissionId)) {
          return {
            data: {
              ...emptyTables(),
              applied: state.seen.get(submissionId),
              replayed: true,
              reads: answered,
            },
            error: null,
          }
        }

        const { applied, storedRows } = applyPush(push, submissionId)
        return { data: { ...emptyTables(), ...storedRows, applied, reads: answered }, error: null }
      }

      if (fn !== 'kwenta_sync') return { data: null, error: null }

      const submissionId = args?.p_submission_id as string | undefined

      // A server predating migration 050 has no three-argument overload.
      if (state.rejectSubmissionId && submissionId !== undefined) {
        return { data: null, error: MISSING_FUNCTION }
      }

      state.calls = (state.calls ?? 0) + 1
      const push = (args?.p_push ?? {}) as Record<string, { id: string }[]>
      state.pushes?.push(push)
      state.submissionIds?.push(submissionId)

      if (state.mode === 'error') return { data: null, error: { message: 'network unreachable' } }

      // Replay: return the original outcome without applying anything again.
      if (submissionId !== undefined && state.seen?.has(submissionId)) {
        return {
          data: { ...emptyTables(), applied: state.seen.get(submissionId), replayed: true },
          error: null,
        }
      }

      const { applied, storedRows } = applyPush(push, submissionId)
      return { data: { ...emptyTables(), ...storedRows, applied }, error: null }
    },
  }
}
