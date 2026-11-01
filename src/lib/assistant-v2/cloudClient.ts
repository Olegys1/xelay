import type { LiveCatalog, LiveDraft, LiveReadResult, LiveReadScope, LiveReadTopic, LiveReceipt } from './liveClient'
export type { LiveCatalog, LiveDraft, LiveReadResult, LiveReadScope, LiveReadTopic, LiveReceipt, LiveRecord, LiveCourse } from './liveClient'

export interface AssistantCloudSession { userId: string; accessToken: string }
export interface AssistantCloudStatus { available: boolean; modelConnected: boolean; writesAvailable: boolean }
export interface AssistantDraftResult { draft: LiveDraft; receipt?: LiveReceipt; status?: string }
export interface AssistantChatScope { groupId?: string; subjectId?: string; materialSubjectId?: string; courseId?: string; date?: string; period?: 'current' | 'archive' | 'all'; mode?: 'learning' | 'teaching' }
export interface AssistantChatHistoryItem { role: 'user' | 'assistant'; content: string }
export interface AssistantChatChoices { type: 'group' | 'subject' | 'lesson'; items: { id: string; label: string }[] }
export interface AssistantActionForm { action: string; title: string; scope: LiveDraft['scope']; payload: Record<string, unknown>; fields: { key: string; label: string; type: string; required?: boolean; options?: { value: string; label: string }[]; lessonOptions?: { value: string; label: string; groupId: string; date: string }[] }[] }
export interface AssistantToolRequest { type: 'schedule-import' | 'material-explain'; scope?: LiveDraft['scope'] }
export interface AssistantQueuedSchedule { action: 'schedule.create'; scope: { groupId: string; date: string }; payload: Record<string, unknown> }
export interface AssistantChatResult {
  userId: string; kind: 'reply' | 'clarify' | 'draft' | 'read' | 'unsupported'; text: string;
  draft?: LiveDraft; drafts?: LiveDraft[]; read?: LiveReadResult; continuation?: string; choices?: AssistantChatChoices; form?: AssistantActionForm; tool?: AssistantToolRequest;
  sources?: { title: string; path?: string; sourcePath?: string }[];
}
export interface AssistantChatRequest { message: string; history?: AssistantChatHistoryItem[]; scope?: AssistantChatScope; continuation?: string; teacherMessage?: string }

