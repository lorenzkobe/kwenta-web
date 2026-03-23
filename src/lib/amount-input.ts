/** Keep digits and at most one decimal separator (comma normalized to dot). */
export function filterDecimalInput(raw: string): string {
  let out = ''
  let hasDot = false
  for (const ch of raw) {
    if (ch >= '0' && ch <= '9') out += ch
    else if ((ch === '.' || ch === ',') && !hasDot) {
      out += '.'
      hasDot = true
    }
  }
  return out
}

/** Remove leading zeros while keeping "0", "0.", "0.5" meaningful. */
export function stripLeadingZerosAmount(raw: string): string {
  const t = raw.trim()
  if (t === '' || t === '.') return ''
  const parts = t.split('.')
  const intPart = parts[0] ?? ''
  const frac = parts[1]
  let i = intPart.replace(/^0+/, '')
  if (i === '' && frac !== undefined) i = '0'
  if (i === '' && frac === undefined) return intPart === '0' ? '0' : ''
  if (frac !== undefined) return `${i}.${frac}`
  return i
}

/** Decimal-only input normalized for live typing (prevents values like "0250"). */
export function normalizeAmountInput(raw: string): string {
  return stripLeadingZerosAmount(filterDecimalInput(raw))
}
