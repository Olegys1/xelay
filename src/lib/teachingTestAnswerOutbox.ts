import type { TeachingTestAttempt } from './teachingTests'

type Answer = TeachingTestAttempt['answers'][string]
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type TeachingTestAnswerDraft = {
  attemptId: string; questionId: string; baseVersion: number; answer: Answer
}
export type TeachingTestAnswerOutbox = { drafts: TeachingTestAnswerDraft[]; raw: string; error: string }
const PREFIX = 'xelay:teaching-answer-outbox:v1:'
const MAX_RAW = 1_500_000, MAX_ANSWER = 200_000, MAX_DRAFTS = 100, MAX_COPIES = MAX_DRAFTS * 4
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const key = (ownerId: string, testId: string) => `${PREFIX}${ownerId}:${testId}`
const browserStore = () => { try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined } }
const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
type CopyRecord = { name: string; raw: string; drafts: TeachingTestAnswerDraft[]; writer: string | null }
const WRITER_HISTORY = 'xelay:teaching-answer-writers:v1'
let writer: { id: string; previous: string[] } | undefined
function randomId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`
}
function documentWriter() {
  if (writer) return writer
  writer = { id: randomId(), previous: [] }
  // A fresh document always has a different writer, even when duplicating a tab
  // copies sessionStorage. History only prefers this tab's old copy on reload;
  // it grants no authority and never makes another writer's record mutable.
  try {
    const session = typeof window === 'undefined' ? undefined : window.sessionStorage
    const previous: unknown = JSON.parse(session?.getItem(WRITER_HISTORY) || '[]')
    if (Array.isArray(previous)) writer.previous = previous.filter(validId).slice(0, 8)
    session?.setItem(WRITER_HISTORY, JSON.stringify([writer.id, ...writer.previous].slice(0, 8)))
  } catch { /* Copies remain readable if optional per-tab ordering is unavailable. */ }
  return writer
}
function forgetEmptyWriter(storage: StoragePort) {
  if (Object.keys(storage).some(name => name.startsWith(PREFIX))) return
  try { if (typeof window !== 'undefined') window.sessionStorage.removeItem(WRITER_HISTORY) } catch { /* Optional ordering only. */ }
  writer = undefined
}
function validAnswer(value: unknown): value is Answer {
  if (typeof value === 'string') return value.length <= MAX_ANSWER
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.length <= 300 && value.every(item => typeof item === 'string' && item.length <= 2000)
  const entries = Object.entries(value)
  return entries.length <= 300 && entries.every(([name, text]) => validId(name) && !['__proto__', 'constructor', 'prototype'].includes(name) && typeof text === 'string' && text.length <= 10000)
}
export function sameTeachingTestAnswer(a: Answer | undefined, b: Answer | undefined) {
  if (a === b) return true
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false
  const entries = Object.entries(a), other = new Map(Object.entries(b))
  return entries.length === other.size && entries.every(([name, value]) => other.get(name) === value)
}
function validDraft(value: unknown): value is TeachingTestAnswerDraft {
  if (!value || typeof value !== 'object' || !exactKeys(value, ['attemptId', 'questionId', 'baseVersion', 'answer'])) return false
  const draft = value as TeachingTestAnswerDraft
  return validId(draft.attemptId) && validId(draft.questionId) && Number.isSafeInteger(draft.baseVersion) && draft.baseVersion >= 0
    && validAnswer(draft.answer) && JSON.stringify(draft.answer).length <= MAX_ANSWER
}
const encode = (ownerId: string, testId: string, drafts: TeachingTestAnswerDraft[]) => JSON.stringify({ version: 1, ownerId, testId, drafts })
function readCopies(ownerId: string, testId: string, storage: StoragePort | undefined): TeachingTestAnswerOutbox & { records: CopyRecord[] } {
  const empty = { drafts: [], raw: '', records: [] }
  if (!validId(ownerId) || !validId(testId)) return { ...empty, error: 'Не вдалося визначити власника локальної копії.' }
  if (!storage) return { ...empty, error: 'Браузер не дозволяє зберігати локальну копію відповідей.' }
  const base = key(ownerId, testId), prefix = base + ':copy:', records: CopyRecord[] = []
  let raw = ''
  try {
    const names = [base, ...Object.keys(storage).filter(name => name.startsWith(prefix))]
    for (const name of names) {
      const bytes = storage.getItem(name) || ''
      if (!bytes) continue
      // Record bytes are immutable. A later edit gets a new key, so a delayed
      // acknowledgement can delete only the exact copy it actually inspected.
      const suffix = name === base ? null : name.slice(prefix.length).split(':')
      const record = { name, raw: bytes, drafts: [], writer: suffix?.[0] || null } as CopyRecord
      records.push(record)
    }
    // Collect every recoverable byte before validating any record. A corrupt
    // first copy must not hide later sound copies from the download-and-clear UI.
    if (records.length > MAX_COPIES) throw Error('size')
    for (const record of records) {
      const bytes = record.raw, suffix = record.name === base ? null : record.name.slice(prefix.length).split(':')
      if (bytes.length > MAX_RAW || suffix && (suffix.length !== 2 || !suffix.every(validId))) throw Error('size')
      const value = JSON.parse(bytes)
      if (!value || !exactKeys(value, ['version', 'ownerId', 'testId', 'drafts']) || value.version !== 1 || value.ownerId !== ownerId || value.testId !== testId
        || !Array.isArray(value.drafts) || value.drafts.length > MAX_DRAFTS || !value.drafts.every(validDraft)
        || suffix && value.drafts.length !== 1
        || new Set(value.drafts.map((draft: TeachingTestAnswerDraft) => `${draft.attemptId}:${draft.questionId}`)).size !== value.drafts.length) throw Error('shape')
      record.drafts = value.drafts
    }
    if (!records.length) return { drafts: [], raw: '', error: '', records }
    const owner = documentWriter(), preference = [owner.id, ...owner.previous]
    records.sort((a, b) => {
      const order = (record: CopyRecord) => { const index = record.writer ? preference.indexOf(record.writer) : -1; return index < 0 ? preference.length : index }
      return order(a) - order(b)
    })
    const unique = new Map<string, TeachingTestAnswerDraft>()
    for (const record of records) for (const draft of record.drafts) {
      const signature = JSON.stringify(draft)
      if (!unique.has(signature)) unique.set(signature, draft)
    }
    const drafts = [...unique.values()]
    raw = records.length ? encode(ownerId, testId, drafts) : ''
    if (drafts.length > MAX_COPIES || raw.length > MAX_RAW) throw Error('size')
    return { drafts, raw, error: '', records }
  } catch {
    raw = records.length === 1 ? records[0].raw : records.length ? JSON.stringify({ copies: records.map(record => record.raw) }) : raw
    return { drafts: [], raw, records, error: 'Локальна копія недоступна або пошкоджена. Її не перезаписано; збережіть копію перед очищенням.' }
  }
}
/** Own answer bytes only. A browser draft is never evidence of access, time,
 * version, question content, submission or a score; every replay uses normal RPC. */
export function readTeachingTestAnswerOutbox(ownerId: string, testId: string, storage: StoragePort | undefined = browserStore()): TeachingTestAnswerOutbox {
  const { records: _records, ...copy } = readCopies(ownerId, testId, storage)
  return copy
}
export function writeTeachingTestAnswerDraft(ownerId: string, testId: string, draft: TeachingTestAnswerDraft, storage: StoragePort | undefined = browserStore()): TeachingTestAnswerOutbox {
  const current = readCopies(ownerId, testId, storage), { records, ...copy } = current
  if (copy.error) return copy
  if (!validDraft(draft)) return { ...copy, error: 'Відповідь завелика для локальної копії. Не закривайте вкладку до збереження на сервері.' }
  const owner = documentWriter(), retiring = records.filter(record => record.writer === owner.id
    && record.drafts.every(item => item.attemptId === draft.attemptId && item.questionId === draft.questionId))
  const retired = new Set(retiring)
  const drafts = records.filter(record => !retired.has(record)).flatMap(record => record.drafts)
  drafts.push(draft)
  const ownCount = records.filter(record => record.writer === owner.id && !retired.has(record)).length + 1
  if (ownCount > MAX_DRAFTS || drafts.length > MAX_COPIES || encode(ownerId, testId, drafts).length > MAX_RAW) return { ...copy, error: 'Локальне сховище відповідей заповнено. Збережіть копію; попередні відповіді не видалено.' }
  try {
    const name = `${key(ownerId, testId)}:copy:${owner.id}:${randomId()}`
    if (storage!.getItem(name) !== null) throw Error('duplicate copy')
    storage!.setItem(name, encode(ownerId, testId, [draft]))
    for (const old of retiring) storage!.removeItem(old.name)
    return readTeachingTestAnswerOutbox(ownerId, testId, storage)
  } catch { return { ...readTeachingTestAnswerOutbox(ownerId, testId, storage), error: 'Не вдалося записати локальну копію. Не закривайте вкладку до збереження на сервері.' } }
}
/** Delete only the exact answer confirmed in an authorized server receipt;
 * a newer edit in another tab must survive an older request's receipt. */
export function acknowledgeTeachingTestAnswerDraft(ownerId: string, testId: string, attempt: Pick<TeachingTestAttempt, 'id' | 'answers'>, storage: StoragePort | undefined = browserStore()): TeachingTestAnswerOutbox {
  const { records, ...current } = readCopies(ownerId, testId, storage)
  if (current.error) return current
  try {
    for (const record of records) {
      const drafts = record.drafts.filter(draft => draft.attemptId !== attempt.id || !sameTeachingTestAnswer(attempt.answers[draft.questionId], draft.answer))
      if (drafts.length === record.drafts.length || storage!.getItem(record.name) !== record.raw) continue
      // Only the old shared v1 document needs a rewrite. New immutable copy
      // keys never receive changed bytes and cannot erase a concurrent edit.
      if (drafts.length) storage!.setItem(record.name, encode(ownerId, testId, drafts))
      else storage!.removeItem(record.name)
    }
    forgetEmptyWriter(storage!)
    return readTeachingTestAnswerOutbox(ownerId, testId, storage)
  } catch { return { ...current, error: 'Відповідь прийняв сервер, але локальна копія ще потребує перевірки.' } }
}
export function discardTeachingTestAnswerOutbox(ownerId: string, testId: string, storage: StoragePort | undefined = browserStore()) {
  if (!validId(ownerId) || !validId(testId)) return
  try {
    if (!storage) return
    const base = key(ownerId, testId)
    for (const name of [base, ...Object.keys(storage).filter(name => name.startsWith(base + ':copy:'))]) storage.removeItem(name)
    forgetEmptyWriter(storage)
  } catch { /* keep the explicit warning on the next read */ }
}
export function clearTeachingTestAnswerOutbox() {
  try { const storage = browserStore(); if (storage) for (const name of Object.keys(storage)) if (name.startsWith(PREFIX)) storage.removeItem(name) } catch { /* disabled storage */ }
  try { if (typeof window !== 'undefined') window.sessionStorage.removeItem(WRITER_HISTORY) } catch { /* disabled storage */ }
  writer = undefined
}
