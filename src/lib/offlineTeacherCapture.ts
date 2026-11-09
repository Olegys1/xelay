import { supabase } from './supabase'
import { kyivToday } from './seminars'
import { addTimetableDays, isTimetableDate, LESSON_TYPES } from './studyGroupTimetable'
import {
  getOfflineTeacherCalendarRevision, OFFLINE_STUDY_DAYS, offlineStudyError,
  removeOfflineTeacherCalendar, saveOfflineTeacherCalendar,
  type OfflineTeacherCalendarInput, type OfflineTeacherCalendarSnapshot, type OfflineTeacherHomework,
} from './offlineStudy'
import {
  getOfflineShellStatus, prepareOfflineShellPreview, registerOfflineShell, retryOfflineShellPreparation,
} from './offlineShell'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_LESSONS = 3000
const MAX_HOMEWORK_PER_LESSON = 10
const CAPTURE_TIMEOUT_MS = 60_000
const RETRY = 'Не вдалося оновити офлайн-розклад. Перевірте інтернет і спробуйте ще раз. Попередня копія залишається доступною.'
const ACCOUNT_CHANGED = 'Акаунт або сеанс змінився. Відкрийте розклад викладача ще раз.'
const INVALID_CALENDAR = 'Не вдалося перевірити дані розкладу. Спробуйте оновити його ще раз.'

type CaptureInput = { userId: string; sessionId: string; signal?: AbortSignal }
type RecordValue = Record<string, unknown>

class CaptureError extends Error {}
class TeacherAccessDenied extends CaptureError {
  constructor(removed = false) {
    super(removed
      ? 'Доступ викладача змінився. Збережений розклад прибрано з пристрою.'
      : 'Доступ викладача змінився. Не вдалося підтвердити видалення збереженого розкладу.')
  }
}

export function isOfflineTeacherAccessDenied(value: unknown): boolean {
  return value instanceof TeacherAccessDenied
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  // Only display fields are copied. Strip pasted URLs and invisible controls
  // from those fields too, for example a meeting URL entered as a room.
  return value.replace(/(?:https?:\/\/|www\.)\S+/giu, ' ')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, limit)
}

function time(value: unknown): string | null {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d+)?)?$/.test(value) ? value.slice(0, 5) : null
}

function deadline(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64 || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined
  const stamp = Date.parse(value)
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : undefined
}

function homeworkFrom(value: unknown): OfflineTeacherHomework[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > MAX_HOMEWORK_PER_LESSON) throw new CaptureError(INVALID_CALENDAR)
  return value.flatMap(raw => {
    const item = record(raw)
    if (!item || (item.source !== 'teacher' && item.source !== 'group')
      || (item.status !== undefined && item.status !== 'published') || item.withdrawn_at != null) return []
    const dueAt = deadline(item.due_at)
    const audience = ['Для всієї групи', 'Для підгрупи', 'Для команди'].find(label => label === item.audience_label)
    return [{ title: text(item.title, 500) || 'Домашнє завдання', ...(dueAt ? { dueAt } : {}), ...(audience ? { audience } : {}) }]
  })
}

function courseGroupKey(courseId: string, groupId: string): string {
  return courseId.toLowerCase() + ':' + groupId.toLowerCase()
}

