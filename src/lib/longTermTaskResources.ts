import { supabase } from './supabase'
import {
  HOMEWORK_FILE_ACCEPT, MAX_HOMEWORK_FILE_BYTES, MAX_HOMEWORK_FILES, MAX_HOMEWORK_LINKS,
  formatHomeworkFileSize, type HomeworkAttachment,
} from './homeworkResources'
import { getSeminarAttachments, getSeminarLinks, normalizeSeminarLinks, validateSeminarFile } from './seminarResources'

export type LongTermTaskAttachment = HomeworkAttachment
export const LONG_TERM_FILES_BUCKET = 'xelay-long-term-task-files'
export const LONG_TERM_FILE_ACCEPT = HOMEWORK_FILE_ACCEPT
export const MAX_LONG_TERM_FILES = MAX_HOMEWORK_FILES
export const MAX_LONG_TERM_LINKS = MAX_HOMEWORK_LINKS
export const MAX_LONG_TERM_FILE_BYTES = MAX_HOMEWORK_FILE_BYTES
export const formatLongTermFileSize = formatHomeworkFileSize

const UUID_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_PATTERN = new RegExp(`^${UUID_PART}$`)
const STORAGE_PATTERN = new RegExp(`^${UUID_PART}/${UUID_PART}/${UUID_PART}-[A-Za-z0-9][A-Za-z0-9._-]{0,179}$`)
const SAFE_FILE_NAME = /^[^/\\\u0000-\u001f\u007f]{1,255}$/
const SCHEMA_ERROR_CODES = new Set(['PGRST205', 'PGRST202', 'PGRST204', '42P01', '42703', '42883'])
const FILE_MIME_TYPES: Record<string, string> = {
  pdf: 'application/pdf', doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  png: 'image/png', webp: 'image/webp', zip: 'application/zip',
}

const extension = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()
const safePath = (path: string) => path.length <= 512 && STORAGE_PATTERN.test(path)
  && Object.prototype.hasOwnProperty.call(FILE_MIME_TYPES, extension(path))
const isSchemaError = (error: unknown) => SCHEMA_ERROR_CODES.has(String((error as { code?: unknown } | null)?.code || ''))

type CleanupAccount = { userId: string; version: number }
const PENDING_STORAGE_PREFIX = 'xelay:long-term-task-file-cleanup:v1:'
const pendingInMemory = new Map<string, Set<string>>()
const uploadAccounts = new Map<string, CleanupAccount>()
let activeUserId: string | null = null
let accountVersion = 0

function observeAccount(userId: string | null) {
  if (activeUserId !== userId) { activeUserId = userId; accountVersion += 1 }
}

// This callback only observes identity. Network work stays outside Supabase's
// auth callback lock, and an A -> B -> A switch invalidates old operations too.
const accountObserver = supabase.auth.onAuthStateChange((_event, session) => {
  observeAccount(session?.user.id ?? null)
})
if (import.meta.hot) import.meta.hot.dispose(() => accountObserver.data.subscription.unsubscribe())

async function cleanupAccount(): Promise<CleanupAccount | null> {
  const previousVersion = accountVersion
  try {
    const { data, error } = await supabase.auth.getSession()
    if (!error) {
      const userId = data.session?.user.id ?? null
      if (accountVersion !== previousVersion && activeUserId !== userId) return null
      observeAccount(userId)
    }
  } catch { /* A known signed-in account can retain cleanup while offline. */ }
  return activeUserId && UUID_PATTERN.test(activeUserId)
    ? { userId: activeUserId, version: accountVersion } : null
}

const sameAccount = (account: CleanupAccount) => activeUserId === account.userId && accountVersion === account.version
const ownedPath = (path: string, userId: string) => safePath(path) && path.split('/')[1] === userId

function pendingPaths(userId: string): Set<string> {
  let pending = pendingInMemory.get(userId)
  if (!pending) { pending = new Set<string>(); pendingInMemory.set(userId, pending) }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(`${PENDING_STORAGE_PREFIX}${userId}`) ?? '[]')
    if (Array.isArray(stored)) for (const path of stored) {
      if (typeof path === 'string' && ownedPath(path, userId)) pending.add(path)
    }
  } catch { /* Storage can be disabled; the in-memory set remains available. */ }
  return pending
}

function persistPending(userId: string, pending: Set<string>) {
  pendingInMemory.set(userId, pending)
  try {
    const key = `${PENDING_STORAGE_PREFIX}${userId}`
    if (pending.size) localStorage.setItem(key, JSON.stringify([...pending].sort()))
    else localStorage.removeItem(key)
  } catch { /* Keep pending paths in memory when browser persistence is full/unavailable. */ }
}

function rememberPending(userId: string, paths: string[]) {
  const pending = pendingPaths(userId)
  // Only an uploader's own uncertain paths need a local receipt. Detached
  // uploads belonging to another editor already have a durable server receipt.
  paths.filter((path) => ownedPath(path, userId)).forEach((path) => pending.add(path))
  persistPending(userId, pending)
}

