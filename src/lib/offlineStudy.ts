/** Durable, read-only study downloads. Never persist Supabase sessions or raw API rows here. */
import { isStudyGroupListed } from './studyGroupVisibility'

export const OFFLINE_STUDY_DAYS = 14
export const OFFLINE_STUDY_TTL_MS = OFFLINE_STUDY_DAYS * 86_400_000
export const OFFLINE_STUDY_CHANGED = 'xelay:offline-study-changed'
const DB_NAME = 'xelay-offline-study-v1'
const MAX_GROUPS = 10
const MAX_GROUP_BYTES = 3 * 1024 * 1024
const OWNER_KEY = 'owner'
// An independent durable deny marker survives a failed IndexedDB purge and a cold reload.
// Unique keys prevent a login in one tab from deleting a newer logout from another tab.
const TOMBSTONE_PREFIX = 'xelay-offline-study-blocked:'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type OfflineOwner = { id: string; displayName: string; sessionId: string }
export type OfflineResourceLink = { label: string; url: string }
export type OfflineLesson = { id: string; date: string; subject: string; startsAt: string; endsAt: string; lessonType: string; teacherName?: string; location?: string }
export type OfflineHomework = { id: string; date: string; scheduleItemId?: string; subject: string; title?: string; body: string; links?: OfflineResourceLink[]; fileNames?: string[] }
export type OfflineAssignment = { id: string; date: string | null; scheduleItemId?: string; subject: string; title: string; body: string; teacherName?: string; dueAt?: string | null; links?: OfflineResourceLink[]; fileNames?: string[] }
export type OfflineTimetablePhoto = { dataUrl: string; updatedAt?: string }
export type OfflineGroupSnapshotInput = { groupId: string; groupName: string; rangeStart: string; rangeEnd: string; lessons: OfflineLesson[]; homework: OfflineHomework[]; assignments: OfflineAssignment[]; timetablePhoto?: OfflineTimetablePhoto }
export type OfflineGroupSnapshot = OfflineGroupSnapshotInput & { schemaVersion: 1; ownerId: string; sessionId: string; savedAt: string; expiresAt: string }
export type OfflineGroupSummary = Pick<OfflineGroupSnapshot, 'groupId' | 'groupName' | 'rangeStart' | 'rangeEnd' | 'savedAt' | 'expiresAt'> & { lessonCount: number; homeworkCount: number; assignmentCount: number }
type StoredSnapshot = OfflineGroupSnapshot & { key: string }
let intentVersion = 0
let intendedOwner: string | null | undefined
let databasePromise: Promise<IDBDatabase> | null = null
let channel: BroadcastChannel | null = null
let memoryBlocked = false

function tombstones(): string[] | null {
  try {
    const keys: string[] = []
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index)
      if (key?.startsWith(TOMBSTONE_PREFIX)) keys.push(key)
    }
    return keys.sort()
  } catch { return null }
}
function blocked(): boolean {
  const keys = tombstones()
  return memoryBlocked || keys === null || keys.length > 0
}
function sameTombstones(expected: string[]): boolean {
  const actual = tombstones()
  return actual !== null && actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
function createTombstone(): boolean {
  try {
    const key = `${TOMBSTONE_PREFIX}${Date.now()}:${crypto.randomUUID()}`
    localStorage.setItem(key, '1')
    return localStorage.getItem(key) === '1'
  } catch { return false }
}
function changed(deny = false) {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OFFLINE_STUDY_CHANGED))
  try { channel?.postMessage({ type: deny ? 'blocked' : 'changed' }) } catch { /* another tab may have closed */ }
}

if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
  channel = new BroadcastChannel('xelay-offline-study-v1')
  channel.onmessage = (event) => {
    if (event.data?.type === 'blocked') { ++intentVersion; intendedOwner = null; memoryBlocked = true }
    window.dispatchEvent(new Event(OFFLINE_STUDY_CHANGED))
  }
}
if (typeof window !== 'undefined') window.addEventListener('storage', (event) => {
  if (event.key !== null && !event.key.startsWith(TOMBSTONE_PREFIX)) return
  ++intentVersion
  if (event.newValue !== null || event.key === null) { intendedOwner = null; memoryBlocked = true }
  window.dispatchEvent(new Event(OFFLINE_STUDY_CHANGED))
})

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('OFFLINE_STORAGE_UNAVAILABLE'))
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('meta')) request.result.createObjectStore('meta')
      if (!request.result.objectStoreNames.contains('groups')) request.result.createObjectStore('groups', { keyPath: 'key' })
    }
    request.onsuccess = () => {
      const database = request.result
      database.onversionchange = () => { database.close(); databasePromise = null }
      resolve(database)
    }
    request.onerror = () => { databasePromise = null; reject(new Error('OFFLINE_STORAGE_UNAVAILABLE')) }
    request.onblocked = () => { databasePromise = null; reject(new Error('OFFLINE_STORAGE_UNAVAILABLE')) }
  })
  return databasePromise
}

