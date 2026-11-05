// Executes current runner routing and session handlers against synthetic boundaries.
// No browser, credentials, provider SDK or real RPC is loaded by this harness.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const NOW = Date.parse('2026-11-04T12:00:00.000Z')
const question = id => ({ id, kind: 'choice', text: 'Synthetic question ' + id, points: 1, time_limit_seconds: 30,
  partial_credit: false, options: ['a', 'b', 'c', 'd'].map(id => ({ id, text: 'Synthetic ' + id })), buckets: [], answer: 'b' })
const definition = changes => ({ id: 'synthetic-test', course_id: 'synthetic-course', course_title: 'Synthetic course', title: 'Synthetic test', description: '',
  status: 'published', opens_at: new Date(NOW - 60000).toISOString(), closes_at: new Date(NOW + 3600000).toISOString(), duration_seconds: 1200,
  max_points: 10, category: '', journal_date: '2026-11-04', work_type: 'Тест', allow_skip: true, allow_return: true, question_timer_policy: 'continue',
  restrict_copy: true, bonus_percent: 20, bonus_points: 2, targets: [{ group_id: 'synthetic-group', audience_mode: 'all', subgroup_ids: [] }],
  questions: [question('one'), question('two')], question_count: 2, version: 3, has_attempts: false, results_finalized_at: null, review_revision: 0,
  approved_revision: null, can_edit: true, can_review: true, ...changes })

function runtime() {
  const cells = [], effects = []
  let index = 0, dirty = false, component, props, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; if (!cells[i]) { const cell = { value: typeof initial === 'function' ? initial() : initial }; cell.set = next => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) { cell.value = value; dirty = true } }; cells[i] = cell } return [cells[i].value, cells[i].set] },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial } },
    useCallback(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, callback }; return cells[i].callback },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const previous = cells[i]; cells[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const render = () => { for (let pass = 0; pass < 30; pass++) { index = 0; dirty = false; tree = component(props); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree } throw Error('Synthetic hooks did not settle') }
  return { hooks, render, start(fn, initial) { component = fn; props = initial; return render() }, update(patch) { props = { ...props, ...patch }; return render() },
    get tree() { return tree }, async flush() { for (let pass = 0; pass < 15; pass++) { await Promise.resolve(); render() } }, unmount() { for (const cell of cells) cell?.cleanup?.() } }
}

