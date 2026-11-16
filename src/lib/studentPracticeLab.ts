export type PracticeQuestion = { id: string; subject: string; topic: string; prompt: string; options: string[]; correct: number; explanation: string }
export type PracticeAttempt = { id: string; mode: 'practice' | 'exam'; questions: PracticeQuestion[]; answers: Record<string, number>; startedAt: number; deadline: number | null; submittedAt: number | null }
export type PracticeLabState = { version: 1; questions: PracticeQuestion[]; current: PracticeAttempt | null; history: PracticeAttempt[] }
export const PRACTICE_LAB_STORAGE_KEY = 'xelay:local-student-practice:synthetic:v1'
export const PRACTICE_MAX_QUESTIONS = 200
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const record = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
const instant = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v < 8_640_000_000_000_000
const questionSignature = (q: Pick<PracticeQuestion, 'subject' | 'topic' | 'prompt' | 'options' | 'correct' | 'explanation'>) => JSON.stringify([q.subject, q.topic, q.prompt, q.options, q.correct, q.explanation])
export function questionFingerprint(q: Pick<PracticeQuestion, 'subject' | 'topic' | 'prompt' | 'options' | 'correct' | 'explanation'>): string {
  const value = questionSignature(q); let hash = 2166136261
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619)
  return (hash >>> 0).toString(36)
}
export function validatePracticeQuestion(value: unknown, fallbackId = ''): PracticeQuestion {
  if (!record(value) || Object.keys(value).some(k => !['id', 'subject', 'topic', 'prompt', 'options', 'correct', 'explanation'].includes(k))
    || !text(value.subject, 120) || !text(value.topic, 120) || !text(value.prompt, 2000)
    || !Array.isArray(value.options) || value.options.length < 2 || value.options.length > 6 || !value.options.every(option => text(option, 600))
    || new Set(value.options.map(option => option.trim())).size !== value.options.length
    || !Number.isInteger(value.correct) || Number(value.correct) < 0 || Number(value.correct) >= value.options.length
    || typeof value.explanation !== 'string' || value.explanation.length > 2000) throw new Error('Потрібні предмет, тема, питання, 2–6 різних відповідей та один правильний варіант.')
  const id = value.id === undefined ? fallbackId : value.id
  if (typeof id !== 'string' || !ID.test(id) || ['constructor', 'prototype'].includes(id)) throw new Error('Некоректний ідентифікатор питання.')
  return { id, subject: value.subject.trim(), topic: value.topic.trim(), prompt: value.prompt.trim(), options: value.options.map(option => option.trim()), correct: Number(value.correct), explanation: value.explanation.trim() }
}
export function initialPracticeLabState(questions: PracticeQuestion[] = []): PracticeLabState { return { version: 1, questions: questions.map(q => validatePracticeQuestion(q)).slice(0, PRACTICE_MAX_QUESTIONS), current: null, history: [] } }
function parseCsv(raw: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], cell = '', quoted = false, afterQuote = false
  const pushCell = () => { row.push(cell); cell = ''; afterQuote = false; if (row.length > 12) throw new Error('Забагато стовпців CSV.') }
  const pushRow = () => { pushCell(); if (row.some(v => v.trim())) rows.push(row); row = []; if (rows.length > PRACTICE_MAX_QUESTIONS + 1) throw new Error('До 200 питань за один імпорт.') }
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (quoted) { if (char === '"') { if (raw[i + 1] === '"') { cell += '"'; i++ } else { quoted = false; afterQuote = true } } else cell += char; continue }
    if (char === '"' && cell.length === 0 && !afterQuote) { quoted = true; continue }
    if (char === ',') { pushCell(); continue }
    if (char === '\r' || char === '\n') { if (char === '\r' && raw[i + 1] === '\n') i++; pushRow(); continue }
    if (afterQuote && char.trim()) throw new Error('Перевірте лапки та розділювачі CSV.')
    if (!afterQuote) cell += char
  }
  if (quoted) throw new Error('Незакриті лапки у CSV.')
  if (cell || row.length) pushRow()
  return rows
}
export const PRACTICE_CSV_HEADER = ['subject', 'topic', 'question', 'option1', 'option2', 'option3', 'option4', 'option5', 'option6', 'correct', 'explanation'] as const
export function importPracticeQuestions(raw: string, format: 'json' | 'csv'): PracticeQuestion[] {
  if (typeof raw !== 'string' || raw.length > 1_000_000 || !raw.trim()) throw new Error('Вставте файл або текст до 1 МБ.')
  let values: unknown[]
  if (format === 'json') {
    let parsed: unknown; try { parsed = JSON.parse(raw) } catch { throw new Error('Не вдалося прочитати JSON. Перевірте приклад формату.') }
    if (Array.isArray(parsed)) values = parsed
    else if (record(parsed) && parsed.format === 'xelay-practice-v1' && Array.isArray(parsed.questions) && Object.keys(parsed).every(k => ['format', 'questions'].includes(k))) values = parsed.questions
    else throw new Error('JSON має містити масив питань або об’єкт формату xelay-practice-v1.')
  } else {
    const rows = parseCsv(raw.replace(/^\uFEFF/, '')); const header = rows.shift()
    if (!header || header.length !== PRACTICE_CSV_HEADER.length || header.some((v, i) => v.trim() !== PRACTICE_CSV_HEADER[i])) throw new Error('Заголовки CSV мають відповідати прикладу. Розділювач — кома.')
    values = rows.map((row, index) => {
      if (row.length !== PRACTICE_CSV_HEADER.length) throw new Error(`Рядок ${index + 2}: має бути 11 стовпців.`)
      const options = row.slice(3, 9); while (options.length && options[options.length - 1] === '') options.pop()
      if (!/^[1-6]$/.test(row[9].trim())) throw new Error(`Рядок ${index + 2}: correct — номер відповіді від 1 до 6.`)
      return { subject: row[0], topic: row[1], prompt: row[2], options, correct: Number(row[9]) - 1, explanation: row[10] }
    })
  }
  if (!values.length || values.length > PRACTICE_MAX_QUESTIONS) throw new Error('Імпортуйте від 1 до 200 питань.')
  const ids = new Set<string>()
  return values.map((value, index) => {
    let question: PracticeQuestion
    try { question = validatePracticeQuestion(value, `import-${index}-${record(value) ? questionFingerprint(value as PracticeQuestion) : 'invalid'}`) } catch (error) { throw new Error(`Питання ${index + 1}: ${error instanceof Error ? error.message : 'перевірте дані.'}`) }
    if (ids.has(question.id)) throw new Error(`Питання ${index + 1}: ідентифікатор повторюється.`)
    ids.add(question.id); return question
  })
}
export function mergePracticeQuestions(existing: PracticeQuestion[], imported: PracticeQuestion[]): PracticeQuestion[] {
  const fingerprints = new Set(existing.map(questionSignature)), ids = new Set(existing.map(q => q.id)); const result = [...existing]
  for (const q of imported) {
    const safe = validatePracticeQuestion(q), fingerprint = questionSignature(safe)
    if (fingerprints.has(fingerprint)) continue
    if (ids.has(safe.id)) throw new Error('Ідентифікатор збігається з іншим питанням. Змініть його в імпорті.')
    result.push(safe); fingerprints.add(fingerprint); ids.add(safe.id)
  }
  if (result.length > PRACTICE_MAX_QUESTIONS) throw new Error('У бібліотеці може бути до 200 питань. Імпортуйте менший набір.')
  return result
}
export function exportPracticeQuestions(questions: PracticeQuestion[], format: 'json' | 'csv'): string {
  const safe = questions.map(q => validatePracticeQuestion(q))
  if (format === 'json') return JSON.stringify({ format: 'xelay-practice-v1', questions: safe }, null, 2)
  const escape = (value: string) => '"' + (/^[\s\uFEFF]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? "'" + value : value).replace(/"/g, '""') + '"'
  return [PRACTICE_CSV_HEADER.join(','), ...safe.map(q => [q.subject, q.topic, q.prompt, ...Array.from({ length: 6 }, (_, i) => q.options[i] || ''), String(q.correct + 1), q.explanation].map(escape).join(','))].join('\r\n')
}
export function startPracticeAttempt(questions: PracticeQuestion[], mode: 'practice' | 'exam', now: number, id: string, minutes = 20, random: () => number = Math.random, shuffle = false): PracticeAttempt {
  if (!instant(now) || !ID.test(id) || !questions.length || questions.length > PRACTICE_MAX_QUESTIONS || !['practice', 'exam'].includes(mode) || !Number.isInteger(minutes) || minutes < 1 || minutes > 180) throw new Error('Перевірте набір питань і час на тренування.')
  const snapshots = questions.map(q => ({ ...validatePracticeQuestion(q), options: [...q.options] }))
  if (new Set(snapshots.map(q => q.id)).size !== snapshots.length) throw new Error('Питання не повинні повторюватися.')
  if (shuffle) for (let i = snapshots.length - 1; i > 0; i--) { const value = random(); if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Не вдалося перемішати питання.'); const j = Math.floor(value * (i + 1)); [snapshots[i], snapshots[j]] = [snapshots[j], snapshots[i]] }
  return { id, mode, questions: snapshots, answers: Object.create(null), startedAt: now, deadline: mode === 'exam' ? now + minutes * 60000 : null, submittedAt: null }
}
export function practiceSecondsRemaining(attempt: PracticeAttempt, now: number): number | null { if (attempt.deadline === null) return null; return Math.max(0, Math.ceil((attempt.deadline - now) / 1000)) }
export function answerPracticeQuestion(attempt: PracticeAttempt, questionId: string, option: number, now: number): PracticeAttempt {
  const q = attempt.questions.find(q => q.id === questionId)
  if (!instant(now) || now < attempt.startedAt || attempt.submittedAt !== null || attempt.deadline !== null && now >= attempt.deadline || !q || !Number.isInteger(option) || option < 0 || option >= q.options.length) return attempt
  return { ...attempt, answers: { ...attempt.answers, [questionId]: option } }
}
export function scorePracticeAttempt(attempt: PracticeAttempt) {
  const correct = attempt.questions.filter(q => attempt.answers[q.id] === q.correct).length
  return { correct, total: attempt.questions.length, percent: attempt.questions.length ? Math.round(correct / attempt.questions.length * 100) : 0, answered: attempt.questions.filter(q => Number.isInteger(attempt.answers[q.id])).length, mistakes: attempt.questions.filter(q => attempt.answers[q.id] !== q.correct) }
}
export function finishPracticeAttempt(state: PracticeLabState, now: number): PracticeLabState {
  if (!state.current || state.current.submittedAt !== null || !instant(now) || now < state.current.startedAt) return state
  const done = { ...state.current, submittedAt: Math.min(now, state.current.deadline ?? now) }
  return { ...state, current: done, history: [done, ...state.history.filter(item => item.id !== done.id)].slice(0, 50) }
}
/** Keep bank/current first; bounded local history is not unlimited cloud storage. */
export function preparePracticeStorage(state: PracticeLabState, maxLength = 3_000_000) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 3_000_000) throw new Error('Некоректний обсяг збереження.')
  const currentDone = state.current?.submittedAt !== null ? state.current : null
  const history = state.history.filter(attempt => attempt.id !== currentDone?.id).slice(0, 50)
  let json = JSON.stringify({ ...state, history })
  while (json.length > maxLength && history.length) { history.pop(); json = JSON.stringify({ ...state, history }) }
  if (json.length > maxLength) throw new Error('Бібліотека й поточна спроба завеликі для локального збереження. Завантаж усі дані у JSON.')
  const retainedHistoryIds = [...(currentDone ? [currentDone.id] : []), ...history.map(attempt => attempt.id)]
  return { json, retainedHistoryIds, dropped: state.history.filter(attempt => !retainedHistoryIds.includes(attempt.id)).length }
}
function parseAttempt(value: unknown): PracticeAttempt | null {
  if (!record(value) || typeof value.id !== 'string' || !ID.test(value.id) || !['practice', 'exam'].includes(String(value.mode)) || !Array.isArray(value.questions) || !value.questions.length || value.questions.length > PRACTICE_MAX_QUESTIONS || !instant(value.startedAt) || !(value.submittedAt === null || instant(value.submittedAt)) || !(value.deadline === null || instant(value.deadline))) return null
  try {
    const questions = value.questions.map(q => validatePracticeQuestion(q)); if (new Set(questions.map(q => q.id)).size !== questions.length) return null
    if (value.mode === 'practice' && value.deadline !== null || value.mode === 'exam' && (value.deadline === null || Number(value.deadline) <= value.startedAt || Number(value.deadline) - value.startedAt > 180 * 60000) || value.submittedAt !== null && Number(value.submittedAt) < value.startedAt) return null
    const answers: Record<string, number> = Object.create(null)
    if (record(value.answers)) for (const q of questions) { const answer = value.answers[q.id]; if (Number.isInteger(answer) && Number(answer) >= 0 && Number(answer) < q.options.length) answers[q.id] = Number(answer) }
    return { id: value.id, mode: value.mode as 'practice' | 'exam', questions, answers, startedAt: value.startedAt, deadline: value.deadline as number | null, submittedAt: value.submittedAt as number | null }
  } catch { return null }
}
export function parsePracticeLabState(raw: string | null, seed: PracticeQuestion[] = []): PracticeLabState {
  const initial = initialPracticeLabState(seed)
  if (!raw || raw.length > 3_000_000) return initial
  try {
    const value: unknown = JSON.parse(raw); if (!record(value) || value.version !== 1 || !Array.isArray(value.questions) || value.questions.length > PRACTICE_MAX_QUESTIONS) return initial
    const questions = value.questions.map(q => validatePracticeQuestion(q)); if (new Set(questions.map(q => q.id)).size !== questions.length) return initial
    const current = value.current === null ? null : parseAttempt(value.current)
    const history = Array.isArray(value.history) ? value.history.map(parseAttempt).filter((v): v is PracticeAttempt => !!v && v.submittedAt !== null).slice(0, 50) : []
    const uniqueHistory = [...new Map([...(current && current.submittedAt !== null ? [current] : []), ...history].map(attempt => [attempt.id, attempt])).values()].slice(0, 50)
    return { version: 1, questions, current, history: uniqueHistory }
  } catch { return initial }
}