async function transaction<T>(mode: IDBTransactionMode, action: (tx: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['meta', 'groups'], mode)
    let value: T
    let customError: Error | null = null
    tx.oncomplete = () => resolve(value)
    tx.onabort = () => reject(customError || new Error('OFFLINE_STORAGE_UNAVAILABLE'))
    tx.onerror = () => { /* onabort rejects with the original safe error */ }
    const fail = (error: Error) => { customError = error; tx.abort() }
    try { action(tx, (result) => { value = result }, fail) } catch (error) { fail(error instanceof Error ? error : new Error('OFFLINE_STORAGE_UNAVAILABLE')) }
  })
}

function ownerId(value: string): string {
  if (!UUID.test(value)) throw new Error('OFFLINE_OWNER_INVALID')
  return value.toLowerCase()
}
function receipt(value: unknown): OfflineOwner | null {
  const v = value as OfflineOwner | null
  return v && UUID.test(v.id) && typeof v.sessionId === 'string' && v.sessionId.length >= 16 && typeof v.displayName === 'string'
    ? { id: v.id, displayName: v.displayName.slice(0, 100), sessionId: v.sessionId } : null
}
function sameOwner(value: unknown, id: string, sessionId?: string): boolean {
  const owner = receipt(value)
  return !!owner && owner.id === id && (!sessionId || owner.sessionId === sessionId)
}

/** Call only after normal authenticated identity confirmation, never from a cached profile. */
export async function establishOfflineOwner(userId: string, displayName = ''): Promise<OfflineOwner> {
  const id = ownerId(userId)
  if (intendedOwner !== id) ++intentVersion
  intendedOwner = id
  const version = intentVersion
  const denyKeys = tombstones()
  if (denyKeys === null) { memoryBlocked = true; throw new Error('OFFLINE_STORAGE_UNAVAILABLE') }
  const wasBlocked = memoryBlocked || denyKeys.length > 0
  const name = typeof displayName === 'string' ? displayName.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) : ''
  const owner = await transaction<OfflineOwner>('readwrite', (tx, done, fail) => {
    const meta = tx.objectStore('meta')
    const req = meta.get(OWNER_KEY)
    req.onsuccess = () => {
      if (version !== intentVersion || intendedOwner !== id || !sameTombstones(denyKeys)) return fail(new Error('OFFLINE_OWNER_CHANGED'))
      const current = receipt(req.result)
      const next: OfflineOwner = current?.id === id && !wasBlocked ? { ...current, displayName: name || current.displayName } : { id, displayName: name || (current?.id === id ? current.displayName : ''), sessionId: crypto.randomUUID() }
      if (wasBlocked || !current || current.id !== id) tx.objectStore('groups').clear()
      meta.put(next, OWNER_KEY)
      done(next)
    }
  })
  if (version !== intentVersion || intendedOwner !== id || !sameTombstones(denyKeys)) throw new Error('OFFLINE_OWNER_CHANGED')
  try { for (const key of denyKeys) localStorage.removeItem(key) }
  catch { memoryBlocked = true; throw new Error('OFFLINE_STORAGE_UNAVAILABLE') }
  const remaining = tombstones()
  if (remaining === null || remaining.length > 0 || version !== intentVersion) { memoryBlocked = true; throw new Error('OFFLINE_OWNER_CHANGED') }
  memoryBlocked = false
  changed()
  return owner
}

export async function getOfflineOwner(): Promise<OfflineOwner | null> {
  if (blocked()) return null
  const version = intentVersion
  const owner = await transaction<OfflineOwner | null>('readonly', (tx, done) => {
    const req = tx.objectStore('meta').get(OWNER_KEY)
    req.onsuccess = () => {
      const current = receipt(req.result)
      done(intendedOwner !== undefined && current?.id !== intendedOwner ? null : current)
    }
  })
  return version === intentVersion && !blocked() ? owner : null
}

