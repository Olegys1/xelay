export type LiveReadTopic = 'study' | 'materials' | 'results' | 'teaching' | 'gradebook' | 'seminars' | 'organizer' | 'community' | 'news' | 'opportunities' | 'help'
export interface LiveGroup { id: string; name: string; program: string; studyYear: number; learning: boolean; permissions: string[]; testGroup?: boolean }
export interface LiveCourse { id: string; name: string; groupIds: string[]; subjects: { groupId: string; subjectId: string }[]; permissions: string[]; archived: boolean; teaching: boolean; teachingGroupIds: string[] }
export interface LiveCatalog { userId: string; defaultLearningGroupId?: string; groups: LiveGroup[]; subjects: { id: string; groupId: string; name: string; kind: 'study' | 'materials' | 'teacher' }[]; courses: LiveCourse[] }
export interface LiveReadScope { groupId?: string; subjectId?: string; courseId?: string; from?: string; to?: string; period: 'current' | 'archive' | 'all'; query?: string;workspaceId?:string;space?:'personal'|'shared'|'all' }
export interface LiveRecord {
  // Raw group timetable entries may have no linked seminar subject. Server
  // validation still requires a subject for grades, materials and teaching.
  id: string; kind: 'lesson' | 'homework' | 'material' | 'grade' | 'seminar' | 'task' | 'question' | 'news' | 'opportunity' | 'help'; groupId: string; subjectId?: string; courseId?:string;sourcePath?:string;teacherName?:string;subjectName?:string;
  title: string; body?: string; date?: string; startsAt?: string; endsAt?: string; location?: string;
  links?: string[]; conferenceId?: string; accessCode?: string; scheduleId?: string; lessonId?: string;
  personalElective?: true;
  dueAt?: string | null; points?: number; maxPoints?: number; coefficient?: number; published?: boolean; studentName?:string;
  allowAi?: boolean; allowDownload?: boolean; fileName?: string; bodyTruncated?: boolean;
  materialId?:string;materialSourceKind?:'study'|'teaching';rightsVersion?:string;
  completed?:boolean;space?:'personal'|'shared';workspaceId?:string;canEdit?:boolean;
  format?:'questions'|'teams'|'booking';selectionVersion?:number;selectionDeadlineAt?:string|null;canReopen?:boolean;
  questions?:{id:string;body:string;position:number;primaryCapacity:number;supplementCapacity:number;occupiedPrimary:number;occupiedSupplement:number}[];
  teams?:{id:string;name:string;capacity:number;occupied:number}[];
  myReservation?:{id:string;role:'primary'|'supplement'|'booking'|'team';questionId?:string;teamId?:string};
}
export interface LiveReadResult { userId: string; audience: 'student' | 'teacher'; records: LiveRecord[]; truncated: boolean; readAt: string; gradeSummary?:{groupId:string;subjectId:string;courseId?:string;title:string;workCount:number;points:number;maxPoints:number;weightedPoints:number;weightedMaxPoints:number|null;percentage:number|null;formula:string;partial:boolean;categories?:{id:string;name:string;raw:number;count:number;coefficient:number;weighted:number;capped:number;maximum:number}[];rounding?:string}[] }
export interface LiveDraft {
  requiresMaterialRights?:boolean;
  id: string; action: string; title: string; revision: number; status: 'pending' | 'committing' | 'confirmed' | 'cancelled' | 'stale' | 'unknown';
  createdAt: string; expiresAt: string; scope: { groupId?: string; courseId?: string; date?: string };
  payload: Record<string, unknown>; confirmationToken: string;
  fields: { key: string; label: string; value: string; type: string; required?: boolean }[];
  items: { id: string; label: string; before?: string; after: string }[];
}
export interface LiveReceipt { draftId: string; action: string; savedAt: string; affectedIds: string[]; path: string; syntheticOnly: false }
export interface LiveBootstrap { mode: 'local-authenticated'; supabaseUrl: string; supabaseAnonKey: string; sessionToken: string; modelConnected: false }

