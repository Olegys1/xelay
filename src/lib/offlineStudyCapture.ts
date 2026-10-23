import { supabase } from './supabase'
import { addTimetableDays, scheduleOccursOnDate, type TimetableLesson } from './studyGroupTimetable'
import { kyivToday } from './seminars'
import { getResourceLinkLabels } from './resourceLinkLabels'
import type { TeachingLessonAssignment } from './teaching'
import { loadTimetablePhoto, timetablePhotoUrl, MAX_TIMETABLE_PHOTO_BYTES, type TimetablePhoto } from './studyGroupTimetablePhoto'
import type { OfflineAssignment, OfflineGroupSnapshotInput, OfflineHomework, OfflineLesson, OfflineTimetablePhoto } from './offlineStudy'

const PAGE_SIZE = 250
const MAX_ROWS = 2_000
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class OfflineStudyAccessDenied extends Error {
  constructor() { super('Доступ до групи змінився. Її збережену копію прибрано з пристрою.'); this.name = 'OfflineStudyAccessDenied' }
}

export function isOfflineStudyAccessDenied(value: unknown): boolean {
  const error = value as { code?: unknown; status?: unknown; message?: unknown } | null
  return value instanceof OfflineStudyAccessDenied || error?.code === '42501' || error?.status === 403
    || /TEACHING_FORBIDDEN|MEMBER_REQUIRED/.test(typeof error?.message === 'string' ? error.message : '')
}

function checkAbort(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Збереження скасовано.', 'AbortError')
}

function assertReadableResult(result: { error: unknown; status: number }) {
  // PostgREST's error body need not retain the HTTP status. A definitive 403
  // must purge the copy even when its error code differs from PostgreSQL 42501.
  if (result.status === 403) throw new OfflineStudyAccessDenied()
  if (result.error) throw result.error
}

async function assertAccount(userId: string, signal: AbortSignal) {
  checkAbort(signal)
  const result = await supabase.auth.getSession()
  checkAbort(signal)
  if (result.error || result.data.session?.user.id !== userId) throw new Error('Акаунт змінився. Увійдіть до Xelay ще раз.')
}

async function acceptedGroup(userId: string, groupId: string, signal: AbortSignal) {
  await assertAccount(userId, signal)
  const [group, membership] = await Promise.all([
    supabase.from('study_groups').select('id,group_name,representative_id').eq('id', groupId).abortSignal(signal).maybeSingle(),
    supabase.from('study_group_members').select('id,status').eq('group_id', groupId).eq('user_id', userId).abortSignal(signal).maybeSingle(),
  ])
  checkAbort(signal)
  assertReadableResult(group)
  assertReadableResult(membership)
  if (!group.data || (group.data.representative_id !== userId && membership.data?.status !== 'accepted')) throw new OfflineStudyAccessDenied()
  return group.data as { id: string; group_name: string; representative_id: string }
}

function plainLinks(values: unknown, labels: unknown): { label: string; url: string }[] {
  const links: string[] = []
  for (const candidate of Array.isArray(values) ? values : []) {
    if (typeof candidate !== 'string' || candidate.length > 2000) continue
    try {
      const url = new URL(candidate)
      // Never persist private Storage URLs, access tokens or signed downloads.
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || /\/storage\/v1\//i.test(url.pathname)
        || [...url.searchParams.keys()].some(key => /token|signature|credential|authorization|^key$|x-amz-|x-goog-/i.test(key))) continue
      if (!links.includes(url.href)) links.push(url.href)
    } catch { /* An invalid resource is not a navigable offline link. */ }
    if (links.length === 10) break
  }
  const names = getResourceLinkLabels(labels, links)
  return links.map((url, index) => ({ url, label: names[url] || `Посилання ${index + 1}` }))
}