/** Copy only authorized timetable display fields, using the personal home calendar's role rules. */
export function projectOfflineTeacherCalendar(value: unknown, rangeStart: string, rangeEnd: string): OfflineTeacherCalendarInput {
  const calendar = record(value)
  if (!calendar || !Array.isArray(calendar.lessons) || calendar.lessons.length > MAX_LESSONS
    || !isTimetableDate(rangeStart) || !isTimetableDate(rangeEnd)
    || addTimetableDays(rangeStart, OFFLINE_STUDY_DAYS - 1) !== rangeEnd
    || (calendar.teaching_roles !== undefined && !Array.isArray(calendar.teaching_roles))) {
    throw new CaptureError(INVALID_CALENDAR)
  }
  const configuredRoles = new Set<string>()
  for (const raw of Array.isArray(calendar.teaching_roles) ? calendar.teaching_roles : []) {
    const role = record(raw)
    if (role && uuid(role.course_id) && uuid(role.group_id) && Number.isSafeInteger(role.version) && Number(role.version) > 0) {
      configuredRoles.add(courseGroupKey(role.course_id, role.group_id))
    }
  }

  const lessons: OfflineTeacherCalendarInput['lessons'] = []
  const seen = new Set<string>()
  for (const raw of calendar.lessons) {
    const lesson = record(raw)
    // Old calendar endpoints also returned seminar planning rows. Only a
    // real timetable occurrence belongs in the offline teaching schedule.
    if (lesson?.source === 'seminar') continue
    if (!lesson || lesson.source !== 'timetable' || !uuid(lesson.course_id) || !uuid(lesson.group_id) || !uuid(lesson.id)
      || typeof lesson.lesson_date !== 'string' || !isTimetableDate(lesson.lesson_date)) throw new CaptureError(INVALID_CALENDAR)
    const date = lesson.lesson_date
    if (date < rangeStart || date > rangeEnd) continue
    const pair = courseGroupKey(lesson.course_id, lesson.group_id)
    // A configured personal role uses the server's final flag, including
    // manual exceptions. Unconfigured pairs keep the legacy group timetable.
    if (configuredRoles.has(pair) && lesson.assigned_to_me !== true) continue
    const startsAt = time(lesson.starts_at)
    const endsAt = time(lesson.ends_at)
    const groupName = text(lesson.group_name, 240)
    const subject = text(lesson.subject_name, 500) || text(lesson.course_title, 500)
    if (!startsAt || !endsAt || startsAt >= endsAt || !groupName || !subject) throw new CaptureError(INVALID_CALENDAR)
    const id = 'teaching:' + pair + ':' + lesson.id.toLowerCase() + ':' + date
    if (seen.has(id)) continue
    seen.add(id)
    const lessonType = typeof lesson.lesson_type === 'string' && Object.prototype.hasOwnProperty.call(LESSON_TYPES, lesson.lesson_type)
      ? lesson.lesson_type : 'other'
    const location = text(lesson.location, 1000)
    const homework = homeworkFrom(lesson.homework)
    lessons.push({
      id, groupId: lesson.group_id.toLowerCase(), groupName, subject, date, startsAt, endsAt, lessonType,
      ...(location ? { location } : {}), ...(homework ? { homework } : {}),
    })
  }
  lessons.sort((a, b) => a.date.localeCompare(b.date) || a.startsAt.localeCompare(b.startsAt)
    || a.groupName.localeCompare(b.groupName, 'uk') || a.id.localeCompare(b.id))
  return { rangeStart, rangeEnd, lessons }
}

function abortable<T>(pending: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(pending).then(value => {
      signal.removeEventListener('abort', abort)
      if (signal.aborted) abort()
      else resolve(value)
    }, error => {
      signal.removeEventListener('abort', abort)
      reject(error)
    })
    if (signal.aborted) {
      signal.removeEventListener('abort', abort)
      abort()
    }
  })
}

function tokenSessionId(token: string | undefined): string | null {
  try {
    const payload = token?.split('.')[1]
    if (!payload || payload.length > 12_000) return null
    const claims = record(JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))))
    return uuid(claims?.session_id) ? claims.session_id : null
  } catch {
    return null
  }
}

async function requireAccount(userId: string, signal: AbortSignal, expectedSession?: string | null) {
  signal.throwIfAborted()
  const result = await abortable(supabase.auth.getSession(), signal)
  const session = result.data.session
  if (result.error || session?.user.id !== userId) throw new CaptureError(ACCOUNT_CHANGED)
  const identity = tokenSessionId(session.access_token)
  if (expectedSession !== undefined && identity !== expectedSession) throw new CaptureError(ACCOUNT_CHANGED)
  return identity
}

function requireReadable(result: { status: number; error: unknown }) {
  if (!result.error && result.status < 400) return
  const error = record(result.error)
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = typeof error?.message === 'string' ? error.message : ''
  if (result.status === 401 || ['28000', '28P01', 'PGRST301', 'PGRST302', 'PGRST303'].includes(code)
    || message === 'TEACHING_AUTH_REQUIRED') throw new CaptureError(ACCOUNT_CHANGED)
  if (result.status === 403 || code === '42501' || /^(TEACHING_FORBIDDEN|TEACHING_ACCESS_EXPIRED_OR_UNVERIFIED)$/.test(message)) {
    throw new TeacherAccessDenied()
  }
  throw new CaptureError(RETRY)
}