const BASE = '/__assistant-live/api'
const messages: Record<string, string> = {
  session_invalid: 'Увійдіть знову у свій акаунт Xelay.', session_changed: 'Акаунт змінився. Увійдіть знову.',
  session_unavailable: 'Не вдалося перевірити вхід. Спробуйте ще раз.', session_or_access_unavailable: 'Не вдалося перевірити доступ. Оновіть дані.',
  access_denied: 'У вас немає доступу до обраної групи або предмета.', permission_required: 'Для цієї дії потрібне право редагування.',
  membership_required: 'Ви не є прийнятим учасником цієї групи.', local_test_group_required: 'У локальній перевірці збереження дозволене тільки у вашій тестовій групі.',
  group_required: 'Оберіть навчальну групу.', course_required: 'Оберіть свій викладацький предмет.', study_subject_required: 'Оберіть предмет навчальної групи.',
  target_unavailable: 'Пару або інший запис уже змінено. Оновіть дані.', conflict: 'Дані змінилися. Оновіть їх і підготуйте нову чернетку.',
  access_changed: 'Ваш доступ змінився під час завантаження. Оновіть дані.', material_changed: 'Матеріал або дозвіл автора змінився. Оновіть дані.',
  database_unavailable: 'База тимчасово недоступна. Зміни автоматично не повторюються.', repository_unavailable: 'Не вдалося завантажити дані. Спробуйте ще раз.',
  invalid_payload: 'Перевірте поля майбутньої зміни.', invalid_request: 'Перевірте обрані поля.', invalid_scope: 'Оберіть групу, предмет і дату ще раз.',
  invalid_text: 'Перевірте текст: поле порожнє або завелике.', invalid_date: 'Оберіть правильну дату.', invalid_time: 'Перевірте час початку та закінчення.',
  invalid_schedule: 'Перевірте дату, початок, завершення й тип заняття.', schedule_overlap: 'У цей час уже є заняття. Оберіть інший час.',
  lesson_not_on_date: 'Ця пара не проводиться у вибрану дату. Оновіть розклад.', empty_homework: 'Додайте тему або текст домашнього завдання.',
  student_homework_deadline_not_supported: 'Точний термін для цього ДЗ поки не підключений. Залиште вільний термін.',
  recurring_schedule_requires_platform_editor: 'Зміни повторюваних пар поки потрібно робити у звичному редакторі розкладу.',
  one_off_schedule_required: 'Змінити тут можна лише окрему пару на конкретну дату.', copied_schedule_requires_platform_editor: 'Перенесену пару поки потрібно змінювати у звичному редакторі розкладу.',
  draft_expired: 'Час чернетки минув. Підготуйте нову.', draft_stale: 'Чернетка застаріла. Оновіть дані й підготуйте нову.',
  draft_conflict: 'Чернетку вже змінено. Перевірте її ще раз.', draft_unavailable: 'Ця чернетка недоступна.', confirmation_required: 'Перевірте чернетку перед підтвердженням.',
  draft_changed: 'Чернетку вже змінено. Підготуйте актуальний варіант.', draft_not_found: 'Чернетку не знайдено для вашого акаунта.', draft_limit: 'Забагато відкритих чернеток. Скасуйте непотрібні.',
  write_unknown: 'Результат збереження поки невідомий. Не повторюйте зміну. Перевірте її на платформі.',
  subscription_required: 'Для особистого органайзера потрібна чинна підписка «Учасник».',
  participant_required: 'Для особистого органайзера потрібна чинна підписка «Учасник».',
  unsupported_action: 'Ця дія ще не підключена в локальному перегляді.', unsupported_deadline: 'Для цього домашнього завдання точний термін поки не підключений.',
  invalid_session: 'Локальну сесію оновлено. Перезавантажте сторінку.', local_origin_required: 'Скористайтеся локальною сторінкою перевірки.',
}
export class LiveAssistantError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(messages[code] || 'Не вдалося виконати запит. Спробуйте оновити дані.'); this.name = 'LiveAssistantError' }
}

/** All authentication tokens remain in the component/client memory. No browser
 * storage, public provider key, arbitrary origin, telemetry or auto-retry. */
