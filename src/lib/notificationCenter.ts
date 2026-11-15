import { supabase } from './supabase'

export const NOTIFICATION_CATEGORIES = [
  { id: 'schedule', title: 'Розклад і зміни пар', description: 'Скасування, перенесення та зміни занять.' },
  { id: 'assignments', title: 'Завдання й дедлайни', description: 'Нові завдання, строки здавання та нагадування.' },
  { id: 'tests', title: 'Тести та допуск', description: 'Опубліковані тести, доступ і завершені спроби.' },
  { id: 'grades', title: 'Оцінки й перевірка', description: 'Опубліковані бали, повернені роботи та запити.' },
  { id: 'teacher_messages', title: 'Повідомлення викладачів', description: 'Оголошення для ваших груп і підгруп.' },
  { id: 'groups', title: 'Групи та заявки', description: 'Запрошення, підключення й зміни ролей.' },
  { id: 'messages', title: 'Чати та особисті повідомлення', description: 'Нові повідомлення й запити на спілкування.' },
  { id: 'news', title: 'Новини', description: 'Публікації факультету та спільноти.' },
  { id: 'organizer', title: 'Особисті справи', description: 'Нагадування вашого органайзера.' },
  { id: 'account', title: 'Акаунт і доступ', description: 'Статус акаунта та доступ до можливостей Xelay.' },
  { id: 'community', title: 'Спільнота й подарунки', description: 'Відповіді й коментарі. Подарунки показуємо лише в Xelay, без листів.' },
] as const

export type NotificationCategory = typeof NOTIFICATION_CATEGORIES[number]['id']
export type NotificationEmailDelivery = 'immediate' | 'daily' | 'off'
export type NotificationCategorySetting = { in_app: boolean; email: NotificationEmailDelivery }
export type NotificationCategorySettings = Record<NotificationCategory, NotificationCategorySetting>
export type NotificationCenterTab = 'inbox' | 'settings'
export type NotificationFilters = {
  view: 'all' | 'unread' | 'required' | 'urgent'; category: 'all' | NotificationCategory
  group_id: string | null; course_id: string | null; period: 'all' | 'today' | 'week' | 'month'; search: string
}
export const DEFAULT_NOTIFICATION_FILTERS: NotificationFilters = Object.freeze({ view: 'all', category: 'all', group_id: null, course_id: null, period: 'all', search: '' })
export function notificationCategorySettings(value?: unknown): NotificationCategorySettings {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return Object.fromEntries(NOTIFICATION_CATEGORIES.map(category => {
    const item = source[category.id] as Partial<NotificationCategorySetting> | undefined
    return [category.id, { in_app: item?.in_app !== false, email: item?.email === 'off' || item?.email === 'daily' ? item.email : 'immediate' }]
  })) as NotificationCategorySettings
}
export type NotificationCenterItem = {
  id: string; actor_name: string; message: string; created_at: string; is_read: boolean
  category_key?: NotificationCategory; delivery_priority?: 'urgent' | 'attention' | 'normal' | null
  acknowledgement_required?: boolean; acknowledged_at?: string | null
  announcement_id?: string | null; announcement_version?: number | null
  group_name?: string | null; course_title?: string | null
  question_id?: string; answer_id?: string; news_post_id?: string | null
  study_group_id?: string | null; study_group_member_id?: string | null; chat_space_id?: string | null
  organizer_task_id?: string | null; direct_conversation_id?: string | null; teaching_course_id?: string | null
  teaching_event_key?: string | null; academic_tab?: string | null
  shared_organizer_workspace_id?: string | null; shared_organizer_invitation_id?: string | null; type?: string
}
export type NotificationCursor = { created_at: string; id: string }
export type NotificationCenterFeed = {
  items: NotificationCenterItem[]; required_items: NotificationCenterItem[]
  unread_count: number; required_count: number; badge_count: number; has_more: boolean; next_cursor: NotificationCursor | null
  groups: { id: string; name: string }[]; courses: { id: string; title: string }[]
}
export interface NotificationCenterRepository {
  feed(userId: string, filters: NotificationFilters, cursor?: NotificationCursor | null, signal?: AbortSignal): Promise<NotificationCenterFeed>
  markRead(userId: string, ids: string[]): Promise<unknown>
  acknowledge(userId: string, notificationId: string): Promise<unknown>
  subscribe?(userId: string, onChange: () => void): () => void
}
export function outstandingNotification(item: NotificationCenterItem) { return item.acknowledgement_required === true && !item.acknowledged_at }
export function notificationDisplayPriority(item: NotificationCenterItem): 'urgent' | 'attention' | 'normal' {
  if (item.delivery_priority) return item.delivery_priority
  if (item.type === 'teaching_update' && item.teaching_event_key?.startsWith('teaching-extension:')) return 'urgent'
  if (item.type === 'academic_deadline' || item.type === 'teaching_followup'
    || item.type === 'teaching_update' && (item.teaching_event_key?.startsWith('classroom-submit:') || item.teaching_event_key?.startsWith('grade-request:'))) return 'attention'
  return 'normal'
}
export function mergeNotificationPage(previous: NotificationCenterFeed | null, next: NotificationCenterFeed, append: boolean): NotificationCenterFeed {
  const required = new Set(next.required_items.map(item => item.id))
  const items = append ? [...previous?.items || [], ...next.items] : next.items
  const seen = new Set<string>()
  return { ...next, items: items.filter(item => {
    if (required.has(item.id) || seen.has(item.id)) return false
    seen.add(item.id); return true
  }) }
}
export function notificationCenterError(error: unknown): string {
  const message = error instanceof Error ? error.message : String((error as { message?: string })?.message || '')
  if (/ACTOR_CHANGED|42501|FORBIDDEN/.test(message)) return 'Акаунт або доступ змінився. Оновіть сповіщення та увійдіть знову.'
  if (/ACK|STALE|CONFLICT/.test(message)) return 'Повідомлення змінилося. Оновіть його й ознайомтеся з актуальною версією.'
  return 'Не вдалося підтвердити дію. Перевірте з’єднання й спробуйте ще раз.'
}
async function rpc<T>(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const query = supabase.rpc(name, args)
  const { data, error } = await (signal ? query.abortSignal(signal) : query)
  if (error) throw error
  return data as T
}
export function createNotificationCenterRepository(): NotificationCenterRepository {
  return {
    feed: (userId, filters, cursor, signal) => rpc('xelay_notification_center', { p_filters: filters, p_cursor: cursor || null, p_limit: 40, p_expected_user_id: userId }, signal),
    markRead: (userId, ids) => rpc('xelay_notification_mark_read', { p_ids: ids, p_expected_user_id: userId }),
    acknowledge: (userId, id) => rpc('xelay_notification_acknowledge', { p_notification_id: id, p_expected_user_id: userId }),
    subscribe: (userId, onChange) => {
      const channel = supabase.channel(`notification-center-${userId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, onChange).subscribe()
      return () => { void supabase.removeChannel(channel) }
    },
  }
}
export function notificationChanged(userId: string) { window.dispatchEvent(new CustomEvent('xelay-notifications-updated', { detail: { userId } })) }