const BASE = '/api/assistant'
const errors: Record<string, string> = {
  session_invalid: 'Увійдіть до Xelay ще раз.', session_changed: 'Акаунт змінився. Відкрийте помічника знову.',
  session_unavailable: 'Не вдалося перевірити вхід. Спробуйте пізніше.',
  access_denied: 'У вас немає доступу до цієї групи або предмета.', permission_required: 'Для зміни потрібне відповідне право доступу.',
  access_changed: 'Права змінилися. Оновіть дані й перевірте чернетку.', material_changed: 'Матеріал змінився. Оновіть дані.',
  assistant_disabled: 'Помічник готується до запуску. Спробуйте пізніше.', assistant_unavailable: 'Помічник тимчасово недоступний.',
  configuration_unavailable: 'Помічник готується до запуску. Ваші записи не змінено.',
  model_not_connected: 'Чат ще не підключено. Поки можна переглядати записи й готувати зміни вручну.',
  model_unavailable: 'Помічник не зміг відповісти. Записи не змінено. Спробуйте пізніше.',
  model_timeout: 'Не вдалося дочекатися відповіді. Запит не повторювався автоматично. Перевірте «Чернетки» перед новою спробою.',
  model_configuration_required: 'Чат тимчасово недоступний. Звичайні розділи Xelay працюють.',
  model_balance_required: 'Чат тимчасово призупинено. Можна скористатися звичайними розділами Xelay.',
  model_rate_limited: 'Зараз багато звернень до помічника. Спробуйте трохи пізніше.',
  model_refused: 'Помічник не зміг опрацювати цей запит. Спробуйте сформулювати конкретне навчальне завдання.',
  model_context_too_large: 'Повідомлення завелике для одного запиту. Розділіть його на кілька окремих завдань.',
  model_output_invalid: 'Не вдалося надійно розібрати повідомлення. Уточніть запит або скористайтеся ручним редактором.',
  model_invalid_response: 'Не вдалося надійно розібрати повідомлення. Уточніть запит або скористайтеся ручним редактором.',
  chat_continuation_invalid: 'Час уточнення минув. Напишіть запит заново.',
  chat_context_expired: 'Час уточнення минув. Напишіть запит заново.',
  chat_message_too_large: 'Повідомлення завелике. Розділіть його на кілька окремих завдань.',
  assistant_model_budget_disabled: 'Чат ще не підключено. Поки можна переглядати записи й готувати зміни вручну.',
  assistant_model_budget_exhausted: 'Доступний ліміт помічника вичерпано. Звичайні розділи Xelay продовжують працювати.',
  assistant_model_budget_replay: 'Повторне виконання цього запиту заблоковано. Перевірте «Чернетки» перед новим зверненням.',
  assistant_model_budget_halted: 'Чат призупинено для перевірки. Запити автоматично не повторюються.',
  assistant_model_budget_unavailable: 'Не вдалося перевірити доступний ліміт. Запит до моделі не запускається.',
  assistant_model_request_failed: 'Помічник не зміг завершити запит. Автоматичного повтору немає.',
  assistant_model_usage_invalid: 'Чат тимчасово призупинено для перевірки. Спробуйте пізніше.',
  cloud_unavailable: 'Не вдалося виконати запит. Спробуйте оновити дані.',
  database_unavailable: 'Не вдалося перевірити запис у Xelay. Автоматичного повтору немає.',
  repository_unavailable: 'Не вдалося завантажити дані. Спробуйте пізніше.',
  repository_scope_violation: 'Відповідь не відповідає вибраній групі або предмету.',
  repository_invalid_response: 'Потрібна перевірка формату даних. Записи не змінено.',
  invalid_request: 'Перевірте вибрані поля.', invalid_payload: 'Перевірте поля чернетки.', invalid_scope: 'Оберіть групу й дату.',
  invalid_date: 'Оберіть коректну дату.', invalid_date_range: 'Оберіть діапазон до 31 дня.',
  invalid_text: 'Перевірте текст: поле порожнє або завелике.', invalid_schedule: 'Перевірте дату й час заняття.',
  schedule_overlap: 'На цей час уже є інша пара.', lesson_not_on_date: 'Ця пара не проводиться у вибрану дату.',
  group_required: 'Оберіть навчальну групу.', course_required: 'Оберіть предмет викладання.', study_subject_required: 'Оберіть предмет навчальної групи.',
  draft_expired: 'Час підтвердження минув. Створіть новий перегляд.', draft_changed: 'Чернетка змінилася. Перевірте новий перегляд.',
  draft_conflict: 'Запис змінився після перегляду. Створіть нову чернетку.', draft_not_found: 'Чернетку не знайдено для цього акаунта.',
  draft_unavailable: 'Ця чернетка вже закрита або обробляється.', confirmation_required: 'Підтвердіть показану версію чернетки.',
  draft_review_required: 'Створіть новий перегляд змін перед підтвердженням.', invalid_binding: 'Оновіть чернетку перед підтвердженням.',
  draft_limit: 'Забагато відкритих чернеток. Скасуйте непотрібні.',
  execution_unknown: 'Результат попереднього збереження перевіряється. Не повторюйте зміну.',
  write_unknown: 'Результат запису ще не підтверджено. Перевірте його на платформі.',
  participant_required: 'Для особистого органайзера потрібна чинна підписка «Учасник».',
  membership_required: 'Дія доступна тільки прийнятим учасникам групи.',
  unsupported_action: 'Цю дію поки виконуйте у звичайному редакторі Xelay.',
  one_off_schedule_required: 'Тут можна змінити окрему пару. Серію редагуйте у групі.',
  recurring_schedule_requires_platform_editor: 'Повторювані заняття редагуйте у звичайному редакторі розкладу.',
  student_homework_deadline_not_supported: 'Це ДЗ прикріплюється до дати пари. Строк здачі задає викладач у своєму завданні.',
  material_rights_acceptance_required: 'Підтвердіть, що маєте право розміщувати ці матеріали.',
  rate_limited: 'Забагато запитів. Спробуйте пізніше.', request_cancelled: 'Запит скасовано.',
}
export class AssistantCloudError extends Error {
  constructor(readonly code: string, readonly status = 400) {
    super(errors[code] || errors.cloud_unavailable); this.name = 'AssistantCloudError'
  }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const calendarDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)
