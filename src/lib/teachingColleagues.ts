import { supabase } from './supabase'
import type { TeachingPermission } from './teaching'

export type TeachingColleague = { user_id: string; username: string; full_name: string; department: string; position: string; status: 'available' | 'pending' | 'accepted' | 'removed' | 'rejected' }
export type TeachingGroupScope = { group_scope: 'selected' | 'all'; group_ids: string[] }
export const teachingPermissionDescriptions: Record<TeachingPermission, string> = {
  materials: 'Додавати власні матеріали. Оновлювати чи відкликати матеріал колеги можна лише з його окремим дозволом. Авторство зберігається.',
  assignments: 'Створювати й редагувати завдання, перевіряти здані роботи у вибраних групах.',
  grades: 'Бачити журнал вибраних груп, зберігати та публікувати бали й коментарі.',
  manage: 'Керування предметом залишається у його власника.',
}
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
export function normalizeTeachingNickname(value: string): string {
  const name = value.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA')
  if (!/^[\p{L}\p{N}][\p{L}\p{N}_.-]{2,29}$/u.test(name)) throw new Error('Вкажіть точний нікнейм викладача: від 3 до 30 символів, без пробілів.')
  return name
}
export async function lookupTeachingColleague(courseId: string, nickname: string, signal?: AbortSignal): Promise<TeachingColleague | null> {
  if (!uuid.test(courseId)) throw new Error('Не вдалося визначити предмет.')
  const username = normalizeTeachingNickname(nickname)
  signal?.throwIfAborted()
  const { data, error } = await supabase.rpc('xelay_teaching_find_colleague', { p_course_id: courseId, p_username: username }).abortSignal(signal || new AbortController().signal)
  signal?.throwIfAborted()
  if (error) throw new Error('Не вдалося перевірити викладача. Перевірте доступ до предмета та повторіть спробу.')
  if (data === null) return null
  if (!data || typeof data !== 'object' || Array.isArray(data) || !uuid.test(data.user_id)
    || typeof data.username !== 'string' || normalizeTeachingNickname(data.username) !== username
    || !['full_name', 'department', 'position'].every(key => typeof data[key] === 'string' && data[key].length <= 500)
    || !['available','pending','accepted','removed','rejected'].includes(data.status)) throw new Error('Не вдалося підтвердити профіль викладача.')
  return { user_id: data.user_id, username: data.username, full_name: data.full_name, department: data.department, position: data.position, status: data.status }
}