function forgetPending(userId: string, paths: Iterable<string>) {
  const pending = pendingPaths(userId)
  for (const path of paths) {
    pending.delete(path)
    if (uploadAccounts.get(path)?.userId === userId) uploadAccounts.delete(path)
  }
  persistPending(userId, pending)
}

async function resolvedPaths(account: CleanupAccount, requested: string[]): Promise<Set<string>> {
  const resolved = new Set<string>()
  for (const groupId of new Set(requested.map((path) => path.split('/')[0]))) {
    if (!sameAccount(account)) return resolved
    try {
      const attached = await supabase.from('study_group_long_term_tasks')
        .select('resource_attachments').eq('group_id', groupId)
      if (!sameAccount(account)) return resolved
      if (!attached.error) for (const task of attached.data ?? []) {
        for (const file of getLongTermAttachments(task.resource_attachments)) {
          if (requested.includes(file.storage_path)) resolved.add(file.storage_path)
        }
      }
    } catch { /* An unavailable read is not evidence that a file can be deleted. */ }
  }
  for (let offset = 0; offset < requested.length; offset += 50) {
    if (!sameAccount(account)) return resolved
    try {
      const completed = await supabase.from('study_group_long_term_task_file_cleanup')
        .select('storage_path').in('storage_path', requested.slice(offset, offset + 50)).not('completed_at', 'is', null)
      if (!sameAccount(account)) return resolved
      if (!completed.error) for (const item of completed.data ?? []) {
        if (typeof item.storage_path === 'string' && requested.includes(item.storage_path)) resolved.add(item.storage_path)
      }
    } catch { /* An uncertain ACK remains pending until a later confirmed read. */ }
  }
  if (sameAccount(account)) forgetPending(account.userId, resolved)
  return resolved
}

export const getLongTermLinks = (value: unknown): string[] => getSeminarLinks(value)
export const getLongTermAttachments = (value: unknown): LongTermTaskAttachment[] => getSeminarAttachments(value)

export function validateLongTermResources(links: string[], files: File[], attachments: LongTermTaskAttachment[]) {
  if (files.length + attachments.length > MAX_LONG_TERM_FILES) {
    throw new Error('До довгострокового завдання можна додати щонайбільше 10 файлів.')
  }
  const validAttachments = getLongTermAttachments(attachments)
  if (validAttachments.length !== attachments.length) {
    throw new Error('Збережений файл має некоректні дані. Оновіть завдання й повторіть спробу.')
  }
  files.forEach(validateSeminarFile)
  try {
    return { links: normalizeSeminarLinks(links), attachments: validAttachments }
  } catch (error) {
    if (error instanceof Error) throw new Error(error.message.replace('завдання семінару', 'довгострокового завдання'))
    throw error
  }
}

function safeFilename(name: string) {
  const suffix = extension(name)
  const stem = name.slice(0, -(suffix.length + 1)).normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|-+$/g, '').slice(0, 150) || 'file'
  return `${stem}.${suffix}`
}

export async function uploadLongTermTaskFiles(
  groupId: string, userId: string, files: File[], onProgress?: (completed: number, total: number) => void,
): Promise<LongTermTaskAttachment[]> {
  validateLongTermResources([], files, [])
  if (!files.length) return []
  if (!UUID_PATTERN.test(groupId) || !UUID_PATTERN.test(userId)) {
    throw new Error('Не вдалося визначити групу або акаунт для завантаження файлів.')
  }
  const account = await cleanupAccount()
  if (!account || account.userId !== userId) throw new Error('Акаунт змінився. Оновіть сторінку й повторіть спробу.')
  const uploaded: LongTermTaskAttachment[] = []
  const attemptedPaths: string[] = []
  try {
    for (const file of files) {
      if (!sameAccount(account)) throw new Error('Account changed during upload')
      const storage_path = `${groupId}/${userId}/${crypto.randomUUID()}-${safeFilename(file.name)}`
      const mime_type = FILE_MIME_TYPES[extension(file.name)]
      attemptedPaths.push(storage_path)
      uploadAccounts.set(storage_path, account)
      const { error } = await supabase.storage.from(LONG_TERM_FILES_BUCKET)
        .upload(storage_path, file, { contentType: mime_type, upsert: false })
      if (error) throw error
      if (!sameAccount(account)) throw new Error('Account changed during upload')
      uploaded.push({ storage_path, file_name: file.name, mime_type, file_size: file.size })
      onProgress?.(uploaded.length, files.length)
    }
    return uploaded
  } catch {
    // An upload can finish even when its response is lost. Retirement claims
    // serialize with upload/save, and the server refuses to retire attached files.
    // Keep the original uploader's receipt even if the user switched accounts
    // while the request was in flight. It is retried only by that account.
    const removed = await removeFilesForAccount(attemptedPaths, account)
    throw new Error(removed
      ? 'Не вдалося завантажити файли. Перевірте з’єднання та доступ до групи й повторіть спробу.'
      : 'Не вдалося завантажити файли. Очищення тимчасових файлів буде повторено після відновлення з’єднання.')
  }
}

