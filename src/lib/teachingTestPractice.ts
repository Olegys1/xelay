import type { TeachingTest, TeachingTestAttempt, TeachingTestDetail, TeachingTestQuestion, TeachingTestRepository } from './teachingTests'

type Answer = TeachingTestAttempt['answers'][string]
type Snapshot = { createdAt: number; testVersion: number; questions: TeachingTestQuestion[]; attempt: TeachingTestAttempt; tabExitEvents?: string[] }
const DAY = 86_400_000
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const fail = (code: string): never => { throw new Error(code) }
const round = (value: number, places = 4) => Math.round((value + Number.EPSILON) * 10 ** places) / 10 ** places
const owns = (value: object, name: string) => Object.prototype.hasOwnProperty.call(value, name)
const keyFor = (test: TeachingTest, user: string) => `xelay:teacher-practice:v1:${encodeURIComponent(user)}:${encodeURIComponent(test.id)}:${test.version}`
function browserStorage(): Storage | undefined {
  try { return typeof window === 'undefined' ? undefined : window.sessionStorage } catch { return undefined }
}

// Deliberately accepts arithmetic only: no calls, property access, powers or executable code.
function arithmetic(formula: string, variables: Record<string, number>): number {
  if (!formula.trim() || formula.length > 500) return fail('TEST_INVALID_INPUT')
  let position = 0
  const whitespace = () => { while (/\s/.test(formula[position] || '') && position < formula.length) position++ }
  const bounded = (value: number) => Number.isFinite(value) && Math.abs(value) <= 1e12 ? value : fail('TEST_INVALID_INPUT')
  const parse = (mode: number, depth: number): number => {
    if (depth > 30) return fail('TEST_INVALID_INPUT')
    whitespace()
    if (mode < 2) {
      let value = parse(mode + 1, depth + 1)
      while (true) {
        whitespace()
        const operator = formula[position]
        if (!(mode === 0 ? ['+', '-'] : ['*', '/']).includes(operator)) return value
        position++
        const right = parse(mode + 1, depth + 1)
        value = bounded(operator === '+' ? value + right : operator === '-' ? value - right : operator === '*' ? value * right : value / right)
      }
    }
    const operator = formula[position]
    if (operator === '+' || operator === '-') { position++; return bounded(parse(2, depth + 1) * (operator === '-' ? -1 : 1)) }
    if (operator === '(') {
      position++
      const value = parse(0, depth + 1)
      whitespace()
      if (formula[position++] !== ')') return fail('TEST_INVALID_INPUT')
      return value
    }
    const token = formula.slice(position).match(/^[A-Za-z][A-Za-z0-9_]{0,19}|^(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)/)?.[0]
    if (!token || token.length > 30) return fail('TEST_INVALID_INPUT')
    position += token.length
    return bounded(/^[A-Za-z]/.test(token) ? owns(variables, token) ? variables[token] : NaN : Number(token))
  }
  const value = parse(0, 0)
  whitespace()
  return position === formula.length ? value : fail('TEST_INVALID_INPUT')
}

