import * as studentTestArchive from '../../src/lib/studentTestArchive.ts'
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
  const localEntries = Object.create(null), documentListeners = new Map()
  const localStorage = Object.create({
    getItem: key => localEntries[key] ?? null,
    setItem(key, value) { localEntries[key] = value; this[key] = value },
    removeItem(key) { delete localEntries[key]; delete this[key] },
  })
  const fireDocument = name => { for (const fn of documentListeners.get(name) || []) fn() }
  const document = { visibilityState: 'visible', fullscreenElement: null, fullscreenEnabled: true,
    addEventListener(name, fn) { if (!documentListeners.has(name)) documentListeners.set(name, new Set()); documentListeners.get(name).add(fn) },
    removeEventListener: (name, fn) => documentListeners.get(name)?.delete(fn),
    async exitFullscreen() { document.fullscreenElement = null; fireDocument('fullscreenchange') } }
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
  const answerOutbox = evaluate(read('src/lib/teachingTestAnswerOutbox.ts'), {}, 'outbox.ts')
  function mount(name, props) {
    const run = runtime()
    const module = evaluate(read('src/components/teaching/TeachingTestRunner.tsx') + '\nexport { TeachingTestResolver, TeachingTestSession };', {
      react: run.hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_target, key) => String(key) }),
      '../../lib/studentTestArchive': studentTestArchive, '../../lib/teaching': { teachingDate: value => value || '' }, '../../lib/teachingTests': { teachingTestError: error => error?.message || String(error), formatTeachingTestWatermark: attempt => `${attempt.watermark_surname || 'Xelay'} · Спроба №${attempt.attempt_number ?? 1}` },
      '../../lib/teachingTestPractice': practice, './TeachingUI': { TeachingModal: 'TeachingModal', TeachingButton: 'TeachingButton', TeachingEmpty: 'TeachingEmpty', TeachingField: 'TeachingField', teachingInput: 'input' },
      '../../lib/teachingTestAnswerOutbox': answerOutbox,
      './TeachingRubrics': { TeachingRubricAssessment: 'TeachingRubricAssessment' }, './teaching-tests.css': {}, './teaching-assessment-phase1.css': {},
      './TeachingTestQuestionImages': { TeachingTestQuestionImages: 'TeachingTestQuestionImages' },
      './TeachingTestContent': { TeachingTestContent: 'TeachingTestContent' },
      './TeachingTestExitGuard': { TeachingTestExitGuard: 'TeachingTestExitGuard' },
      './useTeachingTestTabGuard': evaluate(read('src/components/teaching/useTeachingTestTabGuard.ts'), { react: run.hooks }, 'guard.ts'),
    })
    run.start(module[name], props)
    return run
  }
  return { mount, entries, localEntries, document, otherTabOutbox: () => evaluate(read('src/lib/teachingTestAnswerOutbox.ts'), {}, 'other-tab-outbox.ts'), advance(milliseconds) { now += milliseconds }, mountFullscreen(run, { refuse = false } = {}) {
    let requests = 0
    const target = { async requestFullscreen() { requests++; if (refuse) throw Error('Not allowed'); document.fullscreenElement = target; fireDocument('fullscreenchange') } }
    find(run, node => node.props.className === 'teaching-test-screen').props.ref.current = target
    return { target, get requests() { return requests } }
  }, async tick(run, milliseconds = 0) { now += milliseconds; for (const { fn } of [...intervals.values()]) fn(); for (const [id, timer] of [...timeouts]) if (timer.delay <= milliseconds) { timeouts.delete(id); timer.fn() } await run.flush() },
    async online(run) { for (const fn of listeners.get('online') || []) fn(); await run.flush() },
    async pagehide(run) { for (const fn of listeners.get('pagehide') || []) fn(); await run.flush() },
    async visibility(run, state) { document.visibilityState = state; fireDocument('visibilitychange'); await run.flush() },
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

test('question images and answer controls have unique stable sibling keys and reset for the next question', async () => {
  const h = harness(), live = boundary(definition())
  const resolver = h.mount('TeachingTestResolver', props(live.repository)); await resolver.flush()
  const session = h.mount('TeachingTestSession', currentSession(resolver).props); await session.flush(); await start(session)
  const keys = () => {
    const section = find(session, node => node.type === 'section' && node.props.className === 'teaching-test-question')
    const children = [section.props.children].flat(Infinity).filter(child => child && typeof child === 'object')
    const keyed = children.filter(child => child.key != null)
    assert.equal(new Set(keyed.map(child => child.key)).size, keyed.length, 'React siblings must never share a key')
    const image = children.find(child => child.type === 'TeachingTestQuestionImages')
    const answer = children.find(child => child.props?.question && child.props.onChange)
    assert.ok(image?.key && answer?.key)
    return { image: image.key, answer: answer.key }
  }
  const first = keys()
  await h.tick(session, 1000)
  assert.deepEqual(keys(), first, 'A timer tick must keep the same question component identities')
  await click(session, /^(Далі|Пропустити)/)
  const next = keys()
  assert.notEqual(next.image, first.image, 'Images reset when the question changes')
  assert.notEqual(next.answer, first.answer, 'Answer controls reset when the question changes')
  session.unmount(); resolver.unmount()
})

test('Start requests browser fullscreen once, leaving the exam exits it, and denial retains a viewport session', async () => {
  for (const refuse of [false, true]) {
    const h = harness(), live = boundary(definition())
    const resolver = h.mount('TeachingTestResolver', props(live.repository)); await resolver.flush()
    const session = h.mount('TeachingTestSession', currentSession(resolver).props)
    const fullscreen = h.mountFullscreen(session, { refuse })
    await start(session)
    assert.equal(fullscreen.requests, 1)
    assert.equal(session.tree.props.viewport, true)
    assert.equal(h.document.fullscreenElement, refuse ? null : fullscreen.target)
    assert.match(text(session.tree), /Запитання\s+1\s+з\s+2/)
    session.unmount()
    assert.equal(h.document.fullscreenElement, null)
    resolver.unmount()
  }
})

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
  const questionNavigation = find(session, node => node.props?.className === 'teaching-test-navigation')
  assert.doesNotMatch(text(questionNavigation), /Здати|Завершити/)
  const earlySubmit = find(session, node => node.props?.className === 'teaching-test-early-submit')
  earlySubmit.props.onClick(); await session.flush()
  assert.match(text(session.tree), /Без відповіді залишилось 1/)
  await click(session, /^Продовжити роботу$/)
  await click(session, /^Далі/)
  find(session, node => node.props?.question?.id === 'two' && node.props.onChange).props.onChange('a'); await session.flush()
  await click(session, /^Завершити пробне проходження$/)
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

test('text answers bypass the typing delay near either deadline and still debounce earlier edits', async () => {
  for (const mode of ['question', 'attempt', 'normal']) {
    const h = harness(), userId = 'synthetic-student'
    const source = definition({ can_edit: false, can_review: false, questions: [] })
    const attempt = { id: 'attempt-one', user_id: userId, group_id: 'synthetic-group', status: 'in_progress',
      answers: {}, locked: [], current_index: 0, version: 1, current_question: { ...question('one'), kind: 'short_text' },
      expires_at: new Date(NOW + (mode === 'attempt' ? 300 : 1200000)).toISOString(),
      question_expires_at: mode === 'question' ? new Date(NOW + 300).toISOString() : null }
    const detail = { test: source, attempt, attempts: [], server_now: new Date(NOW).toISOString() }
    const live = boundary(source, { detail: () => plain(detail), mutate: (action, payload) => {
      assert.equal(action, 'save_answer')
      assert.ok(h.now < Date.parse(attempt.question_expires_at || attempt.expires_at))
      return plain({ ...detail, attempt: { ...attempt, version: 2, answers: { one: payload.answer } }, server_now: new Date(h.now).toISOString() })
    } })
    const session = h.mount('TeachingTestSession', { ...props(live.repository), userId, initialDetail: detail, onRestart() {} })
    const answerField = () => find(session, node => node.props?.question?.id === 'one' && node.props.onChange)
    answerField().props.onChange('початок')
    await session.flush()
    if (mode === 'normal') {
      assert.equal(live.calls.mutate.length, 0)
      answerField().props.onChange('готова відповідь')
      await h.tick(session, 450)
      assert.equal(live.calls.mutate[0][1].answer, 'готова відповідь')
    }
    assert.equal(live.calls.mutate.length, 1, `one save for ${mode}`)
    assert.match(text(session.tree), /Відповіді збережено/)
    session.unmount()
  }
})

test('a submission receipt must not imply that a missing last answer was saved', async () => {
  for (const mode of ['missing', 'saved', 'refresh']) {
    const h = harness(), userId = 'synthetic-student'
    const source = definition({ can_edit: false, can_review: false, questions: [] })
    const attempt = { id: 'attempt-one', user_id: userId, group_id: 'synthetic-group', status: 'in_progress',
      answers: { one: 'a' }, locked: [], current_index: 0, version: 1,
      current_question: { ...question('one'), kind: mode === 'refresh' ? 'short_text' : 'choice' },
      expires_at: new Date(NOW + (mode === 'refresh' ? 3000 : 300)).toISOString() }
    const detail = { test: source, attempt, attempts: [], server_now: new Date(NOW).toISOString() }
    const receipt = plain({ ...detail, attempt: { ...attempt, status: 'submitted', version: 2, current_question: undefined,
      submitted_at: attempt.expires_at, answers: { one: mode === 'saved' ? 'b' : 'a' } } })
    let finishRefresh
    const refresh = new Promise(resolve => { finishRefresh = resolve })
    const live = boundary(source, { detail: () => refresh, mutate: () => receipt })
    const session = h.mount('TeachingTestSession', { ...props(live.repository), userId, initialDetail: detail, onRestart() {} })
    if (mode === 'refresh') await h.online(session)
    find(session, node => node.props?.question?.id === 'one' && node.props.onChange).props.onChange('b')
    await session.flush()
    if (mode === 'refresh') {
      finishRefresh(receipt)
      await session.flush()
      await h.tick(session, 450)
      assert.equal(live.calls.mutate.length, 0)
    }
    assert.match(text(session.tree), /Роботу здано/)
    assert.equal(session.tree.props.busy, false)
    const alert = nodes(session.tree).find(node => node.props?.role === 'alert')
    if (mode === 'saved') assert.equal(alert, undefined)
    else {
      assert.match(text(alert), /Останню відповідь не збережено/)
      assert.doesNotMatch(text(alert), /Повторити збереження/)
    }
    session.unmount()
  }
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

test('module family and current-publication links retain the authorized student repository', async () => {
  for (const testId of ['family-root', 'current-publication']) {
    const h = harness(), source = definition({ id: 'preferred-publication', publication_family_id: 'family-root', current_publication_id: 'current-publication', can_edit: false, can_review: false, questions: [] })
    const detail = { test: { ...source, id: 'current-publication' }, attempt: null, attempts: [], server_now: new Date(NOW).toISOString() }
    const live = boundary(source, { detail: async id => { assert.equal(id, testId); return plain(detail) }, mutate: async () => plain(detail) })
    const resolver = h.mount('TeachingTestResolver', { ...props(live.repository), testId, userId: 'synthetic-student' }); await resolver.flush()
    const current = currentSession(resolver)
    assert.equal(current.props.repository, live.repository)
    assert.equal(Boolean(current.props.initialDetail.practice), false)
    const session = h.mount('TeachingTestSession', current.props); await session.flush(); await start(session)
    assert.equal(live.calls.mutate[0][1].id, testId)
    assert.equal(live.calls.mutate[0][1].expected_user_id, 'synthetic-student')
    session.unmount(); resolver.unmount()
  }
})

test('an old intermediate module link is accepted only as an explicit alias of a listed student family', async () => {
  const h = harness(), source = definition({ id: 'current-publication', publication_family_id: 'family-root', current_publication_id: 'current-publication', publication_alias_ids: ['old-intermediate-publication'], can_edit: false, can_review: false, questions: [] })
  const detail = { test: { ...source, id: 'old-intermediate-publication' }, attempt: null, attempts: [], server_now: new Date(NOW).toISOString() }
  const live = boundary(source, { detail: async id => { assert.equal(id, 'old-intermediate-publication'); return plain(detail) } })
  const resolver = h.mount('TeachingTestResolver', { ...props(live.repository), testId: 'old-intermediate-publication', userId: 'synthetic-student' }); await resolver.flush()
  assert.equal(currentSession(resolver).props.repository, live.repository)
  assert.equal(currentSession(resolver).props.initialDetail.test.id, 'old-intermediate-publication')
  assert.deepEqual(live.calls.detail, [['old-intermediate-publication']])
  assert.deepEqual(live.calls.mutate, [])
  resolver.unmount()
})

test('an authorized old alias rejects foreign detail families', async () => {
  for (const changes of [{ publication_family_id: 'foreign-family' }, { can_edit: true }, { can_review: true }]) {
    const h = harness(), source = definition({ id: 'current-publication', publication_family_id: 'family-root', publication_alias_ids: ['old-intermediate-publication'], can_edit: false, can_review: false, questions: [] })
    const detail = { test: { ...source, id: 'old-intermediate-publication', ...changes }, attempt: null, attempts: [], server_now: new Date(NOW).toISOString() }
    const live = boundary(source, { detail: async () => plain(detail) })
    const resolver = h.mount('TeachingTestResolver', { ...props(live.repository), testId: 'old-intermediate-publication', userId: 'synthetic-student' }); await resolver.flush()
    assert.match(text(resolver.tree), /TEST_FORBIDDEN/)
    assert.deepEqual(live.calls.mutate, []); assert.equal(h.entries.size, 0)
    resolver.unmount()
  }
})

test('staff family links rehearse the listed physical publication without any live detail or mutation', async () => {
  const h = harness(), live = boundary(definition({ id: 'current-publication', publication_family_id: 'family-root', current_publication_id: 'current-publication' }))
  const resolver = h.mount('TeachingTestResolver', { ...props(live.repository), testId: 'family-root' }); await resolver.flush()
  const current = currentSession(resolver)
  assert.equal(current.props.initialDetail.practice, true)
  assert.equal(current.props.testId, 'current-publication')
  const session = h.mount('TeachingTestSession', current.props); await session.flush(); await start(session)
  assert.equal(current.props.initialDetail.test.id, 'current-publication')
  assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, [])
  session.unmount(); resolver.unmount()
})

test('unlisted staff intermediate links and mismatched direct student details fail closed', async () => {
  const h = harness(), staff = boundary(definition({ id: 'current-publication', publication_family_id: 'family-root' }))
  const rehearsal = h.mount('TeachingTestResolver', { ...props(staff.repository), testId: 'old-intermediate-publication' }); await rehearsal.flush()
  assert.match(text(rehearsal.tree), /TEST_FORBIDDEN/)
  assert.deepEqual(staff.calls.detail, []); assert.deepEqual(staff.calls.mutate, [])
  rehearsal.unmount()
  const source = definition({ publication_family_id: 'family-root', can_edit: false, can_review: false, questions: [] })
  const student = boundary(source, { detail: async () => ({ test: { ...source, publication_family_id: 'foreign-family' }, attempt: null, attempts: [], server_now: new Date(NOW).toISOString() }) })
  const resolver = h.mount('TeachingTestResolver', { ...props(student.repository), userId: 'synthetic-student' }); await resolver.flush()
  assert.match(text(resolver.tree), /TEST_FORBIDDEN/)
  assert.deepEqual(student.calls.mutate, [])
  resolver.unmount()
})

test('a dual-role account never probes an unknown staff URL through an unrelated student card', async () => {
  const h = harness(), source = definition({ id: 'own-staff-publication', publication_family_id: 'own-staff-family' })
  const student = definition({ id: 'other-student-publication', publication_family_id: 'other-student-family', can_edit: false, can_review: false, questions: [] })
  const live = boundary(source, { list: async () => ({ tests: [plain(source), plain(student)], server_now: new Date(NOW).toISOString() }) })
  const resolver = h.mount('TeachingTestResolver', { ...props(live.repository), testId: 'unknown-old-staff-publication' }); await resolver.flush()
  assert.match(text(resolver.tree), /TEST_FORBIDDEN/)
  assert.deepEqual(live.calls.detail, []); assert.deepEqual(live.calls.mutate, []); assert.equal(h.entries.size, 0)
  resolver.unmount()
})

test('personal retake answers, navigation and submission stay bound to their child test and issued attempt', async () => {
  const h=harness(),source=definition({id:'personal-retake',is_personal_retake:true,retake_parent_id:'original-test',retake_parent_title:'Початковий тест',retake_number:2,can_edit:false,can_review:false,questions:[],question_count:2,bonus_percent:0})
  const safeQuestion=id=>{const {answer:_key,...safe}=question(id);return safe}
  let attempt=null
  const at=new Date(NOW).toISOString()
  const live=boundary(source,{detail:async()=>plain({test:source,attempt,attempts:[],server_now:at}),mutate:async(action,payload)=>{
    assert.equal(payload.id,'personal-retake')
    if(action==='start'){
      assert.equal(payload.attempt_id,undefined)
      attempt={id:'issued-retake-attempt',test_id:'personal-retake',group_id:'synthetic-group',user_id:'synthetic-student',status:'in_progress',started_at:at,expires_at:new Date(NOW+60000).toISOString(),current_index:0,current_question:safeQuestion('one'),question_count:2,opened_at:{one:at},locked:[],version:1,answers:{}}
    }else{
      assert.equal(payload.attempt_id,'issued-retake-attempt','no old tab can rely only on a recycled version number')
      if(action==='save_answer')attempt={...attempt,version:attempt.version+1,answers:{...attempt.answers,[payload.question_id]:payload.answer}}
      if(action==='navigate')attempt={...attempt,version:attempt.version+1,current_index:payload.index,current_question:safeQuestion('two')}
      if(action==='finish')attempt={...attempt,version:attempt.version+1,status:'submitted',submitted_at:at,current_question:null}
    }
    return plain({test:source,attempt,attempts:[],server_now:at})
  }})
  const session=h.mount('TeachingTestSession',{...props(live.repository),testId:source.id,userId:'synthetic-student',initialDetail:{test:source,attempt:null,attempts:[],server_now:at}})
  assert.match(text(session.tree),/Повторна спроба №\s*2/)
  await start(session)
  find(session,node=>node.props?.question?.id==='one'&&node.props.onChange).props.onChange('b');await session.flush()
  await click(session,/^Далі/)
  find(session,node=>node.props?.question?.id==='two'&&node.props.onChange).props.onChange('a');await session.flush()
  await click(session,/^Перейти до здачі роботи$/);await click(session,/^Так, здати роботу$/)
  assert.deepEqual(live.calls.mutate.map(([action])=>action),['start','save_answer','navigate','save_answer','finish'])
  assert.match(text(session.tree),/Роботу здано/)
  assert.deepEqual(attempt.answers,{one:'b',two:'a'})
  assert.equal(h.entries.size,0);session.unmount()
})

test('student history exposes only its published attempt results and distinguishes the preserved best grade',async()=>{
  const h=harness(),source=definition({is_personal_retake:true,retake_number:3,retake_parent_id:'original-test',retake_parent_title:'Початковий тест',retake_published_at:new Date(NOW).toISOString(),retake_published_score:4,retake_best_published_score:8,questions:[],can_edit:false,can_review:false})
  const attempt={id:'third',user_id:'synthetic-student',status:'submitted',started_at:new Date(NOW).toISOString(),submitted_at:new Date(NOW).toISOString(),published_score:4,grade_published_at:new Date(NOW).toISOString(),answers:{},locked:[],current_index:1,version:3}
  const history=[{...attempt,id:'first',attempt_number:1,published_score:8,variant_title:'Перший набір',variant_number:1},{...attempt,id:'second',attempt_number:2,published_score:null,grade_published_at:null,auto_score:9,answers:{one:'PRIVATE_UNPUBLISHED_ANSWER'},questions:[{text:'PRIVATE_UNPUBLISHED_QUESTION'}]},attempt]
  const live=boundary(source)
  const session=h.mount('TeachingTestSession',{...props(live.repository),userId:'synthetic-student',initialDetail:{test:source,attempt,attempts:[],attempt_history:history,server_now:new Date(NOW).toISOString()}});await session.flush()
  assert.match(text(session.tree),/Результат цієї спроби:\s+4\s+із\s+10/)
  assert.match(text(session.tree),/Найкращий опублікований бал у журналі:\s+8/)
  assert.match(text(session.tree),/Історія ваших спроб/)
  assert.match(text(session.tree),/Результат цієї спроби ще не опубліковано/)
  assert.doesNotMatch(text(session.tree),/PRIVATE_UNPUBLISHED|9 із 10/)
  assert.equal(live.calls.mutate.length,0);session.unmount()
})

test('the original student card labels the family best while a personal retake card keeps its own published result',async()=>{
  const h=harness(),at=new Date(NOW).toISOString()
  const root=definition({questions:[],can_edit:false,can_review:false,my_attempt:{id:'original-attempt',status:'submitted',submitted_at:at,published_score:10,grade_published_at:at}})
  const child={...root,id:'personal-child',is_personal_retake:true,retake_parent_id:root.id,retake_number:3,my_attempt:{...root.my_attempt,id:'third-attempt',published_score:3}}
  const live=boundary(root,{list:async()=>({tests:[root,child],server_now:at})})
  const list=h.mount('TeachingGroupTests',{repository:live.repository,groupId:'synthetic-group',userId:'synthetic-student'});await list.flush()
  const cards=nodes(list.tree).filter(node=>node.type==='article'&&node.props.className==='teaching-card teaching-student-test-card')
  assert.match(text(cards[0]),/Найкращий опублікований бал 10 із 10/)
  assert.match(text(cards[1]),/Результат 3 із 10/)
  assert.doesNotMatch(text(cards[1]),/Найкращий опублікований бал 3/)
  assert.equal(live.calls.mutate.length,0);list.unmount()
})

test('owner QA first exit uses the strict attempt-bound RPC payload and preserves an unsent answer', async () => {
  const h = harness()
  const source = definition({ qa_own_attempt: true, qa_can_start: true, restrict_tab_switch: true,
    questions: [], can_edit: false, can_review: false, question_count: 1 })
  const question = { id: 'one', kind: 'essay', text: 'Synthetic QA edit', points: 1,
    time_limit_seconds: null, options: [], buckets: [], partial_credit: false }
  let attempt = { id: 'qa-exit', user_id: 'synthetic-teacher', group_id: 'synthetic-group', status: 'in_progress',
    current_index: 0, question_count: 1, current_question: question, version: 1, answers: {}, locked: [],
    expires_at: new Date(NOW + 60000).toISOString() }
  const calls = []
  const detail = () => plain({ test: source, attempt, attempts: [], server_now: new Date(NOW).toISOString() })
  const repository = {
    list() { throw Error('QA cannot read teacher list') },
    detail() { throw Error('QA cannot read teacher detail') },
    mutate() { throw Error('QA cannot call ordinary mutations') },
    async qaStudent(action, payload) {
      calls.push({ action, payload: plain(payload) })
      assert.equal(payload.id, 'synthetic-test')
      assert.equal(payload.expected_user_id, 'synthetic-teacher')
      if (action === 'detail') return detail()
      assert.equal(action, 'record_tab_exit')
      assert.deepEqual(Object.keys(payload).sort(), ['attempt_id', 'event_id', 'expected_user_id', 'id', 'pending_answer'])
      assert.equal(payload.attempt_id, attempt.id)
      assert.equal(payload.pending_answer.question_id, 'one')
      assert.equal(payload.pending_answer.version, attempt.version)
      attempt = { ...attempt, answers: { one: payload.pending_answer.answer }, version: 2, status: 'submitted',
        submitted_at: new Date(NOW).toISOString(), current_question: null, completion_reason: 'tab_switch', tab_exit_count: 1 }
      return detail()
    },
  }
  let closed = 0
  const resolver = h.mount('TeachingTestResolver', { ...props(repository), qa: true, onClose() { closed++ } })
  await resolver.flush()
  const session = h.mount('TeachingTestSession', currentSession(resolver).props); await session.flush()
  find(session, node => node.props?.question?.id === 'one').props.onChange('Synthetic newest QA answer')
  await session.flush()
  find(session, node => node.type === 'TeachingModal').props.onClose(); await session.flush()
  await click(session, /^Так, здати роботу та вийти$/)
  assert.equal(attempt.answers.one, 'Synthetic newest QA answer')
  assert.equal(attempt.status, 'submitted')
  assert.equal(closed, 1)
  assert.deepEqual(calls.map(call => call.action), ['detail', 'record_tab_exit'])
  assert.equal(Object.keys(h.localEntries).length, 0)
  session.unmount(); resolver.unmount()
})

test('a rejected confirmed exit shows its actual reason inside the blocking warning and never claims success', async () => {
  const h = harness()
  const fx = exitSession(h, { mutate() { throw Error('TEST_FORBIDDEN') } })
  find(fx.session, node => node.type === 'TeachingModal').props.onClose(); await fx.session.flush()
  await click(fx.session, /^Так, здати роботу та вийти$/)
  const warning = find(fx.session, node => node.props?.title === 'Якщо вийду, роботу буде здано')
  assert.match(text(warning), /TEST_FORBIDDEN/)
  assert.match(text(warning), /Сервер ще не підтвердив здачу/)
  assert.doesNotMatch(text(warning), /Якщо зв’язок перервався/)
  assert.equal(fx.closes, 0)
  assert.equal(Object.keys(h.localEntries).length, 1, 'unconfirmed exit identity must remain durable')
  assert.doesNotMatch(text(fx.session.tree), /Роботу здано після виходу з тесту/)
  fx.session.unmount()
})

test('permanent exit rejection pauses automatic retries but an explicit retry keeps the same attempt and event', async () => {
  for (const failure of [Error('TEST_INVALID_INPUT'), Error('TEST_QA_FORBIDDEN'), { code: '42501', message: 'permission denied' }]) {
    const h = harness(); let denied = true
    const fx = exitSession(h, { mutate(action, payload, api) { if (denied) throw failure; return api.submit(action, payload) } })
    find(fx.session, node => node.type === 'TeachingModal').props.onClose(); await fx.session.flush()
    await click(fx.session, /^Так, здати роботу та вийти$/)
    assert.equal(fx.live.calls.mutate.length, 1)
    const event = fx.live.calls.mutate[0][1].event_id
    assert.match(text(find(fx.session, node => node.props?.title === 'Якщо вийду, роботу буде здано')), /Автоматичні повтори призупинено/)
    await h.tick(fx.session, 2500); await h.online(fx.session); await h.visibility(fx.session, 'hidden'); await h.visibility(fx.session, 'visible')
    assert.equal(fx.live.calls.mutate.length, 1, 'repeated timer, online and visibility events must not flood a rejected action')
    assert.equal(fx.closes, 0)
    assert.equal(Object.keys(h.localEntries).length, 1)
    denied = false
    await click(fx.session, /^Повторити здачу та вийти$/)
    assert.equal(fx.live.calls.mutate.length, 2)
    assert.equal(fx.live.calls.mutate[1][1].event_id, event)
    assert.equal(fx.live.calls.mutate[1][1].attempt_id, fx.live.calls.mutate[0][1].attempt_id)
    assert.equal(fx.closes, 1)
    assert.equal(Object.keys(h.localEntries).length, 0)
    fx.session.unmount()
  }
})

test('a rejected actual tab switch has a manual recovery control and never clears the pending edit or exit', async () => {
  const h = harness(); let denied = true
  const fx = exitSession(h, { mutate(action, payload, api) { if (denied) throw Error('TEST_FORBIDDEN'); return api.submit(action, payload) } })
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Synthetic retained last answer')
  await fx.session.flush(); await h.visibility(fx.session, 'hidden')
  const event = fx.live.calls.mutate[0][1].event_id
  assert.equal(find(fx.session, node => node.props?.question?.id === 'one').props.disabled, true)
  assert.match(text(fx.session.tree), /Сервер відхилив здачу/)
  await h.tick(fx.session, 5000)
  assert.equal(fx.live.calls.mutate.length, 1)
  denied = false
  await click(fx.session, /^Перевірити здачу$/)
  assert.equal(fx.live.calls.mutate[1][1].event_id, event)
  assert.equal(fx.live.calls.mutate[1][1].pending_answer.answer, 'Synthetic retained last answer')
  assert.match(text(fx.session.tree), /Роботу здано після виходу/)
  assert.equal(Object.keys(h.localEntries).length, 0)
  fx.session.unmount()
})

test('explicit QA uses the scoped student RPC for a real save, submission and published receipt', async () => {
  const h = harness()
  const staff = definition({ qa_own_attempt: true, qa_can_start: true, question_count: 1 })
  const student = { ...staff, questions: [], can_edit: false, can_review: false }
  const { answer: _key, ...currentQuestion } = question('one')
  const at = new Date(NOW).toISOString()
  const calls = []
  let attempt = null
  const repository = {
    list() { throw Error('QA must not read the teacher list') },
    detail() { throw Error('QA must not read the teacher detail') },
    mutate() { throw Error('QA must not call teacher mutations') },
    async qaStudent(action, payload) {
      calls.push({ action, payload: plain(payload) })
      if (action === 'start') attempt = { id: 'qa-attempt', group_id: 'synthetic-group', user_id: 'synthetic-teacher', status: 'in_progress',
        started_at: at, expires_at: new Date(NOW + 60000).toISOString(), current_question: currentQuestion, current_index: 0,
        question_count: 1, opened_at: { one: at }, locked: [], version: 1, answers: {} }
      if (action === 'save_answer') attempt = { ...attempt, version: 2, answers: { one: payload.answer } }
      if (action === 'finish') attempt = { ...attempt, version: 3, status: 'submitted', submitted_at: at, current_question: null }
      return plain({ test: student, attempt, attempts: [], server_now: at })
    },
  }
  const resolver = h.mount('TeachingTestResolver', { ...props(repository), qa: true }); await resolver.flush()
  const session = h.mount('TeachingTestSession', currentSession(resolver).props); await session.flush(); await start(session)
  find(session, node => node.props?.question?.id === 'one' && node.props.onChange).props.onChange('b'); await session.flush()
  await click(session, /^Перейти до здачі роботи$/)
  await click(session, /^(Так, здати|Так, завершити)/)
  assert.match(text(session.tree), /Роботу здано/)
  assert.match(text(session.tree), /Очікує перевірки/)
  assert.equal(attempt.answers.one, 'b')
  assert.deepEqual(calls.map(call => call.action), ['detail', 'start', 'save_answer', 'finish'])
  for (const { payload } of calls) {
    assert.equal(payload.id, 'synthetic-test')
    assert.equal(payload.group_id, 'synthetic-group')
    assert.equal(payload.expected_user_id, 'synthetic-teacher')
  }
  assert.equal(h.entries.size, 0, 'real QA must not use the local rehearsal store')
  session.unmount(); resolver.unmount()
  attempt = { ...attempt, published_score: 10, grade_published_at: at }
  const reopened = h.mount('TeachingTestResolver', { ...props(repository), qa: true }); await reopened.flush()
  const receipt = h.mount('TeachingTestSession', currentSession(reopened).props); await receipt.flush()
  assert.match(text(receipt.tree), /Ваш тестовий бал\s+10 із 10/)
  receipt.unmount(); reopened.unmount()
})

test('first distinct hidden transition submits the saved answer without a free first exit', async () => {
  const h = harness()
  const live = boundary(definition({ require_access_code: true, restrict_tab_switch: true, discourage_capture: true }))
  const resolver = h.mount('TeachingTestResolver', props(live.repository)); await resolver.flush()
  const session = h.mount('TeachingTestSession', currentSession(resolver).props); await start(session)
  const questionAnswer = find(session, node => typeof node.type === 'function' && node.type.name === 'QuestionAnswer')
  questionAnswer.props.onChange('b'); await session.flush()
  assert.ok(find(session, node => node.props?.className === 'teaching-test-watermark'))

  await h.visibility(session, 'hidden')
  await h.visibility(session, 'hidden')
  await h.visibility(session, 'visible')
  assert.match(text(session.tree), /Роботу здано після виходу з тесту/)
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
    return plain({ ...detail, attempt: { ...attempt, status: 'submitted', current_question: null, submitted_at: new Date(NOW).toISOString(), tab_exit_count: 1, completion_reason: 'tab_switch' } })
  } })
  const input = { ...props(live.repository), initialDetail: detail, userId: attempt.user_id }
  const session = h.mount('TeachingTestSession', input)
  await h.visibility(session, 'hidden')
  assert.match(text(session.tree), /Вихід із тесту зафіксовано/)
  session.unmount()
  offline = false
  const reopened = h.mount('TeachingTestSession', input)
  await h.visibility(reopened, 'visible')
  assert.deepEqual(live.calls.mutate.map(([, payload]) => payload.event_id), Array(2).fill(live.calls.mutate[0][1].event_id))
  assert.match(text(reopened.tree), /Роботу здано після виходу з тесту/)
  reopened.unmount()
})

