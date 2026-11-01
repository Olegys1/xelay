// Actual editor/select/hooks, real input validation and an injected in-memory
// SDK boundary. No real session, network, storage mutation or provider exists.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url), read = path => readFileSync(new URL(path, root), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText
const id = number => '70000000-0000-4000-8000-' + String(number).padStart(12, '0')
const USER = id(1), OTHER = id(2), GROUP = id(10), SECOND = id(11), PLAN = id(20), ENTRY = id(30)
const plain = value => JSON.parse(JSON.stringify(value))
const text = value => value == null || typeof value === 'boolean' ? '' : Array.isArray(value) ? value.map(text).join(' ') : typeof value === 'object' ? text(value.props?.children) : String(value)
const nodes = value => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
function evaluate(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(compile(source), { module, exports: module.exports, URL, TextEncoder, AbortController, DOMException, ...globals, require(name) { assert.ok(Object.hasOwn(imports, name), 'Explicit import ' + name); return imports[name] }, fetch() { throw Error('Network forbidden') } })
  return module.exports
}
const links = evaluate(read('src/lib/studyGroupLinks.ts'))
const electives = evaluate(read('src/lib/studentElectiveTimetable.ts'), { './studyGroupLinks.ts': links })
const repositoryModule = evaluate(read('src/lib/studentElectiveTimetableRepository.ts'), { './supabase': { supabase: {} }, './studentElectiveTimetable': electives })
const timetableSource = read('src/lib/studyGroupTimetable.ts')
const timetable = evaluate(timetableSource.slice(timetableSource.indexOf('export const LESSON_TYPES'), timetableSource.indexOf('export function timetableImportError')))
const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: 'fragment' }

function hooksRuntime() {
  const cells = [], effects = []; let index = 0, dirty = false, component, props, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? initial() : initial }; const cell = cells[i]; cell.set ??= next => { const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) { cell.value = value; dirty = true } }; return [cell.value, cell.set] },
    useRef(initial) { return cells[index++] ??= { current: initial } },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const prior = cells[i]; cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { prior?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const render = () => { for (let pass = 0; pass < 40; pass++) { index = 0; dirty = false; tree = component(props); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree } throw Error('Actual component did not settle') }
  return { hooks, start(value, input) { component = value; props = input; return render() }, update(input) { props = { ...props, ...input }; return render() }, render, get tree() { return tree }, find(predicate) { const value = nodes(tree).find(predicate); assert.ok(value, 'Actual control exists'); return value }, async flush() { for (let n = 0; n < 25; n++) { await Promise.resolve(); render() } }, unmount() { for (const cell of cells) cell?.cleanup?.() } }
}
const meeting = (extra = {}) => ({ id: ENTRY, subject: 'Психологія спілкування', weekday: 4, starts_at: '18:00', ends_at: '19:20', lesson_type: 'seminar', teacher_name: '', location: '', online_url: null, online_url_secondary: null, online_links_extra: [], conference_id: null, conference_access_code: null, week_pattern: 'every', week_anchor_date: null, ...extra })
const plan = (extra = {}) => ({ id: PLAN, user_id: USER, group_id: GROUP, valid_from: '2026-11-02', valid_until: '2027-01-31', configured: true, version: 7, lessons: [meeting()], ...extra })
function editorFixture(t, options = {}) {
  const run = hooksRuntime(), saves = [], rpcCalls = [], results = []; let currentUser = USER, rpcBehavior = options.rpc
  const client = { auth: { getSession: async () => ({ data: { session: { user: { id: currentUser } } }, error: null }) }, from() { throw Error('Unexpected read') }, rpc(name, args) {
    rpcCalls.push({ name, args: plain(args) })
    if (rpcBehavior) return rpcBehavior(name, args)
    return Promise.resolve({ data: { id: PLAN, user_id: currentUser, group_id: args.p_group_id, valid_from: args.p_valid_from, valid_until: args.p_valid_until, configured: args.p_configured, version: args.p_expected_version == null ? 1 : args.p_expected_version + 1, lessons: args.p_lessons }, error: null })
  } }
  const actualRepository = repositoryModule.createStudentElectiveRepository(client)
  const repository = { ...actualRepository, save(userId, input, signal) { saves.push({ userId, input: plain(input) }); return actualRepository.save(userId, input, signal) } }
  let nextId = 100
  const component = evaluate(read('src/components/schedule/StudentElectiveTimetable.tsx'), { react: run.hooks, 'react/jsx-runtime': jsx, 'lucide-react': new Proxy({}, { get: (_, name) => 'Icon' + String(name) }), '../../lib/studyGroupTimetable': timetable, '../../lib/studentElectiveTimetable': electives, '../../lib/studentElectiveTimetableRepository': { studentElectiveTimetableRepository: repository } }, { crypto: { randomUUID: () => id(nextId++) } })
  run.start(component.StudentElectiveEditor, { userId: USER, groupId: GROUP, date: '2026-11-02', plan: options.plan, repository, onClose() {}, onSaved(value) { results.push(plain(value)) } })
  t.after(() => run.unmount())
  const field = label => { const parent = run.find(node => node.type === 'label' && (Array.isArray(node.props.children) ? node.props.children[0] : node.props.children) === label); const input = nodes(parent).find(node => ['input', 'select'].includes(node.type)); assert.ok(input, 'Actual field ' + label); return input }
  return { run, saves, rpcCalls, results, repository, component, field, change(label, value) { field(label).props.onChange({ target: { value } }); run.render() }, async add() { run.find(node => node.type === 'button' && text(node).includes('Додати заняття')).props.onClick(); await run.flush() }, async submit() { run.find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); await run.flush() }, setRpc(value) { rpcBehavior = value }, user(value) { currentUser = value }, get text() { return text(run.tree) } }
}