/** Invalidate pending writes synchronously, then purge all downloaded account data. */
export async function clearOfflineStudy(): Promise<void> {
  ++intentVersion
  intendedOwner = null
  memoryBlocked = true
  const durableDeny = createTombstone()
  changed(true)
  try {
    await transaction<void>('readwrite', (tx, done) => {
      tx.objectStore('meta').clear()
      tx.objectStore('groups').clear()
      done(undefined)
    })
  } catch {
    // A persisted deny marker keeps old data inaccessible even if the physical purge failed.
    // If neither storage mechanism worked, the caller must not claim that deletion was confirmed.
    if (!durableDeny) throw new Error('OFFLINE_CLEAR_NOT_CONFIRMED')
    throw new Error('OFFLINE_PURGE_PENDING')
  } finally { changed(true) }
}

function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error('OFFLINE_SNAPSHOT_INVALID')
  return value
}
function optionalText(value: unknown, max: number): string | undefined { return value == null ? undefined : text(value, max) }
function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
function dateInRange(value: unknown, start: string, end: string): string {
  const result = text(value, 10, true)
  if (!validDate(result) || result < start || result > end) throw new Error('OFFLINE_SNAPSHOT_INVALID')
  return result
}
function links(value: unknown): OfflineResourceLink[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 20) throw new Error('OFFLINE_SNAPSHOT_INVALID')
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const raw = item as OfflineResourceLink
    if (typeof raw.url !== 'string' || raw.url.length > 2000) return []
    try {
      const url = new URL(raw.url)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || /[?&](?:access_token|refresh_token|token|signature|authorization|jwt)=/i.test(url.search)) return []
      return [{ label: text(raw.label || 'Посилання', 240), url: url.toString() }]
    } catch { return [] }
  })
}
function fileNames(value: unknown): string[] {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 30) throw new Error('OFFLINE_SNAPSHOT_INVALID')
  return value.map(name => text(name, 240, true))
}
function timetablePhoto(value: unknown): OfflineTimetablePhoto | undefined {
  if (value == null) return undefined
  const photo = value as OfflineTimetablePhoto
  const dataUrl = text(photo.dataUrl, 2 * 1024 * 1024, true)
  if (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) throw new Error('OFFLINE_SNAPSHOT_INVALID')
  const updatedAt = optionalText(photo.updatedAt, 64)
  if (updatedAt && !Number.isFinite(Date.parse(updatedAt))) throw new Error('OFFLINE_SNAPSHOT_INVALID')
  return { dataUrl, updatedAt }
}

/** Strict field whitelist: incoming API objects must be converted before being stored. */
function normalizeSnapshot(input: OfflineGroupSnapshotInput): OfflineGroupSnapshotInput {
  const groupId = text(input.groupId, 160, true)
  const groupName = text(input.groupName, 240, true)
  const rangeStart = text(input.rangeStart, 10, true)
  const rangeEnd = text(input.rangeEnd, 10, true)
  const duration = Date.parse(`${rangeEnd}T00:00:00Z`) - Date.parse(`${rangeStart}T00:00:00Z`)
  if (!validDate(rangeStart) || !validDate(rangeEnd) || duration < 0 || duration >= OFFLINE_STUDY_DAYS * 86_400_000) throw new Error('OFFLINE_SNAPSHOT_INVALID')
  if (!Array.isArray(input.lessons) || input.lessons.length > 336 || !Array.isArray(input.homework) || input.homework.length > 336 || !Array.isArray(input.assignments) || input.assignments.length > 336) throw new Error('OFFLINE_SNAPSHOT_INVALID')
  const lessons = input.lessons.map((item): OfflineLesson => {
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.startsAt) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item.endsAt)) throw new Error('OFFLINE_SNAPSHOT_INVALID')
    return { id: text(item.id, 160, true), date: dateInRange(item.date, rangeStart, rangeEnd), subject: text(item.subject, 500, true), startsAt: item.startsAt, endsAt: item.endsAt, lessonType: text(item.lessonType, 100, true), teacherName: optionalText(item.teacherName, 240), location: optionalText(item.location, 1000) }
  })
  const homework = input.homework.map((item): OfflineHomework => ({ id: text(item.id, 160, true), date: dateInRange(item.date, rangeStart, rangeEnd), scheduleItemId: optionalText(item.scheduleItemId, 160), subject: text(item.subject, 500, true), title: optionalText(item.title, 500), body: text(item.body, 65_536), links: links(item.links), fileNames: fileNames(item.fileNames) }))
  const assignments = input.assignments.map((item): OfflineAssignment => {
    const dueAt = item.dueAt == null ? null : text(item.dueAt, 64, true)
    if (dueAt && !Number.isFinite(Date.parse(dueAt))) throw new Error('OFFLINE_SNAPSHOT_INVALID')
    return { id: text(item.id, 160, true), date: item.date == null ? null : dateInRange(item.date, rangeStart, rangeEnd), scheduleItemId: optionalText(item.scheduleItemId, 160), subject: text(item.subject, 500, true), title: text(item.title, 500, true), body: text(item.body, 65_536), teacherName: optionalText(item.teacherName, 240), dueAt, links: links(item.links), fileNames: fileNames(item.fileNames) }
  })
  const safe = { groupId, groupName, rangeStart, rangeEnd, lessons, homework, assignments, timetablePhoto: timetablePhoto(input.timetablePhoto) }
  if (new TextEncoder().encode(JSON.stringify(safe)).length > MAX_GROUP_BYTES) throw new Error('OFFLINE_SNAPSHOT_TOO_LARGE')
  return safe
}

