import { supabase } from './supabase'
import { isMissingDatabaseColumn, isMissingDatabaseFunction, isMissingDatabaseTable } from './databaseCompatibility'
import { getLongTermAttachments, getLongTermLinks, validateLongTermResources, type LongTermTaskAttachment } from './longTermTaskResources'
import { getResourceLinkLabels, normalizeResourceLinkLabels, type ResourceLinkLabels } from './resourceLinkLabels'
import { groupAcademicDateInYear, groupAcademicYearRange } from './studyGroupAcademicYears'

export type StudyGroupLongTermTask = {
  id: string
  group_id: string
  subject: string
  subject_key: string
  title: string
  description: string
  due_date: string
  closed_at: string | null
  created_at: string
  updated_at: string
  created_by: string
  resource_links: string[]
  resource_link_labels: ResourceLinkLabels
  resource_attachments: LongTermTaskAttachment[]
}

export type StudyGroupLongTermTaskInput = {
  groupId: string
  id?: string | null
  subject: string
  title: string
  description: string
  dueDate: string
  resourceLinks?: string[]
  resourceLinkLabels?: ResourceLinkLabels
  resourceAttachments?: LongTermTaskAttachment[]
  expectedUpdatedAt?: string | null
  createRequestId?: string | null
}

// The UI applies this normalizer to both task.subject and lesson/subject names.
// The generated subject_key is server-internal; its database casing may differ.
const subjectWhitespace = /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+/gu
const singleLineControls = /[\u0000-\u001f\u007f-\u009f]/u
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function displaySubject(value: string): string {
  return value.replace(subjectWhitespace, ' ').trim()
}