function shuffle<T>(values: T[]): T[] {
  for (let index = values.length - 1; index > 0; index--) {
    const target = Math.floor(Math.random() * (index + 1))
    ;[values[index], values[target]] = [values[target], values[index]]
  }
  return values
}
function questionSets(test: TeachingTest): TeachingTestQuestion[][] {
  return [test.questions, ...(test.variants || []).map(variant => variant.questions)]
}
function variant(test: TeachingTest): { questions: TeachingTestQuestion[]; index: number } {
  const sets = questionSets(test)
  const index = sets.length === 1 ? 0 : Math.floor(Math.random() * sets.length)
  const source = clone(sets[index])
  if (source.length < 1 || source.length > 100) return fail('TEST_INVALID_INPUT')
  const questions = (test.shuffle_questions || test.draw_count != null ? shuffle(source) : source)
    .slice(0, test.draw_count == null ? source.length : Math.max(1, Math.min(source.length, test.draw_count)))
  for (const question of questions) {
    if (!Number.isFinite(question.points) || question.points <= 0) return fail('TEST_INVALID_INPUT')
    if (question.kind === 'calculated') {
      const calculation = question.calculation
      if (!calculation || !calculation.variables.length || calculation.variables.length > 10
        || new Set(calculation.variables.map(variable => variable.name)).size !== calculation.variables.length) return fail('TEST_INVALID_INPUT')
      for (const variable of calculation.variables) {
        if (!/^[A-Za-z][A-Za-z0-9_]{0,19}$/.test(variable.name) || ![variable.min, variable.max, variable.step].every(Number.isFinite)
          || variable.min > variable.max || variable.step <= 0 || Math.max(Math.abs(variable.min), Math.abs(variable.max)) > 1e6
          || (variable.max - variable.min) / variable.step > 10_000) return fail('TEST_INVALID_INPUT')
      }
      let generated: Record<string, number> = {}, result: number | undefined
      for (let attempt = 0; attempt <= 32; attempt++) {
        generated = Object.fromEntries(calculation.variables.map(variable => [variable.name, variable.min +
          (attempt === 32 ? 0 : Math.floor(Math.random() * (Math.floor((variable.max - variable.min) / variable.step) + 1))) * variable.step]))
        try { result = arithmetic(calculation.formula, generated); break } catch { if (attempt === 32) return fail('TEST_INVALID_INPUT') }
      }
      question.text = question.text.replace(/\{\{([A-Za-z][A-Za-z0-9_]{0,19})\}\}/g, (whole, name: string) => owns(generated, name) ? String(generated[name]) : whole)
      question.answer = String(result)
    }
    if (question.kind === 'sequence' || question.kind === 'sequence_select' || test.shuffle_answers && ['choice', 'multiple', 'sorting'].includes(question.kind)) shuffle(question.options)
  }
  return { questions, index }
}
function validAnswer(question: TeachingTestQuestion, answer: unknown): answer is Answer {
  if (answer == null) return true
  const ids = question.options.map(option => option.id)
  if (['choice', 'boolean'].includes(question.kind)) return typeof answer === 'string' && ids.includes(answer)
  if (question.kind === 'sequence_select') return Number.isInteger(question.selection_count) && question.selection_count! > 0
    && Array.isArray(answer) && answer.length <= question.selection_count! && new Set(answer).size === answer.length
    && answer.every(id => typeof id === 'string' && ids.includes(id))
  if (['multiple', 'sequence'].includes(question.kind)) return Array.isArray(answer) && answer.length <= ids.length
    && (question.kind !== 'sequence' || answer.length === ids.length) && new Set(answer).size === answer.length
    && answer.every(id => typeof id === 'string' && ids.includes(id))
  if (['sorting', 'cloze'].includes(question.kind)) return typeof answer === 'object' && !Array.isArray(answer)
    && Object.entries(answer).every(([id, value]) => typeof value === 'string' && (question.kind === 'sorting'
      ? ids.includes(id) && question.buckets.some(bucket => bucket.id === value)
      : question.gaps?.some(gap => gap.id === id) && value.length <= 2000))
  return typeof answer === 'string' && answer.length <= (question.kind === 'essay' ? 20_000 : ['numerical', 'calculated'].includes(question.kind) ? 100 : 2000)
    && (!['numerical', 'calculated'].includes(question.kind) || !answer.trim() || /^[-+]?[0-9]+(?:\.[0-9]+)?$/.test(answer.trim().replace(',', '.')))
}
function points(question: TeachingTestQuestion, answer: unknown): number {
  if (answer == null || !validAnswer(question, answer) || question.kind === 'essay') return 0
  const expected = question.answer
  const normalize = (value: string) => question.case_sensitive ? value.trim().replace(/\s+/g, ' ') : value.trim().replace(/\s+/g, ' ').toLowerCase()
  const equal = (value: unknown, expectedText: string) => typeof value === 'string' && normalize(value) === normalize(expectedText)
  let fraction = 0
  if (['choice', 'boolean'].includes(question.kind)) fraction = answer === expected ? 1 : 0
  else if (question.kind === 'short_text') fraction = Array.isArray(expected) && expected.some(text => equal(answer, text)) ? 1 : 0
  else if (['numerical', 'calculated'].includes(question.kind)) {
    const actual = typeof answer === 'string' && answer.trim() ? Number(answer.trim().replace(',', '.')) : NaN, target = Number(expected)
    // Decimal answers at an inclusive tolerance boundary must not fail because of binary floating point.
    const epsilon = (question.tolerance || 0) > 0 ? Number.EPSILON * Math.max(1, Math.abs(actual), Math.abs(target)) * 4 : 0
    fraction = Number.isFinite(actual) && Math.abs(actual - target) <= (question.tolerance || 0) + epsilon ? 1 : 0
  }
  else if (question.kind === 'multiple' && Array.isArray(expected) && Array.isArray(answer)) {
    const correct = answer.filter(id => expected.includes(id)).length, wrong = answer.length - correct
    fraction = question.partial_credit ? Math.max(0, correct / expected.length - wrong / Math.max(1, question.options.length - expected.length))
      : correct === expected.length && wrong === 0 ? 1 : 0
  } else {
    const checks = ['sequence', 'sequence_select'].includes(question.kind) && Array.isArray(expected) && Array.isArray(answer) ? expected.map((id, index) => id === answer[index])
      : question.kind === 'cloze' ? (question.gaps || []).map(gap => gap.answers.some(text => equal((answer as Record<string, string>)[gap.id], text)))
      : typeof expected === 'object' && !Array.isArray(expected) ? Object.entries(expected || {}).map(([id, value]) => (answer as Record<string, string>)[id] === value) : []
    fraction = checks.length ? checks.every(Boolean) ? 1 : question.partial_credit ? checks.filter(Boolean).length / checks.length : 0 : 0
  }
  return question.points * Math.max(0, Math.min(1, fraction))
}
function visibleQuestion(question: TeachingTestQuestion): TeachingTestQuestion {
  const copy = clone(question)
  delete copy.answer
  delete copy.calculation
  if (copy.gaps) copy.gaps = copy.gaps.map(gap => ({ ...gap, answers: [] }))
  return copy
}

