import { supabase } from './supabase'
import { getMaterialAttachments, getMaterialLinks, materialFileName, MAX_MATERIAL_FILE_SIZE, validateMaterialFiles, validateMaterialLinks, type MaterialAttachment, type MaterialLink } from './studyGroupMaterialFiles'
import { isMaterialDate, materialToday } from './studyGroupMaterials'

export const GROUP_PRESENTATION_BUCKET = 'xelay-group-presentations'
export const GROUP_PRESENTATION_ACCEPT = '.pdf,.ppt,.pptx,.doc,.docx,.jpg,.jpeg,.png,.webp'
export type GroupPresentation = {
  id: string; group_id: string; created_by: string; author_name: string; subject: string; title: string;
  lesson_date: string; description: string; links: MaterialLink[]; attachments: MaterialAttachment[];
  version: number; created_at: string; updated_at: string
}
export type GroupPresentationDraft = Pick<GroupPresentation, 'subject' | 'title' | 'lesson_date' | 'description' | 'links' | 'attachments'>
export type GroupPresentationData = { presentations: GroupPresentation[]; subjects: string[]; can_moderate: boolean }
export interface GroupPresentationRepository {
  readonly mode: 'supabase' | 'local'
  list(groupId: string): Promise<GroupPresentationData>
  save(groupId: string, id: string, version: number, draft: GroupPresentationDraft): Promise<GroupPresentation>
  delete(groupId: string, id: string, version: number): Promise<void>
  upload(groupId: string, userId: string, file: File, onProgress?: (percent: number) => void, signal?: AbortSignal): Promise<MaterialAttachment>
  removeFiles(paths: string[]): Promise<void>
  fileUrl(file: MaterialAttachment, download?: boolean): Promise<string>
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const mime: Record<string, string> = { pdf: 'application/pdf', ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }

export function emptyGroupPresentationDraft(subject = ''): GroupPresentationDraft {
  return { subject, title: '', lesson_date: materialToday(), description: '', links: [], attachments: [] }
}
export function validateGroupPresentationFile(file: File): { extension: string; mime: string } {
  validateMaterialFiles([file])
  const extension = file.name.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() || ''
  if (!Object.prototype.hasOwnProperty.call(mime, extension)) throw new Error('Додайте PDF, PowerPoint, Word або зображення. Для онлайн-перегляду презентації додайте PDF-копію.')
  return { extension, mime: mime[extension] }
}
export function validateGroupPresentationDraft(draft: GroupPresentationDraft): GroupPresentationDraft {
  const subject = draft.subject.trim(), title = draft.title.trim(), description = draft.description.trim()
  if (subject.length < 2 || subject.length > 180 || /[\u0000-\u001f\u007f]/.test(subject)) throw new Error('Вкажіть предмет від 2 до 180 символів.')
  if (title.length < 3 || title.length > 180 || /[\u0000-\u001f\u007f]/.test(title)) throw new Error('Назва презентації має містити від 3 до 180 символів.')
  if (!isMaterialDate(draft.lesson_date)) throw new Error('Вкажіть правильну дату заняття.')
  if (description.length > 5000) throw new Error('Опис має містити до 5000 символів.')
  const links = validateMaterialLinks(draft.links)
  if (links.length > 4) throw new Error('До презентації можна додати до 4 посилань.')
  if (draft.attachments.length > 4 || getMaterialAttachments(draft.attachments).length !== draft.attachments.length || draft.attachments.some(file => !Object.values(mime).includes(file.mime_type))) throw new Error('Додайте до 4 файлів у підтримуваному форматі, кожен до 50 МБ.')
  if (!links.length && !draft.attachments.length) throw new Error('Додайте файл презентації або посилання на неї.')
  return { ...draft, subject, title, description, links }
}
export function normalizeGroupPresentation(value: unknown, groupId: string): GroupPresentation | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || item.group_id !== groupId || typeof item.created_by !== 'string' || !Number.isSafeInteger(item.version)) return null
  return { id: item.id, group_id: groupId, created_by: item.created_by, author_name: typeof item.author_name === 'string' ? item.author_name : 'Учасник групи',
    subject: String(item.subject || ''), title: String(item.title || ''), lesson_date: String(item.lesson_date || ''), description: String(item.description || ''),
    attachments: getMaterialAttachments(item.attachments), links: getMaterialLinks(item.links), version: Number(item.version), created_at: String(item.created_at || ''), updated_at: String(item.updated_at || '') }
}
export function groupPresentationError(error: unknown): string {
  const value = error as { message?: string; code?: string }, message = value?.message || ''
  if (/GROUP_PRESENTATION_ACCESS|GROUP_PRESENTATION_FORBIDDEN/.test(message)) return 'Презентації доступні лише учасникам, які приєдналися до цієї навчальної групи.'
  if (/GROUP_PRESENTATION_CONFLICT/.test(message)) return 'Цю презентацію вже оновили. Ваші зміни залишилися у формі. Оновіть список і відкрийте актуальну версію.'
  if (/GROUP_PRESENTATION_QUOTA/.test(message)) return 'Досягнуто ліміту файлів автора: 1 ГБ або 200 файлів. Приберіть зайві вкладення або додайте посилання на Google Drive.'
  if (/GROUP_PRESENTATION_FILE/.test(message)) return 'Не вдалося підтвердити файл. Додайте його знову або прикріпіть посилання.'
  if (/GROUP_PRESENTATION_INVALID/.test(message)) return 'Перевірте предмет, назву, дату, файли та посилання.'
  if (['PGRST202', '42P01'].includes(value?.code || '')) return 'Презентації групи ще не підключені. Спробуйте пізніше.'
  if (error instanceof Error && /[А-Яа-яІіЇїЄєҐґ]/u.test(message)) return message
  return 'Не вдалося виконати дію. Перевірте з’єднання та спробуйте ще раз.'
}

