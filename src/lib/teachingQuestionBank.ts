import { supabase } from './supabase'
import type { TeachingTestQuestion } from './teachingTests'

export type TeachingQuestionBankEntry = {
  id: string; course_id: string; category: string; tags: string[]; question: TeachingTestQuestion
  version: number; archived_at: string | null; created_at?: string
}
export type TeachingQuestionBankData = { entries: TeachingQuestionBankEntry[] }
export type TeachingQuestionBankRepository = {
  list(courseId: string): Promise<TeachingQuestionBankData>
  mutate(action: 'save_entry' | 'archive_entry' | 'import_entries', payload: Record<string, unknown>): Promise<TeachingQuestionBankData>
}
export function createSupabaseTeachingQuestionBankRepository(): TeachingQuestionBankRepository {
  async function call(name: string, args: Record<string, unknown>): Promise<TeachingQuestionBankData> {
    const { data, error } = await supabase.rpc(name, args)
    if (error) throw error
    return data as TeachingQuestionBankData
  }
  return {
    list: courseId => call('xelay_teaching_question_bank', { p_course_id: courseId }),
    mutate: (action, payload) => call('xelay_teaching_question_bank_mutate', { p_action: action, p_payload: payload }),
  }
}
