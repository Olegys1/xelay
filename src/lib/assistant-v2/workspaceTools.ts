import type { LiveCatalog, LiveDraft, LiveReadResult, LiveReadScope, LiveReadTopic, LiveRecord } from './liveClient'
import type { AssistantQueuedSchedule } from './cloudClient'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const isDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().startsWith(value)
export function assistantRouteContext(pathname: string, search: string, catalog: LiveCatalog) {
  const params = new URLSearchParams(search), group = /^\/groups\/([a-f0-9-]{36})(?:\/|$)/i.exec(pathname)?.[1] || params.get('group') || ''
  const requestedCourse = params.get('course') || params.get('teaching') || ''
  const course = catalog.courses.find(item => item.id === requestedCourse && item.teaching && item.teachingGroupIds.length)
  const teaching = pathname.startsWith('/teaching') || !!course
  const allowedGroup = catalog.groups.find(item => item.id === group && (teaching ? catalog.courses.some(candidate => candidate.teaching && candidate.teachingGroupIds.includes(item.id) && (!course || candidate.id === course.id)) : item.learning))
  const subjectId = params.get('subject') || ''
  const subject = catalog.subjects.find(item => item.id === subjectId && item.groupId === allowedGroup?.id)
  const selectedDate = params.get('date')
  return { mode: teaching ? 'teaching' as const : 'learning' as const, ...(allowedGroup ? { groupId: allowedGroup.id } : {}), ...(course ? { courseId: course.id } : {}), ...(subject ? { subjectId: subject.id } : {}), ...(isDate(selectedDate) ? { date: selectedDate } : {}) }
}