async function requireTeacherAccess(signal: AbortSignal) {
  signal.throwIfAborted()
  const result = await abortable(supabase.rpc('xelay_teacher_status').abortSignal(signal), signal)
  signal.throwIfAborted()
  requireReadable(result)
  const status = record(result.data)
  if (status?.verified === false || status?.has_current_access === false || status?.scope_changed === true) throw new TeacherAccessDenied()
  if (status?.verified !== true || status.has_current_access !== true) throw new CaptureError(RETRY)
}

async function warmShell(signal: AbortSignal) {
  signal.throwIfAborted()
  if (!getOfflineShellStatus().supported) throw new CaptureError('Цей браузер не підтримує збереження розкладу для офлайн-перегляду.')
  if (!getOfflineShellStatus().ready) {
    await abortable(registerOfflineShell(), signal)
    const status = getOfflineShellStatus()
    if (!status.ready) {
      await abortable(status.preview ? prepareOfflineShellPreview() : retryOfflineShellPreparation(), signal)
    }
  }
  const status = getOfflineShellStatus()
  if (!status.ready) throw new CaptureError('Не вдалося підготувати офлайн-перегляд. Спробуйте ще раз, поки є інтернет.')
  const pageVersion = typeof document === 'undefined' ? undefined
    : document.querySelector<HTMLMetaElement>('meta[name="xelay-shell-version"]')?.content
  if (pageVersion && status.version !== pageVersion) {
    throw new CaptureError('Збережіть відкриті зміни й натисніть «Оновити Xelay», перш ніж зберігати розклад офлайн.')
  }
}

/** Invoked only by the teacher's explicit save action. Returns the committed local copy. */
export async function captureOfflineTeacherCalendar({ userId, sessionId, signal }: CaptureInput): Promise<OfflineTeacherCalendarSnapshot> {
  if (!uuid(userId) || !uuid(sessionId)) throw new CaptureError(ACCOUNT_CHANGED)
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new CaptureError('Зараз немає інтернету. Оновіть збережений розклад після підключення.')
  }
  signal?.throwIfAborted()
  const controller = new AbortController()
  const captureSignal = controller.signal
  const cancel = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS)
  let authSession: string | null | undefined
  try {
    // This receipt must precede every request. Teacher revocation, logout and a
    // same-account re-login can invalidate it before the final atomic save.
    const revision = await abortable(getOfflineTeacherCalendarRevision(userId, sessionId), captureSignal)
    authSession = await requireAccount(userId, captureSignal)
    await requireTeacherAccess(captureSignal)
    const rangeStart = kyivToday()
    const rangeEnd = addTimetableDays(rangeStart, OFFLINE_STUDY_DAYS - 1)
    const result = await abortable(
      supabase.rpc('xelay_teaching_calendar', { p_from: rangeStart, p_to: rangeEnd }).abortSignal(captureSignal), captureSignal,
    )
    captureSignal.throwIfAborted()
    requireReadable(result)
    const snapshot = projectOfflineTeacherCalendar(result.data, rangeStart, rangeEnd)
    await warmShell(captureSignal)
    await requireAccount(userId, captureSignal, authSession)
    await requireTeacherAccess(captureSignal)
    await requireAccount(userId, captureSignal, authSession)
    captureSignal.throwIfAborted()
    return await saveOfflineTeacherCalendar(userId, snapshot, sessionId, revision)
  } catch (error) {
    if (!isOfflineTeacherAccessDenied(error) || captureSignal.aborted) throw error
    // A permission reply for a replaced browser session must not clear the
    // copy belonging to the session that initiated this capture.
    await requireAccount(userId, captureSignal, authSession)
    try {
      await removeOfflineTeacherCalendar(userId, sessionId)
    } catch {
      throw new TeacherAccessDenied()
    }
    throw new TeacherAccessDenied(true)
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
  }
}

export function offlineTeacherCaptureError(value: unknown): string {
  if (value instanceof CaptureError) return value.message
  if (value instanceof Error && value.message === 'OFFLINE_OWNER_CHANGED') return ACCOUNT_CHANGED
  if (value instanceof Error && value.message.startsWith('OFFLINE_')) return offlineStudyError(value)
  return RETRY
}
