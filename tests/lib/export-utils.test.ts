import { describe, expect, it } from 'vitest'
import { makeExportFilename, memberShareNetFromViewerNet } from '@/lib/export-utils'

describe('makeExportFilename', () => {
  it('appends the extension', () => {
    expect(makeExportFilename('Bills', 'csv')).toMatch(/^Bills .*\.csv$/)
    expect(makeExportFilename('Bills', 'pdf')).toMatch(/\.pdf$/)
    expect(makeExportFilename('Bills', 'png')).toMatch(/\.png$/)
  })

  it('strips filesystem-unsafe characters from the prefix', () => {
    const name = makeExportFilename('Trip: 2026/Q3 "Beach"', 'csv')
    // Only the prefix is sanitized; the appended timestamp legitimately contains a
    // colon (e.g. "2:51 PM"), so assert against the prefix segment only.
    const prefix = name.split(/ \d{1,2}-\d{1,2}-\d{4} /)[0]
    expect(prefix).not.toMatch(/[/\\?%*:|"<>]/)
    expect(prefix).toBe('Trip- 2026-Q3 -Beach-')
  })

  it('embeds a human-readable timestamp', () => {
    const name = makeExportFilename('X', 'csv')
    // e.g. "X 6-18-2026 2:46 PM.csv"
    expect(name).toMatch(/\d{1,2}-\d{1,2}-\d{4} \d{1,2}:\d{2} (AM|PM)\.csv$/)
  })
})

describe('memberShareNetFromViewerNet', () => {
  // Group balances are stored viewer-perspective: positive = the member owes
  // you, negative = you owe the member. The member-share export card frames the
  // number from the MEMBER's own perspective: positive = they receive, negative
  // = they pay. The two perspectives are negations of each other.
  it('flips a member you owe into a "Receives" amount', () => {
    // Viewer owes the member 5365.37 (viewer-net is negative) → from the
    // member's side they are owed that money, i.e. they receive it.
    expect(memberShareNetFromViewerNet(-5365.37)).toBeCloseTo(5365.37, 2)
  })

  it('flips a member who owes you into a "Pays" amount', () => {
    // Member owes the viewer (viewer-net positive) → member pays.
    expect(memberShareNetFromViewerNet(1263.92)).toBeCloseTo(-1263.92, 2)
  })

  it('keeps a settled balance at zero', () => {
    expect(memberShareNetFromViewerNet(0)).toBe(0)
  })
})
