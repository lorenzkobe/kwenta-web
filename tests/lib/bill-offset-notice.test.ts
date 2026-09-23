import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * perf-pass-1, C19. Saving a bill someone else paid used to AWAIT `fetchPersonSummary` before
 * navigating, so the save button sat on "Saving…" for a second round trip. The courtesy toast now
 * lives in `announceBillOffset`, which returns synchronously: the page navigates first and the
 * helper cannot be awaited into the save path.
 */

const mocks = vi.hoisted(() => ({
  fetchPersonSummary: vi.fn(),
  info: vi.fn(),
}))

vi.mock('@/api/balances', () => ({ fetchPersonSummary: mocks.fetchPersonSummary }))
vi.mock('sonner', () => ({ toast: { info: mocks.info, error: vi.fn(), success: vi.fn() } }))

import { announceBillOffset } from '@/lib/bill-offset-notice'

const flush = () => new Promise((r) => setTimeout(r, 0))

function summary(total: Record<string, number>, fromCache = false) {
  return { data: { total }, fromCache, fetchedAt: null }
}

beforeEach(() => {
  mocks.fetchPersonSummary.mockReset()
  mocks.info.mockReset()
})

describe('announceBillOffset', () => {
  it('C19: returns synchronously while the summary fetch is still pending', () => {
    mocks.fetchPersonSummary.mockReturnValue(new Promise(() => {}))

    const out = announceBillOffset({ userId: 'me', payerId: 'bob', payerName: 'Bob', currency: 'PHP' })

    expect(out).toBeUndefined()
    expect(mocks.fetchPersonSummary).toHaveBeenCalledWith('me', 'bob')
    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('announces the offset when the payer still owes the viewer', async () => {
    mocks.fetchPersonSummary.mockResolvedValue(summary({ PHP: 40 }))

    announceBillOffset({ userId: 'me', payerId: 'bob', payerName: 'Bob', currency: 'PHP' })
    await flush()

    expect(mocks.info).toHaveBeenCalledTimes(1)
    expect(mocks.info.mock.calls[0][0]).toContain('Bob still owes you')
  })

  it('announces "even" when the net is effectively zero', async () => {
    mocks.fetchPersonSummary.mockResolvedValue(summary({ PHP: 0.004 }))

    announceBillOffset({ userId: 'me', payerId: 'bob', payerName: 'Bob', currency: 'PHP' })
    await flush()

    expect(mocks.info).toHaveBeenCalledWith('This bill cancels out — you and Bob are now even')
  })

  it('says nothing when the viewer owes the payer', async () => {
    mocks.fetchPersonSummary.mockResolvedValue(summary({ PHP: -25 }))

    announceBillOffset({ userId: 'me', payerId: 'bob', payerName: 'Bob', currency: 'PHP' })
    await flush()

    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('reads the net in the bill currency only', async () => {
    mocks.fetchPersonSummary.mockResolvedValue(summary({ USD: 10 }))

    announceBillOffset({ userId: 'me', payerId: 'bob', payerName: 'Bob', currency: 'PHP' })
    await flush()

    // No PHP entry means a zero PHP net, not the USD balance.
    expect(mocks.info).toHaveBeenCalledWith('This bill cancels out — you and Bob are now even')
  })

  it('makes no claim from a cached answer, which predates the bill just written', async () => {
    mocks.fetchPersonSummary.mockResolvedValue(summary({ PHP: 40 }, true))

    announceBillOffset({ userId: 'me', payerId: 'bob', payerName: 'Bob', currency: 'PHP' })
    await flush()

    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('swallows a failed fetch', async () => {
    mocks.fetchPersonSummary.mockRejectedValue(new Error('offline'))

    expect(() =>
      announceBillOffset({ userId: 'me', payerId: 'bob', payerName: 'Bob', currency: 'PHP' }),
    ).not.toThrow()
    await flush()

    expect(mocks.info).not.toHaveBeenCalled()
  })

  it('does not fetch when the viewer paid, or no payer is set', () => {
    announceBillOffset({ userId: 'me', payerId: 'me', payerName: 'You', currency: 'PHP' })
    announceBillOffset({ userId: 'me', payerId: null, payerName: 'You', currency: 'PHP' })

    expect(mocks.fetchPersonSummary).not.toHaveBeenCalled()
  })
})
