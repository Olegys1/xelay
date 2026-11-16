import type { TeachingTestAttempt } from './teachingTests'

type Answer = TeachingTestAttempt['answers'][string]
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export type TeachingTestAnswerDraft = {
  attemptId: string; questionId: string; baseVersion: number; answer: Answer
}
export type TeachingTestAnswerOutbox = { drafts: TeachingTestAnswerDraft[]; raw: string; error: string }
const PREFIX = 'xelay:teaching-answer-outbox:v1:'
const MAX_RAW = 1_500_000, MAX_ANSWER = 200_000, MAX_DRAFTS = 100
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)
const key = (ownerId: string, testId: string) => `${PREFIX}${ownerId}:${testId}`
const browserStore = () => { try { return typeof localStorage === 'undefined' ? undefined : localStorage } catch { return undefined } }
const exactKeys = (value: object, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.prototype.hasOwnProperty.call(value, key))
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
/** Own answer bytes only. A browser draft is never evidence of access, time,
 * version, question content, submission or a score; every replay uses normal RPC. */
export function readTeachingTestAnswerOutbox(ownerId: string, testId: string, storage: StoragePort | undefined = browserStore()): TeachingTestAnswerOutbox {
  if (!validId(ownerId) || !validId(testId)) return { drafts: [], raw: '', error: 'Не вдалося визначити власника локальної копії.' }
  if (!storage) return { drafts: [], raw: '', error: 'Браузер не дозволяє зберігати локальну копію відповідей.' }
  let raw = ''
  try {
    raw = storage.getItem(key(ownerId, testId)) || ''
    if (!raw) return { drafts: [], raw, error: '' }
    if (raw.length > MAX_RAW) throw Error('size')
    const value = JSON.parse(raw)
    if (!value || !exactKeys(value, ['version', 'ownerId', 'testId', 'drafts']) || value.version !== 1 || value.ownerId !== ownerId || value.testId !== testId
      || !Array.isArray(value.drafts) || value.drafts.length > MAX_DRAFTS || !value.drafts.every(validDraft)
      || new Set(value.drafts.map((draft: TeachingTestAnswerDraft) => `${draft.attemptId}:${draft.questionId}`)).size !== value.drafts.length) throw Error('shape')
    return { drafts: value.drafts, raw, error: '' }
  } catch { return { drafts: [], raw, error: 'Локальна копія недоступна або пошкоджена. Її не перезаписано; збережіть копію перед очищенням.' } }
}
export function writeTeachingTestAnswerDraft(ownerId: string, testId: string, draft: TeachingTestAnswerDraft, storage: StoragePort | undefined = browserStore()): TeachingTestAnswerOutbox {
  const current = readTeachingTestAnswerOutbox(ownerId, testId, storage)
  if (current.error) return current
  if (!validDraft(draft)) return { ...current, error: 'Відповідь завелика для локальної копії. Не закривайте вкладку до збереження на сервері.' }
  const drafts = current.drafts.filter(item => item.attemptId !== draft.attemptId || item.questionId !== draft.questionId)
  drafts.push(draft)
  const raw = JSON.stringify({ version: 1, ownerId, testId, drafts })
  if (drafts.length > MAX_DRAFTS || raw.length > MAX_RAW) return { ...current, error: 'Локальне сховище відповідей заповнено. Збережіть копію; попередні відповіді не видалено.' }
  try { storage!.setItem(key(ownerId, testId), raw); return { drafts, raw, error: '' } }
  catch { return { ...current, error: 'Не вдалося записати локальну копію. Не закривайте вкладку до збереження на сервері.' } }
}
/** Delete only the exact answer confirmed in an authorized server receipt;
 * a newer edit in another tab must survive an older request's receipt. */
export function acknowledgeTeachingTestAnswerDraft(ownerId: string, testId: string, attempt: Pick<TeachingTestAttempt, 'id' | 'answers'>, storage: StoragePort | undefined = browserStore()): TeachingTestAnswerOutbox {
  const current = readTeachingTestAnswerOutbox(ownerId, testId, storage)
  if (current.error) return current
  const drafts = current.drafts.filter(draft => draft.attemptId !== attempt.id || !sameTeachingTestAnswer(attempt.answers[draft.questionId], draft.answer))
  if (drafts.length === current.drafts.length) return current
  try {
    const raw = drafts.length ? JSON.stringify({ version: 1, ownerId, testId, drafts }) : ''
    if (raw) storage!.setItem(key(ownerId, testId), raw)
    else storage!.removeItem(key(ownerId, testId))
    return { drafts, raw, error: '' }
  } catch { return { ...current, error: 'Відповідь прийняв сервер, але локальна копія ще потребує перевірки.' } }
}
export function discardTeachingTestAnswerOutbox(ownerId: string, testId: string, storage: StoragePort | undefined = browserStore()) {
  if (!validId(ownerId) || !validId(testId)) return
  try { storage?.removeItem(key(ownerId, testId)) } catch { /* keep the explicit warning on the next read */ }
}
export function clearTeachingTestAnswerOutbox() {
  try { const storage = browserStore(); if (storage) for (const name of Object.keys(storage)) if (name.startsWith(PREFIX)) storage.removeItem(name) } catch { /* disabled storage */ }
}