function exitSession(h, options = {}) {
  const currentQuestion = { ...question('one'), kind: 'essay', time_limit_seconds: null, options: [], answer: undefined, ...options.question }
  const source = definition({ restrict_tab_switch: options.restricted !== false, can_edit: false, can_review: false, questions: [], question_count: 1 })
  let attempt = { id: 'attempt-exit', test_id: source.id, user_id: 'synthetic-student', status: 'in_progress', current_index: 0,
    answers: options.answers || {}, locked: [], opened_at: { one: new Date(NOW).toISOString() }, question_count: 1, version: 1,
    current_question: currentQuestion, expires_at: new Date(NOW + 60000).toISOString() }
  const detail = () => plain({ test: source, attempt, attempts: [], server_now: new Date(NOW).toISOString() })
  const live = boundary(source, { detail: async () => detail(), mutate: async (action, payload) => {
    if (options.mutate) return options.mutate(action, payload, { detail, get attempt() { return attempt }, submit, save, expire })
    return submit(action, payload)
  } })
  function submit(action, payload) {
    assert.equal(action, 'record_tab_exit')
    assert.equal(payload.attempt_id, attempt.id)
    const last = payload.pending_answer
    if (last) { assert.equal(last.version, attempt.version); attempt = { ...attempt, answers: { ...attempt.answers, [last.question_id]: last.answer } } }
    attempt = { ...attempt, status: 'submitted', version: attempt.version + 1, tab_exit_count: 1, completion_reason: 'tab_switch', submitted_at: new Date(NOW).toISOString(), current_question: null }
    return detail()
  }
  function save(payload) {
    assert.equal(payload.version, attempt.version)
    attempt = { ...attempt, answers: { ...attempt.answers, [payload.question_id]: payload.answer }, version: attempt.version + 1 }
    return detail()
  }
  function expire() {
    attempt = { ...attempt, status: 'submitted', version: attempt.version + 1, tab_exit_count: 0, completion_reason: null, submitted_at: attempt.expires_at, current_question: null }
    return detail()
  }
  let closes = 0
  const session = h.mount('TeachingTestSession', { ...props(live.repository), initialDetail: detail(), userId: attempt.user_id, onClose() { closes++ } })
  return { session, live, get closes() { return closes } }
}