function fileNames(value: unknown): string[] {
  return (Array.isArray(value) ? value : []).flatMap(candidate => {
    if (!candidate || typeof candidate !== 'object') return []
    const item = candidate as { file_name?: unknown; name?: unknown }
    const name = typeof item.file_name === 'string' ? item.file_name : item.name
    return typeof name === 'string' && name.length <= 240 && !/[\/\\\u0000-\u001f\u007f]/.test(name) ? [name] : []
  }).slice(0, 10)
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  checkAbort(signal)
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException('Збереження скасовано.', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    pending.then(value => { signal.removeEventListener('abort', abort); if (signal.aborted) abort(); else resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

async function captureTimetablePhoto(groupId: string, signal: AbortSignal): Promise<{ photo?: OfflineTimetablePhoto; metadata: TimetablePhoto | null }> {
  const metadata = await abortable(loadTimetablePhoto(groupId), signal)
  if (!metadata) return { metadata: null }
  const signedUrl = await abortable(timetablePhotoUrl(metadata.storage_path), signal)
  checkAbort(signal)
  const url = new URL(signedUrl)
  const projectUrl = new URL(import.meta.env.VITE_SUPABASE_URL as string)
  if (url.origin !== projectUrl.origin || !url.pathname.startsWith('/storage/v1/object/sign/xelay-timetable-images/')) throw new Error('Не вдалося перевірити фото розкладу.')
  const response = await fetch(url.href, { signal, cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' })
  if (!response.ok) {
    if (response.status === 403) throw new OfflineStudyAccessDenied()
    throw new Error('Фото розкладу не завантажено. Спробуйте зберегти копію ще раз.')
  }
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  const declared = Number(response.headers.get('content-length') || 0)
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime || '') || declared > MAX_TIMETABLE_PHOTO_BYTES || !response.body) {
    await response.body?.cancel()
    throw new Error('Не вдалося зберегти фото розкладу. Підтримуються JPG, PNG та WebP до 8 МБ.')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  let length = 0
  try {
    while (true) {
      checkAbort(signal)
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_TIMETABLE_PHOTO_BYTES) throw new Error('Фото розкладу завелике для офлайн-копії.')
      chunks.push(new Uint8Array(part.value))
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error }
  finally { reader.releaseLock() }
  if (!length) throw new Error('Фото розкладу порожнє. Спробуйте ще раз.')
  const blob = new Blob(chunks, { type: mime })
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer())
  const isImage = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
    || [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte)
    || String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP'
  if (!isImage) throw new Error('Не вдалося прочитати фото розкладу.')
  const objectUrl = URL.createObjectURL(blob)
  const image = new Image()
  try {
    await abortable(new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Не вдалося прочитати фото розкладу.')); image.src = objectUrl }), signal)
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 32_000_000) throw new Error('Фото розкладу має завелику роздільну здатність для офлайн-копії.')
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Цей браузер не дозволив зберегти фото розкладу.')
    context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    let dataUrl = ''
    for (const quality of [0.88, 0.8, 0.72, 0.64]) {
      checkAbort(signal)
      dataUrl = canvas.toDataURL('image/jpeg', quality)
      if (dataUrl.length <= 1_400_000) break
    }
    canvas.width = 1; canvas.height = 1
    if (dataUrl.length > 1_400_000) throw new Error('Фото розкладу не поміщається в офлайн-копію. Попросіть старосту завантажити менше зображення.')
    return { metadata, photo: { dataUrl, updatedAt: metadata.updated_at } }
  } finally { image.onload = null; image.onerror = null; image.src = ''; URL.revokeObjectURL(objectUrl) }
}

type GroupHomework = { id: string; group_id: string; schedule_item_id: string; lesson_date: string; lesson_topic?: string | null; body: string; url?: string | null; resource_links?: string[]; resource_link_labels?: unknown; attachments?: unknown }
type LongTermHomework = { id: string; group_id: string; subject: string; title: string; description: string; due_date: string; resource_links?: string[]; resource_link_labels?: unknown; resource_attachments?: unknown }

// Keyset pagination does not mistake a project-specific PostgREST row cap for
// the complete result. Overlarge data fails without replacing a good snapshot.
async function groupRows<T extends { id: string; group_id: string }>(table: string, columns: string, groupId: string, signal: AbortSignal, range?: { column: string; start: string; end: string }, activeOnly = false): Promise<T[]> {
  const rows: T[] = []
  let after = ''
  while (true) {
    checkAbort(signal)
    let query = supabase.from(table).select(columns).eq('group_id', groupId).order('id').limit(PAGE_SIZE)
    if (range) query = query.gte(range.column, range.start).lte(range.column, range.end)
    if (activeOnly) query = query.is('closed_at', null)
    if (after) query = query.gt('id', after)
    const result = await query.abortSignal(signal)
    checkAbort(signal)
    assertReadableResult(result)
    if (!Array.isArray(result.data) || !result.data.length) break
    const page = result.data as unknown as T[]
    if (page.some(row => !row || typeof row.id !== 'string' || row.group_id !== groupId) || page[page.length - 1].id === after) throw new Error('Не вдалося перевірити повноту копії. Спробуйте ще раз.')
    rows.push(...page)
    if (rows.length > MAX_ROWS) throw new Error('Для однієї офлайн-копії забагато записів. Зверніться до підтримки Xelay.')
    after = page[page.length - 1].id
  }
  return rows
}

async function teacherAssignments(groupId: string, dates: string[], signal: AbortSignal): Promise<TeachingLessonAssignment[]> {
  const byId = new Map<string, TeachingLessonAssignment>()
  let next = 0
  const worker = async () => {
    while (next < dates.length) {
      checkAbort(signal)
      const date = dates[next++]
      // This existing RPC exposes only published, non-withdrawn assignments to
      // accepted members. Never use the teaching workspace/grade RPC for cache.
      const result = await supabase.rpc('xelay_group_teacher_assignments', { p_group_id: groupId, p_lesson_date: date }).abortSignal(signal)
      checkAbort(signal)
      assertReadableResult(result)
      if (!result.data || !Array.isArray(result.data.assignments)) throw new Error('Не вдалося завантажити всі завдання викладачів. Спробуйте ще раз.')
      for (const item of result.data.assignments as TeachingLessonAssignment[]) {
        if (item.group_id !== groupId || item.source !== 'teacher' || item.read_only !== true || item.status !== 'published'
          || !Array.isArray(item.targets) || !item.targets.some(target => target.group_id === groupId)) throw new Error('Не вдалося перевірити доступ до завдання викладача.')
        byId.set(item.id, item)
        if (byId.size > MAX_ROWS) throw new Error('Для однієї офлайн-копії забагато завдань. Зверніться до підтримки Xelay.')
      }
    }
  }
  await Promise.all([worker(), worker(), worker()])
  return [...byId.values()]
}

/** Capture authorized text only. Callers must obtain a storage session receipt
 * BEFORE calling, and pass that same receipt to the eventual atomic store save. */
export async function captureOfflineStudyGroup(userId: string, groupId: string, signal: AbortSignal): Promise<OfflineGroupSnapshotInput> {
  if (!uuid.test(userId) || !uuid.test(groupId)) throw new Error('Не вдалося визначити акаунт або групу.')
  const group = await acceptedGroup(userId, groupId, signal)
  const rangeStart = kyivToday()
  const rangeEnd = addTimetableDays(rangeStart, 13)
  const dates = Array.from({ length: 14 }, (_, index) => addTimetableDays(rangeStart, index))
  const [schedule, groupHomework, longTerm, published, timetable] = await Promise.all([
    groupRows<TimetableLesson>('study_group_schedule', 'id,group_id,weekday,starts_at,ends_at,subject,teacher_name,lesson_type,location,valid_from,valid_until,week_pattern,week_anchor_date,excluded_dates', groupId, signal),
    groupRows<GroupHomework>('study_group_homework', 'id,group_id,schedule_item_id,lesson_date,lesson_topic,body,url,resource_links,resource_link_labels,attachments', groupId, signal, { column: 'lesson_date', start: rangeStart, end: rangeEnd }),
    groupRows<LongTermHomework>('study_group_long_term_tasks', 'id,group_id,subject,title,description,due_date,resource_links,resource_link_labels,resource_attachments', groupId, signal, { column: 'due_date', start: rangeStart, end: rangeEnd }, true),
    teacherAssignments(groupId, dates, signal),
    captureTimetablePhoto(groupId, signal),
  ])
  const lessons: OfflineLesson[] = dates.flatMap(date => schedule.filter(item => scheduleOccursOnDate(item, date)).map(item => ({
    id: item.id, date, subject: item.subject, startsAt: item.starts_at.slice(0, 5), endsAt: item.ends_at.slice(0, 5),
    lessonType: item.lesson_type, teacherName: item.teacher_name || undefined, location: item.location || undefined,
  })))
  const scheduleById = new Map(schedule.map(item => [item.id, item]))
  const homework: OfflineHomework[] = groupHomework.map(item => ({
    id: item.id, date: item.lesson_date, scheduleItemId: item.schedule_item_id, subject: scheduleById.get(item.schedule_item_id)?.subject || 'Домашнє завдання',
    title: item.lesson_topic || undefined, body: item.body, links: plainLinks([item.url, ...(item.resource_links || [])], item.resource_link_labels), fileNames: fileNames(item.attachments),
  }))
  homework.push(...longTerm.map(item => ({
    id: `long-term:${item.id}`, date: item.due_date, subject: item.subject, title: `Довгострокове завдання: ${item.title}`,
    body: item.description, links: plainLinks(item.resource_links, item.resource_link_labels), fileNames: fileNames(item.resource_attachments),
  })))
  const assignments: OfflineAssignment[] = published.map(item => {
    const target = item.targets.find(value => value.group_id === groupId)!
    return { id: item.id, date: item.lesson_date, scheduleItemId: item.schedule_item_id || undefined, subject: item.subject_name || item.course_title,
      title: item.title, body: item.body, teacherName: item.author_name || undefined, dueAt: target.due_at || undefined,
      links: plainLinks(item.links, item.link_labels), fileNames: fileNames(item.attachments) }
  })
  // Membership may be removed, or account switched, while the 14-day read runs.
  const [, latestPhoto] = await Promise.all([acceptedGroup(userId, groupId, signal), abortable(loadTimetablePhoto(groupId), signal)])
  if (latestPhoto?.storage_path !== timetable.metadata?.storage_path || latestPhoto?.updated_at !== timetable.metadata?.updated_at) throw new Error('Фото розкладу щойно змінилося. Збережіть копію ще раз.')
  checkAbort(signal)
  return { groupId, groupName: group.group_name, rangeStart, rangeEnd, lessons, homework, assignments, timetablePhoto: timetable.photo }
}

export function offlineStudyCaptureError(value: unknown): string {
  if (isOfflineStudyAccessDenied(value)) return 'Доступ до групи змінився. Її збережену копію прибрано з пристрою.'
  if (value instanceof Error && value.name === 'AbortError') return 'Збереження не завершено. Перевірте інтернет і спробуйте ще раз.'
  const error = value as { code?: string; message?: string } | null
  if (value instanceof Error && !error?.code && /^[А-ЯІЇЄҐа-яіїєґ]/u.test(value.message) && !/fetch|network|load failed|timeout/i.test(value.message)) return value.message
  return 'Не вдалося оновити офлайн-копію. Перевірте інтернет і спробуйте ще раз. Попередня копія, якщо була, не змінена.'
}
