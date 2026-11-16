import { supabase } from './supabase'
import { normalizeScheduleConferenceAccess, normalizeScheduleExtraLinks, safeLessonUrl, STUDY_GROUP_LINK_LABEL_MAX_LENGTH, type ScheduleExtraLink } from './studyGroupLinks'

export type TeachingScheduleLinks = {
  online_url: string | null; online_url_secondary: string | null;
  online_url_label: string | null; online_url_secondary_label: string | null;
  online_links_extra: ScheduleExtraLink[]; conference_id: string | null; conference_access_code: string | null;
}
export type TeachingScheduleChange = { kind: 'move' | 'cancel'; date?: string; starts_at?: string; ends_at?: string; reason: string }
export type TeachingScheduleRequest = {
  id: string; schedule_id: string; course_id: string; course_title: string; teacher_name: string;
  subject: string; lesson_date: string; original_start: string; original_end: string;
  change_kind: 'move' | 'cancel'; proposed_date: string | null; proposed_start: string | null; proposed_end: string | null;
  reason: string; status: 'pending'; created_at: string;
}

export function normalizeTeachingScheduleLinks(value: TeachingScheduleLinks): TeachingScheduleLinks {
  const url = (raw: string | null) => {
    if (!raw?.trim()) return null
    const normalized = safeLessonUrl(raw)
    if (!normalized || normalized.length > 2000 || new URL(normalized).username || new URL(normalized).password || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(raw)) throw new Error('Вкажіть посилання http:// або https:// без прихованих символів, логіна й пароля.')
    return normalized
  }
  const label = (raw: string | null) => {
    if (!raw?.trim()) return null
    if (Array.from(raw.trim()).length > STUDY_GROUP_LINK_LABEL_MAX_LENGTH || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(raw)) throw new Error('Назва посилання має містити до 80 символів без прихованих знаків.')
    return raw.trim()
  }
  return { online_url: url(value.online_url), online_url_secondary: url(value.online_url_secondary), online_url_label: label(value.online_url_label), online_url_secondary_label: label(value.online_url_secondary_label), online_links_extra: normalizeScheduleExtraLinks(value.online_links_extra), ...normalizeScheduleConferenceAccess(value) }
}
export async function listTeachingScheduleRequests(groupId: string): Promise<{ requests: TeachingScheduleRequest[] }> {
  const { data, error } = await supabase.rpc('xelay_teaching_schedule_requests', { p_group_id: groupId })
  if (error) throw error
  return data
}
export async function reviewTeachingScheduleRequest(requestId: string, approve: boolean, expectedUserId: string): Promise<{ status: 'approved' | 'rejected' | 'stale' }> {
  const { data, error } = await supabase.rpc('xelay_teaching_schedule_change_review', { p_request_id: requestId, p_approve: approve, p_expected_user_id: expectedUserId })
  if (error) throw error
  return data
}
