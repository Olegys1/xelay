import { supabase } from './supabase'
import type { TimetableLesson } from './studyGroupTimetable'

/** Keep older schedules reachable even when a group outgrows the API row cap. */
export async function loadStudyGroupScheduleHistory(groupId: string, isCurrent: () => boolean = () => true) {
  const rows: TimetableLesson[] = []
  let after: string | null = null
  while (isCurrent()) {
    let query = supabase.from('study_group_schedule').select('*').eq('group_id', groupId).order('id', { ascending: true }).limit(500)
    if (after) query = query.gt('id', after)
    const result = await query
    if (result.error) return { data: null, error: result.error, status: result.status }
    if (!isCurrent()) return { data: null, error: null, status: 200 }
    if (!result.data?.length) break
    const page = result.data.filter(item => item.group_id === groupId) as TimetableLesson[]
    rows.push(...page)
    const next = result.data[result.data.length - 1]?.id
    if (typeof next !== 'string' || next === after) throw new Error('Не вдалося прочитати історію розкладу. Спробуйте ще раз.')
    after = next
  }
  rows.sort((first, second) => first.weekday - second.weekday || first.starts_at.localeCompare(second.starts_at) || first.id.localeCompare(second.id))
  return { data: rows, error: null, status: 200 }
}
