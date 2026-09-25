import { describe, expect, it } from 'vitest'
import * as savedCopy from '@/components/common/SavedCopyNotice'

/**
 * C1: the per-page "Updating…" chip rendered as its own row above the Groups (and five other)
 * lists, pushing the list down for the length of every revalidation. The header bar and the
 * Refresh button carry that signal now, so the chip is gone; the notice for a FINAL cached answer
 * stays.
 */
describe('SavedCopyNotice module', () => {
  it('C1: no longer exports the RefreshingChip', () => {
    expect('RefreshingChip' in savedCopy).toBe(false)
  })

  it('C1: still exports the saved-copy notice', () => {
    expect(typeof savedCopy.SavedCopyNotice).toBe('function')
  })
})