export interface AssistantStorage { readonly length: number; key(index: number): string | null; getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }
export const ASSISTANT_OFFLINE_PREFIX = 'xelay:assistant:offline:v1:'
export const ASSISTANT_OFFLINE_TTL = 14 * 24 * 60 * 60 * 1000
export function updateAssistantRecurringDraft(payload: Record<string, unknown>, field: 'date' | 'recurring' | 'validFrom' | 'validUntil' | 'weekPattern' | 'weekAnchorDate', value: string | boolean) {
  const next = { ...payload, [field]: value }
  const weekday = (day: string) => new Date(day + 'T12:00:00Z').getUTCDay() || 7
  if (field === 'date' && isDate(value)) {
    next.weekday = weekday(value); next.validFrom = value
    if (next.recurring !== true) next.validUntil = value
  }
  if (field === 'weekPattern') {
    if (value === 'every') delete next.weekAnchorDate
    if ('week' in next) next.week = value === 'every' ? 'both' : value
  }
  if (field === 'recurring' && value === false) {
    next.weekPattern = 'every'; if ('week' in next) next.week = 'both'; delete next.weekAnchorDate
    if (isDate(next.date)) { next.weekday = weekday(next.date); next.validFrom = next.date; next.validUntil = next.date }
  }
  // A period starts independently of the weekday on which its first class
  // occurs. Keep the displayed first class truthful when those rules change.
  if (next.recurring === true && ['validFrom', 'weekPattern', 'weekAnchorDate'].includes(field)) {
    const from = next.validFrom ?? next.date, selectedDay = Number.isInteger(next.weekday) ? Number(next.weekday) : isDate(next.date) ? weekday(next.date) : NaN
    const pattern = next.weekPattern ?? (next.week === 'upper' || next.week === 'lower' ? next.week : 'every')
    if (isDate(from) && selectedDay >= 1 && selectedDay <= 7) {
      let first = Date.parse(from + 'T12:00:00Z') + ((selectedDay - weekday(from) + 7) % 7) * 86400000
      if ((pattern === 'upper' || pattern === 'lower') && isDate(next.weekAnchorDate) && weekday(next.weekAnchorDate) === 1) {
        const monday = first - (selectedDay - 1) * 86400000, week = Math.round((monday - Date.parse(next.weekAnchorDate + 'T12:00:00Z')) / (7 * 86400000))
        if (((week % 2) + 2) % 2 !== (pattern === 'upper' ? 0 : 1)) first += 7 * 86400000
      }
      next.date = new Date(first).toISOString().slice(0, 10)
    }
  }
  return next
}
export function assistantRecurringDraftIssues(payload: Record<string, unknown>) {
  const issues: string[] = []
  if (!isDate(payload.date)) issues.push('Оберіть коректну дату першої пари.')
  if (payload.recurring !== true) return issues
  const validFrom = payload.validFrom ?? payload.date, weekPattern = payload.weekPattern ?? (payload.week === 'upper' || payload.week === 'lower' ? payload.week : 'every')
  const weekday = payload.weekday ?? (isDate(payload.date) ? new Date(payload.date + 'T12:00:00Z').getUTCDay() || 7 : NaN)
  if (!isDate(validFrom) || !isDate(payload.validUntil)) issues.push('Укажіть початок і кінець періоду повторення.')
  else {
    if (payload.validUntil < validFrom) issues.push('Кінець періоду має бути не раніше його початку.')
    if (Date.parse(payload.validUntil) - Date.parse(validFrom) > 366 * 86400000) issues.push('Період повторення має бути до одного року.')
    if (isDate(payload.date) && (payload.date < validFrom || payload.date > payload.validUntil)) issues.push('Перша пара має бути всередині вибраного періоду.')
  }
  if (!Number.isInteger(weekday) || Number(weekday) < 1 || Number(weekday) > 7 || isDate(payload.date) && (new Date(payload.date + 'T12:00:00Z').getUTCDay() || 7) !== weekday) issues.push('Перевірте дату першої пари: за нею визначається день тижня.')
  if (!['every', 'upper', 'lower'].includes(String(weekPattern))) issues.push('Оберіть чергування тижнів.')
  else if (weekPattern !== 'every') {
    if (!isDate(payload.weekAnchorDate) || new Date(payload.weekAnchorDate + 'T12:00:00Z').getUTCDay() !== 1) issues.push('Оберіть понеділок, з якого починається верхній тиждень.')
    else if (isDate(payload.date)) {
      const monday = Date.parse(payload.date + 'T12:00:00Z') - ((new Date(payload.date + 'T12:00:00Z').getUTCDay() || 7) - 1) * 86400000
      const week = Math.round((monday - Date.parse(payload.weekAnchorDate + 'T12:00:00Z')) / (7 * 86400000))
      if (((week % 2) + 2) % 2 !== (weekPattern === 'upper' ? 0 : 1)) issues.push('Перша пара припадає на інший тиждень. Перевірте дату, чергування або понеділок верхнього тижня.')
    }
  }
  return issues
}
const MAX_OFFLINE_BYTES = 900_000
const offlineTopics = new Set<string>(['study', 'teaching'])
const recordKeys = new Set(['id', 'kind', 'groupId', 'subjectId', 'courseId', 'title', 'body', 'date', 'startsAt', 'endsAt', 'location', 'links', 'conferenceId', 'accessCode', 'scheduleId', 'lessonId', 'dueAt', 'published', 'bodyTruncated', 'teacherName', 'sourcePath'])
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
function keyOf(topic: string, scope: LiveReadScope) { return JSON.stringify([topic, scope.groupId || '', scope.subjectId || '', scope.courseId || '', scope.from || '', scope.to || '', scope.period]) }
export function clearAssistantOffline(storage: AssistantStorage | undefined, exceptOwner?: string) {
  if (!storage) return
  try { for (let index = storage.length - 1; index >= 0; index--) { const key = storage.key(index); if (key?.startsWith(ASSISTANT_OFFLINE_PREFIX) && key !== ASSISTANT_OFFLINE_PREFIX + exceptOwner) storage.removeItem(key) } } catch { /* Private storage may be disabled. */ }
}
export function createAssistantOfflineCache(storage: AssistantStorage | undefined, ownerId: string, now: () => number = Date.now) {
  const key = ASSISTANT_OFFLINE_PREFIX + ownerId
  type Envelope = { version: 1; ownerId: string; catalog?: LiveCatalog; catalogAt?: number; reads: { key: string; capturedAt: number; value: LiveReadResult }[] }
  function empty(): Envelope { return { version: 1, ownerId, reads: [] } }
  function load(): Envelope {
    if (!storage || !UUID.test(ownerId)) return empty()
    try {
      const raw = storage.getItem(key)
      if (!raw || raw.length > MAX_OFFLINE_BYTES) return empty()
      const value = JSON.parse(raw)
      if (!object(value) || value.version !== 1 || value.ownerId !== ownerId || !Array.isArray(value.reads) || value.reads.length > 12) return empty()
      value.reads = value.reads.filter((entry: any) => object(entry) && typeof entry.key === 'string' && Number.isFinite(entry.capturedAt) && entry.capturedAt <= now() && now() - entry.capturedAt <= ASSISTANT_OFFLINE_TTL && object(entry.value) && entry.value.userId === ownerId && Array.isArray(entry.value.records) && entry.value.records.every((record: any) => object(record) && ['lesson', 'homework'].includes(record.kind)))
      if (value.catalog && (!Number.isFinite(value.catalogAt) || value.catalogAt > now() || now() - value.catalogAt > ASSISTANT_OFFLINE_TTL || value.catalog.userId !== ownerId || !Array.isArray(value.catalog.groups) || !Array.isArray(value.catalog.courses) || !Array.isArray(value.catalog.subjects))) delete value.catalog
      return value as Envelope
    } catch { return empty() }
  }
  function save(value: Envelope) {
    if (!storage || !UUID.test(ownerId)) return
    try {
      let raw = JSON.stringify(value)
      while (raw.length > MAX_OFFLINE_BYTES && value.reads.length > 1) { value.reads.pop(); raw = JSON.stringify(value) }
      while (raw.length > MAX_OFFLINE_BYTES && value.reads[0]?.value.records.length) { value.reads[0].value.records.pop(); value.reads[0].value.truncated = true; raw = JSON.stringify(value) }
      if (raw.length <= MAX_OFFLINE_BYTES) storage.setItem(key, raw)
    } catch { /* A full browser disk must not interrupt normal reads. */ }
  }
  return {
    catalog(): LiveCatalog | undefined { return load().catalog },
    saveCatalog(catalog: LiveCatalog) {
      if (catalog.userId !== ownerId) return
      const value = load(); value.catalog = { userId: ownerId, groups: catalog.groups.map(group => ({ id: group.id, name: group.name, program: group.program, studyYear: group.studyYear, learning: group.learning, permissions: [] })), subjects: catalog.subjects.map(subject => ({ id: subject.id, groupId: subject.groupId, name: subject.name, kind: subject.kind })), courses: catalog.courses.map(course => ({ id: course.id, name: course.name, groupIds: course.groupIds, subjects: course.subjects.map(subject => ({ groupId: subject.groupId, subjectId: subject.subjectId })), archived: course.archived, teaching: course.teaching, teachingGroupIds: course.teachingGroupIds, permissions: [] })) }; value.catalogAt = now(); save(value)
    },
    saveRead(topic: LiveReadTopic, scope: LiveReadScope, result: LiveReadResult) {
      if (!offlineTopics.has(topic) || result.userId !== ownerId || result.records.some(record => !['lesson', 'homework'].includes(record.kind))) return
      const value = load(), entryKey = keyOf(topic, scope)
      const records = result.records.slice(0, 100).map(record => Object.fromEntries(Object.entries(record).filter(([field]) => recordKeys.has(field)))) as unknown as LiveRecord[]
      value.reads = [{ key: entryKey, capturedAt: now(), value: { userId: ownerId, audience: result.audience, records, truncated: result.truncated, readAt: result.readAt } }, ...value.reads.filter(entry => entry.key !== entryKey)].slice(0, 12); save(value)
    },
    read(topic: LiveReadTopic, scope: LiveReadScope): { result: LiveReadResult; capturedAt: number } | undefined {
      if (!offlineTopics.has(topic)) return undefined
      const entry = load().reads.find(entry => entry.key === keyOf(topic, scope)); return entry ? { result: entry.value, capturedAt: entry.capturedAt } : undefined
    },
    clear() { try { storage?.removeItem(key) } catch { /* See storage note above. */ } },
  }
}