/** Use the same browser-host download branches as the existing SheetJS export. */
export async function startGroupPresentationDownload(url: string, fileName: string): Promise<void> {
  const name = materialFileName(fileName)
  const host = globalThis as typeof globalThis & {
    chrome?: { downloads?: { download?: (options: { url: string; filename: string; saveAs: boolean }) => unknown } }
    saveAs?: (blob: Blob, name: string) => unknown
  }
  const browserNavigator = typeof navigator === 'undefined' ? undefined : navigator as Navigator & { msSaveBlob?: (blob: Blob, name: string) => unknown }
  if (typeof host.saveAs === 'function' || typeof browserNavigator?.msSaveBlob === 'function') {
    const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' })
    if (!response.ok) throw new Error('Не вдалося підготувати файл до завантаження. Спробуйте ще раз.')
    const blob = await response.blob()
    if (browserNavigator?.msSaveBlob) browserNavigator.msSaveBlob(blob, name)
    else host.saveAs!(blob, name)
    return
  }
  const downloads = host.chrome?.downloads
  if (typeof downloads?.download === 'function') {
    await downloads.download({ url, filename: name, saveAs: true })
    return
  }
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = name
  ;(document.querySelector('dialog[open]') || document.body).appendChild(anchor)
  anchor.click(); anchor.remove()
}

export const supabaseGroupPresentationRepository: GroupPresentationRepository = {
  mode: 'supabase',
  async list(groupId) {
    const { data, error } = await supabase.rpc('xelay_group_presentations', { p_group_id: groupId })
    if (error) throw error
    return { presentations: (Array.isArray(data?.presentations) ? data.presentations : []).map((row: unknown) => normalizeGroupPresentation(row, groupId)).filter((row: GroupPresentation | null): row is GroupPresentation => Boolean(row)), subjects: Array.isArray(data?.subjects) ? data.subjects.filter((item: unknown): item is string => typeof item === 'string') : [], can_moderate: data?.can_moderate === true }
  },
  async save(groupId, id, version, draft) {
    const clean = validateGroupPresentationDraft(draft)
    const { data, error } = await supabase.rpc('xelay_save_group_presentation', { p_group_id: groupId, p_id: id, p_version: version, p_draft: clean })
    if (error) throw error
    const item = normalizeGroupPresentation(data, groupId)
    if (!item) throw new Error('Не вдалося підтвердити збереження презентації. Спробуйте оновити список.')
    return item
  },
  async delete(groupId, id, version) { const { error } = await supabase.rpc('xelay_delete_group_presentation', { p_group_id: groupId, p_id: id, p_version: version }); if (error) throw error },
  async upload(groupId, userId, file, onProgress, signal) {
    const format = validateGroupPresentationFile(file)
    if (!uuid.test(groupId) || !uuid.test(userId)) throw new Error('Оновіть сторінку й перевірте вхід до своєї групи.')
    const path = `${groupId}/${userId}/${crypto.randomUUID()}.${format.extension}`
    const { data, error } = await supabase.auth.getSession()
    if (error || !data.session?.access_token || data.session.user.id !== userId) throw new Error('Ваш вхід змінився. Збережіть текст і ввійдіть повторно.')
    await uploadPresentationBytes(path, file, format.mime, data.session.access_token, onProgress, signal)
    return { path, file_name: materialFileName(file.name), mime_type: format.mime, file_size: file.size }
  },
  async removeFiles(paths) { for (const path of [...new Set(paths)].sort()) { const { error } = await supabase.storage.from(GROUP_PRESENTATION_BUCKET).remove([path]); if (error) throw error } },
  async fileUrl(file, download = false) {
    const clean = getMaterialAttachments([file])[0]
    if (!clean) throw new Error('Файл недоступний. Оновіть список.')
    const { data, error } = await supabase.storage.from(GROUP_PRESENTATION_BUCKET).createSignedUrl(clean.path, 60, download ? { download: clean.file_name } : undefined)
    if (error) throw error
    if (!data.signedUrl) throw new Error('Не вдалося відкрити файл.')
    return data.signedUrl
  },
}