function harness() {
  let now = NOW, sequence = 0
  const entries = new Map(), intervals = new Map(), timeouts = new Map(), listeners = new Map()
  const localEntries = Object.create(null), visibilityListeners = new Set()
  const localStorage = Object.create({
    getItem: key => localEntries[key] ?? null,
    setItem(key, value) { localEntries[key] = value; this[key] = value },
    removeItem(key) { delete localEntries[key]; delete this[key] },
  })
  const document = { visibilityState: 'visible', addEventListener: (_name, fn) => visibilityListeners.add(fn), removeEventListener: (_name, fn) => visibilityListeners.delete(fn) }
  const sessionStorage = { getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value), removeItem: key => entries.delete(key) }
  class ClockDate extends Date { constructor(...args) { super(...(args.length ? args : [now])) } static now() { return now } }
  const window = { sessionStorage, setInterval: (fn, delay) => { const id = ++sequence; intervals.set(id, { fn, delay }); return id }, clearInterval: id => intervals.delete(id),
    setTimeout: (fn, delay) => { const id = ++sequence; timeouts.set(id, { fn, delay }); return id }, clearTimeout: id => timeouts.delete(id),
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn) }, removeEventListener: (name, fn) => listeners.get(name)?.delete(fn) }
  const jsx = (type, props, key) => ({ type, props: props || {}, key })
  const globals = { Date: ClockDate, window, document, localStorage, crypto: { randomUUID }, console, Intl, URL, structuredClone }
  function evaluate(source, imports, fileName = 'component.tsx') {
    const module = { exports: {} }
    const code = ts.transpileModule(source, { fileName, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
    runInNewContext(code, { ...globals, module, exports: module.exports, require: name => { assert.ok(Object.hasOwn(imports, name), 'Explicit synthetic import: ' + name); return imports[name] } })
    return module.exports
  }
  const practice = evaluate(read('src/lib/teachingTestPractice.ts'), {}, 'practice.ts')
  function mount(name, props) {
    const run = runtime()
    const module = evaluate(read('src/components/teaching/TeachingTestRunner.tsx') + '\nexport { TeachingTestResolver, TeachingTestSession };', {
      react: run.hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_target, key) => String(key) }),
      '../../lib/teaching': { teachingDate: value => value || '' }, '../../lib/teachingTests': { teachingTestError: error => error?.message || String(error) },
      '../../lib/teachingTestPractice': practice, './TeachingUI': { TeachingModal: 'TeachingModal', TeachingButton: 'TeachingButton', TeachingEmpty: 'TeachingEmpty', TeachingField: 'TeachingField', teachingInput: 'input' },
      './TeachingRubrics': { TeachingRubricAssessment: 'TeachingRubricAssessment' }, './teaching-tests.css': {}, './teaching-assessment-phase1.css': {},
      './TeachingTestQuestionImages': { TeachingTestQuestionImages: 'TeachingTestQuestionImages' },
      './useTeachingTestTabGuard': evaluate(read('src/components/teaching/useTeachingTestTabGuard.ts'), { react: run.hooks }, 'guard.ts'),
    })
    run.start(module[name], props)
    return run
  }
  return { mount, entries, async tick(run, milliseconds = 0) { now += milliseconds; for (const { fn } of [...intervals.values()]) fn(); for (const [id, timer] of [...timeouts]) if (timer.delay <= milliseconds) { timeouts.delete(id); timer.fn() } await run.flush() },
    async online(run) { for (const fn of listeners.get('online') || []) fn(); await run.flush() },
    async visibility(run, state) { document.visibilityState = state; for (const fn of [...visibilityListeners]) fn(); await run.flush() },
    get now() { return now } }
}
function boundary(source, options = {}) {
  const calls = { list: [], detail: [], mutate: [] }
  const repository = {
    async list(...args) { calls.list.push(args); return options.list ? options.list(...args) : { tests: [plain(source)], server_now: new Date(NOW).toISOString() } },
    async detail(...args) { calls.detail.push(args); assert.ok(options.detail, 'Staff practice must not call live detail (it can finish real student attempts)'); return options.detail(...args) },
    async mutate(...args) { calls.mutate.push(args); assert.ok(options.mutate, 'Staff practice must not call live mutation'); return options.mutate(...args) },
  }
  return { repository, calls }
}
const props = repository => ({ repository, testId: 'synthetic-test', groupId: 'synthetic-group', userId: 'synthetic-teacher', onClose() {} })
function find(run, predicate) { const node = nodes(run.tree).find(predicate); assert.ok(node, 'Current source control must exist'); return node }
async function click(run, pattern) { const node = find(run, node => node.type === 'TeachingButton' && pattern.test(text(node).trim())); assert.equal(Boolean(node.props.disabled), false, text(node)); node.props.onClick(); await run.flush() }
async function start(run) { find(run, node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); await run.flush(); await click(run, /Почати/) }
const currentSession = resolver => find(resolver, node => typeof node.type === 'function' && node.props.initialDetail)

test('staff practice performs no live detail or mutation during start, answers, refresh, finish and restart', async () => {
  const h = harness(), live = boundary(definition({ status: 'closed', closes_at: new Date(NOW - 1000).toISOString() }))
  const resolver = h.mount('TeachingTestResolver', props(live.repository)); await resolver.flush()
  const first = currentSession(resolver)
  assert.equal(first.props.initialDetail.practice, true)
  assert.equal(first.props.initialDetail.attempt, null)
  const session = h.mount('TeachingTestSession', first.props); await session.flush()
  await start(session)
  find(session, node => node.props?.question?.id === 'one' && node.props.onChange).props.onChange('b'); await session.flush()
  await h.online(session); await h.tick(session)
  const localDetail = first.props.repository.detail
  first.props.repository.detail = async () => { throw Error('Synthetic local refresh failure') }
  await h.online(session)
  assert.match(text(session.tree), /Synthetic local refresh failure/)
  first.props.repository.detail = localDetail
  await click(session, /Оновити дані тесту/)
  await click(session, /^Далі/)
  find(session, node => node.props?.question?.id === 'two' && node.props.onChange).props.onChange('a'); await session.flush()
  await click(session, /^(Здати роботу|Завершити)/)
  await click(session, /^(Так, здати|Так, завершити|Завершити пробне)/)
  assert.match(text(session.tree), /Пробне проходження|Пробу завершено/)
  assert.match(text(session.tree), /5 із 10/)
  assert.doesNotMatch(text(session.tree), /Статус роботи збережено у групі|Викладач перевірить відповіді та опублікує ваш результат/)
  assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, [])
  first.props.onRestart(); await resolver.flush()
  session.unmount()
  const restarted = currentSession(resolver)
  assert.notEqual(restarted.key, first.key)
  assert.equal(restarted.props.initialDetail.attempt, null)
  assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, [])
  assert.equal(live.calls.list.length, 2)
  resolver.unmount()
})

