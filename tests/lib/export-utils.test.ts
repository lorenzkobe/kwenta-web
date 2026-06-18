import { describe, expect, it } from 'vitest'
import { makeExportFilename } from '@/lib/export-utils'

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
