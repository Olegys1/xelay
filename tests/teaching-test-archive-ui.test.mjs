// Real hook/component execution, synthetic identities, inert repository transport.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
function load(path, imports) {
  const module = { exports: {} }
  runInNewContext(ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    module, exports: module.exports, Date, Number, Map, Set, Error, AbortController,
    require(name) { assert.ok(Object.hasOwn(imports, name), 'Explicit import ' + name); return imports[name] },
  })
  return module.exports
}
const archiveModule = load('src/lib/teachingTestArchive.ts', { './supabase': { supabase: { rpc() { throw Error('No network or default client in this suite') } } } })
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const user = id(1), otherUser = id(2), course = id(3), otherCourse = id(4), group = id(5), testId = id(6), otherTest = id(7)
const now = '2026-11-18T10:00:00Z'
const entry = (test = testId, changes = {}) => ({ testId: test, courseId: course, archivedAt: now, version: 1, ...changes })
const state = (changes = {}) => ({ userId: user, canArchive: true, items: [], serverNow: now, ...changes })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function repository(overrides = {}) {
  const reads = [], writes = []
  return { reads, writes, async state(...args) { reads.push(args); return overrides.state ? overrides.state(...args) : state() }, async set(payload) { writes.push(payload); return overrides.set ? overrides.set(payload) : entry(payload.testId, { courseId: payload.courseId, archivedAt: payload.archived ? now : null, version: payload.expectedVersion + 1 }) } }
}

// Effects execute after render, including cleanup on dependency changes. Tests
// can inspect the first render of a changed account before any effect runs.
function renderer(factory, initialProps) {
  const cells = [], effects = []
  let cursor = 0, dirty = false, value, props = initialProps, component, alive = true, setterCalls = 0
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const hooks = {
    useState(initial) { const at = cursor++; cells[at] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[at].value, next => { setterCalls++; if (!alive) return; const value = typeof next === 'function' ? next(cells[at].value) : next; if (!Object.is(value, cells[at].value)) { cells[at].value = value; dirty = true } }] },
    useRef(initial) { return cells[cursor++] ??= { current: initial } },
    useMemo(fn, deps) { const at = cursor++; if (!cells[at] || !same(cells[at].deps, deps)) cells[at] = { deps, value: fn() }; return cells[at].value },
    useEffect(fn, deps) { const at = cursor++, old = cells[at]; if (!old || !same(old.deps, deps)) { cells[at] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); cells[at].cleanup = fn() }) } },
  }
  hooks.useCallback = (fn, deps) => hooks.useMemo(() => fn, deps)
  component = factory(hooks)
  function render(nextProps = props, { effects: runEffects = true } = {}) {
    props = nextProps
    for (let turn = 0; turn < 40; turn++) {
      dirty = false; cursor = 0; value = component(props)
      if (!runEffects) return value
      effects.splice(0).forEach(fn => fn())
      if (!dirty) return value
    }
    throw Error('Hooks did not settle')
  }
  render()
  return { render, get value() { return value }, get props() { return props }, get setterCalls() { return setterCalls }, async settle() { for (let n = 0; n < 12; n++) { await Promise.resolve(); render() } }, unmount() { cells.forEach(cell => cell?.cleanup?.()); alive = false } }
}
const hookFactory = hooks => load('src/components/teaching/useTeachingTestArchive.ts', { react: hooks, '../../lib/teachingTestArchive': archiveModule }).useTeachingTestArchive
const hook = (repo, overrides = {}) => renderer(hookFactory, { userId: user, courseId: course, groupId: group, enabled: true, repository: repo, ...overrides })

