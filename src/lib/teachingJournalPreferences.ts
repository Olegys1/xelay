import type { TeachingActivity } from './teaching'

export type TeachingJournalPreferences = { activity_ids: string[]; version: number }
export function orderedTeachingActivities(activities: TeachingActivity[], ids: string[] = []) {
  const positions = new Map(ids.map((id, index) => [id, index]))
  return [...activities].sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    || a.activity_date.localeCompare(b.activity_date) || a.title.localeCompare(b.title, 'uk') || a.id.localeCompare(b.id))
}
export function teachingActivityTone(workType = ''): 'exam' | 'module' | 'test' | 'ordinary' {
  const value = workType.trim().toLocaleLowerCase('uk-UA')
  if (/залік|іспит|екзамен/.test(value)) return 'exam'
  if (/мкр|модул|контрольн/.test(value)) return 'module'
  return /тест/.test(value) ? 'test' : 'ordinary'
}
export function teachingGradeValue(score: number | null | undefined, absent = false) {
  return absent ? 'Н' : score == null ? '—' : new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 6 }).format(score)
}
