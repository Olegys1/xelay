import { supabase } from './supabase'
import type { TimetableLesson } from './studyGroupTimetable'

/** Keep older schedules reachable even when a group outgrows the API row cap. */
export async function loadStudyGroupScheduleHistory(groupId: string, isCurrent: () => boolean = () => true, signal?: AbortSignal) {
  const rows: TimetableLesson[] = []
  let after: string | null = null
  while (isCurrent() && !signal?.aborted) {
    let query = supabase.from('study_group_schedule').select('*').eq('group_id', groupId).order('id', { ascending: true }).limit(500)
    if (after) query = query.gt('id', after)
    const result = await (signal ? query.abortSignal(signal) : query)
    if (result.error) return { data: null, error: result.error, status: result.status }
    if (!isCurrent() || signal?.aborted) return { data: null, error: null, status: 200 }
    if (!result.data?.length) break
    const page = result.data.filter(item => item.group_id === groupId) as TimetableLesson[]
    rows.push(...page)
    const next = result.data[result.data.length - 1]?.id
    if (typeof next !== 'string' || next === after) throw new Error('Не вдалося прочитати історію розкладу. Спробуйте ще раз.')
    after = next
  }
  // Separate, read-only personalized projection; never expose other students' recipients.
  after = null
  while (isCurrent() && !signal?.aborted) {
    const query = supabase.rpc('xelay_dean_personal_lessons', { p_group: groupId, p_after: after })
    const result = await (signal ? query.abortSignal(signal) : query)
    if (result.error) {
      // Safe rollout before the new schema; all other errors remain visible.
      if (result.error.code === 'PGRST202') break
      return { data: null, error: result.error, status: result.status }
    }
    if (!isCurrent() || signal?.aborted) return { data: null, error: null, status: 200 }
    const page = (Array.isArray(result.data) ? result.data : []) as TimetableLesson[]
    if (!page.length) break
    rows.push(...page.filter(item => item.group_id === groupId && item.dean_managed === true))
    const next = page[page.length - 1]?.id
    if (!next || next === after) throw new Error('Не вдалося прочитати розклад деканату.')
    after = next
  }
  rows.sort((first, second) => first.weekday - second.weekday || first.starts_at.localeCompare(second.starts_at) || first.id.localeCompare(second.id))
  return { data: rows, error: null, status: 200 }
}
