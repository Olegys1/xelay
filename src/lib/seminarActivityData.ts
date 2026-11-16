import { supabase } from './supabase'
import { getPublicProfiles } from './profiles'
import { validateActivityRange, type SeminarActivityData, type SeminarActivityRange, type SeminarActivityRole } from './seminarActivity'

async function assertAccess(groupId: string, signal?: AbortSignal) {
  const result = await supabase.rpc('xelay_can_view_seminars', { p_group_id: groupId }).abortSignal(signal || new AbortController().signal)
  if (result.error) throw result.error
  if (result.data !== true) throw new Error('Статистика доступна лише підтвердженим учасникам цієї групи.')
}

/** Bounded, lazy reads retain existing accepted-member RLS. No grades or private profile fields. */
export async function loadSeminarActivityData(groupId: string, range: SeminarActivityRange, signal?: AbortSignal): Promise<SeminarActivityData> {
  validateActivityRange(range)
  await assertAccess(groupId, signal)
  const abort = signal || new AbortController().signal
  const [group, members, subjects, lessons] = await Promise.all([
    supabase.from('study_groups').select('id,representative_id').eq('id', groupId).abortSignal(abort).single(),
    supabase.from('study_group_members').select('user_id,group_id,status').eq('group_id', groupId).eq('status', 'accepted').order('user_id').limit(501).abortSignal(abort),
    supabase.from('study_group_seminar_subjects').select('id,group_id,name').eq('group_id', groupId).order('id').limit(501).abortSignal(abort),
    supabase.from('study_group_seminars').select('id,group_id,subject_id,lesson_date,starts_at,title').eq('group_id', groupId).gte('lesson_date', range.from).lte('lesson_date', range.to).order('id').limit(601).abortSignal(abort),
  ])
  for (const result of [group, members, subjects, lessons]) if (result.error) throw result.error
  if (!group.data || group.data.id !== groupId) throw new Error('Не вдалося підтвердити групу для цих даних.')
  if (members.data!.some(item => item.group_id !== groupId) || subjects.data!.some(item => item.group_id !== groupId) || lessons.data!.some(item => item.group_id !== groupId)) throw new Error('Не вдалося підтвердити групу для цих даних.')
  if (members.data!.length > 500 || subjects.data!.length > 500 || lessons.data!.length > 600) throw new Error('Забагато записів для одного перегляду. Оберіть коротший період.')
  const acceptedIds = [...new Set([group.data.representative_id, ...members.data!.map(member => member.user_id)].filter(Boolean))] as string[]
  const rows: SeminarActivityData['reservations'] = []
  const lessonRows = lessons.data || []
  // A normal 30-person group needs one reservation read. A large period remains bounded.
  for (let offset = 0; offset < lessonRows.length; offset += 20) {
    const batch = lessonRows.slice(offset, offset + 20).map(item => item.id)
    const result = await supabase.from('study_group_seminar_reservations').select('id,group_id,seminar_id,user_id,role')
      .eq('group_id', groupId).in('seminar_id', batch).order('id').limit(1000).abortSignal(abort)
    if (result.error) throw result.error
    if ((result.data || []).length >= 1000 || rows.length + (result.data || []).length > 12000) throw new Error('Для точного підрахунку оберіть коротший період.')
    rows.push(...(result.data || []).map(item => ({ id: item.id, groupId: item.group_id, seminarId: item.seminar_id, userId: item.user_id, role: item.role as SeminarActivityRole })))
  }
  const profiles = await getPublicProfiles(acceptedIds, signal)
  if (profiles.error) throw profiles.error
  // Access can be revoked while the bounded reads are in progress; discard the whole result.
  await assertAccess(groupId, signal)
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  const names = new Map(profiles.data.map(profile => [profile.id, profile]))
  return {
    groupId,
    members: acceptedIds.map(id => ({ id, name: names.get(id)?.full_name || names.get(id)?.username || 'Учасник групи', username: names.get(id)?.username || null, groupId, accepted: true })),
    subjects: (subjects.data || []).map(item => ({ id: item.id, name: item.name, groupId: item.group_id })),
    lessons: lessonRows.map(item => ({ id: item.id, groupId: item.group_id, subjectId: item.subject_id, date: item.lesson_date, startsAt: item.starts_at, title: item.title })),
    reservations: rows,
  }
}