test('the actual editor performs no save before an explicit submit and requires an explicit empty-plan choice', async t => {
  const f = editorFixture(t)
  f.change('Початок періоду', '2026-11-09'); f.change('Кінець періоду', '2027-01-15')
  assert.equal(f.saves.length, 0); assert.equal(f.rpcCalls.length, 0)
  const save = f.run.find(node => node.type === 'button' && text(node).includes('Зберегти мій розклад'))
  assert.equal(save.props.disabled, true); await f.submit(); assert.equal(f.saves.length, 0)
  f.run.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange({ target: { checked: true } }); f.run.render(); await f.submit()
  assert.equal(f.rpcCalls.length, 1); assert.deepEqual(f.rpcCalls[0].args.p_lessons, []); assert.equal(f.rpcCalls[0].args.p_configured, true)
  assert.equal(f.rpcCalls[0].args.p_valid_from, '2026-11-09'); assert.equal(f.rpcCalls[0].args.p_valid_until, '2027-01-15')
})

test('actual controlled fields produce exact dates, own meeting ids and no shared schedule identifier on save', async t => {
  const f = editorFixture(t); await f.add()
  f.change('Початок періоду', '2026-11-09'); f.change('Кінець періоду', '2027-01-15'); f.change('Предмет', 'Мій обраний курс'); f.change('День', '4'); f.change('Початок', '18:00'); f.change('Завершення', '19:20'); f.change('Викладач', 'Ірина'); f.change('Аудиторія', '401'); f.change('Посилання', 'https://example.com/personal'); f.change('ID конференції', '123 456'); f.change('Код доступу', '0007')
  assert.equal(f.saves.length, 0); await f.submit()
  assert.equal(f.saves[0].userId, USER); assert.equal(f.saves[0].input.groupId, GROUP); assert.equal(f.saves[0].input.lessons[0].id, id(100))
  const call = f.rpcCalls[0]; assert.equal(call.name, 'xelay_save_student_elective_plan'); assert.equal(call.args.p_valid_from, '2026-11-09'); assert.equal(call.args.p_valid_until, '2027-01-15')
  assert.equal(call.args.p_lessons[0].subject, 'Мій обраний курс'); assert.equal(call.args.p_lessons[0].weekday, 4); assert.equal(call.args.p_lessons[0].conference_access_code, '0007')
  assert.equal(call.args.p_expected_version, null); assert.equal(f.results[0].version, 1)
  assert.doesNotMatch(JSON.stringify(call.args), /schedule_item_id|source_schedule_id|p_user_id/)
})

