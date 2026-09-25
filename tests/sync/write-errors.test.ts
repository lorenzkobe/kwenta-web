import { describe, expect, it } from 'vitest'
import { classifyWriteFailure } from '@/sync/write-errors'
import { CloudWriteRejectedError } from '@/sync/cloud-write'

// The one decision that turns a failed save into either "queued, will retry" or "refused, shown to
// the user". Wrong one way loses a flaky save (the old behaviour); wrong the other way replays a
// refused write forever. Doubtful counts as transport: a replay with the same submission id cannot
// apply twice, while a wrongly-refused save is lost.
//
// Shapes are postgrest-js's: a fetch that threw becomes `{ message: '<Name>: <msg>', code:
// '<DOMException code or empty>' }` with status 0; a server answer carries the SQLSTATE in `code`
// and the HTTP status. Access-lost codes (42501, PGRST301/302) from `isAccessError`
// (src/api/balances.ts); the inactive marker from migration 076.

const fetchFailed = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '', status: 0 }
const timedOut = { message: 'TimeoutError: signal timed out', details: '', hint: '', code: '23', status: 0 }
const aborted = { message: 'AbortError: The operation was aborted.', details: '', hint: '', code: '20', status: 0 }

describe('classifyWriteFailure', () => {
  describe('transport — the request may never have reached the server', () => {
    it('C10: a fetch that threw (status 0, empty code) is transport', () => {
      expect(classifyWriteFailure(fetchFailed)).toBe('transport')
    })

    it('C10: the 20 s AbortSignal.timeout firing (TimeoutError, code 23) is transport', () => {
      expect(classifyWriteFailure(timedOut)).toBe('transport')
    })

    it('C10: an aborted request (AbortError, code 20) is transport', () => {
      expect(classifyWriteFailure(aborted)).toBe('transport')
    })

    it('C10: a raw thrown TypeError from fetch is transport', () => {
      expect(classifyWriteFailure(new TypeError('Failed to fetch'))).toBe('transport')
    })

    it('C10: a raw DOMException TimeoutError is transport', () => {
      expect(classifyWriteFailure(new DOMException('signal timed out', 'TimeoutError'))).toBe('transport')
    })

    for (const status of [500, 502, 503, 504]) {
      it(`C10: a ${status} without a Postgres code is transport`, () => {
        expect(
          classifyWriteFailure({ message: 'Service Unavailable', details: '', hint: '', code: '', status }),
        ).toBe('transport')
      })
    }

    // PostgREST's own server-state codes: the database was unreachable, the schema cache was still
    // loading, or no pool connection came free. The write never ran.
    for (const [code, status] of [
      ['PGRST000', 503],
      ['PGRST001', 503],
      ['PGRST002', 503],
      ['PGRST003', 504],
    ] as const) {
      it(`C10: ${code} (${status}) is transport, not a refusal`, () => {
        expect(classifyWriteFailure({ message: 'Could not query the database', code, status })).toBe('transport')
      })
    }

    it('C10: PGRST002 without a status is still transport', () => {
      expect(classifyWriteFailure({ message: 'schema cache loading', code: 'PGRST002' })).toBe('transport')
    })

    it('C10: any PGRST code on a 5xx is transport', () => {
      expect(classifyWriteFailure({ message: 'upstream', code: 'PGRST999', status: 502 })).toBe('transport')
    })

    it('C10: an expired token (401 / PGRST301) is transport: refresh and replay', () => {
      expect(classifyWriteFailure({ message: 'JWT expired', code: 'PGRST301', status: 401 })).toBe('transport')
    })

    it('C10: an error with no code and no status (doubtful) is transport, not rejected', () => {
      expect(classifyWriteFailure({ message: 'network unreachable' })).toBe('transport')
    })

    it('C10: undefined / null / a bare string are doubtful, hence transport', () => {
      expect(classifyWriteFailure(undefined)).toBe('transport')
      expect(classifyWriteFailure(null)).toBe('transport')
      expect(classifyWriteFailure('boom')).toBe('transport')
    })
  })

  describe('rejected — the server answered and refused', () => {
    it('C12: a RAISE from a validator (P0001, 400) is rejected', () => {
      expect(classifyWriteFailure({ message: 'kwenta_write refused rows', code: 'P0001', status: 400 })).toBe(
        'rejected',
      )
    })

    it('C12: a unique violation (23505, 409) is rejected', () => {
      expect(classifyWriteFailure({ message: 'duplicate key value', code: '23505', status: 409 })).toBe('rejected')
    })

    it('C12: a check violation (23514) is rejected', () => {
      expect(classifyWriteFailure({ message: 'violates check constraint', code: '23514', status: 400 })).toBe(
        'rejected',
      )
    })

    it('C12: an RLS refusal (42501, 403) WITHOUT the inactive marker is rejected, not inactive', () => {
      expect(
        classifyWriteFailure({
          message: 'new row violates row-level security policy for table "bills"',
          code: '42501',
          status: 403,
        }),
      ).toBe('rejected')
    })

    it('C12: a PGRST client error on a 4xx (e.g. PGRST204 unknown column) is rejected', () => {
      expect(classifyWriteFailure({ message: 'Could not find the column', code: 'PGRST204', status: 400 })).toBe(
        'rejected',
      )
    })

    it('C12: NOT_STORED (call succeeded, row absent from applied) is rejected', () => {
      expect(
        classifyWriteFailure(
          new CloudWriteRejectedError('The cloud did not store this change. Nothing was saved.', 'NOT_STORED'),
        ),
      ).toBe('rejected')
    })
  })

  describe('inactive — migration 076 refused the caller', () => {
    it('C28: 42501 carrying kwenta_account_inactive:inactive is inactive', () => {
      expect(
        classifyWriteFailure({ message: 'kwenta_account_inactive:inactive', code: '42501', status: 403 }),
      ).toBe('inactive')
    })

    it('C28: the unconfirmed status is inactive too', () => {
      expect(
        classifyWriteFailure({ message: 'kwenta_account_inactive:unconfirmed', code: '42501', status: 403 }),
      ).toBe('inactive')
    })

    it('C33: the pre-request 403 (empty body code) is still inactive by its marker', () => {
      expect(classifyWriteFailure({ message: 'kwenta_account_inactive:inactive', code: '', status: 403 })).toBe(
        'inactive',
      )
    })

    it('C28: the marker wins over a 5xx-looking status', () => {
      expect(
        classifyWriteFailure({ message: 'kwenta_account_inactive:inactive', code: 'P0001', status: 500 }),
      ).toBe('inactive')
    })
  })
})
