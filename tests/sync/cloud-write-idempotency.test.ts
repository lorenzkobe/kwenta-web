import { beforeEach, describe, expect, it, vi } from 'vitest'
import { db } from '@/db/db'
import { resetSubmissionIdSupport, submitCloudWrite } from '@/sync/cloud-write'
import { makeBill, resetDb } from '../helpers/db'

/**
 * Submission ids close the one duplicate the write-path inversion cannot.
 *
 * Inverting the write path means a REJECTED save leaves nothing behind, so the user's retry is
 * the only write. But an interrupted request is not a rejection: the row may well have been
 * stored and only the response lost. The client cannot tell those apart, so it retries — and
 * without a server-side record of the submission, that retry is indistinguishable from a new
 * write. Carrying a stable id lets the server recognise the replay and report the original
 * outcome instead of applying anything twice.
 */

const cloud = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'error' | 'drop',
  calls: 0,
  submissionIds: [] as (string | undefined)[],
  rejectSubmissionId: false,
  seen: new Map<string, Record<string, string[]>>(),
}))

vi.mock('@/lib/supabase', async () => {
  const { makeSupabaseCloudMock } = await import('../helpers/cloud-sync-mock')
  return { supabase: makeSupabaseCloudMock(cloud) }
})

function payloadFor(id: string) {
  return { bills: [makeBill({ id, group_id: null, created_by: 'ME', paid_by: 'ME' })] }
}

beforeEach(async () => {
  await resetDb()
  cloud.mode = 'ok'
  cloud.calls = 0
  cloud.submissionIds = []
  cloud.rejectSubmissionId = false
  cloud.seen = new Map()
  resetSubmissionIdSupport()
})

describe('cloud write idempotency', () => {
  it('sends the submission id with the write', async () => {
    await submitCloudWrite({
      actorUserId: 'ME',
      payload: payloadFor('B1'),
      submissionId: 'SUB-1',
    })

    expect(cloud.submissionIds).toEqual(['SUB-1'])
  })

  it('treats a replay of the same submission as the success it already was', async () => {
    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1'), submissionId: 'SUB-1' })

    // The response to the first attempt was lost, so the client retries the SAME submission.
    await expect(
      submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1'), submissionId: 'SUB-1' }),
    ).resolves.toBeTruthy()

    // The replay reports the original applied ids rather than re-running the validators, and
    // the bill exists exactly once.
    expect(await db.bills.count()).toBe(1)
  })

  it('still saves against a server without migration 050', async () => {
    // No three-argument overload: the client must fall back rather than fail the write.
    cloud.rejectSubmissionId = true

    await expect(
      submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1'), submissionId: 'SUB-1' }),
    ).resolves.toBeTruthy()

    expect(await db.bills.get('B1')).toBeTruthy()
    // The retry went out without the id.
    expect(cloud.submissionIds).toEqual([undefined])
  })

  it('stops re-probing the missing overload after the first fallback', async () => {
    cloud.rejectSubmissionId = true

    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1'), submissionId: 'S1' })
    const afterFirst = cloud.calls
    await submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B2'), submissionId: 'S2' })

    // Second write costs ONE round trip, not a rejected probe plus a retry.
    expect(cloud.calls - afterFirst).toBe(1)
  })

  it('does not swallow a genuine failure that happens to carry a submission id', async () => {
    cloud.mode = 'error'

    await expect(
      submitCloudWrite({ actorUserId: 'ME', payload: payloadFor('B1'), submissionId: 'SUB-1' }),
    ).rejects.toThrow()

    expect(await db.bills.count()).toBe(0)
  })
})
