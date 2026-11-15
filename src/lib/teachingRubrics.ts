import { supabase } from './supabase'

export type TeachingRubric = { criteria: { id: string; title: string; levels: { id: string; label: string; points: number }[] }[] }
export type TeachingRubricLevels = Record<string, string>
export type TeachingRubricMark = { id: string; submission_id: string; rubric: TeachingRubric; levels: TeachingRubricLevels; score: number; maximum: number; feedback: string; version: number; updated_at: string }
export type TeachingRubricData = { rubric: TeachingRubric | null; version: number; marks: TeachingRubricMark[]; can_edit: boolean; can_grade: boolean }
export function teachingRubricScore(rubric: TeachingRubric, levels: TeachingRubricLevels, maximum: number): number | null {
  let total = 0, cap = 0
  if (!rubric.criteria.length || !Number.isFinite(maximum) || maximum <= 0) return null
  for (const criterion of rubric.criteria) {
    const level = criterion.levels.find(level => level.id === levels[criterion.id])
    if (!level) return null
    total += level.points; cap += Math.max(...criterion.levels.map(item => item.points))
  }
  return cap > 0 ? Math.round(maximum * total / cap * 100) / 100 : null
}
export function teachingRubricError(error: unknown): string {
  const text = String((error as { message?: unknown })?.message || error)
  if (text.includes('RUBRIC_CONFLICT') || text.includes('TEACHING_CONFLICT')) return 'Дані вже змінилися. Оновіть роботу й перевірте оцінку перед повторним збереженням.'
  if (text.includes('RUBRIC_LOCKED')) return 'За цими критеріями вже оцінено роботи. Створіть інше завдання, щоб змінити критерії.'
  if (text.includes('RUBRIC_FORBIDDEN') || text.includes('TEACHING_FORBIDDEN')) return 'Немає дозволу на цю роботу або оцінювання.'
  return 'Перевірте критерії, обрані рівні й актуальність роботи.'
}
export const teachingRubricRepository = {
  async get(assignmentId: string, groupId: string): Promise<TeachingRubricData> {
    const { data, error } = await supabase.rpc('xelay_teaching_rubric', { p_assignment_id: assignmentId, p_group_id: groupId })
    if (error) throw error
    return data as TeachingRubricData
  },
  async mutate(action: 'save_rubric' | 'assess_submission', payload: Record<string, unknown>): Promise<TeachingRubricData> {
    const { data, error } = await supabase.rpc('xelay_teaching_rubric_mutate', { p_action: action, p_payload: payload })
    if (error) throw error
    return data as TeachingRubricData
  },
}