test('failed/offline save preserves visible tests; duplicate clicks make one mutation and successful retry uses the unchanged version', async () => {
  const save = deferred(), repo = repository({ set: () => save.promise }), h = hook(repo)
  await h.settle()
  const pending = h.value.change(testId, true)
  h.render()
  assert.equal(h.value.busyId, testId)
  assert.equal(h.value.data.items.length, 0, 'No optimistic hiding before server commit')
  assert.equal(await h.value.change(testId, true), false)
  assert.equal(repo.writes.length, 1)
  save.reject(TypeError('Synthetic offline'))
  assert.equal(await pending, false); await h.settle()
  assert.equal(h.value.busyId, ''); assert.equal(h.value.data.items.length, 0); assert.ok(h.value.error)
  const retry = deferred(); repo.set = payload => { repo.writes.push(payload); return retry.promise }
  const next = h.value.change(testId, true)
  assert.equal(repo.writes[1].expectedVersion, 0)
  assert.equal(repo.writes[1].expectedUserId, user)
  retry.resolve(entry()); assert.equal(await next, true); await h.settle()
  assert.equal(h.value.data.items[0].testId, testId); assert.equal(h.value.error, '')
  h.unmount()
})

for (const dimension of ['account', 'course', 'group', 'repository']) {
  test(`${dimension} switch hides previous data during render and ignores a late read`, async () => {
    const oldRead = deferred(), newRead = deferred()
    let calls = 0
    const repo = repository({ state: () => ++calls === 1 ? oldRead.promise : newRead.promise })
    const nextRepo = dimension === 'repository' ? repository({ state: () => newRead.promise }) : repo
    const h = hook(repo), next = { ...h.props, repository: nextRepo,
      ...(dimension === 'account' ? { userId: otherUser } : dimension === 'course' ? { courseId: otherCourse } : dimension === 'group' ? { groupId: id(8) } : {}) }
    h.render(next, { effects: false }); assert.equal(h.value.data, null); assert.equal(h.value.busyId, '')
    h.render(); oldRead.resolve(state({ items: [entry()] })); await h.settle()
    assert.equal(h.value.data, null, 'Previous account/scope read cannot populate the new render')
    newRead.resolve(state({ userId: next.userId, items: [] })); await h.settle()
    assert.equal(h.value.data.userId, next.userId); assert.equal(h.value.data.items.length, 0)
    h.unmount()
  })
  test(`${dimension} switch hides old archive immediately and ignores a late write`, async () => {
    const write = deferred()
    const repo = repository({ state: async selectedCourse => state({ items: selectedCourse === otherCourse ? [] : [entry(otherTest)] }), set: () => write.promise })
    const h = hook(repo); await h.settle()
    const pending = h.value.change(testId, true)
    h.render(); assert.equal(h.value.busyId, testId)
    const nextRepo = repository({ state: async () => state({ userId: dimension === 'account' ? otherUser : user }) })
    const next = { ...h.props, repository: nextRepo,
      ...(dimension === 'account' ? { userId: otherUser } : dimension === 'course' ? { courseId: otherCourse } : dimension === 'group' ? { groupId: id(8) } : {}) }
    // Keeping repository identity unchanged for the first three variants matters.
    if (dimension !== 'repository') { next.repository = repo; repo.state = async () => state({ userId: next.userId }) }
    h.render(next, { effects: false }); assert.equal(h.value.data, null); assert.equal(h.value.busyId, '')
    h.render(); await h.settle(); write.resolve(entry())
    assert.equal(await pending, false); await h.settle()
    assert.equal(h.value.data.userId, next.userId); assert.equal(h.value.data.items.length, 0)
    assert.equal(h.value.error, ''); assert.equal(h.value.busyId, '')
    h.unmount()
  })
}

test('expired/free plan cannot add archives but can restore an existing entry with its exact revision', async () => {
  const repo = repository({ state: async () => state({ canArchive: false, items: [entry()] }) }), h = hook(repo)
  await h.settle()
  assert.equal(await h.value.change(otherTest, true), false)
  assert.equal(await h.value.change(otherTest, false), false)
  assert.equal(repo.writes.length, 0)
  assert.equal(await h.value.change(testId, false), true); await h.settle()
  assert.equal(repo.writes.length, 1); assert.equal(repo.writes[0].expectedVersion, 1)
  assert.equal(repo.writes[0].archived, false); assert.equal(h.value.data.items[0].archivedAt, null)
  h.unmount()
})