function validQueuedSchedule(value: unknown, expectedGroup: string | undefined): value is AssistantQueuedSchedule {
  if (!object(value) || Object.keys(value).some(key => !['action', 'scope', 'payload'].includes(key)) || value.action !== 'schedule.create' || !object(value.scope) || Object.keys(value.scope).some(key => !['groupId', 'date'].includes(key)) || typeof value.scope.groupId !== 'string' || value.scope.groupId !== expectedGroup || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value.scope.groupId) || !calendarDate(value.scope.date) || !object(value.payload)) return false
  const payload = value.payload, keys = ['date', 'subject', 'startsAt', 'endsAt', 'lessonType', 'location', 'teacherName', 'links', 'conferenceId', 'accessCode', 'week', 'recurring', 'weekday', 'validFrom', 'validUntil', 'weekPattern', 'weekAnchorDate']
  if (Object.keys(payload).some(key => !keys.includes(key)) || payload.date !== value.scope.date || typeof payload.subject !== 'string' || !payload.subject.trim() || payload.subject.length > 240 || typeof payload.startsAt !== 'string' || typeof payload.endsAt !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload.startsAt) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(payload.endsAt) || payload.startsAt >= payload.endsAt || !['lecture', 'seminar', 'practical', 'lab', 'makeup', 'replacement', 'module', 'final_assessment', 'test', 'other'].includes(payload.lessonType as string)) return false
  if (payload.recurring !== undefined && typeof payload.recurring !== 'boolean' || payload.weekday !== undefined && (!Number.isInteger(payload.weekday) || Number(payload.weekday) < 1 || Number(payload.weekday) > 7) || payload.week !== undefined && !['both', 'upper', 'lower'].includes(payload.week as string) || payload.weekPattern !== undefined && !['every', 'upper', 'lower'].includes(payload.weekPattern as string)) return false
  for (const key of ['validFrom', 'validUntil', 'weekAnchorDate']) if (payload[key] !== undefined && !calendarDate(payload[key])) return false
  for (const key of ['location', 'teacherName', 'conferenceId', 'accessCode']) if (payload[key] !== undefined && (typeof payload[key] !== 'string' || payload[key].length > 500)) return false
  if (payload.links !== undefined && (!Array.isArray(payload.links) || payload.links.length > 20 || payload.links.some(value => typeof value !== 'string' || value.length > 2200))) return false
  return true
}
const validForm = (value: unknown): value is AssistantActionForm => object(value) && typeof value.action === 'string' && value.action.length <= 100 && typeof value.title === 'string' && value.title.length <= 240 && object(value.scope) && object(value.payload) && Array.isArray(value.fields) && value.fields.length <= 150 && value.fields.every(field => object(field) && typeof field.key === 'string' && field.key.length <= 100 && !['__proto__', 'constructor', 'prototype'].includes(field.key) && typeof field.label === 'string' && field.label.length <= 240 && typeof field.type === 'string' && (field.options === undefined || Array.isArray(field.options) && field.options.length <= 500 && field.options.every(option => object(option) && typeof option.value === 'string' && option.value.length <= 200 && typeof option.label === 'string' && option.label.length <= 500)))

/** Same-origin transport only. The current platform session is resolved afresh
 * for every operation. Accepted writes are never automatically retried. */