test('wrong clocks, blank subject and reversed dates are rejected by real validation before any RPC and retain inputs', async t => {
  for (const invalid of [{ field: 'Початок', value: '24:00' }, { field: 'Завершення', value: '18:00' }, { field: 'Предмет', value: '' }, { field: 'Кінець періоду', value: '2026-11-01' }]) {
    const f = editorFixture(t, { plan: plan() }); f.change(invalid.field, invalid.value); await f.submit()
    assert.equal(f.rpcCalls.length, 0); assert.equal(f.results.length, 0); assert.equal(f.field(invalid.field).props.value, invalid.value)
    assert.ok(nodes(f.run.tree).some(node => node.props?.role === 'alert'))
  }
})

test('updating a plan keeps exact existing entry ids and passes its optimistic version', async t => {
  const f = editorFixture(t, { plan: plan() }); f.change('Предмет', 'Оновлений курс'); await f.submit()
  assert.equal(f.saves[0].input.expectedVersion, 7); assert.equal(f.rpcCalls[0].args.p_expected_version, 7)
  assert.equal(f.rpcCalls[0].args.p_lessons[0].id, ENTRY); assert.equal(f.results[0].version, 8); assert.equal(f.results[0].lessons[0].subject, 'Оновлений курс')
})

test('editing the existing term updates the same owner plan through its id and version instead of deleting or creating', async t => {
  let stored = plan()
  const f = editorFixture(t, { plan: stored, rpc: (name, args) => {
    assert.equal(name, 'xelay_save_student_elective_plan')
    assert.equal(args.p_plan_id, stored.id, 'the existing plan id is required to find its changed period')
    assert.equal(args.p_expected_version, stored.version); assert.equal(args.p_group_id, stored.group_id)
    stored = { ...stored, valid_from: args.p_valid_from, valid_until: args.p_valid_until, lessons: args.p_lessons, version: stored.version + 1 }
    return Promise.resolve({ data: stored, error: null })
  } })
  f.change('Початок періоду', '2026-11-09'); f.change('Кінець періоду', '2027-01-15'); await f.submit()
  assert.equal(f.rpcCalls.length, 1); assert.equal(f.saves[0].input.planId, PLAN); assert.equal(f.saves[0].input.expectedVersion, 7)
  assert.equal(f.results.length, 1); assert.equal(f.results[0].id, PLAN); assert.equal(f.results[0].user_id, USER)
  assert.equal(f.results[0].valid_from, '2026-11-09'); assert.equal(f.results[0].valid_until, '2027-01-15'); assert.equal(f.results[0].version, 8)
  assert.equal(f.results[0].lessons[0].id, ENTRY)
})

test('double submit before a state rerender still dispatches only one save, and a server failure leaves fields editable', async t => {
  let release
  const f = editorFixture(t, { plan: plan(), rpc: () => new Promise(resolve => { release = resolve }) })
  f.change('Предмет', 'Збережіть цей текст')
  const submit = f.run.find(node => node.type === 'form').props.onSubmit
  submit({ preventDefault() {} }); submit({ preventDefault() {} }); await f.run.flush()
  assert.equal(f.saves.length, 1); assert.equal(f.rpcCalls.length, 1)
  release({ data: null, error: { code: '40001', message: 'Synthetic conflict' } }); await f.run.flush()
  assert.equal(f.results.length, 0); assert.equal(f.field('Предмет').props.value, 'Збережіть цей текст'); assert.match(f.text, /Налаштування вже змінилися/)
  assert.equal(f.run.find(node => node.type === 'fieldset').props.disabled, false)
})

test('an unmounted editor from the previous keyed account cannot report a stale successful save', async t => {
  let release
  const f = editorFixture(t, { plan: plan(), rpc: (_name, args) => new Promise(resolve => { release = () => resolve({ data: plan({ version: 8, lessons: args.p_lessons }), error: null }) }) })
  await f.submit(); assert.equal(f.rpcCalls.length, 1); f.run.unmount(); release(); await f.run.flush()
  assert.deepEqual(f.results, [])
  // The actual parent keys editors by current owner, group and date.
  assert.match(read('src/pages/StudyGroupsPage.tsx'), /StudentElectiveEditor key=\{`\$\{authUser\.id\}:\$\{group\.id\}:\$\{selectedDate\}`\}/)
})

test('returning to the generic block requires its own explicit action with the current owner and version', async t => {
  const f = editorFixture(t, { plan: plan(), rpc: () => Promise.resolve({ data: true, error: null }) })
  assert.equal(f.rpcCalls.length, 0)
  f.run.find(node => node.type === 'button' && text(node).includes('Повернути загальний блок')).props.onClick(); await f.run.flush()
  assert.deepEqual(f.rpcCalls, [{ name: 'xelay_remove_student_elective_plan', args: { p_id: PLAN, p_expected_version: 7 } }])
  assert.deepEqual(f.results, [null]); assert.equal(f.saves.length, 0)
})