test('readonly/disabled archive issues no requests and disabling drops a pending read and a previously captured write callback', async () => {
  const read = deferred(), repo = repository({ state: () => read.promise }), h = hook(repo, { enabled: false })
  await h.settle(); await h.value.reload(); assert.equal(repo.reads.length, 0)
  assert.equal(await h.value.change(testId, true), false); assert.equal(repo.writes.length, 0)
  h.render({ ...h.props, enabled: true }); assert.equal(repo.reads.length, 1)
  const captured = h.value.change
  h.render({ ...h.props, enabled: false }, { effects: false })
  assert.equal(h.value.data, null); assert.equal(h.value.busyId, '')
  assert.equal(await captured(testId, true), false)
  h.render(); read.resolve(state({ items: [entry()] })); await h.settle()
  assert.equal(h.value.data, null); assert.equal(repo.writes.length, 0); assert.equal(repo.reads.length, 1)
  h.unmount()
})

test('a stale reload cannot overwrite a committed archive and reload does not overlap an active mutation', async () => {
  const refresh = deferred(), write = deferred(); let reads = 0
  const repo = repository({ state: () => ++reads === 1 ? state() : refresh.promise, set: () => write.promise }), h = hook(repo)
  await h.settle()
  const oldReload = h.value.reload(); h.render()
  const pending = h.value.change(testId, true); h.render()
  await h.value.reload(); assert.equal(repo.reads.length, 2)
  write.resolve(entry()); assert.equal(await pending, true); await h.settle()
  refresh.resolve(state()); await oldReload; await h.settle()
  assert.equal(h.value.data.items[0].testId, testId); assert.equal(h.value.loading, false)
  h.unmount()
})

test('foreign-owner responses fail closed; unmount ignores late reads and writes', async () => {
  const wrong = hook(repository({ state: async () => state({ userId: otherUser, items: [entry()] }) }))
  await wrong.settle(); assert.equal(wrong.value.data, null); assert.match(wrong.value.error, /змінився/); wrong.unmount()
  const read = deferred(), first = hook(repository({ state: () => read.promise })); first.unmount()
  const before = first.setterCalls; read.resolve(state({ items: [entry()] })); await Promise.resolve(); await Promise.resolve()
  assert.equal(first.setterCalls, before)
  const write = deferred(), second = hook(repository({ set: () => write.promise })); await second.settle()
  const pending = second.value.change(testId, true); second.unmount(); const after = second.setterCalls
  write.resolve(entry()); assert.equal(await pending, false); assert.equal(second.setterCalls, after)
})

test('leaving and returning to the same course cannot revive an old mutation or leave loading stuck', async () => {
  const write = deferred(), repo = repository({ set: () => write.promise }), h = hook(repo)
  await h.settle()
  const original = h.props, pending = h.value.change(testId, true)
  h.render({ ...original, courseId: otherCourse }); await h.settle()
  h.render(original); await h.settle()
  write.resolve(entry()); assert.equal(await pending, false, 'A mutation captured before leaving the scope stays obsolete after return')
  await h.settle()
  assert.equal(h.value.loading, false); assert.equal(h.value.data.userId, user)
  assert.equal(h.value.data.items.length, 0)
  h.unmount()
})

test('a late old-account completion cannot unlock or replace a new account mutation', async () => {
  const oldSave = deferred(), newSave = deferred(), oldRepo = repository({ set: () => oldSave.promise })
  const newRepo = repository({ state: async () => state({ userId: otherUser }), set: () => newSave.promise })
  const h = hook(oldRepo); await h.settle()
  const oldPending = h.value.change(testId, true)
  h.render({ ...h.props, userId: otherUser, repository: newRepo }); await h.settle()
  const newPending = h.value.change(otherTest, true); h.render()
  oldSave.resolve(entry()); assert.equal(await oldPending, false); await h.settle()
  assert.equal(h.value.busyId, otherTest); assert.equal(h.value.data.userId, otherUser)
  assert.equal(await h.value.change(otherTest, true), false); assert.equal(newRepo.writes.length, 1)
  newSave.resolve(entry(otherTest)); assert.equal(await newPending, true); await h.settle()
  assert.equal(h.value.busyId, ''); assert.equal(h.value.data.items[0].testId, otherTest)
  h.unmount()
})

