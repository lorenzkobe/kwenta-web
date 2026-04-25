export function activeOnly<T extends { is_deleted: boolean }>(rows: T[]): T[] {
  return rows.filter((row) => !row.is_deleted)
}

export function mapById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, row]))
}

export function uniqueStrings(values: Iterable<string | null | undefined>): string[] {
  return [...new Set([...values].filter((value): value is string => Boolean(value)))]
}
