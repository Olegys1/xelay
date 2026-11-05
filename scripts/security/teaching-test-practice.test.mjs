import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createTeachingTestPracticeRepository as create, clearTeachingTestPractice as clear } from '../../src/lib/teachingTestPractice.ts'

class MemoryStorage {
  values = new Map()
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
const option = id => ({ id, text: id })
const question = (kind = 'choice', extra = {}) => ({ id: `q-${kind}`, kind, text: kind, points: 1, time_limit_seconds: null,
  partial_credit: false, options: ['a', 'b', 'c', 'd'].map(option), buckets: [], answer: 'a', ...extra })
const authored = (questions = [question()], extra = {}) => ({ id: 'test', course_id: 'course', title: 'Test', description: '', status: 'draft',
  opens_at: '2030-01-01T00:00:00Z', closes_at: '2030-01-02T00:00:00Z', duration_seconds: 1200, max_points: 20,
  category: '', journal_date: '2026-11-04', work_type: 'test', allow_skip: true, allow_return: true,
  question_timer_policy: 'continue', restrict_copy: true, bonus_percent: 20, bonus_points: 5, targets: [], questions,
  question_count: questions.length, version: 7, has_attempts: false, results_finalized_at: null, review_revision: 0, approved_revision: null, ...extra })
function harness(source = authored(), storage = new MemoryStorage()) {
  let time = Date.parse('2026-11-04T12:00:00Z')
  const repository = create(source, 'teacher', 'group', storage, () => time)
  const mutate = async (action, extra = {}) => {
    const current = await repository.detail(source.id)
    return repository.mutate(action, { id: source.id, expected_user_id: 'teacher', group_id: 'group', version: current.attempt?.version, ...extra })
  }
  return { repository, storage, mutate, advance: milliseconds => { time += milliseconds }, now: () => time }
}
async function answerAll(source, answers) {
  const h = harness(source)
  await h.mutate('start')
  for (let i = 0; i < source.questions.length; i++) {
    if (i) await h.mutate('navigate', { index: i })
    const current = (await h.repository.detail(source.id)).attempt.current_question
    if (answers[current.id] !== undefined) await h.mutate('save_answer', { question_id: current.id, answer: answers[current.id] })
  }
  return (await h.mutate('finish')).attempt
}

test('all ten kinds follow literal server scoring, including negative multiple penalty and manual essay', async () => {
  const questions = [question(), question('boolean', { options: ['a', 'b'].map(option) }),
    question('sorting', { answer: { a: 'x', b: 'y' }, buckets: ['x', 'y'].map(option), partial_credit: true }),
    question('sequence', { answer: ['a', 'b', 'c', 'd'], partial_credit: true }),
    question('multiple', { answer: ['a', 'b'], partial_credit: true }),
    question('short_text', { answer: ['Київ університет'], case_sensitive: false }),
    question('numerical', { answer: '12.5', tolerance: 0.1 }),
    question('calculated', { text: '{{a}} + {{b}}', calculation: { formula: 'a+b*2', variables: [{ name: 'a', min: 2, max: 2, step: 1 }, { name: 'b', min: 3, max: 3, step: 1 }] }, tolerance: 0 }),
    question('cloze', { gaps: [{ id: 'g1', answers: ['Так'] }, { id: 'g2', answers: ['Ні'] }], answer: undefined, partial_credit: true }),
    question('essay')]
  const result = await answerAll(authored(questions, { max_points: 10 }), {
    'q-choice': 'a', 'q-boolean': 'b', 'q-sorting': { a: 'x', b: 'x' }, 'q-sequence': ['a', 'b', 'd', 'c'],
    'q-multiple': ['a', 'b', 'c'], 'q-short_text': '  КИЇВ\t університет ', 'q-numerical': '12,55', 'q-calculated': '8',
    'q-cloze': { g1: ' так ', g2: 'wrong' }, 'q-essay': 'An open response',
  })
  assert.deepEqual(result.question_results.map(item => item.points), [1, 0, 0.5, 0.5, 0.5, 1, 1, 1, 0.5, 0])
  assert.equal(result.auto_score, 6)
  assert.equal(result.practice_score, 6)
  assert.equal(result.requires_manual_review, true)
  assert.equal(result.question_results.at(-1).manual, false)
  assert.match(result.question_results.at(-1).reason, /потребує перевірки/)
  assert.equal(result.published_score, undefined)
  assert.equal(result.bonus_score, 0)
  assert.equal(result.rank, null)
})

test('exact-set, text case, numerical tolerance, and all-or-nothing gap scoring', async () => {
  const questions = [question('multiple', { answer: ['a', 'b'] }), question('short_text', { answer: ['Yes'], case_sensitive: true }),
    question('numerical', { answer: '1', tolerance: 0.01 }), question('cloze', { gaps: [{ id: 'x', answers: ['one'] }, { id: 'y', answers: ['two'] }] })]
  const result = await answerAll(authored(questions, { max_points: 4 }), { 'q-multiple': ['b', 'a'], 'q-short_text': 'yes', 'q-numerical': '1.02', 'q-cloze': { x: 'one' } })
  assert.deepEqual(result.question_results.map(item => item.points), [1, 0, 0, 0])
})

test('practice is isolated, answer keys hidden, repeats resume, reload and optimistic conflict work', async () => {
  const source = authored(), before = structuredClone(source), h = harness(source)
  const first = await h.mutate('start')
  assert.equal(first.practice, true)
  assert.equal(first.test.status, 'published')
  assert.equal(first.attempt.current_question.answer, undefined)
  h.advance(3000)
  const saved = await h.mutate('save_answer', { question_id: 'q-choice', answer: 'a' })
  const repeated = await h.mutate('start')
  assert.equal(repeated.attempt.id, first.attempt.id)
  assert.equal(repeated.attempt.expires_at, first.attempt.expires_at)
  const reloaded = create(source, 'teacher', 'group', h.storage, h.now)
  assert.deepEqual((await reloaded.detail('test')).attempt.answers, { 'q-choice': 'a' })
  await assert.rejects(reloaded.mutate('save_answer', { id: 'test', expected_user_id: 'teacher', version: first.attempt.version, question_id: 'q-choice', answer: 'b' }), /TEST_CONFLICT/)
  assert.equal(saved.attempt.version, first.attempt.version + 1)
  assert.equal((await create(source, 'other', 'group', h.storage, h.now).detail('test')).attempt, null)
  assert.equal((await create({ ...source, version: 8 }, 'teacher', 'group', h.storage, h.now).detail('test')).attempt, null)
  await assert.rejects(h.repository.mutate('save_test', { id: 'test', expected_user_id: 'teacher' }), /TEST_FORBIDDEN/)
  await assert.rejects(h.repository.detail('another'), /TEST_FORBIDDEN/)
  assert.deepEqual(source, before)
})

test('practice freezes the authored variant and handles tab-exit retries without requiring a code', async t => {
  t.mock.method(Math, 'random', () => 0.99)
  const source = authored([question()], {
    require_access_code: true, restrict_tab_switch: true,
    variants: [{ id: 'second', title: 'Другий варіант', questions: [question('choice', { id: 'alternate', answer: 'b' })] }],
  })
  const h = harness(source)
  const started = await h.mutate('start')
  assert.equal(started.test.require_access_code, false)
  assert.equal(started.test.variants, undefined)
  assert.equal(started.attempt.current_question.id, 'alternate')
  const attempt_id = started.attempt.id
  await h.mutate('save_answer', { question_id: 'alternate', answer: 'b' })
  const first = { attempt_id, event_id: crypto.randomUUID() }
  const warned = await h.mutate('record_tab_exit', first)
  assert.equal(warned.attempt.status, 'in_progress')
  assert.equal(warned.attempt.tab_exit_count, 1)
  const reloaded = create(source, 'teacher', 'group', h.storage, h.now)
  const retry = await reloaded.mutate('record_tab_exit', { id: source.id, expected_user_id: 'teacher', ...first })
  assert.equal(retry.attempt.current_question.id, 'alternate')
  assert.equal(retry.attempt.tab_exit_count, 1)
  const ended = await h.mutate('record_tab_exit', { attempt_id, event_id: crypto.randomUUID() })
  assert.equal(ended.attempt.status, 'submitted')
  assert.equal(ended.attempt.completion_reason, 'tab_switch')
  assert.equal(ended.attempt.tab_exit_count, 2)
  assert.equal(ended.attempt.practice_score, 20)
})

test('question timing, no skipping, no forward jump, expired progression, and total auto finish', async () => {
  const h = harness(authored([question('choice', { time_limit_seconds: 5 }), question('boolean'), question('short_text', { answer: ['yes'] })], { allow_skip: false, duration_seconds: 20 }))
  await h.mutate('start')
  await assert.rejects(h.mutate('navigate', { index: 1 }), /TEST_NAVIGATION_BLOCKED/)
  await assert.rejects(h.mutate('navigate', { index: 2 }), /TEST_NAVIGATION_BLOCKED/)
  h.advance(5000)
  await assert.rejects(h.mutate('save_answer', { question_id: 'q-choice', answer: 'a' }), /TEST_ANSWER_LOCKED/)
  const second = await h.mutate('navigate', { index: 1 })
  assert.deepEqual(second.attempt.locked, ['q-choice'])
  await h.mutate('navigate', { index: 0 })
  await assert.rejects(h.mutate('save_answer', { question_id: 'q-choice', answer: 'a' }), /TEST_ANSWER_LOCKED/)
  h.advance(15_000)
  const finished = await h.repository.detail('test')
  assert.equal(finished.attempt.status, 'submitted')
  assert.equal(finished.attempt.elapsed_seconds, 20)
  assert.equal(Date.parse(finished.attempt.submitted_at), h.now())
})

test('continue policy keeps original question time and lock-on-leave/no-return policies are enforced', async () => {
  for (const policy of [{ question_timer_policy: 'continue' }, { question_timer_policy: 'lock_on_leave' }, { allow_return: false }]) {
    const h = harness(authored([question('choice', { time_limit_seconds: 10 }), question('boolean')], policy))
    const start = await h.mutate('start')
    h.advance(2000)
    const next = await h.mutate('navigate', { index: 1 })
    if (policy.allow_return === false) await assert.rejects(h.mutate('navigate', { index: 0 }), /TEST_NAVIGATION_BLOCKED/)
    else {
      const back = await h.mutate('navigate', { index: 0 })
      assert.equal(back.attempt.question_expires_at, start.attempt.question_expires_at)
      if (policy.question_timer_policy === 'lock_on_leave') await assert.rejects(h.mutate('save_answer', { question_id: 'q-choice', answer: 'a' }), /TEST_ANSWER_LOCKED/)
      else assert.equal((await h.mutate('save_answer', { question_id: 'q-choice', answer: 'a' })).attempt.answers['q-choice'], 'a')
    }
    assert.equal(next.attempt.current_index, 1)
  }
})

test('frozen subset and shuffled variants survive reload and explicit clear creates fresh attempt', async () => {
  const source = authored(Array.from({ length: 12 }, (_, i) => question('choice', { id: `q${i}` })), { draw_count: 4, shuffle_questions: true, shuffle_answers: true })
  const h = harness(source)
  assert.equal((await h.repository.detail('test')).test.question_count, 4)
  const start = await h.mutate('start')
  assert.equal(start.attempt.questions.length, 4)
  const loaded = await create(source, 'teacher', 'group', h.storage, h.now).detail('test')
  assert.deepEqual(loaded.attempt.questions, start.attempt.questions)
  clear(source, 'teacher', h.storage)
  const fresh = create(source, 'teacher', 'group', h.storage, h.now)
  assert.equal((await fresh.detail('test')).attempt, null)
  const restarted = await fresh.mutate('start', { id: 'test', expected_user_id: 'teacher', group_id: 'group' })
  assert.notEqual(restarted.attempt.id, start.attempt.id)
})

test('calculated arithmetic rejects executable or unbounded expressions and uses safe fallback', async () => {
  for (const formula of ['globalThis.process.exit()', 'a.constructor', '1/0', '2**3', '1000000000001', `${'('.repeat(40)}1${')'.repeat(40)}`]) {
    const h = harness(authored([question('calculated', { calculation: { formula, variables: [{ name: 'a', min: 1, max: 1, step: 1 }] } })]))
    await assert.rejects(h.mutate('start'), /TEST_INVALID_INPUT/)
  }
  const random = Math.random
  Math.random = () => 0.5
  try {
    const source = authored([question('calculated', { text: '1 / {{a}}', tolerance: 0, calculation: { formula: '1 / a', variables: [{ name: 'a', min: -1, max: 1, step: 1 }] } })])
    const result = await answerAll(source, { 'q-calculated': '-1' })
    assert.equal(result.practice_score, 20)
    assert.equal(result.questions[0].text, '1 / -1')
  } finally { Math.random = random }
})

test('invalid answers are rejected and local snapshots expire after 24 hours', async () => {
  const h = harness()
  await h.mutate('start')
  for (const answer of ['missing', ['a'], { a: 'b' }]) await assert.rejects(h.mutate('save_answer', { question_id: 'q-choice', answer }), /TEST_INVALID_INPUT/)
  assert.equal((await h.mutate('save_answer', { question_id: 'q-choice', answer: undefined })).attempt.answers['q-choice'], null)
  h.advance(86_400_000)
  assert.equal((await h.repository.detail('test')).attempt, null)
  const source = readFileSync(new URL('../../src/lib/teachingTestPractice.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\b(?:eval|Function)\s*\(|\bsupabase\b|\bfetch\s*\(/)
})

test('storage is bounded, version-checked, and optional; decimal tolerance boundary is inclusive', async () => {
  const source = authored([question('numerical', { answer: '0.3', tolerance: 0.1 })])
  assert.equal((await answerAll(source, { 'q-numerical': '0.4' })).practice_score, 20)
  const h = harness(source)
  await h.mutate('start')
  const [key, value] = [...h.storage.values.entries()][0], saved = JSON.parse(value)
  h.storage.setItem(key, JSON.stringify({ ...saved, testVersion: 6 }))
  assert.equal((await create(source, 'teacher', 'group', h.storage, h.now).detail('test')).attempt, null)
  saved.attempt.answers = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`q${i}`, 'answer']))
  h.storage.setItem(key, JSON.stringify(saved))
  assert.equal((await create(source, 'teacher', 'group', h.storage, h.now).detail('test')).attempt, null)
  const unavailable = { getItem() { throw Error('disabled') }, setItem() { throw Error('disabled') }, removeItem() { throw Error('disabled') } }
  const memory = harness(source, unavailable)
  await memory.mutate('start')
  assert.equal((await memory.mutate('save_answer', { question_id: 'q-numerical', answer: '0.3' })).attempt.answers['q-numerical'], '0.3')
})