export function assistantGradeSummary(records: LiveRecord[], catalog?: LiveCatalog) {
  const groups = new Map<string, { id: string; title: string; points: number; maximum: number; weighted: number; weightedMaximum: number; count: number }>()
  for (const record of records) {
    if (record.kind !== 'grade' || !Number.isFinite(record.points) || !Number.isFinite(record.maxPoints)) continue
    const coefficient = Number.isFinite(record.coefficient) && record.coefficient! >= 0 ? record.coefficient! : 1
    const id = record.groupId + ':' + record.subjectId, title = catalog?.subjects.find(subject => subject.id === record.subjectId && subject.groupId === record.groupId)?.name || 'Предмет'
    const group = groups.get(id) || { id, title, points: 0, maximum: 0, weighted: 0, weightedMaximum: 0, count: 0 }
    group.points += record.points!; group.maximum += record.maxPoints!; group.weighted += record.points! * coefficient; group.weightedMaximum += record.maxPoints! * coefficient; group.count++; groups.set(id, group)
  }
  return [...groups.values()].map(group => ({ ...group, points: Number(group.points.toFixed(2)), maximum: Number(group.maximum.toFixed(2)), weighted: Number(group.weighted.toFixed(2)), weightedMaximum: Number(group.weightedMaximum.toFixed(2)) }))
}