test('cancelling a close or route warning stays in the active attempt without recording an exit', async () => {
  const h = harness(), fx = exitSession(h)
  const parent = find(fx.session, node => node.type === 'TeachingModal')
  parent.props.onClose(); await fx.session.flush()
  assert.ok(find(fx.session, node => node.props?.title === 'Якщо вийду, роботу буде здано'))
  await click(fx.session, /^Залишитися в тесті$/)
  assert.equal(fx.live.calls.mutate.length, 0); assert.equal(fx.closes, 0)
  const guard = find(fx.session, node => node.type === 'TeachingTestExitGuard')
  const requested = guard.props.requestLeave(); await fx.session.flush()
  await click(fx.session, /^Залишитися в тесті$/)
  assert.equal(await requested, false)
  assert.equal(fx.live.calls.mutate.length, 0)
  assert.ok(find(fx.session, node => node.props?.question?.id === 'one'))
  fx.session.unmount()
})

test('confirmed close sends the newest debounced answer atomically before leaving', async () => {
  const h = harness(), fx = exitSession(h)
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Synthetic latest unsent answer')
  await fx.session.flush()
  find(fx.session, node => node.type === 'TeachingModal').props.onClose(); await fx.session.flush()
  assert.equal(fx.live.calls.mutate.length, 0)
  await click(fx.session, /^Так, здати роботу та вийти$/)
  assert.deepEqual(fx.live.calls.mutate.map(([action]) => action), ['record_tab_exit'])
  assert.equal(fx.live.calls.mutate[0][1].pending_answer.answer, 'Synthetic latest unsent answer')
  assert.equal(fx.closes, 1)
  assert.equal(Object.keys(h.localEntries).length, 0)
  fx.session.unmount()
})