function currentSnapshot(value: unknown, owner: OfflineOwner): OfflineGroupSnapshot | null {
  const v = value as OfflineGroupSnapshot | null
  if (!v || v.schemaVersion !== 1 || v.ownerId !== owner.id || v.sessionId !== owner.sessionId || !Number.isFinite(Date.parse(v.savedAt)) || !Number.isFinite(Date.parse(v.expiresAt)) || Date.parse(v.expiresAt) <= Date.now() || Date.parse(v.savedAt) > Date.now() + 300_000 || Date.parse(v.expiresAt) < Date.parse(v.savedAt) || Date.parse(v.expiresAt) - Date.parse(v.savedAt) > OFFLINE_STUDY_TTL_MS) return null
  try { return { ...normalizeSnapshot(v), schemaVersion: 1, ownerId: owner.id, sessionId: owner.sessionId, savedAt: v.savedAt, expiresAt: v.expiresAt } } catch { return null }
}

export async function saveOfflineGroupSnapshot(userId: string, input: OfflineGroupSnapshotInput, sessionId: string): Promise<OfflineGroupSummary> {
  const id = ownerId(userId)
  if (!sessionId || blocked()) throw new Error('OFFLINE_OWNER_CHANGED')
  const safe = normalizeSnapshot(input)
  const version = intentVersion
  const savedAt = new Date().toISOString()
  const next: StoredSnapshot = { ...safe, schemaVersion: 1, ownerId: id, sessionId, savedAt, expiresAt: new Date(Date.now() + OFFLINE_STUDY_TTL_MS).toISOString(), key: `${id}:${safe.groupId}` }
  await transaction<void>('readwrite', (tx, done, fail) => {
    const req = tx.objectStore('meta').get(OWNER_KEY)
    req.onsuccess = () => {
      if (version !== intentVersion || blocked() || (intendedOwner !== undefined && intendedOwner !== id) || !sameOwner(req.result, id, sessionId)) return fail(new Error('OFFLINE_OWNER_CHANGED'))
      const groups = tx.objectStore('groups')
      const all = groups.getAll()
      all.onsuccess = () => {
        if (version !== intentVersion || blocked()) return fail(new Error('OFFLINE_OWNER_CHANGED'))
        const rows = (all.result as StoredSnapshot[]).filter(item => item.key !== next.key)
        for (const row of rows) if (row.ownerId !== id || row.sessionId !== sessionId || Date.parse(row.expiresAt) <= Date.now()) groups.delete(row.key)
        const active = rows.filter(item => item.ownerId === id && item.sessionId === sessionId && Date.parse(item.expiresAt) > Date.now()).sort((a, b) => a.savedAt.localeCompare(b.savedAt))
        while (active.length >= MAX_GROUPS) groups.delete(active.shift()!.key)
        groups.put(next)
        done(undefined)
      }
    }
  })
  changed()
  return summary(next)
}

