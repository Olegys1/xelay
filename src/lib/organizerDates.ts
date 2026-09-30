export const dayKey = (date: Date) => Number.isFinite(date.getTime())
  ? new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Europe/Kyiv',
  }).format(date) : ''

const kyivDateParts = (date: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(date).map((part) => [part.type, part.value]))

export const toDateTimeInput = (value: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = kyivDateParts(date)
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`
}

/** Interpret the wall clock in Kyiv even when the student travels. */
export const fromDateTimeInput = (value: string) => {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!match) return new Date(NaN)
  const [, year, month, day, hour, minute] = match.map(Number)
  const wallClock = Date.UTC(year, month - 1, day, hour, minute)
  let timestamp = wallClock
  if (!Number.isFinite(timestamp)) return new Date(NaN)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = kyivDateParts(new Date(timestamp))
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
    timestamp += wallClock - represented
  }
  const date = new Date(timestamp)
  // The spring skipped hour and overflowing dates must not silently move.
  // The autumn repeated hour consistently uses the later occurrence.
  return Number.isFinite(date.getTime()) && toDateTimeInput(date.toISOString()) === value ? date : new Date(NaN)
}

export const dueLabel = (value: string) => {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Kyiv',
  }).format(date) : 'Дату не визначено'
}
