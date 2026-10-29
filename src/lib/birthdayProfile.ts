import { supabase } from './supabase'

export interface BirthdayProfile { day: number | null; month: number | null; showToGroup: boolean }
export interface GroupBirthday { userId: string; name: string; avatarUrl: string | null; day: number; month: number; isToday: boolean; daysUntil: number }
export const BIRTHDAY_PROFILE_CHANGED = 'xelay:birthday-profile-changed'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const invalid = () => new Error('Не вдалося перевірити налаштування дня народження. Спробуйте ще раз.')
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
export function validBirthday(day: unknown, month: unknown): day is number {
  if (!Number.isInteger(day) || !Number.isInteger(month) || Number(month) < 1 || Number(month) > 12) return false
  return Number(day) >= 1 && Number(day) <= new Date(Date.UTC(2000, Number(month), 0)).getUTCDate()
}
export function parseBirthdayProfile(value: unknown): BirthdayProfile {
  if (!object(value) || typeof value.share_with_groups !== 'boolean') throw invalid()
  if (value.day === null && value.month === null && !value.share_with_groups) return { day: null, month: null, showToGroup: false }
  if (!validBirthday(value.day, value.month)) throw invalid()
  return { day: value.day, month: Number(value.month), showToGroup: value.share_with_groups }
}
function avatar(value: unknown): string | null {
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) throw invalid()
  try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw invalid(); return url.href } catch { throw invalid() }
}
export function parseGroupBirthdays(value: unknown): GroupBirthday[] {
  if (!Array.isArray(value) || value.length > 200) throw invalid()
  const seen = new Set<string>()
  return value.map(item => {
    if (!object(item) || typeof item.user_id !== 'string' || !UUID.test(item.user_id) || seen.has(item.user_id)
      || typeof item.full_name !== 'string' || !item.full_name.trim() || item.full_name.length > 200 || /[\u0000-\u001f\u007f]/u.test(item.full_name)
      || !validBirthday(item.day, item.month) || !Number.isInteger(item.days_until) || Number(item.days_until) < 0 || Number(item.days_until) > 7
      || typeof item.is_today !== 'boolean' || item.is_today !== (item.days_until === 0)) throw invalid()
    seen.add(item.user_id)
    return { userId: item.user_id, name: item.full_name.trim(), avatarUrl: avatar(item.avatar_url), day: item.day, month: Number(item.month), isToday: item.is_today, daysUntil: Number(item.days_until) }
  })
}

/** Owner identity is checked before and after each request; the server derives
 * the actor, date and group scope independently from the authenticated session. */
async function rpc(actor: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (!UUID.test(actor)) throw invalid()
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('Запит перервано. Перевірте налаштування ще раз.'))
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
  const timeout = window.setTimeout(() => controller.abort(new Error('Відповідь затримується. Перевірте з’єднання та спробуйте ще раз.')), 15000)
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT' || session && session.user.id !== actor) abort()
  })
  const check = () => { if (controller.signal.aborted) throw controller.signal.reason instanceof Error ? controller.signal.reason : new Error('Запит перервано. Перевірте налаштування ще раз.') }
  let rejectAbort: (() => void) | undefined
  try {
    check()
    const interrupted = new Promise<never>((_, reject) => {
      rejectAbort = () => { try { check() } catch (error) { reject(error) } }
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    return await Promise.race([interrupted, (async () => {
    const before = await supabase.auth.getSession(); check()
    if (before.error || before.data.session?.user.id !== actor) throw new Error('Увійдіть у свій акаунт, щоб продовжити.')
    const result = await supabase.rpc(name, args).abortSignal(controller.signal); check()
    const after = await supabase.auth.getSession(); check()
    if (after.error || after.data.session?.user.id !== actor) throw new Error('Акаунт змінився. Відкрийте налаштування ще раз.')
    if (result.error) {
      const code = String(result.error.code || '')
      if (code === '42501') throw new Error('Доступ недоступний. Перевірте свій акаунт і участь у групі.')
      if (code === '22023') throw new Error('Перевірте день і місяць народження.')
      throw invalid()
    }
    return result.data
    })()])
  } finally { window.clearTimeout(timeout); signal?.removeEventListener('abort', abort); if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort); subscription.unsubscribe() }
}
export async function loadBirthdayProfile(actor: string, signal?: AbortSignal) {
  return parseBirthdayProfile(await rpc(actor, 'xelay_my_birthday_profile', {}, signal))
}
export async function saveBirthdayProfile(actor: string, value: BirthdayProfile, signal?: AbortSignal) {
  if (value.day === null && value.month === null ? value.showToGroup : !validBirthday(value.day, value.month)) throw invalid()
  if (typeof value.showToGroup !== 'boolean') throw invalid()
  return parseBirthdayProfile(await rpc(actor, 'xelay_save_my_birthday_profile', { p_day: value.day, p_month: value.month, p_share_with_groups: value.showToGroup }, signal))
}
export async function loadGroupBirthdays(actor: string, groupId: string, signal?: AbortSignal) {
  if (!UUID.test(groupId)) throw invalid()
  return parseGroupBirthdays(await rpc(actor, 'xelay_group_birthdays', { p_group_id: groupId }, signal))
}