function summary(row: OfflineGroupSnapshot): OfflineGroupSummary {
  return { groupId: row.groupId, groupName: row.groupName, rangeStart: row.rangeStart, rangeEnd: row.rangeEnd, savedAt: row.savedAt, expiresAt: row.expiresAt, lessonCount: row.lessons.length, homeworkCount: row.homework.length, assignmentCount: row.assignments.length }
}

export async function listOfflineGroups(userId?: string): Promise<OfflineGroupSummary[]> {
  if (blocked()) return []
  const id = userId ? ownerId(userId) : null
  const version = intentVersion
  const result = await transaction<OfflineGroupSummary[]>('readwrite', (tx, done) => {
    const req = tx.objectStore('meta').get(OWNER_KEY)
    req.onsuccess = () => {
      const owner = receipt(req.result)
      if (!owner || (id && id !== owner.id) || (intendedOwner !== undefined && intendedOwner !== owner.id)) return done([])
      const groups = tx.objectStore('groups')
      const all = groups.getAll()
      all.onsuccess = () => {
        const result: OfflineGroupSummary[] = []
        for (const raw of all.result as StoredSnapshot[]) {
          const item = currentSnapshot(raw, owner)
          if (item) { if (isStudyGroupListed(item.groupId)) result.push(summary(item)) }
          else groups.delete(raw.key)
        }
        done(result.sort((a, b) => a.groupName.localeCompare(b.groupName, 'uk')))
      }
    }
  })
  return version === intentVersion && !blocked() ? result : []
}

export async function loadOfflineGroup(userId: string, groupId: string): Promise<OfflineGroupSnapshot | null> {
  if (blocked()) return null
  const id = ownerId(userId)
  const key = `${id}:${text(groupId, 160, true)}`
  const version = intentVersion
  const result = await transaction<OfflineGroupSnapshot | null>('readwrite', (tx, done) => {
    const req = tx.objectStore('meta').get(OWNER_KEY)
    req.onsuccess = () => {
      const owner = receipt(req.result)
      if (!owner || owner.id !== id || (intendedOwner !== undefined && intendedOwner !== id)) return done(null)
      const groups = tx.objectStore('groups')
      const item = groups.get(key)
      item.onsuccess = () => { const row = currentSnapshot(item.result, owner); if (!row && item.result) groups.delete(key); done(row) }
    }
  })
  return version === intentVersion && !blocked() ? result : null
}

export async function removeOfflineGroupSnapshot(userId: string, groupId: string, sessionId: string): Promise<void> {
  if (blocked()) throw new Error('OFFLINE_OWNER_CHANGED')
  const id = ownerId(userId)
  const key = `${id}:${text(groupId, 160, true)}`
  await transaction<void>('readwrite', (tx, done, fail) => {
    const req = tx.objectStore('meta').get(OWNER_KEY)
    req.onsuccess = () => {
      if (!sessionId || blocked() || !sameOwner(req.result, id, sessionId)) return fail(new Error('OFFLINE_OWNER_CHANGED'))
      tx.objectStore('groups').delete(key)
      done(undefined)
    }
  })
  changed()
}

export function offlineStudyError(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'OFFLINE_OWNER_CHANGED') return 'Обліковий запис змінився. Відкрийте групу ще раз, щоб зберегти актуальну копію.'
  if (message === 'OFFLINE_CLEAR_NOT_CONFIRMED') return 'Браузер не дозволив підтвердити видалення локальної копії. Очистіть дані сайту Xelay на цьому пристрої.'
  if (message === 'OFFLINE_PURGE_PENDING') return 'Доступ до офлайн-копій заблоковано після виходу. Їх фізичне видалення ще не підтверджено браузером.'
  if (message === 'OFFLINE_SNAPSHOT_TOO_LARGE') return 'Цей розклад із завданнями завеликий для офлайн-копії. Попередня збережена копія залишається доступною.'
  if (message === 'OFFLINE_SNAPSHOT_INVALID') return 'Не вдалося підготувати повну офлайн-копію. Попередня копія залишається доступною; спробуйте оновити групу.'
  return 'Браузер не дозволив зберегти дані на пристрої. Перевірте вільне місце та дозвіл на зберігання даних сайту.'
}