test('the actual shared lesson-type selector persists elective as an explicit flag plus the ordinary other type', () => {
  const component = evaluate(read('src/components/schedule/ScheduleLessonTypeSelect.tsx'), { 'react/jsx-runtime': jsx, '../../lib/studyGroupTimetable': timetable })
  const calls = [], render = props => component.ScheduleLessonTypeSelect({ lessonType: 'lecture', elective: false, onChange: (...args) => calls.push(args), ...props })
  nodes(render({})).find(node => node.type === 'select').props.onChange({ target: { value: 'elective' } })
  assert.deepEqual(calls, [['other', true]])
  const selected = render({ lessonType: 'other', elective: true }); assert.equal(nodes(selected).find(node => node.type === 'select').props.value, 'elective'); assert.match(text(selected), /лише в його розкладі/)
  nodes(selected).find(node => node.type === 'select').props.onChange({ target: { value: 'seminar' } }); assert.deepEqual(calls[1], ['seminar', false])
})

test('useStudentElectivePlans discards old user/group load replies and clears private data immediately on disabling', async t => {
  const run = hooksRuntime(), pending = [], repository = { load(userId, groupId, signal) { return new Promise((resolve, reject) => pending.push({ userId, groupId, signal, resolve, reject })) } }
  const component = evaluate(read('src/components/schedule/StudentElectiveTimetable.tsx'), { react: run.hooks, 'react/jsx-runtime': jsx, 'lucide-react': {}, '../../lib/studyGroupTimetable': timetable, '../../lib/studentElectiveTimetable': electives, '../../lib/studentElectiveTimetableRepository': { studentElectiveTimetableRepository: repository } })
  run.start(props => component.useStudentElectivePlans(props.userId, props.groupId, props.enabled, repository), { userId: USER, groupId: GROUP, enabled: true }); t.after(() => run.unmount())
  assert.equal(pending.length, 1); assert.equal(run.tree.loading, true)
  run.update({ userId: OTHER, groupId: SECOND }); assert.equal(pending[0].signal.aborted, true); assert.deepEqual(plain(run.tree.plans), [])
  pending[0].resolve([plan()]); await run.flush(); assert.deepEqual(plain(run.tree.plans), [])
  const current = plan({ user_id: OTHER, group_id: SECOND }); pending[1].resolve([current]); await run.flush(); assert.deepEqual(plain(run.tree.plans), [current])
  run.update({ enabled: false }); assert.deepEqual(plain(run.tree.plans), []); assert.equal(run.tree.loading, false); assert.equal(pending[1].signal.aborted, true)
  run.update({ userId: USER, groupId: GROUP, enabled: true }); assert.equal(pending.length, 3)
  pending[2].reject(new Error('Synthetic access failure')); await run.flush(); assert.deepEqual(plain(run.tree.plans), []); assert.match(run.tree.error, /Не вдалося завантажити/)
})

test('a hook reload aborts the previous read even for the same owner scope and keeps only its newest result', async t => {
  const run = hooksRuntime(), pending = [], repository = { load(_user, _group, signal) { return new Promise(resolve => pending.push({ signal, resolve })) } }
  const component = evaluate(read('src/components/schedule/StudentElectiveTimetable.tsx'), { react: run.hooks, 'react/jsx-runtime': jsx, 'lucide-react': {}, '../../lib/studyGroupTimetable': timetable, '../../lib/studentElectiveTimetable': electives, '../../lib/studentElectiveTimetableRepository': { studentElectiveTimetableRepository: repository } })
  run.start(() => component.useStudentElectivePlans(USER, GROUP, true, repository), {}); t.after(() => run.unmount())
  run.tree.reload(); run.render(); assert.equal(pending.length, 2); assert.equal(pending[0].signal.aborted, true)
  pending[1].resolve([plan({ version: 9 })]); await run.flush(); assert.equal(run.tree.plans[0].version, 9)
  pending[0].resolve([plan({ version: 7 })]); await run.flush(); assert.equal(run.tree.plans[0].version, 9)
})
