/** Dates received from the database may include PostgreSQL infinity or extended years. */
export function parseSafeDate(value: unknown): Date | null {
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string' && !value.trim()) return null
  const date = value instanceof Date ? value : new Date(value)
  const year = date.getUTCFullYear()
  return Number.isFinite(date.getTime()) && year >= 1 && year <= 9999 ? date : null
}

export function safeDateTime(value: unknown): number | null {
  return parseSafeDate(value)?.getTime() ?? null
}

export function formatSafeDate(value: unknown, formatter: Intl.DateTimeFormat, fallback = 'Дату не визначено'): string {
  const date = parseSafeDate(value)
  return date ? formatter.format(date) : fallback
}
