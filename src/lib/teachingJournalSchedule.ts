import type { TeachingActivity } from './teaching'

const types: Record<string, string> = { lecture: 'Лекція', seminar: 'Семінар', practical: 'Практичне', lab: 'Лабораторна', makeup: 'Відпрацювання', replacement: 'Заміна', module: 'МКР', final_assessment: 'Підсумкова робота', test: 'Тест', other: 'Заняття' }
export function teachingJournalLessonLabel(activity: TeachingActivity): string {
  if (!activity.schedule_item_id) return ''
  const type = types[activity.schedule_lesson_type || ''] || 'Заняття'
  const time = activity.schedule_starts_at ? ` · ${activity.schedule_starts_at.slice(0, 5)}${activity.schedule_ends_at ? ` до ${activity.schedule_ends_at.slice(0, 5)}` : ''}` : ''
  return `${type}${time}${activity.schedule_missing ? ' · пару змінено або прибрано з розкладу' : ''}`
}
