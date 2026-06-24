function formatExportDatetime(): string {
  const now = new Date()
  const month = now.getMonth() + 1
  const day = now.getDate()
  const year = now.getFullYear()
  let hours = now.getHours()
  const minutes = now.getMinutes().toString().padStart(2, '0')
  const ampm = hours >= 12 ? 'PM' : 'AM'
  hours = hours % 12 || 12
  return `${month}-${day}-${year} ${hours}:${minutes} ${ampm}`
}

export function makeExportFilename(prefix: string, ext: 'csv' | 'pdf' | 'png'): string {
  const safe = prefix.replace(/[/\\?%*:|"<>]/g, '-').trim()
  return `${safe} ${formatExportDatetime()}.${ext}`
}

/**
 * Convert a viewer-perspective group balance into the member's own perspective
 * for the member-share export card.
 *
 * Group balances (`computeGroupPairwiseBalances`) are stored from the viewer's
 * side: positive = the member owes you, negative = you owe the member. The
 * export card frames the same relationship from the MEMBER's side: positive =
 * they receive, negative = they pay. The two are negations of each other, so a
 * member you owe must render as "Receives", not "Pays".
 */
export function memberShareNetFromViewerNet(viewerNet: number): number {
  // Avoid returning -0 for a settled balance.
  return viewerNet === 0 ? 0 : -viewerNet
}