test('first hide retries one opaque exit identity while its own answer survives in the separate scoped outbox', async () => {
  const h = harness(); let offline = true
  const fx = exitSession(h, { mutate(action, payload, api) { if (offline) throw Error('OFFLINE'); return api.submit(action, payload) } })
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('PRIVATE_SYNTHETIC_LAST_EDIT')
  await fx.session.flush(); await h.visibility(fx.session, 'hidden')
  assert.equal(fx.live.calls.mutate.length, 1)
  assert.equal(fx.live.calls.mutate[0][1].pending_answer.answer, 'PRIVATE_SYNTHETIC_LAST_EDIT')
  const exitEntries = Object.entries(h.localEntries).filter(([key]) => key.startsWith('xelay-test-tab-exit:'))
  assert.doesNotMatch(JSON.stringify(exitEntries), /PRIVATE_SYNTHETIC_LAST_EDIT|pending_answer|question_id|answer/)
  assert.equal(exitEntries.length, 1)
  const answerEntries = Object.entries(h.localEntries).filter(([key]) => key.startsWith('xelay:teaching-answer-outbox:'))
  assert.equal(answerEntries.length, 1)
  assert.match(JSON.stringify(answerEntries), /PRIVATE_SYNTHETIC_LAST_EDIT/)
  assert.doesNotMatch(JSON.stringify(answerEntries), /Synthetic question|correct|options|expires_at/)
  await h.visibility(fx.session, 'visible'); await h.visibility(fx.session, 'hidden')
  offline = false; await h.online(fx.session)
  const ids = fx.live.calls.mutate.map(([, payload]) => payload.event_id)
  assert.ok(ids.length >= 2); assert.equal(new Set(ids).size, 1)
  assert.equal(fx.live.calls.mutate.at(-1)[1].pending_answer.answer, 'PRIVATE_SYNTHETIC_LAST_EDIT')
  assert.match(text(fx.session.tree), /Роботу здано після виходу з тесту/)
  assert.equal(Object.keys(h.localEntries).length, 0)
  fx.session.unmount()
})

