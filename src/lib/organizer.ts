import { supabase } from './supabase'
import { isMissingDatabaseColumn, isMissingDatabaseFunction, isMissingDatabaseTable } from './databaseCompatibility'

export interface OrganizerTask {
  id: string
  user_id: string
  title: string
  notes: string
  subject: string
  due_at: string | null
  due_date: string | null
  due_sort_at: string | null
  reminder_at: string | null
  reminder_sent_at: string | null
  reminder_offsets_minutes: number[]
  recurrence_rule: 'none' | 'daily' | 'weekly' | 'monthly'
  recurrence_until: string | null
  recurrence_next_id: string | null
  completed: boolean
  source_kind: 'homework' | 'seminar' | null
  source_id: string | null
  source_group_id: string | null
  source_question_id: string | null
  source_date: string | null
  created_at: string
  updated_at: string
}

export const ORGANIZER_SELECT = 'id,user_id,title,notes,subject,due_at,due_date,due_sort_at,reminder_at,reminder_sent_at,reminder_offsets_minutes,recurrence_rule,recurrence_until,recurrence_next_id,completed,source_kind,source_id,source_group_id,source_question_id,source_date,created_at,updated_at'
export const ORGANIZER_UPDATED_EVENT = 'xelay_organizer_updated'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function organizerSession(expectedUserId?: string) {
  const { data, error } = await supabase.auth.getSession()
  const session = data.session
  if (error || !session?.user.id || !session.access_token) throw new Error('ORGANIZER_AUTH_REQUIRED')
  if (expectedUserId && session.user.id !== expectedUserId) throw new Error('ORGANIZER_AUTH_CHANGED')
  return session
}

async function retainOrganizerIdentity(userId: string) {
  await organizerSession(userId)
}

function organizerTask(value: unknown, userId: string): OrganizerTask {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ORGANIZER_RESPONSE_INVALID')
  const task = value as Partial<OrganizerTask>
  if (typeof task.id !== 'string' || !UUID.test(task.id) || task.user_id !== userId
    || typeof task.title !== 'string' || typeof task.notes !== 'string' || typeof task.subject !== 'string'
    || typeof task.completed !== 'boolean' || typeof task.created_at !== 'string' || typeof task.updated_at !== 'string') {
    throw new Error('ORGANIZER_RESPONSE_INVALID')
  }
  for (const key of ['due_at', 'due_date', 'due_sort_at', 'reminder_at', 'reminder_sent_at', 'source_id', 'source_group_id', 'source_question_id', 'source_date'] as const) {
    if (task[key] !== null && typeof task[key] !== 'string') throw new Error('ORGANIZER_RESPONSE_INVALID')
  }
  if (task.source_kind !== null && task.source_kind !== 'homework' && task.source_kind !== 'seminar') throw new Error('ORGANIZER_RESPONSE_INVALID')
  // Older assignment RPC responses can omit the new optional settings until
  // migration deployment, without erasing the immutable source snapshot.
  return { ...task, reminder_offsets_minutes: task.reminder_offsets_minutes || [],
    recurrence_rule: task.recurrence_rule || 'none', recurrence_until: task.recurrence_until || null,
    recurrence_next_id: task.recurrence_next_id || null } as OrganizerTask
}

// Pin the request to the captured account instead of letting an intervening
// sign-in change the SDK's automatic bearer header. Never persist/log this token.
export async function addOrganizerAssignment(
  kind: 'homework' | 'seminar', assignmentId: string, questionId?: string | null, expectedUserId?: string,
): Promise<OrganizerTask> {
  if (!['homework', 'seminar'].includes(kind) || !UUID.test(assignmentId)
    || (questionId != null && (!UUID.test(questionId) || kind !== 'seminar'))) {
    throw new Error('ORGANIZER_INVALID_ASSIGNMENT')
  }
  const session = await organizerSession(expectedUserId)
  const { data, error } = await supabase.rpc('xelay_add_organizer_assignment', {
    p_kind: kind, p_assignment_id: assignmentId, p_question_id: questionId || null,
  }).setHeader('Authorization', `Bearer ${session.access_token}`)
  await retainOrganizerIdentity(session.user.id)
  if (error) throw error
  return organizerTask(data, session.user.id)
}

