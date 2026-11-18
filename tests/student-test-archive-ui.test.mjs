import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(path, resolve) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, { module, exports: module.exports, Date, Map, Set, Error, require: resolve })
  return module.exports
}
const api = load('src/lib/studentTestArchive.ts', () => { throw Error('Unexpected import') })
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const item = (id, changes = {}) => ({ id, title: id, course_id: 'course', course_title: 'Subject', questions: [], duration_seconds: 900, max_points: 10,
  question_count: 2, opens_at: '2026-11-01T08:00:00Z', closes_at: '2026-12-01T08:00:00Z',
  my_attempt: { id: id + '-attempt', status: 'submitted', submitted_at: '2026-11-18T08:00:00Z', published_score: 8, grade_published_at: '2026-11-18T09:00:00Z' }, ...changes })
const samples = () => [item('finished'), item('waiting-grade', { my_attempt: { id: 'waiting-attempt', status: 'submitted', submitted_at: '2026-11-18T08:00:00Z' } }), item('active', { my_attempt: { id: 'active-attempt', status: 'in_progress' } }), item('new', { my_attempt: null })]
function renderer(repository) {
  let props = { repository, groupId: 'group', courseId: 'course', userId: 'student' }, tree, cursor = 0, dirty = false
  const cells = [], effects = []
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const hooks = {
    useState(initial) { const at = cursor++; cells[at] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[at].value, next => { const value = typeof next === 'function' ? next(cells[at].value) : next; if (!Object.is(value, cells[at].value)) { cells[at].value = value; dirty = true } }] },
    useRef(initial) { return cells[cursor++] ??= { current: initial } },
    useCallback(fn, deps) { const at = cursor++; if (!cells[at] || !same(cells[at].deps, deps)) cells[at] = { deps, value: fn }; return cells[at].value },
    useEffect(fn, deps) { const at = cursor++, old = cells[at]; if (!old || !same(old.deps, deps)) { cells[at] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); cells[at].cleanup = fn() }) } },
  }
  const jsx = (type, props) => ({ type, props })
  const Component = load('src/components/teaching/TeachingTestRunner.tsx', name => {
    if (name === 'react') return hooks
    if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
    if (name === 'lucide-react') return new Proxy({}, { get: (_, name) => String(name) })
    if (name.endsWith('/studentTestArchive')) return api
    if (name.endsWith('/teaching')) return { teachingDate: x => x || '' }
    if (name.endsWith('/teachingTests')) return { teachingTestError: e => e.message }
    if (name === './TeachingUI') return { TeachingButton: 'button', TeachingEmpty: 'empty', TeachingField: 'field', TeachingModal: 'modal' }
    return {}
  }).TeachingGroupTests
  function render(next = props, runEffects = true) {
    props = next
    for (let n = 0; n < 30; n++) { dirty = false; cursor = 0; tree = Component(props); if (!runEffects) return; effects.splice(0).forEach(fn => fn()); if (!dirty) return }
    throw Error('Render did not settle')
  }
  const nodes = (value = tree) => value && typeof value === 'object' ? [value, ...[value.props?.children].flat(Infinity).filter(v => v && typeof v === 'object').flatMap(v => nodes(v))] : []
  const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' ? [node.props?.children].flat(Infinity).map(v => v == null ? '' : text(v)).join('') : ''
  const buttons = label => nodes().filter(n => n.type === 'button' && text(n).includes(label))
  render()
  return { render, nodes, buttons, text, get props() { return props }, cards: () => nodes().filter(n => n.type === 'article').map(text), async settle() { for (let n = 0; n < 12; n++) { await Promise.resolve(); render() } }, unmount() { cells.forEach(c => c.cleanup?.()) } }
}
function repository(initial = samples()) {
  let tests = structuredClone(initial)
  const calls = [], repo = { calls, async list() { return { tests: structuredClone(tests) } }, async archive(action, input) {
    calls.push({ action, input }); tests = tests.map(t => api.studentTestCanArchive(t) && (action === 'archive_all' || t.my_attempt.id === input.attemptId) ? { ...t, my_archived: action !== 'restore' } : t)
    return { tests: structuredClone(tests) }
  } }
  return repo
}
test('one click files submitted works, keeps active/new work visible, and restores an individual result', async () => {
  const repo = repository(), ui = renderer(repo); await ui.settle()
  assert.equal(ui.cards().length, 4)
  ui.buttons('В архів усі пройдені')[0].props.onClick(); await ui.settle()
  assert.equal(repo.calls.length, 1); assert.equal(repo.calls[0].action, 'archive_all')
  assert.equal(repo.calls[0].input.userId, 'student'); assert.equal(repo.calls[0].input.groupId, 'group')
  assert.equal(ui.cards().length, 2); assert.ok(ui.cards().some(c => c.includes('active')))
  ui.buttons('Архів ·')[0].props.onClick(); ui.render(); assert.equal(ui.cards().length, 2)
  assert.ok(ui.cards().some(c => c.includes('Результат 8 із 10')))
  ui.buttons('Повернути з архіву')[0].props.onClick(); await ui.settle(); assert.equal(ui.cards().length, 1)
  ui.buttons('Мої тести')[0].props.onClick(); ui.render(); assert.equal(ui.cards().length, 3)
  ui.unmount(); const reloaded = renderer(repo); await reloaded.settle(); assert.equal(reloaded.cards().length, 3); reloaded.unmount()
})
test('network failure and duplicate clicks do not hide tests or produce duplicate writes', async () => {
  const pending = deferred(), repo = repository(); let calls = 0
  repo.archive = () => { calls++; return pending.promise }
  const ui = renderer(repo); await ui.settle(); const button = ui.buttons('В архів усі пройдені')[0]
  button.props.onClick(); button.props.onClick(); ui.render(); assert.equal(calls, 1); assert.equal(ui.cards().length, 4)
  assert.equal(ui.buttons('Оновити')[0].props.disabled, true)
  pending.reject(Error('offline')); await ui.settle(); assert.equal(ui.cards().length, 4)
  assert.ok(ui.nodes().some(n => n.props?.role === 'alert')); ui.unmount()
})
test('account/group changes discard stale archive responses and hide previous private list before effects', async () => {
  const pending = deferred(), repo = repository(); repo.archive = () => pending.promise
  const ui = renderer(repo); await ui.settle(); ui.buttons('В архів усі пройдені')[0].props.onClick()
  const other = repository([item('other-student-work')])
  ui.render({ ...ui.props, repository: other, userId: 'other', groupId: 'other-group' }, false); assert.equal(ui.cards().length, 0)
  ui.render(); pending.resolve({ tests: samples().map(t => ({ ...t, my_archived: true })) }); await ui.settle()
  assert.equal(ui.cards().length, 1); assert.match(ui.cards()[0], /other-student-work/); assert.equal(ui.buttons('В архів усі пройдені')[0].props.disabled, false); ui.unmount()
})
test('new retakes and active attempts cannot inherit archive visibility; staff and QA practice are excluded', () => {
  for (const change of [{ can_edit: true }, { can_review: true }, { qa_own_attempt: true }, { questions: [{}] }, { my_attempt: null }, { my_attempt: { status: 'in_progress' } }]) {
    assert.equal(api.studentTestCanArchive(item('not-completed', change)), false)
    assert.equal(api.studentTestIsArchived(item('not-completed', { my_archived: true, ...change })), false)
  }
  assert.equal(api.studentTestIsArchived(item('old', { my_archived: true })), true)
  assert.equal(api.studentTestIsArchived(item('retake', { is_personal_retake: true, retake_parent_id: 'old', my_attempt: null })), false)
})
test('cloud adapter scopes archive action and rejects an account-mismatched server response', async () => {
  const calls = []; let actor = 'student'
  const module = load('src/lib/teachingTests.ts', name => name === './supabase' ? { supabase: { async rpc(name, args) { calls.push({ name, args }); return { data: { tests: [], archive_user_id: actor }, error: null } } } } : {})
  const repo = module.createSupabaseTeachingTestRepository()
  await repo.archive('archive_all', { userId: 'student', groupId: 'group' })
  assert.equal(calls[0].name, 'xelay_student_test_archive'); assert.equal(calls[0].args.p_expected_user_id, 'student'); assert.equal(calls[0].args.p_attempt_id, null)
  actor = 'other'; await assert.rejects(repo.archive('restore', { userId: 'student', groupId: 'group', attemptId: 'attempt' }), /INVALID_RESPONSE/)
})
