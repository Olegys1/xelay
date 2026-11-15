// Exercise the real local rehearsal repository with invented questions only.
// No browser, live identity, provider or network is involved.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createTeachingTestPracticeRepository as create, clearAllTeachingTestPractice as clearAll, purgeLegacyTeachingTestPractice as purgeLegacy } from '../../src/lib/teachingTestPractice.ts'

class Storage {
  values = new Map()
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
const NOW = Date.parse('2026-11-11T12:00:00Z')
const q = (kind = 'choice', extra = {}) => ({ id: 'q-' + kind, kind, text: 'PRIVATE_PROMPT_' + kind, points: 1,
  time_limit_seconds: null, partial_credit: false, options: [{ id: 'a', text: 'PRIVATE_OPTION_A' }, { id: 'b', text: 'PRIVATE_OPTION_B' }],
  buckets: [], answer: 'a', ...extra })
const authored = (extra = {}) => ({ id: 'synthetic-test', course_id: 'synthetic-course', title: 'Synthetic future test',
  description: '', status: 'published', opens_at: '2030-01-01T00:00:00Z', closes_at: '2030-01-02T00:00:00Z', duration_seconds: 1200,
  max_points: 5, category: '', journal_date: '2030-01-01', work_type: 'test', allow_skip: true, allow_return: true,
  question_timer_policy: 'continue', restrict_copy: true, bonus_percent: 0, bonus_points: 0, targets: [], questions: [q()],
  question_count: 1, version: 1, has_attempts: false, results_finalized_at: null, review_revision: 0, approved_revision: null, ...extra })
function fixture(source = authored(), storage = new Storage()) {
  let time = NOW
  const repo = create(source, 'teacher', 'group', storage, () => time)
  const act = async (action, fields = {}) => {
    const detail = await repo.detail(source.id)
    return repo.mutate(action, { id: source.id, expected_user_id: 'teacher', group_id: 'group', version: detail.attempt?.version, ...fields })
  }
  return { source, storage, repo, act, advance: ms => { time += ms }, now: () => time }
}
const raw = storage => [...storage.values.values()].join('\n')
const saved = storage => JSON.parse([...storage.values.values()][0])

test('stored progress contains no authored prompts, options, keys, formulas, gap answers or correctness feedback', async () => {
  const source = authored({ questions: [q(), q('cloze', { gaps: [{ id: 'gap', answers: ['PRIVATE_GAP_SOLUTION'] }], answer: undefined }),
    q('calculated', { text: 'PRIVATE_CALC_PROMPT {{x}}', calculation: { formula: 'x*3+17', variables: [{ name: 'x', min: 2, max: 2, step: 1 }] } })] })
  const fx = fixture(source)
  await fx.act('start')
  for (const secret of ['PRIVATE_PROMPT', 'PRIVATE_OPTION', 'PRIVATE_GAP_SOLUTION', 'PRIVATE_CALC_PROMPT', 'x*3+17']) assert.ok(!raw(fx.storage).includes(secret))
  let progress = saved(fx.storage)
  assert.equal(progress.schemaVersion, 2)
  assert.equal(progress.questions, undefined)
  assert.deepEqual(progress.questionRefs.map(x => x.id), source.questions.map(x => x.id))
  assert.ok(progress.questionRefs.every(x => x.answer === undefined && x.text === undefined && x.options === undefined))
  await fx.act('save_answer', { question_id: 'q-choice', answer: 'a' })
  await fx.act('finish')
  progress = saved(fx.storage)
  for (const field of ['question_results', 'auto_score', 'score', 'practice_score', 'final_score', 'questions', 'current_question']) assert.equal(progress.attempt[field], undefined)
  assert.ok(!raw(fx.storage).includes('automatic_points'))
})

test('authorized reload restores frozen subset, option order, calculated values, progress and recomputed result', async t => {
  t.mock.method(Math, 'random', () => 0.7)
  const source = authored({ shuffle_questions: true, shuffle_answers: true, draw_count: 2, questions: [q('choice'),
    q('calculated', { text: 'PRIVATE_CALC {{x}}', calculation: { formula: 'x+10', variables: [{ name: 'x', min: 1, max: 5, step: 1 }] } })] })
  const fx = fixture(source)
  const started = await fx.act('start')
  const current = started.attempt.current_question
  await fx.act('save_answer', { question_id: current.id, answer: current.kind === 'choice' ? 'a' : '13' })
  const reloaded = create(source, 'teacher', 'group', fx.storage, fx.now)
  const before = await fx.repo.detail(source.id), after = await reloaded.detail(source.id)
  assert.deepEqual(after.attempt.questions, before.attempt.questions)
  assert.deepEqual(after.attempt.answers, before.attempt.answers)
  assert.equal(after.attempt.id, before.attempt.id)
  const finished = await fx.act('finish')
  const resumed = await create(source, 'teacher', 'group', fx.storage, fx.now).detail(source.id)
  assert.equal(resumed.attempt.status, 'submitted')
  assert.equal(resumed.attempt.practice_score, finished.attempt.practice_score)
  assert.deepEqual(resumed.attempt.question_results, finished.attempt.question_results)
  assert.equal(resumed.attempt.version, finished.attempt.version)
})

test('redacted student source cannot rehydrate teacher questions even with a copied or renamed descriptor', async () => {
  const fx = fixture()
  await fx.act('start')
  const [key, value] = [...fx.storage.values.entries()][0]
  const copied = JSON.parse(value)
  copied.attempt.user_id = 'student'
  fx.storage.setItem(key.replace(':teacher:', ':student:'), JSON.stringify(copied))
  const student = create({ ...fx.source, can_edit: false, can_review: false, questions: [] }, 'student', 'group', fx.storage, fx.now)
  const detail = await student.detail(fx.source.id)
  assert.equal(detail.attempt, null)
  assert.deepEqual(detail.test.questions, [])
  await assert.rejects(student.mutate('start', { id: fx.source.id, expected_user_id: 'student', group_id: 'group' }), /TEST_INVALID_INPUT/)
})

test('legacy content-bearing snapshots are discarded and never migrated back into storage', async () => {
  const storage = new Storage(), source = authored()
  const old = 'xelay:teacher-practice:v1:teacher:synthetic-test:1'
  const marker = 'xelay:teacher-practice:auth:v1'
  storage.setItem(marker, JSON.stringify({ userId: 'teacher', sessionId: 'synthetic-session' }))
  storage.setItem(old, JSON.stringify({ questions: source.questions, attempt: { user_id: 'teacher' } }))
  const repo = create(source, 'teacher', 'group', storage, () => NOW)
  assert.equal(storage.getItem(old), null)
  assert.deepEqual(JSON.parse(storage.getItem(marker)), { userId: 'teacher', sessionId: 'synthetic-session' })
  assert.equal((await repo.detail(source.id)).attempt, null)
  await repo.mutate('start', { id: source.id, expected_user_id: 'teacher', group_id: 'group' })
  assert.ok(!raw(storage).includes('PRIVATE_PROMPT'))
})

test('logout/account boundary clears every practice key but retains unrelated browser data and fences old repositories', async () => {
  const fx = fixture()
  await fx.act('start')
  fx.storage.setItem('xelay:teacher-practice:v1:another-teacher:old:2', 'LEGACY_PRIVATE_CONTENT')
  fx.storage.setItem('unrelated-setting', 'keep')
  clearAll(fx.storage)
  assert.deepEqual([...fx.storage.values.entries()], [['unrelated-setting', 'keep']])
  await assert.rejects(fx.repo.detail(fx.source.id), /TEST_FORBIDDEN/)
  await assert.rejects(fx.repo.list(), /TEST_FORBIDDEN/)
  await assert.rejects(fx.repo.mutate('start', { id: fx.source.id, expected_user_id: 'teacher', group_id: 'group' }), /TEST_FORBIDDEN/)
  const fresh = create(fx.source, 'teacher', 'group', fx.storage, fx.now)
  assert.equal((await fresh.detail(fx.source.id)).attempt, null)
})

test('global legacy purge removes every old account/test/version without invalidating current progress or auth metadata', async () => {
  const fx = fixture(), started = await fx.act('start')
  const marker = 'xelay:teacher-practice:auth:v1', safeKey = [...fx.storage.values.keys()][0], safeValue = fx.storage.getItem(safeKey)
  fx.storage.setItem(marker, JSON.stringify({ userId: 'teacher', sessionId: 'same-session' }))
  fx.storage.setItem('unrelated-setting', 'keep')
  for (const key of ['xelay:teacher-practice:v1:teacher:other-test:2', 'xelay:teacher-practice:v1:another-teacher:old-test:99']) fx.storage.setItem(key, 'LEGACY_PRIVATE_CONTENT')
  purgeLegacy(fx.storage)
  assert.deepEqual([...fx.storage.values.keys()].sort(), [safeKey, marker, 'unrelated-setting'].sort())
  assert.equal(fx.storage.getItem(safeKey), safeValue)
  assert.deepEqual(JSON.parse(fx.storage.getItem(marker)), { userId: 'teacher', sessionId: 'same-session' })
  assert.equal((await fx.repo.detail(fx.source.id)).attempt.id, started.attempt.id)
})

test('same-session construction purges unrelated legacy keys and resumes the authorized safe snapshot', async () => {
  const fx = fixture(), started = await fx.act('start')
  const marker = 'xelay:teacher-practice:auth:v1'
  fx.storage.setItem(marker, JSON.stringify({ userId: 'teacher', sessionId: 'same-session' }))
  fx.storage.setItem('xelay:teacher-practice:v1:former-teacher:unrelated-test:55', 'LEGACY_PRIVATE_CONTENT')
  const reloaded = create(fx.source, 'teacher', 'group', fx.storage, fx.now)
  assert.ok([...fx.storage.values.keys()].every(key => !key.startsWith('xelay:teacher-practice:v1:')))
  assert.equal((await reloaded.detail(fx.source.id)).attempt.id, started.attempt.id)
  assert.deepEqual(JSON.parse(fx.storage.getItem(marker)), { userId: 'teacher', sessionId: 'same-session' })
})

test('auth generation denies old memory-only repositories even when storage is disabled', async () => {
  const unavailable = { get length() { throw Error('disabled') }, getItem() { throw Error('disabled') }, removeItem() { throw Error('disabled') }, setItem() { throw Error('disabled') } }
  const fx = fixture(authored(), unavailable)
  await fx.act('start')
  clearAll(unavailable)
  await assert.rejects(fx.repo.detail(fx.source.id), /TEST_FORBIDDEN/)
})

test('malformed, foreign, out-of-source, out-of-range and executable descriptors never hydrate', async () => {
  const source = authored({ questions: [q('calculated', { text: '{{x}}', calculation: { formula: 'x+10', variables: [{ name: 'x', min: 1, max: 5, step: 1 }] } })] })
  const changes = [s => { s.attempt.group_id = 'other' }, s => { s.attempt.user_id = 'other' }, s => { s.testVersion++ },
    s => { s.questionRefs[0].id = 'foreign' }, s => { s.questionRefs[0].optionOrder = ['forged'] },
    s => { s.questionRefs[0].variables.x = 999 }, s => { s.questionRefs[0].variables.x = 'process.exit()' },
    s => { s.questionRefs[0].variables.extra = 1 }, s => { s.attempt.answers = { foreign: 'a' } }]
  for (const change of changes) {
    const fx = fixture(source)
    await fx.act('start')
    const [key] = [...fx.storage.values.keys()], progress = saved(fx.storage)
    change(progress); fx.storage.setItem(key, JSON.stringify(progress))
    assert.equal((await create(source, 'teacher', 'group', fx.storage, fx.now).detail(source.id)).attempt, null)
  }
})