export function clearTeachingTestPractice(test: TeachingTest, userId: string, storage = browserStorage()): void {
  try { storage?.removeItem(keyFor(test, userId)) } catch { /* Storage may be disabled. */ }
}

/** Local simulation only. Never invokes or writes through the real test repository. */
export function createTeachingTestPracticeRepository(test: TeachingTest, userId: string, groupId: string, storage = browserStorage(), now = Date.now): TeachingTestRepository {
  const original = clone(test), key = keyFor(test, userId)
  let snapshot: Snapshot | null = null
  const iso = (time = now()) => new Date(time).toISOString()
  const persist = () => { try { if (snapshot) storage?.setItem(key, JSON.stringify(snapshot)) } catch { /* Continue safely in memory. */ } }
  const read = () => {
    try {
      const raw = storage?.getItem(key)
      if (!raw || raw.length > 4_000_000) return
      const saved = JSON.parse(raw) as Snapshot
      const attempt = saved?.attempt
      if (saved.testVersion !== original.version || !Number.isFinite(saved.createdAt) || now() - saved.createdAt >= DAY || saved.createdAt > now() + 60_000
        || !attempt || attempt.test_id !== original.id || attempt.user_id !== userId || attempt.group_id !== groupId
        || !Array.isArray(saved.questions) || !saved.questions.length || saved.questions.length > 100
        || !attempt.answers || Object.keys(attempt.answers).length > 100 || !attempt.opened_at || !Array.isArray(attempt.locked)
        || !Number.isInteger(attempt.version) || !Number.isInteger(attempt.current_index) || attempt.current_index < 0 || attempt.current_index >= saved.questions.length
        || !Number.isFinite(Date.parse(attempt.expires_at)) || !Number.isFinite(Date.parse(attempt.started_at))
        || !['in_progress', 'submitted'].includes(attempt.status)
        || !questionSets(original).some(set => saved.questions.every(question => set.some(authored => authored.id === question.id)))) return
      snapshot = saved
    } catch { /* Ignore invalid or unavailable local storage. */ }
  }
  const finish = () => {
    if (!snapshot || snapshot.attempt.status === 'submitted') return
    const attempt = snapshot.attempt, ended = Math.min(now(), Date.parse(attempt.expires_at))
    const sum = snapshot.questions.reduce((total, question) => total + points(question, attempt.answers[question.id]), 0)
    attempt.question_results = snapshot.questions.map(question => {
      const score = round(points(question, attempt.answers[question.id]))
      return { question_id: question.id, automatic_points: score, points: score, max_points: question.points, manual: false, mode: 'auto', reason: question.kind === 'essay' ? 'Відкрита відповідь потребує перевірки викладачем.' : '' }
    })
    attempt.auto_score = attempt.score = attempt.practice_score = round(original.max_points * sum / snapshot.questions.reduce((total, question) => total + question.points, 0), 2)
    attempt.requires_manual_review = snapshot.questions.some(question => question.kind === 'essay')
    attempt.status = 'submitted'; attempt.submitted_at = iso(ended); attempt.elapsed_seconds = Math.max(0, (ended - Date.parse(attempt.started_at)) / 1000)
    attempt.bonus_score = 0; attempt.rank = null; attempt.bonus_winner = false; attempt.version++; persist()
  }
  const detail = (): TeachingTestDetail => {
    if (snapshot && now() - snapshot.createdAt >= DAY) snapshot = null
    if (snapshot && Date.parse(snapshot.attempt.expires_at) <= now()) finish()
    const questions = snapshot?.questions || original.questions
    const shown = { ...original, status: 'published' as const, opens_at: iso(now() - 1000), closes_at: iso(now() + DAY), bonus_percent: 0 as const, bonus_points: 0,
      my_attempt: null, questions: questions.map(visibleQuestion), question_count: snapshot ? questions.length : Math.min(questions.length, original.draw_count || questions.length) }
    delete shown.variants
    shown.require_access_code = false
    const attempt = snapshot ? clone(snapshot.attempt) : null
    if (attempt) {
      const question = questions[attempt.current_index]
      attempt.tab_exit_count = snapshot?.tabExitEvents?.length || 0
      attempt.current_question = attempt.status === 'in_progress' ? visibleQuestion(question) : null
      attempt.question_expires_at = question.time_limit_seconds == null ? null : iso(Math.min(Date.parse(attempt.expires_at), Date.parse(attempt.opened_at[question.id]) + question.time_limit_seconds * 1000))
      attempt.questions = questions.map(visibleQuestion); attempt.question_count = questions.length
    }
    return { test: shown, attempt, attempts: [], server_now: iso(), practice: true }
  }
  read()
  return {
    async list(course, group) { return { tests: (!course || course === original.course_id) && (!group || group === groupId) ? [detail().test] : [], server_now: iso() } },
    async detail(id) { if (id !== original.id) return fail('TEST_FORBIDDEN'); read(); return detail() },
    async mutate(action, payload) {
      if (payload.id !== original.id || payload.expected_user_id !== userId || payload.group_id != null && payload.group_id !== groupId) return fail('TEST_FORBIDDEN')
      if (!['start', 'save_answer', 'navigate', 'finish', 'record_tab_exit'].includes(action)) return fail('TEST_FORBIDDEN')
      read(); detail()
      if (action === 'start') {
        if (!snapshot) {
          const generated = variant(original), questions = generated.questions, started = now()
          snapshot = { createdAt: started, testVersion: original.version, questions, attempt: { id: `practice-${globalThis.crypto.randomUUID()}`, test_id: original.id, group_id: groupId, user_id: userId,
            variant_id: generated.index === 0 ? null : original.variants![generated.index - 1].id,
            variant_title: generated.index === 0 ? original.base_variant_title || 'Варіант 1' : original.variants![generated.index - 1].title,
            variant_number: generated.index + 1,
            status: 'in_progress', started_at: iso(started), expires_at: iso(started + Math.min(86_400, Math.max(1, original.duration_seconds)) * 1000), submitted_at: null,
            current_index: 0, answers: {}, opened_at: { [questions[0].id]: iso(started) }, locked: [], version: 1 } }
          persist()
        }
        return detail()
      }
      if (!snapshot) return fail('TEST_FORBIDDEN')
      const attempt = snapshot.attempt, question = snapshot.questions[attempt.current_index]
      if (attempt.status === 'submitted') return detail()
      if (action === 'record_tab_exit') {
        const eventId = payload.event_id
        if (payload.attempt_id !== attempt.id || typeof eventId !== 'string'
          || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(eventId)) return fail('TEST_INVALID_INPUT')
        const events = snapshot.tabExitEvents || []
        if (original.restrict_tab_switch && !events.includes(eventId)) {
          snapshot.tabExitEvents = [...events, eventId]
          if (events.length) { attempt.completion_reason = 'tab_switch'; finish() }
          else persist()
        }
        return detail()
      }
      if (payload.version !== attempt.version) return fail('TEST_CONFLICT')
      const expired = question.time_limit_seconds != null && now() >= Date.parse(attempt.opened_at[question.id]) + question.time_limit_seconds * 1000
      if (action === 'save_answer') {
        if (payload.question_id !== question.id || expired || attempt.locked.includes(question.id)) return fail('TEST_ANSWER_LOCKED')
        if (!validAnswer(question, payload.answer)) return fail('TEST_INVALID_INPUT')
        if (JSON.stringify(attempt.answers[question.id]) !== JSON.stringify(payload.answer ?? null)) { attempt.answers[question.id] = clone(payload.answer ?? null) as Answer; attempt.version++; persist() }
      } else if (action === 'navigate') {
        const index = payload.index as number, next = snapshot.questions[index]
        if (index === attempt.current_index) return detail()
        const answer = attempt.answers[question.id], unanswered = answer == null || answer === '' || typeof answer === 'object' && Object.keys(answer).length === 0
        if (!Number.isInteger(index) || !next || index < attempt.current_index && (!original.allow_return || !owns(attempt.opened_at, next.id))
          || index > attempt.current_index && (index !== attempt.current_index + 1 || !original.allow_skip && unanswered && !expired)) return fail('TEST_NAVIGATION_BLOCKED')
        if ((original.question_timer_policy === 'lock_on_leave' || !original.allow_return || expired) && !attempt.locked.includes(question.id)) attempt.locked.push(question.id)
        attempt.current_index = index
        if (!owns(attempt.opened_at, next.id)) attempt.opened_at[next.id] = iso()
        attempt.version++; persist()
      } else finish()
      return detail()
    },
  }
}