export async function removeLongTermTaskFiles(paths: string[]): Promise<boolean> {
  const requested = [...new Set(paths)].sort()
  if (!requested.length) return true
  if (requested.some((path) => !safePath(path))) return false
  // A form may unmount after logout. Persist genuine paths minted by this
  // uploader before consulting the current session; never infer another
  // account's identity from an arbitrary caller-provided path alone.
  for (const path of requested) {
    const uploader = uploadAccounts.get(path)
    if (uploader) rememberPending(uploader.userId, [path])
  }
  const account = await cleanupAccount()
  if (!account || requested.some((path) => {
    const uploader = uploadAccounts.get(path)
    return uploader && uploader.userId !== account.userId
  })) return false
  return removeFilesForAccount(requested, account)
}

async function removeFilesForAccount(paths: string[], account: CleanupAccount): Promise<boolean> {
  const requested = [...new Set(paths)].sort()
  if (!requested.length) return true
  if (requested.some((path) => !safePath(path))) return false
  rememberPending(account.userId, requested)
  if (!sameAccount(account)) return false
  const complete = await resolvedPaths(account, requested)
  if (!sameAccount(account)) return false
  const outstanding = requested.filter((path) => !complete.has(path))
  for (let offset = 0; offset < outstanding.length; offset += 50) {
    if (!sameAccount(account)) return false
    const batch = outstanding.slice(offset, offset + 50)
    try {
      const claim = await supabase.rpc('xelay_claim_long_term_task_file_cleanup', { p_storage_paths: batch })
      if (!sameAccount(account)) return false
      if (claim.error || !Array.isArray(claim.data)) continue
      const claims = new Map<string, string>()
      for (const item of claim.data) {
        if (typeof item?.storage_path !== 'string' || !batch.includes(item.storage_path)
          || typeof item.claim_token !== 'string' || !UUID_PATTERN.test(item.claim_token)) continue
        claims.set(item.storage_path, item.claim_token)
      }
      for (const [path, token] of claims) {
        if (!sameAccount(account)) return false
        try {
          const removed = await supabase.storage.from(LONG_TERM_FILES_BUCKET).remove([path])
          if (!sameAccount(account)) return false
          if (removed.error) continue
          // ACK checks actual object absence, including a previous removal whose
          // response was lost. Unclaimed paths never reach the Storage API.
          const acknowledged = await supabase.rpc('xelay_ack_long_term_task_file_cleanup', {
            p_storage_path: path, p_claim_token: token,
          })
          if (!sameAccount(account)) return false
          if (!acknowledged.error) { complete.add(path); forgetPending(account.userId, [path]) }
        } catch { /* Keep the durable uploader receipt for a later retry. */ }
      }
    } catch { /* A missing claim response cannot authorize physical deletion. */ }
  }
  if (!sameAccount(account)) return false
  // Omitted claims can mean an earlier ACK already completed, or an uncertain
  // save actually attached the file. Confirm either before discarding a receipt.
  const unresolved = requested.filter((path) => !complete.has(path))
  if (unresolved.length) for (const path of await resolvedPaths(account, unresolved)) complete.add(path)
  return sameAccount(account) && complete.size === requested.length
}

const cleanupInFlight = new Map<string, Promise<boolean>>()
export async function cleanupPendingLongTermTaskFiles(groupId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(groupId)) return false
  const account = await cleanupAccount()
  if (!account) return false
  const key = `${account.userId}:${account.version}:${groupId}`
  const current = cleanupInFlight.get(key)
  if (current) return current
  const pending = (async () => {
    try {
      const paths = [...pendingPaths(account.userId)].filter((path) => path.startsWith(`${groupId}/`))
      let serverAvailable = true
      try {
        const { data, error } = await supabase.from('study_group_long_term_task_file_cleanup')
          .select('storage_path').eq('group_id', groupId).is('completed_at', null).order('created_at').limit(50)
        if (!sameAccount(account)) return false
        if (error) {
          serverAvailable = false
          if (!isSchemaError(error)) console.warn('[Xelay] Long-term task file cleanup could not finish')
        } else for (const item of data ?? []) {
          if (typeof item.storage_path !== 'string' || !item.storage_path.startsWith(`${groupId}/`) || !safePath(item.storage_path)) return false
          paths.push(item.storage_path)
        }
      } catch { serverAvailable = false }
      if (!sameAccount(account)) return false
      const removed = paths.length ? await removeFilesForAccount(paths, account) : true
      return serverAvailable && removed
    } finally { cleanupInFlight.delete(key) }
  })()
  cleanupInFlight.set(key, pending)
  return pending
}

export async function getLongTermTaskFileUrl(path: string, fileName: string): Promise<string> {
  if (!safePath(path) || !SAFE_FILE_NAME.test(fileName)) {
    throw new Error('Файл має некоректні дані. Зверніться до старости.')
  }
  const { data, error } = await supabase.storage.from(LONG_TERM_FILES_BUCKET)
    .createSignedUrl(path, 60, { download: fileName })
  if (error || !data?.signedUrl) throw new Error('Не вдалося завантажити файл. Перевірте з’єднання й доступ до групи та повторіть спробу.')
  return data.signedUrl
}