function uploadPresentationBytes(storagePath: string, file: File, mimeType: string, accessToken: string, progress?: (percent: number) => void, signal?: AbortSignal): Promise<void> {
  const project = new URL(import.meta.env.VITE_SUPABASE_URL as string)
  const publicKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
  if (!['https:', 'http:'].includes(project.protocol) || project.pathname !== '/' || project.username || project.password || project.search || project.hash || !publicKey || !accessToken) return Promise.reject(new Error('Не вдалося визначити сховище файлів.'))
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Завантаження скасовано.', 'AbortError')); return }
    const request = new XMLHttpRequest()
    let settled = false
    const abort = () => { request.abort(); finish(new DOMException('Завантаження скасовано.', 'AbortError')) }
    const finish = (error?: Error) => { if (settled) return; settled = true; signal?.removeEventListener('abort', abort); request.onload = request.onerror = request.ontimeout = request.onabort = null; request.upload.onprogress = null; if (error) reject(error); else { progress?.(100); resolve() } }
    request.open('POST', new URL(`/storage/v1/object/${GROUP_PRESENTATION_BUCKET}/${storagePath}`, project).href)
    request.withCredentials = false; request.timeout = 15 * 60 * 1000
    request.setRequestHeader('Authorization', `Bearer ${accessToken}`); request.setRequestHeader('apikey', publicKey); request.setRequestHeader('x-upsert', 'false')
    request.upload.onprogress = event => { if (event.lengthComputable) progress?.(Math.min(99, Math.max(0, Math.floor(event.loaded / event.total * 100)))) }
    request.onload = () => {
      let body: { Key?: string; message?: string } = {}; try { body = JSON.parse(request.responseText) } catch { /* Failed replies remain failures. */ }
      if (request.status >= 200 && request.status < 300 && body.Key === `${GROUP_PRESENTATION_BUCKET}/${storagePath}`) finish()
      else if (/GROUP_PRESENTATION_QUOTA/.test(body.message || '')) finish(new Error('GROUP_PRESENTATION_QUOTA'))
      else finish(new Error(request.status === 413 ? 'Файл завеликий. Максимум — 50 МБ. Завантажте презентацію в Google Drive та додайте посилання.' : 'Не вдалося завантажити файл. Перевірте з’єднання та повторіть спробу.'))
    }
    request.onerror = request.ontimeout = () => finish(new Error('Не вдалося завантажити файл. Перевірте з’єднання та повторіть спробу.'))
    request.onabort = () => finish(new DOMException('Завантаження скасовано.', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    const form = new FormData(); form.append('cacheControl', '3600'); form.append('', new Blob([file], { type: mimeType }), file.name)
    progress?.(0); try { request.send(form) } catch { finish(new Error('Не вдалося почати завантаження файлу.')) }
  })
}