test('whole-test expiry stays local for staff practice', async () => {
  const h = harness(), live = boundary(definition({ duration_seconds: 1 }))
  const resolver = h.mount('TeachingTestResolver', props(live.repository)); await resolver.flush()
  const session = h.mount('TeachingTestSession', currentSession(resolver).props); await session.flush(); await start(session)
  await h.tick(session, 1500)
  assert.match(text(session.tree), /Пробне проходження|Пробу завершено/)
  assert.doesNotMatch(text(session.tree), /Статус роботи збережено у групі/)
  assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, [])
  session.unmount(); resolver.unmount()
})

test('question timeout locks the answer and permits the next question without live calls', async () => {
  const h = harness(), live = boundary(definition({ allow_skip: false, questions: [{ ...question('one'), time_limit_seconds: 1 }, question('two')] }))
  const resolver = h.mount('TeachingTestResolver', props(live.repository)); await resolver.flush()
  const session = h.mount('TeachingTestSession', currentSession(resolver).props); await session.flush(); await start(session)
  await h.tick(session, 1500)
  assert.equal(find(session, node => node.props?.question?.id === 'one' && node.props.onChange).props.disabled, true)
  await click(session, /^Далі/)
  assert.equal(find(session, node => node.props?.question?.id === 'two' && node.props.onChange).props.disabled, false)
  assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, [])
  session.unmount(); resolver.unmount()
})

test('another account never resumes a teacher practice attempt saved in the same tab', async () => {
  const h = harness(), live = boundary(definition())
  const first = h.mount('TeachingTestResolver', props(live.repository)); await first.flush()
  const session = h.mount('TeachingTestSession', currentSession(first).props); await session.flush(); await start(session)
  find(session, node => node.props?.question?.id === 'one' && node.props.onChange).props.onChange('b'); await session.flush()
  assert.equal(h.entries.size, 1)
  session.unmount(); first.unmount()
  const second = h.mount('TeachingTestResolver', { ...props(live.repository), userId: 'synthetic-second-teacher' }); await second.flush()
  assert.equal(currentSession(second).props.initialDetail.attempt, null)
  assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, [])
  second.unmount()
})

test('scoped staff full questions allow practice even when all-target edit/review flags are false', async () => {
  const h = harness(), live = boundary(definition({ can_edit: false, can_review: false }))
  const resolver = h.mount('TeachingTestResolver', props(live.repository)); await resolver.flush()
  assert.equal(currentSession(resolver).props.initialDetail.practice, true)
  assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, [])
  resolver.unmount()
})

test('ordinary students retain real repository and server start authorization', async () => {
  const source = definition({ can_edit: false, can_review: false, questions: [] })
  const detail = { test: source, attempt: null, attempts: [], server_now: new Date(NOW).toISOString() }
  const live = boundary(source, { detail: async () => plain(detail), mutate: async () => { throw Error('TEST_FORBIDDEN') } }), h = harness()
  const resolver = h.mount('TeachingTestResolver', { ...props(live.repository), userId: 'synthetic-student' }); await resolver.flush()
  const current = currentSession(resolver)
  assert.equal(current.props.repository, live.repository)
  assert.equal(Boolean(current.props.initialDetail.practice), false)
  const session = h.mount('TeachingTestSession', current.props); await session.flush(); await start(session)
  assert.equal(live.calls.detail.length, 1)
  assert.equal(live.calls.mutate.length, 1)
  assert.equal(live.calls.mutate[0][0], 'start')
  assert.equal(live.calls.mutate[0][1].expected_user_id, 'synthetic-student')
  assert.match(text(session.tree), /TEST_FORBIDDEN/)
  assert.equal(h.entries.size, 0)
  session.unmount(); resolver.unmount()
})

