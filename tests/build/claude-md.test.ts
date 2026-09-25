import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * C30 — CLAUDE.md is part of "done" (rule 21). A stale next-migration number or Dexie version
 * sends the next contributor to write 076 over an existing file or to mutate a shipped version.
 */

const doc = readFileSync(resolve(__dirname, '../../CLAUDE.md'), 'utf8')

describe('CLAUDE.md reflects the sync realignment', () => {
  it('C30: rule 3 names 079 as the next migration', () => {
    expect(doc).toMatch(/Next number: \*\*`079`\*\*/)
    expect(doc).not.toMatch(/Next number: \*\*`076`\*\*/)
  })

  it('C30: the Dexie schema section says version 15', () => {
    expect(doc).toMatch(/Current version: \*\*15\*\*/)
  })

  it('C30: the migrations table has rows for 076, 077 and 078', () => {
    for (const n of ['076', '077', '078']) {
      expect(doc, `migrations table row for ${n}`).toMatch(new RegExp('^\\| `' + n + '` \\|', 'm'))
    }
  })

  it('C30: the coverage inventory names the new suites', () => {
    for (const name of ['write-queue', 'write-errors', 'device-owner', 'AuthProvider']) {
      expect(doc, name).toContain(name)
    }
    for (const n of ['076_', '077_', '078_']) {
      expect(doc, `SQL coverage entry ${n}`).toContain('`' + n)
    }
  })

  it('C30: the tab-activation staleness bound reads 60 minutes, not 5', () => {
    expect(doc).toMatch(/60[ -]min/)
    expect(doc).not.toMatch(/a refresh >= 5 min old/)
  })

  it('C30: finalizeMutationSync is no longer described as the mutation path', () => {
    expect(doc).not.toMatch(/notifySyncAfterMutation → finalizeMutationSync/)
  })
})