export function assistantImportBatchReady(drafts: Pick<LiveDraft, 'status'>[]) { return drafts.every(draft => draft.status === 'confirmed' || draft.status === 'cancelled') }
export const ASSISTANT_REMINDER_OPTIONS = [{ value: 15, label: 'За 15 хвилин' }, { value: 60, label: 'За годину' }, { value: 180, label: 'За 3 години' }, { value: 1440, label: 'За день' }, { value: 10080, label: 'За тиждень' }] as const
export function updateAssistantMaterialGrant(grants: { userId: string; canEdit: boolean; canDelete: boolean; canManageGroups: boolean }[], userId: string, permission: 'canEdit' | 'canDelete' | 'canManageGroups', allowed: boolean) {
  const previous = grants.find(grant => grant.userId === userId), updated = { userId, canEdit: previous?.canEdit === true, canDelete: previous?.canDelete === true, canManageGroups: previous?.canManageGroups === true, [permission]: allowed }
  const remaining = grants.filter(grant => grant.userId !== userId)
  return updated.canEdit || updated.canDelete || updated.canManageGroups ? [...remaining, updated] : remaining
}
/** Prepare only the explicitly requested next chunk. This function has no
 * model or confirmation port. A failure retains both completed drafts and the
 * unprepared remainder; neither a failed row nor a lost response is retried. */
export async function prepareAssistantImportChunk(queue: AssistantQueuedSchedule[], dependencies: { current(): boolean; prepare(row: AssistantQueuedSchedule): Promise<{ draft: LiveDraft }> }) {
  const remaining = [...queue], drafts: LiveDraft[] = []
  for (let count = 0; count < 10 && remaining.length; count++) {
    if (!dependencies.current()) return { drafts, remaining, interrupted: true }
    const row = remaining[0]
    if (row.action !== 'schedule.create') return { drafts, remaining, error: new Error('Непідтримувана дія в черзі імпорту.') }
    try {
      const result = await dependencies.prepare(row)
      if (!dependencies.current()) return { drafts, remaining, interrupted: true }
      drafts.push(result.draft); remaining.shift()
    } catch (error) { return { drafts, remaining, error } }
  }
  return { drafts, remaining }
}