export const LOCAL_GROUP_PRESENTATION_IDS = { group: '00000000-0000-4000-8000-000000000011', author: '00000000-0000-4000-8000-000000000002', classmate: '00000000-0000-4000-8000-000000000005', teacher: '00000000-0000-4000-8000-000000000001', head: '00000000-0000-4000-8000-000000000003' }
export type LocalGroupPresentationRole = 'author' | 'classmate' | 'teacher' | 'head'
const localFiles = new Map<string, { view: string; download: string }>()
let localPresentations: GroupPresentation[] = []
export function resetLocalGroupPresentations(): void {
  for (const urls of localFiles.values()) { URL.revokeObjectURL(urls.view); URL.revokeObjectURL(urls.download) }
  localFiles.clear(); localPresentations = []
}
export function seedLocalGroupPresentations(): void {
  if (localPresentations.length) return
  const group = LOCAL_GROUP_PRESENTATION_IDS.group, author = LOCAL_GROUP_PRESENTATION_IDS.author
  const path = `${group}/${author}/00000000-0000-4000-8000-000000000101.pdf`
  const stream = 'BT /F1 28 Tf 65 740 Td (Market equilibrium) Tj 0 -50 Td /F1 16 Tf (A presentation shared with classmates) Tj 0 -35 Td (Demand = Supply) Tj 0 -35 Td (Xelay local example - no real student data) Tj ET'
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`]
  let pdf = '%PDF-1.4\n'; const offsets = [0]
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n` })
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const file = new File([pdf], 'Ринкова рівновага.pdf', { type: 'application/pdf' })
  localFiles.set(path, { view: URL.createObjectURL(file), download: URL.createObjectURL(new Blob([file], { type: 'application/octet-stream' })) })
  const now = new Date().toISOString()
  localPresentations = [{ id: '00000000-0000-4000-8000-000000000102', group_id: group, created_by: author, author_name: 'Марія Прикладенко', subject: 'Економічна теорія', title: 'Ринкова рівновага: коротко й по суті', lesson_date: materialToday(), description: 'Презентація з нашого сьогоднішнього заняття. Залишаю тут, щоб усі могли повторити тему.', links: [], attachments: [{ path, file_name: file.name, mime_type: file.type, file_size: file.size }], version: 1, created_at: now, updated_at: now }]
}
export function createLocalGroupPresentationRepository(role: LocalGroupPresentationRole): GroupPresentationRepository {
  const user = LOCAL_GROUP_PRESENTATION_IDS[role], group = LOCAL_GROUP_PRESENTATION_IDS.group
  const access = (id = group) => { if (id !== group || role === 'teacher') throw new Error('GROUP_PRESENTATION_ACCESS') }
  return {
    mode: 'local',
    async list(id) { access(id); return { presentations: structuredClone(localPresentations), subjects: ['Економічна теорія', 'Вища математика', 'Іноземна мова'], can_moderate: role === 'head' } },
    async save(groupId, id, version, draft) {
      access(groupId); const clean = validateGroupPresentationDraft(draft), previous = localPresentations.find(item => item.id === id)
      if (previous && previous.created_by !== user) throw new Error('GROUP_PRESENTATION_FORBIDDEN')
      if (previous && version === 0 && previous.version === 1 && JSON.stringify({ subject: previous.subject, title: previous.title, lesson_date: previous.lesson_date, description: previous.description, links: previous.links, attachments: previous.attachments }) === JSON.stringify(clean)) return structuredClone(previous)
      if ((previous?.version || 0) !== version) throw new Error('GROUP_PRESENTATION_CONFLICT')
      if (clean.attachments.some(file => !file.path.startsWith(`${group}/${user}/`) && !previous?.attachments.some(existing => existing.path === file.path))) throw new Error('GROUP_PRESENTATION_FILE')
      const now = new Date().toISOString(), item: GroupPresentation = { ...clean, id, group_id: groupId, created_by: user, author_name: role === 'author' ? 'Марія Прикладенко' : role === 'head' ? 'Андрій Прикладенко' : 'Назар Прикладенко', version: version + 1, created_at: previous?.created_at || now, updated_at: now }
      localPresentations = [...localPresentations.filter(row => row.id !== id), item]; return structuredClone(item)
    },
    async delete(groupId, id, version) { access(groupId); const item = localPresentations.find(row => row.id === id); if (!item || (item.created_by !== user && role !== 'head')) throw new Error('GROUP_PRESENTATION_FORBIDDEN'); if (item.version !== version) throw new Error('GROUP_PRESENTATION_CONFLICT'); localPresentations = localPresentations.filter(row => row.id !== id) },
    async upload(groupId, userId, file, onProgress, signal) {
      access(groupId); if (userId !== user) throw new Error('GROUP_PRESENTATION_FORBIDDEN')
      const format = validateGroupPresentationFile(file), path = `${group}/${user}/${crypto.randomUUID()}.${format.extension}`
      onProgress?.(0); for (const percent of [25, 55, 80, 100]) { if (signal?.aborted) throw new DOMException('Завантаження скасовано.', 'AbortError'); await new Promise(resolve => setTimeout(resolve, 80)); onProgress?.(percent) }
      localFiles.set(path, { view: URL.createObjectURL(file), download: URL.createObjectURL(new Blob([file], { type: 'application/octet-stream' })) }); return { path, file_name: materialFileName(file.name), mime_type: format.mime, file_size: file.size }
    },
    async removeFiles(paths) { access(); for (const path of paths) if (!localPresentations.some(item => item.attachments.some(file => file.path === path)) && (path.startsWith(`${group}/${user}/`) || role === 'head')) { const urls = localFiles.get(path); if (urls) { URL.revokeObjectURL(urls.view); URL.revokeObjectURL(urls.download) }; localFiles.delete(path) } },
    async fileUrl(file, download = false) { access(); if (!localPresentations.some(item => item.attachments.some(attachment => attachment.path === file.path))) throw new Error('GROUP_PRESENTATION_FILE'); const urls = localFiles.get(file.path); if (!urls) throw new Error('Файл доступний лише до перезавантаження локального прикладу. Додайте власний файл.'); return download ? urls.download : urls.view },
  }
}

export const GROUP_PRESENTATION_MAX_FILE_BYTES = MAX_MATERIAL_FILE_SIZE
