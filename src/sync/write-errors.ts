import type { WriteFailureKind } from '@/types'

/** The marker migration 076 puts in every refusal of a caller whose account is not active. */
export const ACCOUNT_INACTIVE_MARKER = 'kwenta_account_inactive'

/**
 * A failed write whose kind is already known. `submitCloudWrite` throws this for an RPC error so
 * the caller does not have to re-read the postgrest shape; `CloudWriteRejectedError` (a server
 * answer that stored nothing) carries `kind: 'rejected'` the same way.
 */
export class CloudWriteFailedError extends Error {
  kind: WriteFailureKind

  constructor(message: string, kind: WriteFailureKind) {
    super(message)
    this.name = 'CloudWriteFailedError'
    this.kind = kind
  }
}

/**
 * The signed-in account is not the one that made this write (a sign-out without a wipe, then another
 * account in the same tab). Nothing was sent and nothing is recorded: sending would put one account's
 * change under another account's authority.
 */
export class WriteSessionMismatchError extends Error {
  constructor() {
    super('This change belongs to a different account than the one signed in. Nothing was sent.')
    this.name = 'WriteSessionMismatchError'
  }
}

const KINDS: readonly WriteFailureKind[] = ['transport', 'rejected', 'inactive']

// An expired or not-yet-refreshed token (R3): refresh and replay with the same submission id.
const TRANSPORT_CODES = new Set(['PGRST301', 'PGRST302', 'PGRST303'])
// SQLSTATE classes that describe the server's state, not the write: connection exception,
// transaction rollback (serialization / deadlock), insufficient resources, operator intervention
// (incl. statement timeout 57014).
const TRANSIENT_SQLSTATE_CLASSES = new Set(['08', '40', '53', '57'])
const SQLSTATE = /^[0-9A-Z]{5}$/
const SERVER_STATE_PGRST = new Set(['PGRST000', 'PGRST001', 'PGRST002', 'PGRST003'])

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message ?? '')
  return ''
}

/**
 * Transport (the request may never have reached the server: stage and replay with the SAME
 * submission id), rejected (the server answered and refused: throw to the form, or mark the queue
 * entry `conflict`), or inactive (076 refused the caller: stop and sign out).
 *
 * Doubtful counts as transport. A replay with the same submission id can never apply twice, while
 * a save wrongly classed as refused is lost.
 */
export function classifyWriteFailure(err: unknown): WriteFailureKind {
  if (messageOf(err).includes(ACCOUNT_INACTIVE_MARKER)) return 'inactive'
  if (!err || typeof err !== 'object') return 'transport'

  const kind = (err as { kind?: unknown }).kind
  if (typeof kind === 'string' && (KINDS as readonly string[]).includes(kind)) return kind as WriteFailureKind
  if (err instanceof TypeError || (typeof DOMException !== 'undefined' && err instanceof DOMException)) {
    return 'transport'
  }

  const e = err as { code?: unknown; status?: unknown }
  const code = typeof e.code === 'string' ? e.code : ''
  const status = typeof e.status === 'number' ? e.status : undefined

  if (TRANSPORT_CODES.has(code) || status === 401) return 'transport'
  if (SQLSTATE.test(code)) return TRANSIENT_SQLSTATE_CLASSES.has(code.slice(0, 2)) ? 'transport' : 'rejected'
  // PGRST000-003: PostgREST could not reach the database, its schema cache is loading, or no pool
  // connection came free — the call never ran. Likewise any PGRST code on a 5xx.
  if (code.startsWith('PGRST')) {
    return SERVER_STATE_PGRST.has(code) || (status !== undefined && status >= 500) ? 'transport' : 'rejected'
  }
  if (status === undefined || status === 0 || status >= 500 || status === 408 || status === 429) return 'transport'
  return 'rejected'
}
