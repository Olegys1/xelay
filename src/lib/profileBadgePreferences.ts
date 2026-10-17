import { supabase } from './supabase'

export const PROFILE_BADGES_CHANGED = 'xelay:profile-badges-changed'
export interface ProfileBadgePreferences { showParticipant: boolean; showTeacher: boolean }

export function parseProfileBadgePreferences(value: unknown): ProfileBadgePreferences {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!row || typeof row.showParticipant !== 'boolean' || typeof row.showTeacher !== 'boolean') {
    throw new Error('Не вдалося перевірити налаштування бейджів. Спробуйте ще раз.')
  }
  return { showParticipant: row.showParticipant, showTeacher: row.showTeacher }
}

export async function loadProfileBadgePreferences(userId: string, signal?: AbortSignal): Promise<ProfileBadgePreferences> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(userId)) throw new Error('Не вдалося визначити профіль.')
  signal?.throwIfAborted()
  const request = supabase.rpc('xelay_profile_badge_preferences', { p_user_id: userId })
  const { data, error } = await (signal ? request.abortSignal(signal) : request)
  signal?.throwIfAborted()
  if (error) throw new Error('Не вдалося завантажити налаштування бейджів. Спробуйте ще раз.')
  return parseProfileBadgePreferences(data)
}

export async function saveMyProfileBadgePreferences(showParticipant: boolean, showTeacher: boolean, signal?: AbortSignal): Promise<ProfileBadgePreferences> {
  if (typeof showParticipant !== 'boolean' || typeof showTeacher !== 'boolean') throw new Error('Перевірте вибір бейджів.')
  signal?.throwIfAborted()
  const request = supabase.rpc('xelay_set_my_profile_badges', { p_show_participant: showParticipant, p_show_teacher: showTeacher })
  const { data, error } = await (signal ? request.abortSignal(signal) : request)
  signal?.throwIfAborted()
  if (error) throw new Error('Не вдалося зберегти вибір. Перевірте перемикачі й повторіть спробу.')
  const preferences = parseProfileBadgePreferences(data)
  if (preferences.showParticipant !== showParticipant || preferences.showTeacher !== showTeacher) {
    throw new Error('Не вдалося підтвердити збереження вибору. Перевірте налаштування ще раз.')
  }
  return preferences
}
