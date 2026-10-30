import { supabase } from './supabase'
import { getPublicProfiles } from './profiles'
import { getSeminarAttachments, getSeminarLinks, type SeminarAttachment } from './seminarResources'
import { scheduleOccursOnDate, type WeekPattern } from './studyGroupTimetable'
import { normalizedScheduleSubjectName } from './scheduleSubjects'

export type SeminarFormat = 'questions' | 'teams' | 'booking'
export const SEMINAR_DEFAULT_SUPPLEMENT_CAPACITY = 3
export const SEMINAR_MAX_SUPPLEMENT_CAPACITY = 30

// Old local drafts may predate the per-question snapshot. A valid zero closes
// supplements; it must not be replaced with the default through a truthy check.
export function seminarSupplementCapacity(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= SEMINAR_MAX_SUPPLEMENT_CAPACITY
    ? value : SEMINAR_DEFAULT_SUPPLEMENT_CAPACITY
}
export const SEMINAR_FORMATS: { id: SeminarFormat; label: string; description: string }[] = [
  { id: 'questions', label: 'Доповідачі та доповнювачі', description: 'Основні відповіді й доповнення з рекомендацією чергувати ролі.' },
  { id: 'teams', label: 'Командна робота', description: 'Команди з назвами та окремою кількістю місць.' },
  { id: 'booking', label: 'Бронювання питань', description: 'Учасники обирають питання, а викладач визначає доповідачів.' },
]

export type SeminarSubject = { id: string; group_id: string; name: string; created_by: string; has_schedule_sources?: boolean }
export type SeminarSchedule = {
  id: string; group_id: string; subject_id: string; weekday: number; starts_at: string; ends_at: string
  valid_from: string; valid_until: string; created_by: string
  source_schedule_id?: string | null; source_managed?: boolean; source_active?: boolean
  week_pattern?: WeekPattern; week_anchor_date?: string | null; excluded_dates?: string[]
}
export type Seminar = {
  id: string; group_id: string; subject_id: string; schedule_id: string; lesson_date: string
  starts_at: string; ends_at: string; title: string; instructions: string; format: SeminarFormat; created_by: string
  resource_links: string[]; resource_attachments: SeminarAttachment[]
  teaching_course_id?: string | null; teaching_author_id?: string | null
  selection_deadline_at?: string | null; selection_version?: number
}
export type SeminarSelectionOccupancy = {
  seminar_id: string; question_id: string | null; team_id: string | null
  role: SeminarReservation['role']; count: number
}
export type SeminarQuestion = { id: string; seminar_id: string; position: number; body: string; primary_capacity: number; supplement_capacity?: number }
export type SeminarTeam = { id: string; seminar_id: string; position: number; name: string; capacity: number }
export type SeminarReservation = {
  id: string; seminar_id: string; user_id: string; role: 'primary' | 'supplement' | 'team' | 'booking'
  question_id: string | null; team_id: string | null
}
export type SeminarProfile = { id: string; full_name: string | null; username: string | null; avatar_url: string | null }
export type SeminarData = {
  supplement_capacity: number
  subjects: SeminarSubject[]; schedule: SeminarSchedule[]; seminars: Seminar[]
  questions: SeminarQuestion[]; teams: SeminarTeam[]; reservations: SeminarReservation[]
  profiles: Record<string, SeminarProfile>; streaks: Record<string, number>; subjectStreaks: Record<string, number>
  reopened_seminars?: Seminar[]; reopened_schedule?: SeminarSchedule[]; selection_occupancy?: SeminarSelectionOccupancy[]
}

export const EMPTY_SEMINAR_DATA: SeminarData = {
  supplement_capacity: SEMINAR_DEFAULT_SUPPLEMENT_CAPACITY,
  subjects: [], schedule: [], seminars: [], questions: [], teams: [], reservations: [], profiles: {}, streaks: {}, subjectStreaks: {},
  reopened_seminars: [], reopened_schedule: [], selection_occupancy: [],
}