export function assistantSourcePath(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048 || !/^\/(?:groups|organizer|teaching|community|questions|news|opportunities|guides)(?:[/?#]|$)/.test(value) || /[\\\u0000-\u0020]|%(?:5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(value)) return null
  try { const url = new URL(value, 'https://www.xelay.ink'); return url.origin === 'https://www.xelay.ink' && /^\/(?:groups|organizer|teaching|community|questions|news|opportunities|guides)(?:\/|$)/.test(url.pathname) ? value : null } catch { return null }
}

export function assistantKyivInput(value: unknown) {
  if (typeof value !== 'string' || !value) return ''
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value
  if (!Number.isFinite(Date.parse(value))) return ''
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(value))
  const part = (key: string) => parts.find(item => item.type === key)?.value || ''
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}
export function assistantKyivInstant(value: string): string | null {
  if (!value) return null
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) || !isDate(value.slice(0, 10))) throw new Error('Перевірте дату й час за Києвом.')
  const target = Date.parse(value + ':00Z'); let result = target
  for (let index = 0; index < 3; index++) { const local = assistantKyivInput(new Date(result).toISOString()); result += target - Date.parse(local + ':00Z') }
  const output = new Date(result).toISOString()
  if (assistantKyivInput(output) !== value) throw new Error('Такого часу немає через переведення годинника. Оберіть інший час.')
  return output
}

export interface AssistantImportFile { name: string; mimeType: string; data: string }
export async function prepareAssistantFiles(files: File[]): Promise<AssistantImportFile[]> {
  if (!files.length || files.length > 10 || files.some(file => file.size > 8 * 1024 * 1024) || files.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) throw new Error('Додайте до 10 файлів, до 8 МБ кожен і до 20 МБ разом.')
  const formats: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv', tsv: 'text/tab-separated-values' }
  const output: AssistantImportFile[] = []
  for (const file of files) {
    const extension = file.name.split('.').pop()?.toLowerCase() || '', mimeType = formats[extension]
    if (!mimeType) throw new Error('Для розкладу додайте PNG, JPG, WebP, XLSX, CSV або TSV.')
    let content: Blob = file, contentType = mimeType, name = file.name.slice(0, 180)
    if (mimeType.startsWith('image/')) {
      const bitmap = await createImageBitmap(file)
      try {
        if (bitmap.width * bitmap.height > 40_000_000) throw new Error('Зображення надто велике. Зробіть окремі скриншоти потрібних частин.')
        const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(bitmap.width * ratio)); canvas.height = Math.max(1, Math.round(bitmap.height * ratio))
        const context = canvas.getContext('2d'); if (!context) throw new Error('Не вдалося підготувати фото.')
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
        content = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Не вдалося підготувати фото.')), 'image/webp', 0.82))
        contentType = content.type === 'image/webp' ? 'image/webp' : 'image/png'; name = name.replace(/\.[^.]+$/, '') + (contentType === 'image/webp' ? '.webp' : '.png')
      } finally { bitmap.close() }
    } else if (file.size > 2 * 1024 * 1024) throw new Error('Таблиця має бути до 2 МБ. Залиште потрібні аркуші або додайте посилання Google Sheets.')
    const bytes = new Uint8Array(await content.arrayBuffer()); let binary = ''
    for (let offset = 0; offset < bytes.length; offset += 32768) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768))
    output.push({ name, mimeType: contentType, data: btoa(binary) })
    if (JSON.stringify(output).length > 3_400_000) throw new Error('Файлів забагато для одного запиту. Розділіть розклад на частини або додайте Google-таблицю.')
  }
  return output
}