test('an initially hidden hydrated attempt is armed only after a visible-to-hidden transition', async () => {
  const h = harness(); h.document.visibilityState = 'hidden'
  const fx = exitSession(h)
  await h.visibility(fx.session, 'hidden')
  assert.equal(fx.live.calls.mutate.length, 0)
  await h.visibility(fx.session, 'visible')
  assert.equal(fx.live.calls.mutate.length, 0)
  await h.visibility(fx.session, 'hidden')
  assert.equal(fx.live.calls.mutate.length, 1)
  fx.session.unmount()
})

test('a forced exit does not claim that an unfinished numerical token was accepted as an answer', async () => {
  const h = harness(), fx = exitSession(h, { question: { kind: 'numerical' } })
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('-')
  await fx.session.flush(); await h.visibility(fx.session, 'hidden')
  assert.equal(fx.live.calls.mutate[0][1].pending_answer, undefined)
  assert.match(text(fx.session.tree), /Останній запис не був прийнятий/)
  assert.match(text(fx.session.tree), /Роботу здано після виходу з тесту/)
  fx.session.unmount()
})

test('an exit sends the newest edit before an older save receipt, then the server orders save and exit atomically', async () => {
  const h = harness(); let release, serverAnswer, firstSaved
  const previous = new Promise(resolve => { firstSaved = resolve })
  const fx = exitSession(h, { mutate(action, payload, api) {
    if (action === 'save_answer') {
      if (!release) return new Promise(resolve => { release = () => { resolve(api.save(payload)); firstSaved() } })
      return api.save(payload)
    }
    return previous.then(() => { const receipt = api.submit(action, payload); serverAnswer = api.attempt.answers.one; return receipt })
  } })
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('First edit')
  await fx.session.flush(); await h.tick(fx.session, 450)
  assert.deepEqual(fx.live.calls.mutate.map(([action]) => action), ['save_answer'])
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Newest edit')
  await fx.session.flush(); await h.visibility(fx.session, 'hidden')
  assert.deepEqual(fx.live.calls.mutate.map(([action]) => action), ['save_answer', 'record_tab_exit'])
  assert.equal(fx.live.calls.mutate[1][1].pending_answer.answer, 'Newest edit')
  assert.equal(fx.live.calls.mutate[1][1].pending_answer.version, 2)
  release(); await fx.session.flush()
  assert.deepEqual(fx.live.calls.mutate.map(([action]) => action), ['save_answer', 'record_tab_exit'])
  assert.equal(serverAnswer, 'Newest edit')
  fx.session.unmount()
})