const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
function componentFixture(archiveRepo, { readonly = false, records: suppliedRecords } = {}) {
  const records = suppliedRecords || [testId, otherTest].map((id, at) => ({ id, title: at ? 'Synthetic archived test' : 'Synthetic current test', status: 'closed', opens_at: '2026-11-17T10:00:00Z', closes_at: '2026-11-17T11:00:00Z', questions: [], targets: [{ group_id: group }], question_count: 0, duration_seconds: 900, max_points: 10, bonus_percent: 0, can_review: true, can_edit: false }))
  const listCalls = [], mutations = [], journal = () => {}
  const repo = { list: async (...args) => { listCalls.push(args); return { tests: structuredClone(records) } }, mutate: async (...args) => { mutations.push(args); throw Error('Archive must never mutate tests or grades') } }
  const h = renderer(hooks => {
    const jsx = (type, props) => ({ type, props: props || {} })
    const hookModule = load('src/components/teaching/useTeachingTestArchive.ts', { react: hooks, '../../lib/teachingTestArchive': archiveModule })
    return load('src/components/teaching/TeachingTests.tsx', {
      react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, name) => String(name) }),
      '../../lib/teachingTestArchive': archiveModule, './useTeachingTestArchive': hookModule,
      '../../lib/teaching': { teachingDate: String }, '../../lib/teachingTests': { teachingTestError: e => String(e?.message || e) },
      './TeachingTestBuilder': { TeachingTestBuilder: 'TeachingTestBuilder', TEST_QUESTION_LABELS: {} }, './TeachingPublishedTestEditor': { TeachingPublishedTestEditor: 'TeachingPublishedTestEditor' },
      './TeachingUI': Object.fromEntries(['TeachingButton', 'TeachingEmpty', 'TeachingField', 'TeachingModal', 'TeachingSectionHelp'].map(name => [name, name])),
      './TeachingQuestionBank': { TeachingQuestionBank: 'TeachingQuestionBank' }, './TeachingRubrics': { TeachingRubricAssessment: 'TeachingRubricAssessment' }, '../../lib/teachingRubrics': {},
      './TeachingTestOverrides': { TeachingTestOverrides: 'TeachingTestOverrides' }, './TeachingTestRunner': { TeachingTestRunner: 'TeachingTestRunner' }, './TeachingTestAccessCode': { TeachingTestAccessCodeDialog: 'TeachingTestAccessCodeDialog' },
      './TeachingTestQuestionImages': {}, './TeachingTestContent': {}, '../../lib/teachingTestReviewState': {}, '../../lib/teachingTestReports': {}, './teaching-tests.css': {}, './teaching-test-review.css': {},
    }).TeachingTests
  }, { snapshot: { course: { id: course, permissions: ['assignments', 'grades'], archived_at: null }, groups: [{ group_id: group, status: 'accepted', permissions: ['assignments', 'grades'] }] }, repository: repo, teachingRepository: {}, archiveRepository: archiveRepo, userId: user, groupId: group, readonly, onOpenJournal: journal })
  return Object.assign(h, { listCalls, mutations, journal,
    button(label) { const found = nodes(h.value).find(n => ['button', 'TeachingButton'].includes(n.type) && text(n).trim() === label); assert.ok(found, 'Button ' + label); return found },
    article(title) { return nodes(h.value).find(n => n.type === 'article' && nodes(n).some(child => child.type === 'h3' && text(child).trim() === title)) },
    tab(label) { const found = nodes(h.value).find(n => n.type === 'button' && text(n).trim().startsWith(label)); assert.ok(found, 'Tab ' + label); return found },
  })
}