export function createLiveAssistantClient(accessToken: () => string | null) {
  let nonce = ''
  let configuration = ''
  async function call<T>(route: string, options: { body?: unknown; public?: boolean; signal?: AbortSignal } = {}): Promise<T> {
    if (typeof window !== 'undefined' && window.location.origin !== 'http://127.0.0.1:3077') throw new LiveAssistantError('local_origin_required')
    // A local backend restart may rotate only its request nonce. Refresh before
    // dispatch, never retry a mutation after it has been submitted.
    if (options.body !== undefined) await refreshBootstrap(options.signal)
    const token = accessToken()
    if (!options.public && !token) throw new LiveAssistantError('session_invalid', 401)
    const response = await fetch(BASE + route, {
      method: options.body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', signal: options.signal,
      headers: { ...(token && !options.public ? { Authorization: `Bearer ${token}` } : {}), ...(options.body !== undefined ? { 'Content-Type': 'application/json', 'X-Assistant-Session': nonce } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    })
    let data: any
    try { data = await response.json() } catch { throw new LiveAssistantError('local_unavailable', response.status) }
    if (!response.ok) {
      const code = typeof data?.error === 'string' && /^[a-z0-9_]{1,80}$/.test(data.error) ? data.error : 'request_failed'
      throw new LiveAssistantError(code, response.status)
    }
    return data as T
  }
  async function refreshBootstrap(signal?: AbortSignal) {
      const result = await call<LiveBootstrap>('/bootstrap', { public: true, signal })
      let url: URL
      try { url = new URL(result.supabaseUrl) } catch { throw new LiveAssistantError('invalid_configuration') }
      if (result.mode !== 'local-authenticated' || result.modelConnected !== false || typeof result.sessionToken !== 'string' || result.sessionToken.length < 24
        || url.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/.test(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash
        || typeof result.supabaseAnonKey !== 'string' || /^(?:sb_secret_|service_role)/.test(result.supabaseAnonKey)) throw new LiveAssistantError('invalid_configuration')
      if (!result.supabaseAnonKey.startsWith('sb_publishable_')) {
        try { const payload = JSON.parse(atob(result.supabaseAnonKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); if (payload.role !== 'anon') throw new Error() }
        catch { throw new LiveAssistantError('invalid_configuration') }
      }
      const currentConfiguration = result.supabaseUrl + '\0' + result.supabaseAnonKey
      if (configuration && currentConfiguration !== configuration) throw new LiveAssistantError('invalid_session', 401)
      configuration = currentConfiguration
      nonce = result.sessionToken
      return result
  }
  return {
    bootstrap: refreshBootstrap,
    catalog(signal?: AbortSignal) { return call<LiveCatalog>('/catalog', { signal }) },
    read(topic: LiveReadTopic, scope: LiveReadScope, signal?: AbortSignal) { return call<LiveReadResult>('/read', { body: { topic, scope, limit: 30 }, signal }) },
    prepare(action: string, scope: LiveDraft['scope'], payload: Record<string, unknown>, signal?: AbortSignal) { return call<{ draft: LiveDraft }>('/drafts/prepare', { body: { action, scope, payload }, signal }) },
    edit(draft: LiveDraft, payload: Record<string, unknown>, signal?: AbortSignal) { return call<{ draft: LiveDraft }>('/drafts/edit', { body: { id: draft.id, revision: draft.revision, confirmationToken: draft.confirmationToken, payload }, signal }) },
    cancel(draft: LiveDraft, signal?: AbortSignal) { return call<{ draft: LiveDraft }>('/drafts/cancel', { body: { id: draft.id, revision: draft.revision, confirmationToken: draft.confirmationToken }, signal }) },
    confirm(draft: LiveDraft, signal?: AbortSignal) { return call<{ draft: LiveDraft; receipt?: LiveReceipt }>('/drafts/confirm', { body: { id: draft.id, revision: draft.revision, confirmationToken: draft.confirmationToken }, signal }) },
    clear() { nonce = ''; configuration = '' },
  }
}
