import { supabase } from './supabase'
import { getPublicProfiles } from './profiles'
import { getSeminarAttachments, getSeminarLinks, type SeminarAttachment } from './seminarResources'

export type SeminarFormat = 'questions' | 'teams' | 'booking'
export const SEMINAR_FORMATS: { id: SeminarFormat; label: string; description: string }[] = [
  { id: 'questions', label: 'Доповідачі та доповнювачі', description: 'Основні відповіді й доповнення з урахуванням серії.' },
  { id: 'teams', label: 'Командна робота', description: 'Команди з назвами та окремою кількістю місць.' },
  { id: 'booking', label: 'Бронювання питань', description: 'Учасники обирають питання, а викладач визначає доповідачів.' },
]

export type SeminarSubject = { id: string; group_id: string; name: string; created_by: string }
export type SeminarSchedule = {
  id: string; group_id: string; subject_id: string; weekday: number; starts_at: string; ends_at: string
  valid_from: string; valid_until: string; created_by: string
}
export type Seminar = {
  id: string; group_id: string; subject_id: string; schedule_id: string; lesson_date: string
  starts_at: string; ends_at: string; title: string; instructions: string; format: SeminarFormat; created_by: string
  resource_links: string[]; resource_attachments: SeminarAttachment[]
}
export type SeminarQuestion = { id: string; seminar_id: string; position: number; body: string; primary_capacity: number }
export type SeminarTeam = { id: string; seminar_id: string; position: number; name: string; capacity: number }
export type SeminarReservation = {
  id: string; seminar_id: string; user_id: string; role: 'primary' | 'supplement' | 'team' | 'booking'
  question_id: string | null; team_id: string | null
}
export type SeminarProfile = { id: string; full_name: string | null; username: string | null; avatar_url: string | null }
export type SeminarData = {
  subjects: SeminarSubject[]; schedule: SeminarSchedule[]; seminars: Seminar[]
  questions: SeminarQuestion[]; teams: SeminarTeam[]; reservations: SeminarReservation[]
  profiles: Record<string, SeminarProfile>; streaks: Record<string, number>; subjectStreaks: Record<string, number>
}

export const EMPTY_SEMINAR_DATA: SeminarData = {
  subjects: [], schedule: [], seminars: [], questions: [], teams: [], reservations: [], profiles: {}, streaks: {}, subjectStreaks: {},
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
export function scheduleOnDate(slot: SeminarSchedule, date: string) {
  return slot.weekday === (parseSeminarDate(date).getDay() || 7) && slot.valid_from <= date && slot.valid_until >= date
}

const ERROR_TEXT: Record<string, string> = {
  SEMINAR_AUTH_REQUIRED: 'Увійдіть знову, щоб продовжити.',
  SEMINAR_MEMBER_REQUIRED: 'Ця функція доступна лише учасникам групи.',
  SEMINAR_REPRESENTATIVE_REQUIRED: 'Для цієї дії потрібне право керувати семінарами цієї групи. Оновіть сторінку та перевірте доступ.',
  STUDY_GROUP_PERMISSION_REQUIRED: 'Для цієї дії немає потрібного дозволу. Староста може надати його в налаштуваннях групи.',
  SEMINAR_RESOURCE_FORBIDDEN: 'Для зміни або видалення матеріалів потрібне окреме право керувати матеріалами семінарів.',
  GROUP_LICENSE_REQUIRED: 'Не вдалося підтвердити безкоштовний доступ групи. Оновіть сторінку або зверніться до підтримки.',
  SEMINAR_NOT_FOUND: 'Завдання вже змінене або видалене. Оновіть список.',
  SEMINAR_LOCKED: 'Заняття вже почалося. Змінювати вибір більше не можна.',
  SEMINAR_TARGET_FULL: 'Останнє місце вже зайняли. Ваш попередній вибір збережено.',
  PRIMARY_STREAK_LIMIT: 'У вас уже три основні відповіді поспіль із цього предмета. На цьому семінарі оберіть роль доповнювача.',
  SEMINAR_FUTURE_STREAK_CONFLICT: 'Ця зміна зробить одну з наступних основних відповідей четвертою поспіль. Спочатку змініть своє пізніше бронювання.',
  SEMINAR_INVALID_INPUT: 'Перевірте назву, час, дати та кількість місць.',
  SEMINAR_DATE_MISMATCH: 'Ця дата не відповідає дню або періоду повторення заняття.',
  SEMINAR_HAS_RESERVATIONS: 'У цьому питанні чи команді вже є учасники. Збережіть їх або спершу узгодьте скасування бронювань.',
  SEMINAR_CAPACITY_BELOW_MEMBERS: 'Кількість місць не може бути меншою за число записаних учасників.',
  SEMINAR_SCHEDULE_HAS_ASSIGNMENTS: 'Для цього заняття вже є завдання. Спочатку видаліть їх або оберіть інший період.',
  SEMINAR_SUBJECT_EXISTS: 'Предмет із такою назвою вже є у групі.',
  SEMINAR_ALREADY_EXISTS: 'На цю пару вже створено завдання. Оновіть список і відредагуйте його.',
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
  const [subjectResult, scheduleResult, seminarResult] = await Promise.all([
    supabase.from('study_group_seminar_subjects').select('id,group_id,name,created_by').eq('group_id', groupId).order('name'),
    supabase.from('study_group_seminar_schedule').select('id,group_id,subject_id,weekday,starts_at,ends_at,valid_from,valid_until,created_by').eq('group_id', groupId).order('starts_at'),
    supabase.from('study_group_seminars').select('id,group_id,subject_id,schedule_id,lesson_date,starts_at,ends_at,title,instructions,format,created_by,resource_links,resource_attachments').eq('group_id', groupId).eq('lesson_date', date).order('starts_at'),
  ])
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
      supabase.from('study_group_seminar_questions').select('id,seminar_id,position,body,primary_capacity').in('seminar_id', ids).order('position'),
      supabase.from('study_group_seminar_teams').select('id,seminar_id,position,name,capacity').in('seminar_id', ids).order('position'),
      supabase.from('study_group_seminar_reservations').select('id,seminar_id,user_id,role,question_id,team_id').in('seminar_id', ids).order('created_at'),
    ])
    questions = (checkResult(questionResult) || []) as SeminarQuestion[]
    teams = (checkResult(teamResult) || []) as SeminarTeam[]
    reservations = (checkResult(reservationResult) || []) as SeminarReservation[]
  }
  const profileIds = [...new Set([
    ...subjects.map((item) => item.created_by), ...seminars.map((item) => item.created_by), ...reservations.map((item) => item.user_id),
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
    subjects, schedule, seminars, questions, teams, reservations,
    profiles: Object.fromEntries((profileResult.data as SeminarProfile[]).map((profile) => [profile.id, profile])),
    streaks: Object.fromEntries(streakResults), subjectStreaks: Object.fromEntries(subjectStreakResults),
  }
}

export async function seminarRpc(name: string, params: Record<string, unknown>) {
  const result = await supabase.rpc(name, params)
  checkResult(result)
  return result.data
}