test('actual test list keeps both lists separate; confirmation, success-only hiding, restore and review callback preserve the original test repository', async () => {
  let save = deferred()
  const repo = repository({ state: async () => state({ items: [entry(otherTest)] }), set: () => save.promise }), h = componentFixture(repo)
  await h.settle()
  assert.ok(h.article('Synthetic current test')); assert.equal(h.article('Synthetic archived test'), undefined)
  h.button('До архіву').props.onClick(); h.render()
  assert.equal(repo.writes.length, 0, 'Opening confirmation is not a write')
  h.button('Перенести до архіву').props.onClick(); h.render()
  assert.equal(repo.writes.length, 1); assert.ok(h.article('Synthetic current test'))
  save.reject(TypeError('Synthetic offline')); await h.settle()
  assert.ok(h.article('Synthetic current test'))
  const failedModal = nodes(h.value).find(n => n.type === 'TeachingModal')
  assert.ok(failedModal)
  const failureAlert = nodes(failedModal).find(n => n.props?.role === 'alert')
  assert.ok(failureAlert, 'A failed save must be announced inside the active modal, not only its inert background')
  assert.match(text(failureAlert), /Не вдалося/)
  assert.equal(failedModal.props.busy, false)
  save = deferred(); h.button('Перенести до архіву').props.onClick(); h.render()
  const retryModal = nodes(h.value).find(n => n.type === 'TeachingModal')
  assert.equal(repo.writes.length, 2); assert.equal(retryModal.props.busy, true)
  assert.equal(nodes(retryModal).find(n => n.props?.role === 'alert'), undefined, 'Starting a real retry clears the previous failure while pending')
  assert.ok(h.article('Synthetic current test'), 'Pending retry still does not hide the test optimistically')
  save.resolve(entry()); await h.settle()
  assert.equal(h.article('Synthetic current test'), undefined)
  assert.equal(nodes(h.value).find(n => n.type === 'TeachingModal'), undefined)
  h.tab('Архів').props.onClick(); h.render()
  assert.ok(h.article('Synthetic current test')); assert.ok(h.article('Synthetic archived test'))
  const card = h.article('Synthetic current test')
  nodes(card).find(n => n.type === 'TeachingButton' && text(n).trim() === 'Відповіді й перевірка').props.onClick(); h.render()
  const review = nodes(h.value).find(n => typeof n.type === 'function' && n.type.name === 'TeachingTestReview')
  assert.ok(review); assert.equal(review.props.repository, h.props.repository); assert.equal(review.props.onOpenJournal, h.journal)
  review.props.onClose(); h.render()
  nodes(h.article('Synthetic current test')).find(n => n.type === 'TeachingButton' && text(n).trim() === 'Повернути з архіву').props.onClick(); h.render()
  save = deferred(); h.button('Повернути тест').props.onClick(); h.render()
  assert.ok(h.article('Synthetic current test'), 'Restore is not optimistic either')
  save.resolve(entry(testId, { archivedAt: null, version: 2 })); await h.settle()
  assert.equal(h.article('Synthetic current test'), undefined)
  h.tab('Робочий список').props.onClick(); h.render(); assert.ok(h.article('Synthetic current test'))
  assert.equal(h.mutations.length, 0); assert.equal(h.listCalls.length, 1)
  h.unmount()
})

test('missing archive RPC leaves the ordinary test list usable; readonly list never requests archive state', async () => {
  const missing = componentFixture(repository({ state: async () => { throw { code: 'PGRST202', message: 'Synthetic function not in schema cache' } } }))
  await missing.settle()
  assert.ok(missing.article('Synthetic current test')); assert.ok(missing.article('Synthetic archived test'))
  assert.ok(nodes(missing.value).find(n => n.props?.className === 'teaching-test-archive-warning'))
  assert.equal(missing.mutations.length, 0); missing.unmount()
  const archive = repository(), readonly = componentFixture(archive, { readonly: true }); await readonly.settle()
  assert.equal(archive.reads.length, 0); assert.equal(archive.writes.length, 0)
  assert.ok(readonly.article('Synthetic current test')); assert.ok(readonly.article('Synthetic archived test'))
  assert.equal(nodes(readonly.value).find(n => n.props?.className === 'teaching-test-archive-toolbar'), undefined)
  readonly.unmount()
})

