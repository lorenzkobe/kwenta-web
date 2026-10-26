import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * C30 — CLAUDE.md is part of "done" (rule 21). A stale next-migration number or Dexie version
 * sends the next contributor to write 076 over an existing file or to mutate a shipped version.
 */

const read = (path: string) => readFileSync(resolve(__dirname, '../..', path), 'utf8')
const doc = read('CLAUDE.md')
const migrations = read('docs/migrations.md')
const coverage = read('docs/testing-coverage.md')

// Claude Code refuses instruction files past 150k chars in total, and the user-level files take
// ~18k of that, so the reference material lives in docs/ and CLAUDE.md stays an index.
const CLAUDE_MD_CHAR_BUDGET = 110_000

describe('CLAUDE.md reflects the sync realignment', () => {
  it('C30: rule 3 names 085 as the next migration', () => {
    expect(doc).toMatch(/Next number: \*\*`085`\*\*/)
    expect(doc).not.toMatch(/Next number: \*\*`076`\*\*/)
  })

  it('C30: the Dexie schema section says version 16', () => {
    expect(doc).toMatch(/Current version: \*\*16\*\*/)
  })

  it('C30: the migrations table has rows for 076, 077 and 078', () => {
    for (const n of ['076', '077', '078']) {
      expect(migrations, `migrations table row for ${n}`).toMatch(new RegExp('^\\| `' + n + '` \\|', 'm'))
    }
  })

  it('C30: the coverage inventory names the new suites', () => {
    for (const name of ['write-queue', 'write-errors', 'device-owner', 'AuthProvider']) {
      expect(coverage, name).toContain(name)
    }
    for (const n of ['076_', '077_', '078_']) {
      expect(coverage, `SQL coverage entry ${n}`).toContain('`' + n)
    }
  })

  it('the open-time bounds read 25 days (event log) and 24 h (backup safety refresh), not 60 minutes', () => {
    // Changed on purpose (fast app open, 2026-10-15): time away alone no longer forces the bundle.
    expect(doc).toMatch(/\*\*25 days\*\*/)
    expect(doc).toMatch(/\*\*24 h\*\*/)
    expect(doc).not.toMatch(/at least \*\*60 min\*\* old/)
    expect(doc).not.toMatch(/a refresh >= 5 min old/)
  })

  it('C30: finalizeMutationSync is no longer described as the mutation path', () => {
    expect(doc).not.toMatch(/notifySyncAfterMutation → finalizeMutationSync/)
  })

  it('stays within its character budget and points at the reference docs', () => {
    expect(doc.length).toBeLessThanOrEqual(CLAUDE_MD_CHAR_BUDGET)
    expect(doc).toContain('docs/migrations.md')
    expect(doc).toContain('docs/testing-coverage.md')
  })
})