export async function deliverOrganizerReminders(expectedUserId?: string): Promise<number> {
  const session = await organizerSession(expectedUserId)
  const { data, error } = await supabase.rpc('xelay_deliver_organizer_reminders')
    .setHeader('Authorization', `Bearer ${session.access_token}`)
  await retainOrganizerIdentity(session.user.id)
  if (error) throw error
  if (typeof data !== 'number' || !Number.isInteger(data) || data < 0 || data > 100) throw new Error('ORGANIZER_RESPONSE_INVALID')
  return data
}

export async function loadOrganizerSubjects(expectedUserId?: string): Promise<string[]> {
  const session = await organizerSession(expectedUserId)
  const { data, error } = await supabase.rpc('xelay_organizer_subjects')
    .setHeader('Authorization', `Bearer ${session.access_token}`)
  await retainOrganizerIdentity(session.user.id)
  if (error) throw error
  if (!Array.isArray(data) || data.some((subject) => typeof subject !== 'string' || !subject.trim() || subject.length > 120)) {
    throw new Error('ORGANIZER_RESPONSE_INVALID')
  }
  return data
}

export function announceOrganizerUpdate(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(ORGANIZER_UPDATED_EVENT))
}

export function organizerError(error: unknown): string {
  const value = error as { code?: string; message?: unknown } | null
  if (isMissingDatabaseColumn(value) || isMissingDatabaseFunction(value) || isMissingDatabaseTable(value)) {
    return 'Оновлення органайзера ще не підключено. Спробуйте пізніше.'
  }
  const message = error instanceof Error ? error.message : String(value?.message || '')
  const labels: Record<string, string> = {
    ORGANIZER_AUTH_REQUIRED: 'Увійдіть до свого акаунта, щоб відкрити органайзер.',
    ORGANIZER_AUTH_CHANGED: 'Акаунт змінився. Оновіть сторінку та спробуйте ще раз.',
    ORGANIZER_PARTICIPANT_REQUIRED: 'Для цієї дії потрібна активна підписка «Учасник».',
    ORGANIZER_ASSIGNMENT_UNAVAILABLE: 'Завдання вже змінено або недоступне у вашій групі. Оновіть сторінку.',
    ORGANIZER_INVALID_ASSIGNMENT: 'Не вдалося визначити завдання. Оновіть сторінку.',
    ORGANIZER_INVALID_DEADLINE: 'Оберіть коректну дату дедлайну або дату з часом.',
    ORGANIZER_INVALID_REMINDER: 'Для нагадування вкажіть дедлайн і коректний час.',
    ORGANIZER_REMINDER_IN_PAST: 'Оберіть майбутній час нагадування.',
    ORGANIZER_IDENTITY_IMMUTABLE: 'Не вдалося змінити це завдання. Оновіть список.',
    ORGANIZER_SOURCE_IMMUTABLE: 'Посилання на навчальне завдання зберігається автоматично.',
    ORGANIZER_RESPONSE_INVALID: 'Не вдалося завантажити органайзер. Оновіть сторінку.',
    ORGANIZER_CONFLICT: 'Завдання змінилося на іншому пристрої. Оновіть список і повторіть дію.',
    ORGANIZER_INVALID_RECURRENCE: 'Для повторення вкажіть дедлайн і дату завершення не раніше за нього. Завдання з навчальної групи не повторюються.',
    ORGANIZER_OCCURRENCE_FINISHED: 'Наступне повторення вже створене. Відкрийте його у списку планів.',
  }
  for (const [code, label] of Object.entries(labels)) if (message.includes(code)) return label
  if (value?.code === '42501') return 'Дія недоступна. Перевірте свій акаунт і підписку.'
  if (value?.code === '23514' || value?.code === '22023') return 'Перевірте назву, дату дедлайну та час нагадування.'
  return 'Не вдалося виконати дію в органайзері. Спробуйте ще раз.'
}