export function normalizeLongTermSubject(value: string): string {
  return displaySubject(value).replace(/[‘’ʼʻ`´＇]/gu, "'").toLowerCase()
}

function validDueDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31') return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value))
}

function requireId(value: string): string {
  if (!uuidPattern.test(value)) throw new Error('LONG_TERM_TASK_INVALID_ID')
  return value.toLowerCase()
}

function normalizeTask(value: unknown, groupId: string): StudyGroupLongTermTask {
  if (!value || typeof value !== 'object') throw new Error('LONG_TERM_TASK_RESPONSE_INVALID')
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || !uuidPattern.test(item.id) || item.group_id !== groupId
    || typeof item.subject !== 'string' || !item.subject
    || typeof item.subject_key !== 'string' || !item.subject_key
    || typeof item.title !== 'string' || !item.title
    || typeof item.description !== 'string'
    || typeof item.due_date !== 'string' || !validDueDate(item.due_date)
    || (item.closed_at !== null && !validTimestamp(item.closed_at))
    || !validTimestamp(item.created_at) || !validTimestamp(item.updated_at)
    || typeof item.created_by !== 'string' || !uuidPattern.test(item.created_by)) {
    throw new Error('LONG_TERM_TASK_RESPONSE_INVALID')
  }
  return {
    id: item.id, group_id: groupId, subject: item.subject, subject_key: item.subject_key,
    title: item.title, description: item.description, due_date: item.due_date,
    closed_at: item.closed_at, created_at: item.created_at, updated_at: item.updated_at, created_by: item.created_by,
    resource_links: getLongTermLinks(item.resource_links),
    resource_link_labels: getResourceLinkLabels(item.resource_link_labels, getLongTermLinks(item.resource_links)),
    resource_attachments: getLongTermAttachments(item.resource_attachments).filter((attachment) => attachment.storage_path.startsWith(`${groupId}/`)),
  }
}

export async function loadStudyGroupLongTermTasks(groupId: string, academicYearStart?: number): Promise<StudyGroupLongTermTask[]> {
  const canonicalGroupId = requireId(groupId)
  const year = academicYearStart === undefined ? null : groupAcademicYearRange(academicYearStart)
  const tasks: StudyGroupLongTermTask[] = []
  let after: string | null = null
  // Keyset pages include both active assignments and the management archive,
  // even if this project's API row cap is lower than the requested page size.
  while (true) {
    let request = supabase.from('study_group_long_term_tasks').select('*')
      .eq('group_id', canonicalGroupId).order('id', { ascending: true }).limit(500)
    if (year) request = request.gte('due_date', year.from).lte('due_date', year.until)
    if (after) request = request.gt('id', after)
    const { data, error } = await request
    if (error) throw error
    if (!data?.length) break
    const page = data.map((item) => normalizeTask(item, canonicalGroupId))
    tasks.push(...page.filter(task => groupAcademicDateInYear(task.due_date, academicYearStart)))
    const lastId = page[page.length - 1].id
    if (lastId === after) throw new Error('LONG_TERM_TASK_RESPONSE_INVALID')
    after = lastId
  }
  return tasks.sort((left, right) => left.due_date.localeCompare(right.due_date)
    || left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id))
}

export async function saveStudyGroupLongTermTask(input: StudyGroupLongTermTaskInput): Promise<string> {
  const subject = displaySubject(input.subject)
  const title = input.title.trim()
  if (!subject || Array.from(subject).length > 120 || singleLineControls.test(subject)) {
    throw new Error('Назва предмета має містити від 1 до 120 символів.')
  }
  if (!title || Array.from(title).length > 240 || singleLineControls.test(title)) {
    throw new Error('Назва завдання має містити від 1 до 240 символів.')
  }
  if (Array.from(input.description).length > 10_000) throw new Error('Опис має містити не більше 10 000 символів.')
  if (!validDueDate(input.dueDate)) throw new Error('Вкажіть правильну дату дедлайну від 1900 до 2200 року.')
  const params: Record<string, unknown> = {
    p_group_id: requireId(input.groupId), p_task_id: input.id ? requireId(input.id) : null,
    p_subject: subject, p_title: title, p_description: input.description, p_due_date: input.dueDate,
  }
  const withResources = input.resourceLinks !== undefined || input.resourceAttachments !== undefined || input.resourceLinkLabels !== undefined
  const withNamedResources = input.resourceLinkLabels !== undefined
  if (withResources) {
    if (input.resourceLinks === undefined || input.resourceAttachments === undefined) throw new Error('LONG_TERM_TASK_INVALID_RESOURCES')
    const resources = validateLongTermResources(input.resourceLinks, [], input.resourceAttachments)
    if (resources.attachments.some((attachment) => !attachment.storage_path.startsWith(`${params.p_group_id}/`))) {
      throw new Error('LONG_TERM_TASK_INVALID_RESOURCES')
    }
    if (input.expectedUpdatedAt != null && !validTimestamp(input.expectedUpdatedAt)) throw new Error('LONG_TERM_TASK_INVALID_VERSION')
    if (!input.id && !input.createRequestId) throw new Error('LONG_TERM_TASK_INVALID_CREATE_REQUEST')
    params.p_resource_links = resources.links
    if (withNamedResources) {
      const entries = Object.entries(input.resourceLinkLabels || {})
      const normalized = normalizeResourceLinkLabels(entries.map(([url]) => url), entries.map(([, label]) => label))
      params.p_resource_link_labels = getResourceLinkLabels(normalized, resources.links)
    }
    params.p_resource_attachments = resources.attachments
    params.p_expected_updated_at = input.expectedUpdatedAt ?? null
    params.p_create_request_id = !input.id && input.createRequestId ? requireId(input.createRequestId) : null
  }
  // Preserve existing materials for callers that only edit scalar fields.
  const { data, error, status } = await supabase.rpc(withNamedResources
    ? 'xelay_save_study_group_long_term_task_resources_named'
    : withResources ? 'xelay_save_study_group_long_term_task_resources' : 'xelay_save_study_group_long_term_task', params)
  if (error) throw {
    ...error, message: error.message, code: error.code, details: error.details, hint: error.hint,
    saveOutcomeUnknown: status === 0 || status >= 500,
  }
  if (typeof data !== 'string' || !uuidPattern.test(data)) throw new Error('LONG_TERM_TASK_RESPONSE_INVALID')
  return data
}

export function isLongTermTaskSaveOutcomeUnknown(error: unknown): boolean {
  const item = error as { saveOutcomeUnknown?: boolean; code?: string; name?: string; message?: string; status?: number } | null
  if (item?.saveOutcomeUnknown === true || item?.status === 0 || (typeof item?.status === 'number' && item.status >= 500)) return true
  if (item?.code === 'LONG_TERM_TASK_RESPONSE_INVALID' || item?.message === 'LONG_TERM_TASK_RESPONSE_INVALID') return true
  return ['TypeError', 'AbortError', 'TimeoutError', 'AuthRetryableFetchError'].includes(item?.name || '')
    || /failed to fetch|load failed|networkerror|network request failed|fetch failed|timeout|timed out|abort/i.test(item?.message || '')
}

export async function setStudyGroupLongTermTaskClosed(groupId: string, taskId: string, closed: boolean): Promise<void> {
  const { error } = await supabase.rpc('xelay_set_study_group_long_term_task_closed', {
    p_group_id: requireId(groupId), p_task_id: requireId(taskId), p_closed: closed,
  })
  if (error) throw error
}

export function longTermTaskError(error: unknown): string {
  const value = error && typeof error === 'object' ? error as { message?: unknown; code?: string; details?: unknown } : {}
  const message = typeof value.message === 'string' ? value.message : typeof error === 'string' ? error : ''
  const combined = `${message} ${value.code || ''} ${typeof value.details === 'string' ? value.details : ''}`
  if (isMissingDatabaseTable(value) || isMissingDatabaseFunction(value) || isMissingDatabaseColumn(value)
    || /schema cache|does not exist/i.test(combined)) {
    return 'Довгострокові завдання ще підключаються. Спробуйте пізніше.'
  }
  const labels: [string, string][] = [
    ['TASK_RESOURCE_LINK_LABELS_INVALID', 'Перевірте назви посилань: до 80 символів кожна, без перенесення рядка.'],
    ['LONG_TERM_TASK_CONFLICT', 'Інший учасник уже змінив завдання. Оновіть список і відкрийте актуальну версію, щоб зберегти свої зміни.'],
    ['LONG_TERM_TASK_RESOURCE_INVALID_INPUT', 'Додайте до 10 посилань і до 10 файлів розміром до 20 МБ кожен.'],
    ['LONG_TERM_TASK_RESOURCE_UPLOAD_MISSING', 'Завантаження файлу не завершилося. Приберіть його й додайте повторно.'],
    ['LONG_TERM_TASK_RESOURCE_METADATA_MISMATCH', 'Дані файлу не відповідають завантаженню. Приберіть його й додайте повторно.'],
    ['LONG_TERM_TASK_RESOURCE_ALREADY_ATTACHED', 'Цей файл уже прикріплено до іншого завдання. Завантажте його повторно для цього завдання.'],
    ['LONG_TERM_TASK_RESOURCE_RETIRED', 'Цей файл уже видалено або передано на очищення. Приберіть його й додайте повторно.'],
    ['STUDY_GROUP_PERMISSION_REQUIRED', 'Керувати довгостроковими завданнями можуть староста й заступники з дозволом на домашні завдання.'],
    ['GROUP_LICENSE_REQUIRED', 'Не вдалося підтвердити безкоштовний доступ групи. Оновіть сторінку й повторіть спробу.'],
    ['DEPUTY_AUTH_REQUIRED', 'Увійдіть до свого акаунта й повторіть спробу.'],
    ['LONG_TERM_TASK_AUTH_REQUIRED', 'Увійдіть до свого акаунта й повторіть спробу.'],
    ['DEPUTY_GROUP_NOT_FOUND', 'Групу вже змінено або видалено. Оновіть сторінку.'],
    ['LONG_TERM_TASK_NOT_FOUND', 'Завдання більше недоступне. Оновіть список.'],
    ['LONG_TERM_TASK_INVALID_SUBJECT', 'Назва предмета має містити від 1 до 120 символів.'],
    ['LONG_TERM_TASK_INVALID_CONTENT', 'Перевірте назву (до 240 символів) та опис (до 10 000 символів).'],
    ['LONG_TERM_TASK_INVALID_DEADLINE', 'Вкажіть правильну дату дедлайну від 1900 до 2200 року.'],
    ['LONG_TERM_TASK_CLOSE_REQUIRED', 'Завдання можна закрити та зберегти в архіві.'],
    ['LONG_TERM_TASK_RESPONSE_INVALID', 'Не вдалося прочитати завдання. Оновіть список.'],
    ['LONG_TERM_TASK_INVALID_', 'Не вдалося зберегти завдання. Оновіть сторінку й повторіть спробу.'],
    ['LONG_TERM_TASK_IDENTITY_IMMUTABLE', 'Не вдалося змінити завдання. Оновіть список.'],
    ['LONG_TERM_TASK_AUTHOR_REQUIRED', 'Не вдалося підтвердити автора. Увійдіть знову й повторіть спробу.'],
  ]
  const known = labels.find(([code]) => combined.includes(code))
  if (known) return known[1]
  if (value.code === '42501' || /permission denied|row.level security/i.test(combined)) {
    return 'У вас немає дозволу на цю дію. Оновіть сторінку або зверніться до старости.'
  }
  if (['22007', '22008'].includes(value.code || '')) return 'Вкажіть правильну дату дедлайну.'
  if (error instanceof Error && /[А-Яа-яІіЇїЄєҐґ]/u.test(message)) return message
  return 'Не вдалося виконати дію. Перевірте з’єднання й повторіть спробу.'
}
