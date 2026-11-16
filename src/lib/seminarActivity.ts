/** Participation is a reservation, never proof that a student actually spoke. */
export type SeminarActivityRole = 'primary' | 'supplement' | 'team' | 'booking'
export type SeminarActivityMember = { id: string; name: string; username?: string | null; groupId: string; accepted: boolean }
export type SeminarActivitySubject = { id: string; name: string; groupId: string }
export type SeminarActivityLesson = { id: string; groupId: string; subjectId: string; date: string; startsAt: string; title: string; cancelled?: boolean }
export type SeminarActivityReservation = { id: string; groupId: string; seminarId: string; userId: string; role: SeminarActivityRole; cancelled?: boolean }
export type SeminarActivityData = { groupId: string; members: SeminarActivityMember[]; subjects: SeminarActivitySubject[]; lessons: SeminarActivityLesson[]; reservations: SeminarActivityReservation[] }
export type SeminarActivityRange = { from: string; to: string }
export type SeminarActivityPeriod = '7' | '30' | 'semester' | 'custom'
export type SeminarActivityCounts = Record<SeminarActivityRole, number> & { planned: number }
export type SeminarActivityEntry = { seminarId: string; date: string; title: string; subjectId: string; subjectName: string; role: SeminarActivityRole; planned: boolean }
export type SeminarActivityRow = { member: SeminarActivityMember; counts: SeminarActivityCounts; subjects: Record<string, SeminarActivityCounts>; entries: SeminarActivityEntry[] }
export const ACTIVITY_ROLE_LABELS: Record<SeminarActivityRole, string> = { primary: 'Основні записи', supplement: 'Доповнення', team: 'Командні записи', booking: 'Бронювання' }
export const SEMINAR_ACTIVITY_MAX_DAYS = 220
const ROLES = new Set<SeminarActivityRole>(['primary', 'supplement', 'team', 'booking'])
export function validActivityDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const ms = Date.parse(`${value}T12:00:00Z`)
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value
}
export function activityKyivClock(now = new Date()): { date: string; time: string } {
  if (!Number.isFinite(now.getTime())) throw new Error('Перевірте дату перегляду.')
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value || ''
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}
export function shiftActivityDate(date: string, days: number): string {
  if (!validActivityDate(date) || !Number.isInteger(days)) throw new Error('Перевірте обрані дати.')
  const instant = new Date(`${date}T12:00:00Z`)
  instant.setUTCDate(instant.getUTCDate() + days)
  return instant.toISOString().slice(0, 10)
}
export function validateActivityRange(range: SeminarActivityRange): SeminarActivityRange {
  if (!validActivityDate(range.from) || !validActivityDate(range.to) || range.from > range.to) throw new Error('Початок періоду має бути не пізніше завершення.')
  const days = (Date.parse(`${range.to}T12:00:00Z`) - Date.parse(`${range.from}T12:00:00Z`)) / 86_400_000 + 1
  if (days > SEMINAR_ACTIVITY_MAX_DAYS) throw new Error('Оберіть період до 220 днів, щоб статистика завантажувалася швидко.')
  return range
}
export function activityRange(period: SeminarActivityPeriod, now = new Date(), custom?: SeminarActivityRange): SeminarActivityRange {
  if (period === 'custom') return validateActivityRange(custom || { from: '', to: '' })
  const today = activityKyivClock(now).date
  if (period === '7' || period === '30') return { from: shiftActivityDate(today, -(Number(period) - 1)), to: today }
  const [year, month] = today.split('-').map(Number)
  const from = month >= 9 ? `${year}-09-01` : month >= 2 ? `${year}-02-01` : `${year - 1}-09-01`
  return validateActivityRange({ from, to: today })
}
export function emptyActivityCounts(): SeminarActivityCounts { return { primary: 0, supplement: 0, team: 0, booking: 0, planned: 0 } }
export function individualActivityCount(counts: SeminarActivityCounts): number { return counts.primary + counts.supplement }
export function buildSeminarActivity(data: SeminarActivityData, range: SeminarActivityRange, subjectId = '', now = new Date()): SeminarActivityRow[] {
  validateActivityRange(range)
  const clock = activityKyivClock(now)
  const subjects = new Map(data.subjects.filter(item => item.groupId === data.groupId).map(item => [item.id, item]))
  const lessons = new Map(data.lessons.filter(item => item.groupId === data.groupId && !item.cancelled && validActivityDate(item.date)
    && /^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(item.startsAt) && subjects.has(item.subjectId)
    && item.date >= range.from && item.date <= range.to && (!subjectId || item.subjectId === subjectId)).map(item => [item.id, item]))
  const rows = new Map<string, SeminarActivityRow>()
  for (const member of data.members) {
    if (member.groupId !== data.groupId || !member.accepted || rows.has(member.id)) continue
    rows.set(member.id, { member, counts: emptyActivityCounts(), subjects: Object.create(null), entries: [] })
  }
  const seen = new Set<string>()
  for (const reservation of data.reservations) {
    if (reservation.groupId !== data.groupId || reservation.cancelled || !ROLES.has(reservation.role)) continue
    const lesson = lessons.get(reservation.seminarId), row = rows.get(reservation.userId)
    if (!lesson || !row) continue
    const key = JSON.stringify([row.member.id, lesson.id, reservation.role])
    if (seen.has(key)) continue
    seen.add(key)
    const planned = lesson.date > clock.date || lesson.date === clock.date && lesson.startsAt.slice(0, 5) > clock.time
    const counts = row.subjects[lesson.subjectId] ||= emptyActivityCounts()
    if (planned) { row.counts.planned += 1; counts.planned += 1 }
    else { row.counts[reservation.role] += 1; counts[reservation.role] += 1 }
    row.entries.push({ seminarId: lesson.id, date: lesson.date, title: lesson.title, subjectId: lesson.subjectId, subjectName: subjects.get(lesson.subjectId)!.name, role: reservation.role, planned })
  }
  return [...rows.values()].map(row => ({ ...row, entries: row.entries.sort((a, b) => b.date.localeCompare(a.date) || a.seminarId.localeCompare(b.seminarId)) }))
    .sort((a, b) => a.member.name.localeCompare(b.member.name, 'uk') || a.member.id.localeCompare(b.member.id))
}