test('confirmed navigation waits for a server receipt across a network failure, then retries the same event', async () => {
  const h = harness(); let offline = true, resolved = false
  const fx = exitSession(h, { mutate(action, payload, api) { if (offline) throw Error('OFFLINE'); return api.submit(action, payload) } })
  const request = find(fx.session, node => node.type === 'TeachingTestExitGuard').props.requestLeave().then(value => { resolved = true; return value })
  await fx.session.flush(); await click(fx.session, /^Так, здати роботу та вийти$/)
  assert.equal(resolved, false); assert.equal(fx.closes, 0)
  assert.equal(find(fx.session, node => node.type === 'TeachingButton' && text(node).trim() === 'Залишитися в тесті').props.disabled, true)
  offline = false; await h.online(fx.session)
  assert.equal(await request, true)
  assert.equal(new Set(fx.live.calls.mutate.map(([, payload]) => payload.event_id)).size, 1)
  fx.session.unmount()
})

test('HTTP exit-before-save order conflicts safely, blocks editing and retries the same event after reconciliation', async () => {
  const h = harness(); let release, lastAnswer
  const fx = exitSession(h, { mutate(action, payload, api) {
    if (action === 'save_answer') return new Promise(resolve => { release = () => resolve(api.save(payload)) })
    if (payload.pending_answer.version !== api.attempt.version) throw Error('TEST_CONFLICT')
    const result = api.submit(action, payload); lastAnswer = api.attempt.answers.one; return result
  } })
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('First edit')
  await fx.session.flush(); await h.tick(fx.session, 450)
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Newest edit')
  await fx.session.flush(); await h.visibility(fx.session, 'hidden')
  assert.equal(fx.live.calls.mutate[1][1].pending_answer.version, 2)
  assert.equal(find(fx.session, node => node.props?.question?.id === 'one').props.disabled, true)
  assert.doesNotMatch(text(fx.session.tree), /Роботу здано після виходу/)
  release(); await fx.session.flush(); await h.online(fx.session)
  assert.equal(lastAnswer, 'Newest edit')
  assert.equal(new Set(fx.live.calls.mutate.filter(([action]) => action === 'record_tab_exit').map(([, payload]) => payload.event_id)).size, 1)
  assert.match(text(fx.session.tree), /Роботу здано після виходу/)
  fx.session.unmount()
})

test('a reordered exit retried after the server deadline never claims the unaccepted newest edit was saved', async () => {
  const h = harness(); let release, serverAnswer
  const fx = exitSession(h, { mutate(action, payload, api) {
    if (action === 'save_answer') return new Promise(resolve => { release = () => resolve(api.save(payload)) })
    if (payload.pending_answer.version !== api.attempt.version) throw Error('TEST_CONFLICT')
    serverAnswer = api.attempt.answers.one
    return api.expire()
  } })
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Accepted earlier edit')
  await fx.session.flush(); await h.tick(fx.session, 450)
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Unaccepted newest edit')
  await fx.session.flush(); await h.visibility(fx.session, 'hidden')
  h.advance(61000); release(); await fx.session.flush(); await h.online(fx.session)
  assert.equal(serverAnswer, 'Accepted earlier edit')
  assert.match(text(fx.session.tree), /Останній запис не був прийнятий/)
  assert.match(text(fx.session.tree), /Роботу здано/)
  assert.equal(new Set(fx.live.calls.mutate.filter(([action]) => action === 'record_tab_exit').map(([, payload]) => payload.event_id)).size, 1)
  fx.session.unmount()
})

test('a delayed old-save response cannot reopen a submitted attempt or replace its newest accepted answer', async () => {
  const h = harness(); let release, serverAnswer
  const fx = exitSession(h, { mutate(action, payload, api) {
    if (action === 'save_answer') {
      const oldReceipt = api.save(payload)
      return new Promise(resolve => { release = () => resolve(oldReceipt) })
    }
    const result = api.submit(action, payload); serverAnswer = api.attempt.answers.one; return result
  } })
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Old edit')
  await fx.session.flush(); await h.tick(fx.session, 450)
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Final edit')
  await fx.session.flush(); await h.visibility(fx.session, 'hidden')
  assert.equal(serverAnswer, 'Final edit')
  assert.match(text(fx.session.tree), /Роботу здано після виходу/)
  release(); await fx.session.flush()
  assert.match(text(fx.session.tree), /Роботу здано після виходу/)
  assert.equal(nodes(fx.session.tree).filter(node => node.props?.question?.id === 'one').length, 0)
  assert.equal(fx.live.calls.mutate.length, 2)
  fx.session.unmount()
})

test('reverting to the last acknowledged answer while another edit is in flight still sends that revert atomically', async () => {
  const h = harness(); let release, applied
  const previous = new Promise(resolve => { applied = resolve })
  let serverAnswer
  const fx = exitSession(h, { answers: { one: 'Original answer' }, mutate(action, payload, api) {
    if (action === 'save_answer') return new Promise(resolve => { release = () => { resolve(api.save(payload)); applied() } })
    return previous.then(() => { const result = api.submit(action, payload); serverAnswer = api.attempt.answers.one; return result })
  } })
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Intermediate answer')
  await fx.session.flush(); await h.tick(fx.session, 450)
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Original answer')
  await fx.session.flush(); await h.visibility(fx.session, 'hidden')
  assert.equal(fx.live.calls.mutate[1][1].pending_answer.answer, 'Original answer')
  release(); await fx.session.flush()
  assert.equal(serverAnswer, 'Original answer')
  fx.session.unmount()
})

test('a missing last answer in a confirmed-exit receipt keeps the student on the receipt with an explicit warning', async () => {
  const h = harness(), fx = exitSession(h, { mutate: (_action, _payload, api) => api.expire() })
  find(fx.session, node => node.props?.question?.id === 'one').props.onChange('Unaccepted final edit')
  await fx.session.flush()
  const request = find(fx.session, node => node.type === 'TeachingTestExitGuard').props.requestLeave()
  await fx.session.flush(); await click(fx.session, /^Так, здати роботу та вийти$/)
  assert.equal(await request, false, 'do not navigate away before the student sees the failure')
  assert.equal(fx.closes, 0)
  assert.match(text(fx.session.tree), /Останній запис не був прийнятий/)
  assert.match(text(fx.session.tree), /Роботу здано/)
  fx.session.unmount()
})

test('leaving native fullscreen warns while the visible test stays active; Stay restores fullscreen without a violation', async () => {
  const h = harness(), fx = exitSession(h), screen = h.mountFullscreen(fx.session)
  find(fx.session, node => node.props?.['aria-label'] === 'Розгорнути на весь екран').props.onClick()
  await fx.session.flush(); assert.equal(screen.requests, 1)
  await h.document.exitFullscreen(); await fx.session.flush()
  assert.ok(find(fx.session, node => node.props?.title === 'Якщо вийду, роботу буде здано'))
  assert.equal(fx.live.calls.mutate.length, 0)
  await click(fx.session, /^Залишитися в тесті$/)
  assert.equal(screen.requests, 2)
  assert.equal(fx.live.calls.mutate.length, 0)
  fx.session.unmount()
})

