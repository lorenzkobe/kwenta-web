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