export const SEMINAR_WEEKDAYS = [
  { id: 1, short: 'Пн', full: 'Понеділок' }, { id: 2, short: 'Вт', full: 'Вівторок' },
  { id: 3, short: 'Ср', full: 'Середа' }, { id: 4, short: 'Чт', full: 'Четвер' },
  { id: 5, short: 'Пт', full: 'П’ятниця' }, { id: 6, short: 'Сб', full: 'Субота' }, { id: 7, short: 'Нд', full: 'Неділя' },
]

export function dateString(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}
export function parseSeminarDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return new Date(year, month - 1, day, 12)
}
export function addSeminarDays(value: string, days: number) {
  const date = parseSeminarDate(value)
  date.setDate(date.getDate() + days)
  return dateString(date)
}
export function seminarWeek(value: string) {
  const date = parseSeminarDate(value)
  const monday = addSeminarDays(value, -((date.getDay() || 7) - 1))
  return SEMINAR_WEEKDAYS.map((day, index) => ({ ...day, date: addSeminarDays(monday, index) }))
}
export function formatSeminarDate(value: string, options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' }) {
  return new Intl.DateTimeFormat('uk-UA', options).format(parseSeminarDate(value))
}
export function kyivToday() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}`
}
export function seminarHasStarted(seminar: Pick<Seminar, 'lesson_date' | 'starts_at'>) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || ''
  const now = `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}:${part('second')}`
  return now >= `${seminar.lesson_date}T${seminar.starts_at.slice(0, 8).padEnd(8, ':00')}`
}
// Used only to wake the UI at the next start. The database remains responsible
// for the authoritative Europe/Kyiv deadline and all reservation mutations.
export function seminarStartMilliseconds(seminar: Pick<Seminar, 'lesson_date' | 'starts_at'>) {
  const nominal = Date.parse(`${seminar.lesson_date}T${seminar.starts_at.slice(0, 8).padEnd(8, ':00')}Z`)
  let instant = nominal
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const parts = formatter.formatToParts(new Date(instant))
    const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((item) => item.type === type)?.value || 0)
    const local = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
    instant += nominal - local
  }
  return instant
}

/** The lesson date stays historical. Only the selection deadline is overridden. */
export function seminarSelectionDeadlineMilliseconds(seminar: Pick<Seminar, 'lesson_date' | 'starts_at' | 'selection_deadline_at'>): number {
  return seminar.selection_deadline_at == null ? seminarStartMilliseconds(seminar) : Date.parse(seminar.selection_deadline_at)
}
export function seminarSelectionIsClosed(seminar: Pick<Seminar, 'lesson_date' | 'starts_at' | 'selection_deadline_at'>, now = Date.now()): boolean {
  const deadline = seminarSelectionDeadlineMilliseconds(seminar)
  return !Number.isFinite(deadline) || now >= deadline
}
export function seminarSelectionDeadlineLocalValue(value: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const part = (key: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === key)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}
export function seminarSelectionDeadlineFromLocal(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Вкажіть дату й час завершення вибору за Києвом.')
  const [date, time] = value.split('T')
  const parsed = new Date(date + 'T00:00:00Z')
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date || date < '1900-01-01' || date > '2200-12-31' || time.slice(0, 2) > '23' || time.slice(3, 5) > '59') {
    throw new Error('Перевірте дату й час завершення вибору.')
  }
  const instant = seminarStartMilliseconds({ lesson_date: date, starts_at: time + ':00' })
  const iso = new Date(instant).toISOString()
  if (seminarSelectionDeadlineLocalValue(iso) !== value) throw new Error('Цей час недоступний через перехід годинника. Оберіть інший київський час.')
  return iso
}
export function scheduleOnDate(slot: SeminarSchedule, date: string) {
  if (slot.source_managed && slot.source_active === false) return false
  return scheduleOccursOnDate({ ...slot, subject: '', lesson_type: 'seminar', location: '', online_url: null }, date)
}

// Existing manual seminars and their bookings keep their own IDs. An empty
// automatic placeholder need not repeat an equivalent manual session, while
// every dated assignment remains visible, including after a source cancellation.
export function seminarSlotsOnDate(
  schedule: SeminarSchedule[], seminars: Seminar[], subjects: SeminarSubject[], date: string,
): SeminarSchedule[] {
  const dated = new Map(seminars.filter((item) => item.lesson_date === date).map((item) => [item.schedule_id, item]))
  const names = new Map(subjects.map((subject) => [subject.id, normalizedScheduleSubjectName(subject.name)]))
  const key = (slot: SeminarSchedule) => {
    const seminar = dated.get(slot.id)
    return `${names.get(slot.subject_id) || slot.subject_id}:${(seminar?.starts_at || slot.starts_at).slice(0, 8)}:${(seminar?.ends_at || slot.ends_at).slice(0, 8)}`
  }
  const visible = schedule.filter((slot) => scheduleOnDate(slot, date) || dated.has(slot.id))
  const manual = new Set(visible.filter((slot) => !slot.source_managed).map(key))
  const assignments = new Set(visible.filter((slot) => dated.has(slot.id)).map(key))
  const automatic = new Set<string>()
  return visible.filter((slot) => {
    if (!slot.source_managed || dated.has(slot.id)) return true
    const identity = key(slot)
    if (manual.has(identity) || assignments.has(identity) || automatic.has(identity)) return false
    automatic.add(identity)
    return true
  }).sort((a, b) => {
    const aTime = dated.get(a.id)?.starts_at || a.starts_at
    const bTime = dated.get(b.id)?.starts_at || b.starts_at
    return aTime.localeCompare(bTime) || a.id.localeCompare(b.id)
  })
}

const ERROR_TEXT: Record<string, string> = {
  SEMINAR_AUTH_REQUIRED: 'Увійдіть знову, щоб продовжити.',
  SEMINAR_MEMBER_REQUIRED: 'Ця функція доступна лише учасникам групи.',
  SEMINAR_REPRESENTATIVE_REQUIRED: 'Для цієї дії потрібне право керувати семінарами цієї групи. Оновіть сторінку та перевірте доступ.',
  STUDY_GROUP_PERMISSION_REQUIRED: 'Для цієї дії немає потрібного дозволу. Староста може надати його в налаштуваннях групи.',
  SEMINAR_RESOURCE_FORBIDDEN: 'Для зміни або видалення матеріалів потрібне окреме право керувати матеріалами семінарів.',
  GROUP_LICENSE_REQUIRED: 'Не вдалося підтвердити безкоштовний доступ групи. Оновіть сторінку або зверніться до підтримки.',
  SEMINAR_NOT_FOUND: 'Завдання вже змінене або видалене. Оновіть список.',
  SEMINAR_LOCKED: 'Вибір завершено. Староста може відкрити його повторно до нового терміну.',
  SEMINAR_SELECTION_CONFLICT: 'Термін уже змінив інший учасник. Оновіть семінар і перевірте поточний час.',
  SEMINAR_SELECTION_FUTURE_REQUIRED: 'Оберіть майбутню дату й час завершення вибору за Києвом.',
  SEMINAR_SELECTION_ARCHIVED: 'Семінар належить до архівного навчального року й доступний лише для перегляду.',
  SEMINAR_SELECTION_ARCHIVE_READ_ONLY: 'Семінар належить до архівного навчального року й доступний лише для перегляду.',
  SEMINAR_SELECTION_DEADLINE_INVALID: 'Оберіть майбутню дату й час завершення вибору за Києвом.',
  SEMINAR_OCCUPIED_TARGET_CHANGED: 'Питання або команда вже мають учасників. Збережіть їхній текст, назву та кількість місць.',
  SEMINAR_OCCUPIED_ITEM_IMMUTABLE: 'Питання або команда вже мають учасників. Збережіть їхній текст, назву та кількість місць.',
  SEMINAR_TEAM_ALREADY_CREATED: 'Ви вже створили команду для цього семінару. Оновіть список і приєднайтеся до неї.',
  SEMINAR_TEAM_CONFLICT: 'Команда з такою назвою вже існує або її вже змінили. Оновіть семінар і перевірте список.',
  SEMINAR_ALREADY_RESERVED: 'Ви вже записані на цей семінар. Спочатку скасуйте свій попередній вибір.',
  SEMINAR_TEAM_LIMIT: 'У семінарі вже є 30 команд. Приєднайтеся до наявної або зверніться до старости.',
  SEMINAR_TARGET_FULL: 'Останнє місце вже зайняли. Ваш попередній вибір збережено.',
  PRIMARY_STREAK_LIMIT: 'Не вдалося зберегти вибір. Оновіть сторінку й повторіть спробу. Якщо помилка повториться, зверніться до підтримки.',
  SEMINAR_FUTURE_STREAK_CONFLICT: 'Не вдалося зберегти вибір. Оновіть сторінку й повторіть спробу. Якщо помилка повториться, зверніться до підтримки.',
  SEMINAR_INVALID_INPUT: 'Перевірте назву, час, дати та кількість місць.',
  SEMINAR_DATE_MISMATCH: 'Ця дата не відповідає дню або періоду повторення заняття.',
  SEMINAR_HAS_RESERVATIONS: 'У цьому питанні чи команді вже є учасники. Збережіть їх або спершу узгодьте скасування бронювань.',
  SEMINAR_CAPACITY_BELOW_MEMBERS: 'Кількість місць не може бути меншою за число записаних учасників.',
  SEMINAR_SUPPLEMENT_CAPACITY_INVALID: 'Вкажіть ціле число місць для доповнювачів від 0 до 30.',
  SEMINAR_SUPPLEMENT_CAPACITY_BELOW_MEMBERS: 'Місць для доповнювачів не може бути менше, ніж уже записаних учасників. Їхні записи збережено.',
  SEMINAR_SCHEDULE_HAS_ASSIGNMENTS: 'Для цього заняття вже є завдання. Спочатку видаліть їх або оберіть інший період.',
  SEMINAR_SUBJECT_EXISTS: 'Предмет із такою назвою вже є у групі.',
  SEMINAR_ALREADY_EXISTS: 'На цю пару вже створено завдання. Оновіть список і відредагуйте його.',
  SEMINAR_SOURCE_SCHEDULE_MANAGED: 'Це заняття підставлено автоматично. Змініть або скасуйте пару у вкладці «Розклад і ДЗ».',
  SEMINAR_SUBJECT_SOURCE_MANAGED: 'Цей предмет використовується у розкладі. Змініть його назву у вкладці «Розклад і ДЗ».',
  SUBJECT_SOURCE_MANAGED: 'Цей предмет використовується у розкладі. Змініть його назву у вкладці «Розклад і ДЗ».',
}

export function seminarError(error: unknown): string {
  const item = error as { code?: string; message?: string } | null
  if (item?.code === 'PGRST205' || item?.code === '42P01' || item?.code === 'PGRST202' || item?.code === 'PGRST204' || item?.code === '42703' || item?.code === '42883') {
    return 'Потрібно застосувати оновлення бази семінарів, а потім оновити цю вкладку.'
  }
  const message = item?.message || ''
  const code = Object.keys(ERROR_TEXT).find((key) => message.includes(key))
  return code ? ERROR_TEXT[code] : 'Не вдалося виконати дію. Перевірте з’єднання та спробуйте ще раз.'
}

function checkResult<T>(result: { data: T | null; error: unknown }): T | null {
  if (result.error) throw result.error
  return result.data
}

export async function loadSeminars(groupId: string, date: string): Promise<SeminarData> {
  const [subjectResult, scheduleResult, seminarResult, groupResult, reopenedResult] = await Promise.all([
    supabase.from('study_group_seminar_subjects').select('*').eq('group_id', groupId).order('name'),
    supabase.from('study_group_seminar_schedule').select('*').eq('group_id', groupId).order('starts_at'),
    supabase.from('study_group_seminars').select('id,group_id,subject_id,schedule_id,lesson_date,starts_at,ends_at,title,instructions,format,created_by,resource_links,resource_attachments,teaching_course_id,teaching_author_id,selection_deadline_at,selection_version').eq('group_id', groupId).eq('lesson_date', date).order('starts_at'),
    supabase.from('study_groups').select('supplement_capacity').eq('id', groupId).single(),
    supabase.rpc('xelay_open_seminar_selections', { p_group_id: groupId }),
  ])
  const reopened = normalizeOpenSeminarSelections(checkResult(reopenedResult), groupId)
  const subjects = (checkResult(subjectResult) || []) as SeminarSubject[]
  const schedule = (checkResult(scheduleResult) || []) as SeminarSchedule[]
  const seminars = ((checkResult(seminarResult) || []) as Seminar[]).map((item) => ({
    ...item, resource_links: getSeminarLinks(item.resource_links), resource_attachments: getSeminarAttachments(item.resource_attachments),
  }))
  const ids = seminars.map((item) => item.id)
  let questions: SeminarQuestion[] = []
  let teams: SeminarTeam[] = []
  let reservations: SeminarReservation[] = []
  if (ids.length) {
    const [questionResult, teamResult, reservationResult] = await Promise.all([
      supabase.from('study_group_seminar_questions').select('id,seminar_id,position,body,primary_capacity,supplement_capacity').in('seminar_id', ids).order('position'),
      supabase.from('study_group_seminar_teams').select('id,seminar_id,position,name,capacity').in('seminar_id', ids).order('position'),
      supabase.from('study_group_seminar_reservations').select('id,seminar_id,user_id,role,question_id,team_id').in('seminar_id', ids).order('created_at'),
    ])
    questions = (checkResult(questionResult) || []) as SeminarQuestion[]
    teams = (checkResult(teamResult) || []) as SeminarTeam[]
    reservations = (checkResult(reservationResult) || []) as SeminarReservation[]
  }
  const profileIds = [...new Set([
    ...subjects.map((item) => item.created_by), ...seminars.map((item) => item.created_by), ...seminars.map((item) => item.teaching_author_id).filter((id): id is string => Boolean(id)), ...reservations.map((item) => item.user_id),
  ])]
  const [profileResult, streakResults, subjectStreakResults] = await Promise.all([
    getPublicProfiles(profileIds),
    Promise.all(seminars.filter((item) => item.format === 'questions').map(async (item) => {
      const result = await supabase.rpc('xelay_seminar_streak', { p_subject_id: item.subject_id, p_before_seminar_id: item.id })
      return [item.id, Number(checkResult(result)) || 0] as const
    })),
    Promise.all(subjects.map(async (item) => {
      const result = await supabase.rpc('xelay_seminar_streak', { p_subject_id: item.id, p_before_seminar_id: null })
      return [item.id, Number(checkResult(result)) || 0] as const
    })),
  ])
  if (profileResult.error) throw profileResult.error
  return {
    supplement_capacity: seminarSupplementCapacity(checkResult(groupResult)?.supplement_capacity),
    subjects, schedule, seminars, questions, teams, reservations,
    profiles: Object.fromEntries((profileResult.data as SeminarProfile[]).map((profile) => [profile.id, profile])),
    streaks: Object.fromEntries(streakResults), subjectStreaks: Object.fromEntries(subjectStreakResults),
    reopened_seminars: reopened.seminars, reopened_schedule: reopened.schedule, selection_occupancy: reopened.occupancy,
  }
}

export async function seminarRpc(name: string, params: Record<string, unknown>) {
  const result = await supabase.rpc(name, params)
  checkResult(result)
  return result.data
}

function normalizeOpenSeminarSelections(value: unknown, groupId: string): { seminars: Seminar[]; schedule: SeminarSchedule[]; occupancy: SeminarSelectionOccupancy[] } {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
  if (!row || !Array.isArray(row.seminars) || !Array.isArray(row.schedule) || !Array.isArray(row.occupancy)) throw new Error('SEMINAR_SELECTION_RESPONSE_INVALID')
  const seminars = row.seminars.filter((item): item is Seminar => !!item && typeof item === 'object' && item.group_id === groupId
    && typeof item.id === 'string' && typeof item.schedule_id === 'string' && typeof item.subject_id === 'string'
    && typeof item.title === 'string' && typeof item.lesson_date === 'string' && typeof item.starts_at === 'string'
    && typeof item.selection_deadline_at === 'string' && !seminarSelectionIsClosed(item)
    && typeof item.selection_version === 'number' && Number.isInteger(item.selection_version) && item.selection_version >= 0).map(item => ({ ...item,
      resource_links: getSeminarLinks(item.resource_links), resource_attachments: getSeminarAttachments(item.resource_attachments) }))
  const seminarIds = new Set(seminars.map(item => item.id))
  const schedule = row.schedule.filter((item): item is SeminarSchedule => !!item && typeof item === 'object' && item.group_id === groupId
    && typeof item.id === 'string' && seminars.some(seminar => seminar.schedule_id === item.id))
  const occupancy = row.occupancy.filter((item): item is SeminarSelectionOccupancy => !!item && typeof item === 'object'
    && seminarIds.has(item.seminar_id) && ['primary', 'supplement', 'team', 'booking'].includes(item.role)
    && Number.isSafeInteger(item.count) && item.count >= 0 && item.count <= 100000
    && (item.question_id === null || typeof item.question_id === 'string') && (item.team_id === null || typeof item.team_id === 'string'))
  return { seminars, schedule, occupancy }
}

const SEMINAR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export async function setSeminarSelectionDeadline(groupId: string, seminarId: string, deadline: string | null, expectedVersion: number): Promise<{ seminar_id: string; selection_deadline_at: string; selection_version: number }> {
  if (!SEMINAR_UUID.test(groupId) || !SEMINAR_UUID.test(seminarId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0
    || deadline !== null && (!Number.isFinite(Date.parse(deadline)) || Date.parse(deadline) <= Date.now())) throw new Error('SEMINAR_SELECTION_FUTURE_REQUIRED')
  const result = await seminarRpc('xelay_set_seminar_selection_deadline', { p_group_id: groupId, p_seminar_id: seminarId,
    p_deadline: deadline === null ? null : new Date(deadline).toISOString(), p_expected_version: expectedVersion })
  if (!result || result.seminar_id !== seminarId || result.selection_version !== expectedVersion + 1
    || typeof result.selection_deadline_at !== 'string' || !Number.isFinite(Date.parse(result.selection_deadline_at))) throw new Error('SEMINAR_SELECTION_RESPONSE_INVALID')
  return result
}
export async function createSeminarTeam(groupId: string, seminarId: string, teamId: string, name: string, capacity: number): Promise<SeminarTeam> {
  if (![groupId, seminarId, teamId].every(value => SEMINAR_UUID.test(value)) || !name.trim() || Array.from(name.trim()).length > 80
    || /[\u0000-\u001f\u007f]/.test(name) || !Number.isInteger(capacity) || capacity < 1 || capacity > 50) throw new Error('SEMINAR_INVALID_INPUT')
  const result = await seminarRpc('xelay_create_seminar_team', { p_group_id: groupId, p_seminar_id: seminarId, p_team_id: teamId, p_name: name.trim(), p_capacity: capacity })
  if (!result || result.id !== teamId || result.seminar_id !== seminarId || typeof result.name !== 'string' || !Number.isInteger(result.capacity)) throw new Error('SEMINAR_SELECTION_RESPONSE_INVALID')
  return result
}