test('tab restriction opt-out does not install an active guard or count visibility changes', async () => {
  const h = harness(), fx = exitSession(h, { restricted: false })
  assert.equal(find(fx.session, node => node.type === 'TeachingTestExitGuard').props.active, false)
  await h.visibility(fx.session, 'hidden'); await h.visibility(fx.session, 'visible')
  assert.equal(fx.live.calls.mutate.length, 0)
  find(fx.session, node => node.type === 'TeachingModal').props.onClose(); await fx.session.flush()
  assert.equal(fx.closes, 1)
  fx.session.unmount()
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

function offlineFixture(h, { restricted = false } = {}) {
  const source = definition({ questions: [], can_edit: false, can_review: false, restrict_tab_switch: restricted, question_count: 1 })
  const currentQuestion = { ...question('one'), kind: 'essay', text: 'SERVER_ONLY_QUESTION', options: [], answer: undefined, time_limit_seconds: null }
  let offline = false, attempt = { id: 'offline-attempt', test_id: source.id, user_id: 'synthetic-student', group_id: 'synthetic-group', status: 'in_progress',
    current_index: 0, question_count: 1, current_question: currentQuestion, answers: {}, locked: [], version: 1, opened_at: { one: new Date(NOW).toISOString() }, expires_at: new Date(NOW + 60000).toISOString() }
  const detail = () => plain({ test: source, attempt, attempts: [], server_now: new Date(h.now).toISOString() })
  const live = boundary(source, { detail: async () => { if (offline) throw Error('OFFLINE'); return detail() }, mutate: async (action, payload) => {
    if (offline) throw Error('OFFLINE')
    assert.equal(payload.expected_user_id, attempt.user_id); assert.equal(payload.attempt_id, attempt.id)
    if (action === 'record_tab_exit') {
      if (payload.pending_answer && h.now < Date.parse(attempt.expires_at)) attempt.answers[payload.pending_answer.question_id] = payload.pending_answer.answer
      attempt = { ...attempt, status: 'submitted', completion_reason: 'tab_switch', current_question: null, version: attempt.version + 1 }; return detail()
    }
    assert.equal(action, 'save_answer'); assert.equal(payload.version, attempt.version)
    if (h.now >= Date.parse(attempt.expires_at)) throw Error('TEST_TIME_EXPIRED')
    attempt = { ...attempt, answers: { ...attempt.answers, [payload.question_id]: payload.answer }, version: attempt.version + 1 }
    return detail()
  } })
  const mount = () => h.mount('TeachingTestSession', { ...props(live.repository), userId: attempt.user_id, initialDetail: detail() })
  return { live, mount, detail, set offline(value) { offline = value }, get attempt() { return attempt }, change(patch) { attempt = { ...attempt, ...patch } } }
}

test('official offline answers are durable before debounce, restore after remount and auto-sync after reconnect', async () => {
  const h = harness(), fx = offlineFixture(h)
  fx.offline = true
  const first = fx.mount()
  find(first, node => node.props?.question?.id === 'one').props.onChange('МОЯ відповідь до втрати мережі')
  const stored = JSON.stringify(h.localEntries)
  assert.match(stored, /МОЯ відповідь/); assert.doesNotMatch(stored, /SERVER_ONLY_QUESTION|options|expires_at|correct/)
  await h.tick(first, 450); assert.match(text(first.tree), /OFFLINE/)
  first.unmount()
  const reopened = fx.mount(); await reopened.flush()
  assert.equal(find(reopened, node => node.props?.question?.id === 'one').props.answer, 'МОЯ відповідь до втрати мережі')
  fx.offline = false; await h.online(reopened)
  assert.equal(fx.attempt.answers.one, 'МОЯ відповідь до втрати мережі')
  assert.equal(Object.keys(h.localEntries).length, 0)
  assert.match(text(reopened.tree), /Відповіді збережено/)
  reopened.unmount()
})

test('late offline drafts remain readable/exportable and never extend the server deadline or auto-submit an edit', async () => {
  const h = harness(), fx = offlineFixture(h), first = fx.mount()
  fx.offline = true
  find(first, node => node.props?.question?.id === 'one').props.onChange('Пізня локальна копія')
  await h.tick(first, 450); first.unmount(); h.advance(61000)
  const reopened = fx.mount(); await reopened.flush(); fx.offline = false
  const before = fx.live.calls.mutate.length
  await h.online(reopened)
  assert.equal(fx.live.calls.mutate.length, before, 'expired browser drafts do not get a privileged replay endpoint')
  assert.equal(fx.attempt.answers.one, undefined)
  assert.equal(find(reopened, node => node.props?.question?.id === 'one').props.disabled, true)
  const copy = find(reopened, node => node.props?.copy?.drafts?.length).props.copy
  assert.equal(copy.drafts[0].answer, 'Пізня локальна копія')
  assert.match(copy.raw, /Пізня локальна копія/)
  assert.equal(fx.attempt.expires_at, new Date(NOW + 60000).toISOString())
  reopened.unmount()
})

test('a changed server version preserves a recovered draft for explicit comparison instead of overwriting another tab', async () => {
  const h = harness(), fx = offlineFixture(h), first = fx.mount(); fx.offline = true
  find(first, node => node.props?.question?.id === 'one').props.onChange('Мій офлайн текст')
  await h.tick(first, 450); first.unmount()
  fx.change({ version: 7, answers: { one: 'Інша підтверджена відповідь' } })
  fx.offline = false
  const reopened = fx.mount(); await reopened.flush()
  assert.equal(fx.attempt.answers.one, 'Інша підтверджена відповідь')
  assert.match(text(reopened.tree), /Спробу змінено після локального запису/)
  const saves = fx.live.calls.mutate.length
  await h.online(reopened); assert.equal(fx.live.calls.mutate.length, saves)
  await click(reopened, /^Відновити відповідь у поточне запитання$/); await h.tick(reopened, 450)
  assert.equal(fx.attempt.answers.one, 'Мій офлайн текст')
  assert.equal(fx.live.calls.mutate.at(-1)[1].version, 7)
  reopened.unmount()
})

test('reconnect in the same mounted offline tab also refuses to silently rebase over a newer server answer', async () => {
  const h = harness(), fx = offlineFixture(h), session = fx.mount(); fx.offline = true
  find(session, node => node.props?.question?.id === 'one').props.onChange('MY_OFFLINE_EDIT')
  await h.tick(session, 450)
  fx.change({ version: 9, answers: { one: 'NEWER_REMOTE_EDIT' } }); fx.offline = false
  const before = fx.live.calls.mutate.length
  await h.online(session)
  assert.equal(fx.live.calls.mutate.length, before)
  assert.equal(fx.attempt.answers.one, 'NEWER_REMOTE_EDIT')
  assert.equal(find(session, node => node.props?.question?.id === 'one').props.answer, 'MY_OFFLINE_EDIT')
  assert.match(text(session.tree), /Спробу змінено після локального запису/)
  assert.equal(find(session, node => node.props?.copy?.drafts?.length).props.copy.drafts[0].baseVersion, 1)
  session.unmount()
})

test('a different tab retained copy never replaces an acknowledged input during polling and needs explicit restore after reload', async () => {
  const h = harness(), fx = offlineFixture(h), session = fx.mount(), other = h.otherTabOutbox()
  other.writeTeachingTestAnswerDraft(fx.attempt.user_id, 'synthetic-test', {
    attemptId: fx.attempt.id, questionId: 'one', baseVersion: fx.attempt.version, answer: 'UNSENT_OTHER_TAB_A',
  })
  find(session, node => node.props?.question?.id === 'one').props.onChange('ACCEPTED_THIS_TAB_B')
  await h.tick(session, 450)
  assert.equal(fx.attempt.answers.one, 'ACCEPTED_THIS_TAB_B')
  const acceptedVersion = fx.attempt.version, acceptedDeadline = fx.attempt.expires_at, saves = fx.live.calls.mutate.length
  await h.online(session)
  assert.equal(find(session, node => node.props?.question?.id === 'one').props.answer, 'ACCEPTED_THIS_TAB_B')
  assert.equal(fx.live.calls.mutate.length, saves, 'retained A is never silently rebased/replayed over acknowledged B')
  const recovery = find(session, node => node.props?.copy?.drafts?.some(draft => draft.answer === 'UNSENT_OTHER_TAB_A'))
  assert.equal(recovery.props.canRestore(recovery.props.copy.drafts[0]), true)
  assert.match(JSON.stringify(h.localEntries), /UNSENT_OTHER_TAB_A/)
  session.unmount()
  const reopened = fx.mount(); await reopened.flush()
  assert.equal(fx.attempt.answers.one, 'ACCEPTED_THIS_TAB_B')
  assert.equal(fx.attempt.version, acceptedVersion)
  assert.match(text(reopened.tree), /Спробу змінено після локального запису/)
  const retained = find(reopened, node => node.props?.copy?.drafts?.some(draft => draft.answer === 'UNSENT_OTHER_TAB_A'))
  const draft = retained.props.copy.drafts.find(value => value.answer === 'UNSENT_OTHER_TAB_A')
  retained.props.onRestore(draft); await h.tick(reopened, 450)
  assert.equal(fx.attempt.answers.one, 'UNSENT_OTHER_TAB_A')
  assert.equal(fx.live.calls.mutate.at(-1)[1].version, acceptedVersion)
  assert.equal(fx.attempt.expires_at, acceptedDeadline)
  reopened.unmount()
})

test('remote question navigation keeps Q1 offline bytes in recovery and never displays or saves them under Q2', async () => {
  const h = harness(), fx = offlineFixture(h), session = fx.mount(); fx.offline = true
  find(session, node => node.props?.question?.id === 'one').props.onChange('PRIVATE_Q1_OFFLINE_EDIT')
  await h.tick(session, 450)
  fx.change({ version: 4, current_index: 1, question_count: 2, current_question: { ...question('two'), kind: 'essay', answer: undefined, options: [], time_limit_seconds: null }, answers: { two: 'SERVER_Q2_ANSWER' } })
  fx.offline = false
  const before = fx.live.calls.mutate.length
  await h.online(session)
  const current = find(session, node => node.props?.question?.id === 'two')
  assert.equal(current.props.answer, 'SERVER_Q2_ANSWER')
  assert.equal(fx.live.calls.mutate.length, before)
  const copy = find(session, node => node.props?.copy?.drafts?.length).props.copy
  assert.equal(copy.drafts[0].questionId, 'one'); assert.equal(copy.drafts[0].answer, 'PRIVATE_Q1_OFFLINE_EDIT')
  current.props.onChange('MY_CURRENT_Q2_EDIT'); await h.tick(session, 450)
  assert.equal(fx.live.calls.mutate.at(-1)[1].question_id, 'two')
  assert.equal(fx.live.calls.mutate.at(-1)[1].answer, 'MY_CURRENT_Q2_EDIT')
  assert.equal(fx.attempt.answers.one, undefined)
  assert.match(JSON.stringify(h.localEntries), /PRIVATE_Q1_OFFLINE_EDIT/)
  session.unmount()
})

test('offline refresh with exit protection drains the original exit before any recovered-answer replay', async () => {
  const h = harness(), fx = offlineFixture(h, { restricted: true }), first = fx.mount(); fx.offline = true
  find(first, node => node.props?.question?.id === 'one').props.onChange('Відповідь перед оновленням')
  await first.flush(); await h.pagehide(first)
  const exitId = fx.live.calls.mutate[0][1].event_id
  first.unmount()
  const reopened = fx.mount(); await reopened.flush()
  assert.equal(find(reopened, node => node.props?.question?.id === 'one').props.disabled, true)
  fx.offline = false; await h.online(reopened)
  assert.equal(fx.attempt.status, 'submitted'); assert.equal(fx.attempt.completion_reason, 'tab_switch')
  assert.equal(fx.attempt.answers.one, 'Відповідь перед оновленням')
  assert.ok(fx.live.calls.mutate.every(([action]) => action === 'record_tab_exit'))
  assert.equal(new Set(fx.live.calls.mutate.map(([, value]) => value.event_id)).size, 1)
  assert.equal(fx.live.calls.mutate.at(-1)[1].event_id, exitId)
  assert.equal(Object.keys(h.localEntries).length, 0)
  reopened.unmount()
})

test('offline resolver exposes its own recovery without cached questions and retries authorization when online', async () => {
  const h = harness(), fx = offlineFixture(h), first = fx.mount(); fx.offline = true
  find(first, node => node.props?.question?.id === 'one').props.onChange('Копія без завантаження питання')
  await first.flush(); first.unmount()
  const resolver = h.mount('TeachingTestResolver', { ...props(fx.live.repository), userId: 'synthetic-student' }); await resolver.flush()
  assert.match(text(resolver.tree), /OFFLINE/)
  const copy = find(resolver, node => node.props?.copy?.drafts?.length).props.copy
  assert.equal(copy.drafts[0].answer, 'Копія без завантаження питання')
  assert.doesNotMatch(JSON.stringify(resolver.tree), /SERVER_ONLY_QUESTION/)
  fx.offline = false; await h.online(resolver)
  assert.equal(currentSession(resolver).props.initialDetail.attempt.id, fx.attempt.id)
  resolver.unmount()
})

test('another authenticated owner never sees or replays a previous owner draft from the same browser', async () => {
  const h = harness(), fx = offlineFixture(h), first = fx.mount(); fx.offline = true
  find(first, node => node.props?.question?.id === 'one').props.onChange('PRIVATE_FIRST_OWNER_DRAFT')
  await first.flush(); first.unmount()
  fx.change({ user_id: 'second-student', id: 'second-attempt' }); fx.offline = false
  const second = fx.mount(); await second.flush(); await h.online(second)
  assert.equal(find(second, node => node.props?.question?.id === 'one').props.answer, undefined)
  assert.doesNotMatch(JSON.stringify(second.tree), /PRIVATE_FIRST_OWNER_DRAFT/)
  assert.equal(fx.live.calls.mutate.length, 0)
  assert.match(JSON.stringify(h.localEntries), /PRIVATE_FIRST_OWNER_DRAFT/, 'identity isolation must not silently erase another owner’s recoverable bytes')
  second.unmount()
})

test('a restored stale-version answer is not smuggled into forced submission after an offline refresh', async () => {
  const h = harness(), fx = offlineFixture(h, { restricted: true }), first = fx.mount(); fx.offline = true
  find(first, node => node.props?.question?.id === 'one').props.onChange('STALE_OFFLINE_DRAFT')
  await first.flush(); await h.pagehide(first); first.unmount()
  fx.change({ version: 4, answers: { one: 'NEWER_SERVER_ANSWER' } })
  const reopened = fx.mount(); await reopened.flush(); fx.offline = false; await h.online(reopened)
  assert.equal(fx.attempt.status, 'submitted'); assert.equal(fx.attempt.answers.one, 'NEWER_SERVER_ANSWER')
  const final = fx.live.calls.mutate.at(-1)
  assert.equal(final[0], 'record_tab_exit'); assert.equal(final[1].pending_answer, undefined)
  const copy = find(reopened, node => node.props?.copy?.drafts?.length).props.copy
  assert.equal(copy.drafts[0].answer, 'STALE_OFFLINE_DRAFT')
  reopened.unmount()
})

test('offline hidden tab stays terminal through return and reload, drains its same exit before answers and cannot resume', async () => {
  // Exercise the current visibility listener and the current scoped durable
  // queues. The repository is synthetic; this is not a real-browser visibility
  // claim and performs no live RPC or grade mutation.
  const h = harness(), fx = offlineFixture(h, { restricted: true }), first = fx.mount()
  const originalId = fx.attempt.id, originalDeadline = fx.attempt.expires_at
  fx.offline = true
  find(first, node => node.props?.question?.id === 'one').props.onChange('LAST_EDIT_BEFORE_OFFLINE_TAB_SWITCH')
  await first.flush()
  await h.visibility(first, 'hidden')
  assert.equal(find(first, node => node.props?.question?.id === 'one').props.disabled, true)
  const exits = () => Object.keys(h.localEntries).filter(key => key.startsWith('xelay-test-tab-exit:'))
  assert.equal(exits().length, 1)
  const originalExitKey = exits()[0], originalExitId = fx.live.calls.mutate[0][1].event_id
  const durableExit = JSON.parse(h.localEntries[originalExitKey])
  assert.deepEqual(Object.keys(durableExit), ['at'], 'the exit log persists no answer or question content')
  await h.visibility(first, 'visible')
  await h.pagehide(first)
  assert.equal(exits().length, 1, 'returning and refreshing do not create a new violation identity')
  assert.equal(exits()[0], originalExitKey)
  assert.equal(fx.attempt.status, 'in_progress', 'offline browser state cannot impersonate a server receipt')
  first.unmount()
  h.advance(10000)
  const reopened = fx.mount(); await reopened.flush()
  assert.equal(find(reopened, node => node.props?.question?.id === 'one').props.disabled, true)
  assert.equal(fx.attempt.id, originalId)
  assert.equal(fx.attempt.expires_at, originalDeadline)
  fx.offline = false
  await h.online(reopened)
  assert.equal(fx.attempt.status, 'submitted')
  assert.equal(fx.attempt.completion_reason, 'tab_switch')
  assert.equal(fx.attempt.answers.one, 'LAST_EDIT_BEFORE_OFFLINE_TAB_SWITCH')
  assert.equal(fx.attempt.id, originalId)
  assert.equal(fx.attempt.expires_at, originalDeadline, 'reconnect never restarts or extends the server timer')
  assert.ok(fx.live.calls.mutate.length > 1)
  assert.ok(fx.live.calls.mutate.every(([action]) => action === 'record_tab_exit'), 'the forced exit drains before any ordinary answer replay')
  assert.equal(new Set(fx.live.calls.mutate.map(([, payload]) => payload.event_id)).size, 1)
  assert.equal(fx.live.calls.mutate.at(-1)[1].event_id, originalExitId)
  assert.equal(Object.keys(h.localEntries).length, 0)
  assert.equal(nodes(reopened.tree).some(node => node.props?.question?.id === 'one'), false)
  reopened.unmount()
  const receipt = fx.mount(); await receipt.flush()
  assert.match(text(receipt.tree), /Роботу здано/)
  assert.equal(nodes(receipt.tree).some(node => node.props?.question?.id === 'one'), false, 'a second reload cannot reopen submitted answer controls')
  assert.equal(fx.attempt.expires_at, originalDeadline)
  receipt.unmount()
})