export function createAssistantCloudClient(options: {
  currentUserId(): string | null
  session(): Promise<AssistantCloudSession | null>
  fetch?: typeof fetch
}) {
  let epoch = 0
  const fetcher = options.fetch || fetch
  async function call<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const expectedUser = options.currentUserId(), started = epoch
    if (!expectedUser) throw new AssistantCloudError('session_invalid', 401)
    let session: AssistantCloudSession | null
    try { session = await options.session() } catch { throw new AssistantCloudError('session_unavailable', 401) }
    if (started !== epoch || options.currentUserId() !== expectedUser) throw new AssistantCloudError('session_changed', 401)
    if (!session || session.userId !== expectedUser || !session.accessToken || /\s/.test(session.accessToken)) throw new AssistantCloudError('session_invalid', 401)
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    let response: Response
    try {
      response = await fetcher(`${BASE}?route=${encodeURIComponent(route)}`, {
        method: body === undefined ? 'GET' : 'POST', cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${session.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      throw new AssistantCloudError('cloud_unavailable', 503)
    }
    let result: unknown
    try { result = await response.json() } catch { throw new AssistantCloudError('cloud_unavailable', response.status) }
    if (started !== epoch || options.currentUserId() !== expectedUser) throw new AssistantCloudError('session_changed', 401)
    if (!response.ok) {
      const code = object(result) && typeof result.error === 'string' && Object.prototype.hasOwnProperty.call(errors, result.error) ? result.error : 'cloud_unavailable'
      throw new AssistantCloudError(code, response.status)
    }
    if (!object(result)) throw new AssistantCloudError('cloud_unavailable', 503)
    if ((['catalog', 'read', 'chat', 'import/prepare', 'materials/explain', 'homework/prepare-batch'].includes(route) || 'userId' in result) && result.userId !== expectedUser) throw new AssistantCloudError('session_changed', 401)
    return result as T
  }
  return {
    async bootstrap(signal?: AbortSignal) {
      const result = await call<AssistantCloudStatus>('bootstrap', undefined, signal)
      if (typeof result.available !== 'boolean' || typeof result.modelConnected !== 'boolean' || typeof result.writesAvailable !== 'boolean') throw new AssistantCloudError('cloud_unavailable', 503)
      return result
    },
    catalog(signal?: AbortSignal) { return call<LiveCatalog>('catalog', undefined, signal) },
    read(topic: LiveReadTopic, scope: LiveReadScope, signal?: AbortSignal) { return call<LiveReadResult>('read', { topic, scope, limit: 30 }, signal) },
    async chat(value: AssistantChatRequest, signal?: AbortSignal) {
      const allowed = ['message', 'history', 'scope', 'continuation', 'teacherMessage']
      if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || typeof value.message !== 'string' || !value.message.trim() || value.message.length > 6000
        || value.teacherMessage !== undefined && (typeof value.teacherMessage !== 'string' || value.teacherMessage.length > 10000)
        || value.continuation !== undefined && (typeof value.continuation !== 'string' || !value.continuation || value.continuation.length > 32768)
        || value.history !== undefined && (!Array.isArray(value.history) || value.history.length > 6 || value.history.some(item => !object(item) || Object.keys(item).some(key => !['role', 'content'].includes(key)) || !['user', 'assistant'].includes(item.role as string) || typeof item.content !== 'string' || item.content.length > 6000) || value.history.reduce((sum, item) => sum + item.content.length, 0) > 18000)
        || value.scope !== undefined && (!object(value.scope) || Object.keys(value.scope).some(key => !['groupId', 'subjectId', 'materialSubjectId', 'courseId', 'date', 'period', 'mode'].includes(key)) || value.scope.mode !== undefined && (typeof value.scope.mode !== 'string' || !['learning', 'teaching'].includes(value.scope.mode)))) throw new AssistantCloudError('invalid_request')
      const requestId = crypto.randomUUID()
      const result = await call<AssistantChatResult>('chat', { ...value, requestId }, signal)
      if (Object.keys(result).some(key => !['userId', 'kind', 'text', 'draft', 'drafts', 'read', 'continuation', 'choices', 'form', 'tool', 'sources'].includes(key))
        || !['reply', 'clarify', 'draft', 'read', 'unsupported'].includes(result.kind) || typeof result.text !== 'string' || result.text.length > 12000
        || result.continuation !== undefined && (typeof result.continuation !== 'string' || result.continuation.length > 32768)
        || result.kind === 'draft' && result.draft === undefined && !result.drafts?.length
        || result.draft !== undefined && (result.kind !== 'draft' || !object(result.draft) || result.draft.status !== 'pending' || typeof result.draft.id !== 'string' || typeof result.draft.title !== 'string' || !object(result.draft.scope) || !object(result.draft.payload) || !Array.isArray(result.draft.items) || !Array.isArray(result.draft.fields))
        || result.kind === 'read' && result.read === undefined
        || result.read !== undefined && (result.kind !== 'read' || !object(result.read) || result.read.userId !== result.userId || !Array.isArray(result.read.records))
        || result.drafts !== undefined && (!Array.isArray(result.drafts) || result.drafts.length > 30 || result.drafts.some(draft => !object(draft) || typeof draft.id !== 'string' || draft.status !== 'pending' || !object(draft.payload) || !object(draft.scope) || !Array.isArray(draft.fields) || !Array.isArray(draft.items)))
        || result.form !== undefined && !validForm(result.form)
        || result.tool !== undefined && (!object(result.tool) || !['schedule-import', 'material-explain'].includes(result.tool.type))
        || result.sources !== undefined && (!Array.isArray(result.sources) || result.sources.length > 30 || result.sources.some(source => !object(source) || typeof source.title !== 'string' || source.title.length > 500 || source.path !== undefined && typeof source.path !== 'string' || source.sourcePath !== undefined && typeof source.sourcePath !== 'string'))
        || result.choices !== undefined && (!object(result.choices) || !['group', 'subject', 'lesson'].includes(result.choices.type) || !Array.isArray(result.choices.items) || result.choices.items.length > 30 || result.choices.items.some(item => !object(item) || typeof item.id !== 'string' || item.id.length > 100 || typeof item.label !== 'string' || item.label.length > 240))) throw new AssistantCloudError('cloud_unavailable', 503)
      return result
    },
    async importSchedule(value: { scope: LiveDraft['scope']; files: { name: string; mimeType: string; data: string }[]; googleSheetUrl?: string; groupHint?: string; courseHint?: string; weekHint?: string; columnHint?: string; validFrom: string; validUntil: string; weekAnchorDate?: string }, signal?: AbortSignal) {
      if (!object(value) || !object(value.scope) || !Array.isArray(value.files) || value.files.length > 10 || value.files.some(file => !object(file) || typeof file.name !== 'string' || file.name.length > 180 || typeof file.mimeType !== 'string' || typeof file.data !== 'string') || JSON.stringify(value).length > 3_600_000) throw new AssistantCloudError('invalid_request')
      const result = await call<{ userId: string; drafts?: LiveDraft[]; remaining?: AssistantQueuedSchedule[]; form?: AssistantActionForm; text: string; clarifications?: string[] }>('import/prepare', { ...value, requestId: crypto.randomUUID() }, signal)
      if (result.remaining !== undefined && (!Array.isArray(result.remaining) || result.remaining.length > 80 || result.remaining.some(row => !validQueuedSchedule(row, value.scope.groupId)))) throw new AssistantCloudError('cloud_unavailable', 503)
      return result
    },
    explainMaterial(scope: LiveDraft['scope'], materialId: string, question?: string, signal?: AbortSignal) { return call<{ userId: string; text: string; sources: { title: string; sourcePath?: string; path?: string }[] }>('materials/explain', { scope, materialId, ...(question ? { question } : {}), requestId: crypto.randomUUID() }, signal) },
    batchHomework(scope: LiveDraft['scope'], source: string, signal?: AbortSignal) { return call<{ userId: string; text: string; drafts: LiveDraft[]; form?: AssistantActionForm }>('homework/prepare-batch', { scope, source, requestId: crypto.randomUUID() }, signal) },
    drafts(signal?: AbortSignal) { return call<{ drafts: { draft: LiveDraft; receipt?: LiveReceipt }[] }>('drafts', undefined, signal) },
    async form(action: string, scope: LiveDraft['scope'], payload: Record<string, unknown> = {}, signal?: AbortSignal) { const result = await call<{ form: AssistantActionForm }>('drafts/form', { action, scope, payload }, signal); if (!validForm(result.form)) throw new AssistantCloudError('cloud_unavailable', 503); return result },
    prepare(action: string, scope: LiveDraft['scope'], payload: Record<string, unknown>, signal?: AbortSignal) { return call<AssistantDraftResult>('drafts/prepare', { action, scope, payload }, signal) },
    edit(draft: LiveDraft, payload: Record<string, unknown>, signal?: AbortSignal) { return call<AssistantDraftResult>('drafts/edit', { id: draft.id, revision: draft.revision, confirmationToken: draft.confirmationToken, payload }, signal) },
    cancel(draft: LiveDraft, signal?: AbortSignal) { return call<AssistantDraftResult>('drafts/cancel', { id: draft.id, revision: draft.revision, confirmationToken: draft.confirmationToken }, signal) },
    confirm(draft: LiveDraft, signal?: AbortSignal, acceptMaterialRights = false) { return call<AssistantDraftResult>('drafts/confirm', { id: draft.id, revision: draft.revision, confirmationToken: draft.confirmationToken, ...(acceptMaterialRights ? { acceptMaterialRights: true } : {}) }, signal) },
    clear() { epoch++ },
  }
}