test('a filing confirmation cannot reappear after leaving and returning to its course; an old confirm callback remains inert', async () => {
  const repo = repository(), h = componentFixture(repo)
  await h.settle()
  h.button('До архіву').props.onClick(); h.render()
  const original = h.props, confirm = h.button('Перенести до архіву').props.onClick
  assert.ok(nodes(h.value).find(n => n.type === 'TeachingModal'))
  h.render({ ...original, snapshot: { ...original.snapshot, course: { ...original.snapshot.course, id: otherCourse } } }, { effects: false })
  assert.equal(nodes(h.value).find(n => n.type === 'TeachingModal'), undefined)
  h.render(); await h.settle()
  h.render(original, { effects: false })
  assert.equal(nodes(h.value).find(n => n.type === 'TeachingModal'), undefined, 'Old confirmation is obsolete even before return-scope effects run')
  h.render(); await h.settle(); confirm(); await h.settle()
  assert.equal(repo.writes.length, 0)
  h.unmount()
})

test('archived revision A remains discoverable after B replaces it in the current list; review and restore retain A identity and revision', async () => {
  const original = { id: otherTest, title: 'Synthetic original revision A', revision: 1, attempts: 2, max_points: 12, opens_at: '2026-11-16T10:00:00Z', closes_at: '2026-11-16T11:00:00Z' }
  const current = { id: testId, title: 'Synthetic current revision B', status: 'published', opens_at: '2026-11-18T10:00:00Z', closes_at: '2026-11-19T11:00:00Z',
    questions: [{ id: 'revision-b-secret-question', text: 'A must never inherit the revised question or key', answer: 'revision-b-secret-answer' }],
    variants: [{ id: 'revision-b-only-variant', questions: [{ id: 'revision-b-only-variant-question' }] }], targets: [{ group_id: group }], question_count: 1, duration_seconds: 900,
    max_points: 15, bonus_percent: 0, can_review: true, can_edit: true, can_republish: true, previous_revisions: [original] }
  const archive = repository({ state: async () => state({ items: [entry(otherTest, { version: 7 })] }) })
  const h = componentFixture(archive, { records: [current] }); await h.settle()
  assert.ok(h.article(current.title), 'B is not archived merely because its predecessor A is filed')
  assert.equal(h.article(original.title), undefined)
  assert.match(text(h.tab('Архів')), /Архів\s*1\b/)
  h.tab('Архів').props.onClick(); h.render()
  const historical = h.article(original.title)
  assert.ok(historical, 'An authorized previous revision must retain its own archive card')
  assert.equal(h.article(current.title), undefined)
  const reviewButton = nodes(historical).find(n => n.type === 'TeachingButton' && /Відповіді|Переглянути|переглянути/.test(text(n)))
  assert.ok(reviewButton, 'Archived A still opens authoritative answers')
  reviewButton.props.onClick(); h.render()
  const review = nodes(h.value).find(n => typeof n.type === 'function' && n.type.name === 'TeachingTestReview')
  assert.ok(review); assert.equal(review.props.test.id, otherTest); assert.equal(review.props.test.title, original.title)
  assert.equal(review.props.repository, h.props.repository)
  assert.equal(review.props.test.questions.length, 0, 'Before detail(A), the historical identity placeholder has no inherited questions')
  assert.doesNotMatch(JSON.stringify(review.props.test), /revision-b-secret|revision-b-only-variant/)
  assert.equal(h.mutations.length, 0); assert.equal(archive.writes.length, 0)
  review.props.onClose(); h.render()
  const restore = nodes(h.article(original.title)).find(n => n.type === 'TeachingButton' && text(n).trim() === 'Повернути з архіву')
  assert.ok(restore); restore.props.onClick(); h.render()
  assert.equal(archive.writes.length, 0, 'Restoring A still requires explicit confirmation')
  h.button('Повернути тест').props.onClick(); await h.settle()
  assert.equal(archive.writes.length, 1)
  assert.equal(archive.writes[0].testId, otherTest); assert.equal(archive.writes[0].expectedVersion, 7)
  assert.equal(archive.writes[0].courseId, course); assert.equal(archive.writes[0].archived, false)
  assert.notEqual(archive.writes[0].testId, current.id)
  assert.equal(h.article(original.title), undefined)
  h.tab('Робочий список').props.onClick(); h.render(); assert.ok(h.article(current.title))
  assert.equal(h.mutations.length, 0); assert.equal(h.listCalls.length, 1)
  h.unmount()
})
