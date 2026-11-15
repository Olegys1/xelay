import type { TeachingActivity } from './teaching'

export type TeachingJournalViewSettings = { layout: 'combined' | 'separate'; show_lectures: boolean; section: 'all' | 'lectures' | 'seminars' }
export type TeachingJournalPreferences = { activity_ids: string[]; version: number; view_settings?: TeachingJournalViewSettings }
export const DEFAULT_JOURNAL_VIEW: TeachingJournalViewSettings = { layout: 'combined', show_lectures: true, section: 'all' }
export function teachingJournalView(value?: Partial<TeachingJournalViewSettings> | null): TeachingJournalViewSettings {
  const layout = value?.layout === 'separate' ? 'separate' : 'combined'
  const show_lectures = value?.show_lectures !== false
  return { layout, show_lectures, section: layout === 'combined' ? 'all' : show_lectures && value?.section === 'lectures' ? 'lectures' : 'seminars' }
}
export function validateTeachingJournalView(value: unknown): TeachingJournalViewSettings {
  const settings = value as TeachingJournalViewSettings
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || Object.keys(settings).some(key => !['layout', 'show_lectures', 'section'].includes(key))
    || !['combined', 'separate'].includes(settings.layout) || typeof settings.show_lectures !== 'boolean' || !['all', 'lectures', 'seminars'].includes(settings.section)
    || JSON.stringify(teachingJournalView(settings)) !== JSON.stringify({ layout: settings.layout, show_lectures: settings.show_lectures, section: settings.section })) throw new Error('TEACHING_INVALID_INPUT')
  return { layout: settings.layout, show_lectures: settings.show_lectures, section: settings.section }
}
export function teachingJournalActivitySection(activity: TeachingActivity): 'lectures' | 'seminars' | 'shared' {
  if (!activity.schedule_item_id) return 'shared'
  if (activity.schedule_lesson_type === 'lecture') return 'lectures'
  return ['seminar', 'practical', 'lab'].includes(activity.schedule_lesson_type || '') ? 'seminars' : 'shared'
}
export function teachingJournalVisibleActivities(activities: TeachingActivity[], value?: TeachingJournalViewSettings): TeachingActivity[] {
  const settings = teachingJournalView(value)
  return activities.filter(activity => {
    const section = teachingJournalActivitySection(activity)
    if (section === 'shared') return true
    if (section === 'lectures' && !settings.show_lectures) return false
    return settings.layout === 'combined' || settings.section === section
  })
}
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
