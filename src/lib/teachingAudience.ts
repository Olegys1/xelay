import { supabase } from './supabase'

export type TeachingAudienceMode = 'all' | 'subgroups' | 'teams'
export type TeachingAudienceTarget = { group_id: string; audience_mode: TeachingAudienceMode; subgroup_ids?: string[]; team_ids?: string[] }
export type TeachingSubgroup = { id: string; course_id: string; group_id: string; name: string; user_ids: string[]; version: number }
export type TeachingLabTeam = TeachingSubgroup & { item_id: string }
export type TeachingAnnouncement = { id: string; course_id: string; course_title?: string; title: string; body: string; created_by: string; author_name: string; created_at: string; updated_at: string; version: number; targets: TeachingAudienceTarget[] }
export type TeachingAudienceContext = { subgroups: TeachingSubgroup[]; teams: TeachingLabTeam[]; announcements: TeachingAnnouncement[]; members?: { group_id: string; user_id: string; full_name: string; username?: string | null }[] }
export interface TeachingAudienceRepository {
  context(courseId: string, groupId?: string): Promise<TeachingAudienceContext>
  messages(groupId: string): Promise<{ announcements: TeachingAnnouncement[] }>
  mutate(action: string, payload: Record<string, unknown>): Promise<{ id?: string; version?: number }>
}
export const EMPTY_TEACHING_AUDIENCE: TeachingAudienceContext = { subgroups: [], teams: [], announcements: [] }
export const ALL_TEACHING_AUDIENCE = (groupId: string): TeachingAudienceTarget => ({ group_id: groupId, audience_mode: 'all', subgroup_ids: [], team_ids: [] })
export function teachingAudienceTarget(target: { group_id: string; audience_mode?: TeachingAudienceMode; subgroup_ids?: string[]; team_ids?: string[] }): TeachingAudienceTarget {
  return { group_id: target.group_id, audience_mode: target.audience_mode || 'all', subgroup_ids: target.subgroup_ids || [], team_ids: target.team_ids || [] }
}
export function teachingAudienceLabel(target: Pick<TeachingAudienceTarget, 'audience_mode' | 'subgroup_ids' | 'team_ids'> | undefined, context?: TeachingAudienceContext): string {
  if (!target || !target.audience_mode || target.audience_mode === 'all') return 'Уся група'
  const selected = target.audience_mode === 'subgroups' ? context?.subgroups.filter(item => target.subgroup_ids?.includes(item.id)) : context?.teams.filter(item => target.team_ids?.includes(item.id))
  return selected?.length ? selected.map(item => item.name).join(', ') : target.audience_mode === 'subgroups' ? 'Вибрані підгрупи' : 'Вибрані команди'
}
export function teachingAudienceIsValid(target: TeachingAudienceTarget): boolean {
  return target.audience_mode === 'all' || target.audience_mode === 'subgroups' && Boolean(target.subgroup_ids?.length) || target.audience_mode === 'teams' && Boolean(target.team_ids?.length)
}
async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw error
  return data as T
}
export function createSupabaseTeachingAudienceRepository(): TeachingAudienceRepository {
  return {
    context: courseId => rpc('xelay_teaching_audience', { p_course_id: courseId }),
    messages: groupId => rpc('xelay_teaching_group_announcements', { p_group_id: groupId }),
    mutate: (action, payload) => rpc('xelay_teaching_audience_mutate', { p_action: action, p_payload: payload }),
  }
}