test('guard warns after one distinct hidden transition, then submits the saved answer', async () => {
  const h = harness()
  const live = boundary(definition({ require_access_code: true, restrict_tab_switch: true, discourage_capture: true }))
  const resolver = h.mount('TeachingTestResolver', props(live.repository)); await resolver.flush()
  const session = h.mount('TeachingTestSession', currentSession(resolver).props); await start(session)
  const questionAnswer = find(session, node => typeof node.type === 'function' && node.type.name === 'QuestionAnswer')
  questionAnswer.props.onChange('b'); await session.flush()

  await h.visibility(session, 'hidden')
  await h.visibility(session, 'hidden')
  await h.visibility(session, 'visible')
  assert.match(text(session.tree), /Наступний вихід автоматично здасть роботу/)
  assert.equal(find(session, node => typeof node.type === 'function' && node.type.name === 'QuestionAnswer').props.answer, 'b')
  assert.ok(find(session, node => node.props?.className === 'teaching-test-watermark'))

  await h.visibility(session, 'hidden')
  await h.visibility(session, 'visible')
  assert.match(text(session.tree), /Роботу автоматично здано після другого виходу/)
  assert.match(text(session.tree), /5 із 10/)
  assert.deepEqual(live.calls.mutate, [])
  session.unmount(); resolver.unmount()
})

test('unacknowledged tab exit survives reopening and retries with the same event ID', async () => {
  const h = harness()
  const source = definition({ restrict_tab_switch: true, can_edit: false, can_review: false, questions: [] })
  const attempt = { id: 'attempt-a', user_id: 'synthetic-student', status: 'in_progress', current_index: 0,
    answers: {}, locked: [], version: 1, current_question: question('one'), expires_at: new Date(NOW + 60000).toISOString() }
  const detail = { test: source, attempt, attempts: [], server_now: new Date(NOW).toISOString() }
  let offline = true
  const live = boundary(source, { detail: async () => plain(detail), mutate: async (action, payload) => {
    assert.equal(action, 'record_tab_exit')
    assert.equal(payload.attempt_id, attempt.id)
    if (offline) throw Error('OFFLINE')
    return plain({ ...detail, attempt: { ...attempt, tab_exit_count: 1 } })
  } })
  const input = { ...props(live.repository), initialDetail: detail, userId: attempt.user_id }
  const session = h.mount('TeachingTestSession', input)
  await h.visibility(session, 'hidden')
  assert.match(text(session.tree), /Перевіряємо стан спроби/)
  session.unmount()
  offline = false
  const reopened = h.mount('TeachingTestSession', input)
  await h.visibility(reopened, 'visible')
  assert.deepEqual(live.calls.mutate.map(([, payload]) => payload.event_id), Array(2).fill(live.calls.mutate[0][1].event_id))
  assert.match(text(reopened.tree), /Наступний вихід автоматично здасть роботу/)
  reopened.unmount()
})

test('late account resolution is ignored and runner keys isolate account identity', async () => {
  const h = harness(), pending = []
  const live = boundary(definition(), { list: () => new Promise(resolve => pending.push(resolve)) })
  const resolver = h.mount('TeachingTestResolver', props(live.repository)); await resolver.flush()
  assert.equal(pending.length, 1)
  resolver.update({ userId: 'synthetic-second-teacher' }); await resolver.flush()
  assert.equal(pending.length, 2)
  pending[1]({ tests: [definition({ title: 'Current account test' })], server_now: new Date(NOW).toISOString() }); await resolver.flush()
  const current = currentSession(resolver)
  assert.equal(current.props.userId, 'synthetic-second-teacher')
  pending[0]({ tests: [definition({ title: 'Stale first account test' })], server_now: new Date(NOW).toISOString() }); await resolver.flush()
  assert.equal(currentSession(resolver).props.initialDetail.test.title, 'Current account test')
  const first = h.mount('TeachingTestRunner', props(live.repository))
  const firstKey = first.tree.key; first.update({ userId: 'synthetic-second-teacher' }); assert.notEqual(first.tree.key, firstKey)
  assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, [])
  first.unmount(); resolver.unmount()
})

test('missing identity or a missing test fails closed without entering any attempt', async () => {
  for (const changes of [{ userId: undefined }, {}]) {
    const h = harness(), live = boundary(definition(), Object.keys(changes).length ? {} : { list: async () => ({ tests: [], server_now: new Date(NOW).toISOString() }) })
    const resolver = h.mount('TeachingTestResolver', { ...props(live.repository), ...changes }); await resolver.flush()
    assert.match(text(resolver.tree), /TEST_FORBIDDEN/)
    assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, []); assert.equal(h.entries.size, 0)
    resolver.unmount()
  }
})
