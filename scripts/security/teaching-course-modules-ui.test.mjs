// Execute the real components and handlers using synthetic identities and metadata.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function load(path, imports, extras = {}) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(compiled, { module, exports: module.exports, Promise, Map, Set, Object, Array, JSON, Number, String, ...extras, require(name) { assert.ok(name in imports, 'Explicit component dependency: ' + name); return imports[name] } })
  return module.exports
}
const contracts = load('src/lib/teachingCourseModules.ts', { './supabase': { supabase: { rpc() { throw Error('No network in UI tests') } } } })
function fixture(name, properties, { strict = false } = {}) {
  const cells = [], effects = []
  let index = 0, dirty = false, tree, mounted = true, uuids = 0, visibility
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { if (!mounted) return; const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial } },
    useMemo(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: fn() }; return cells[i].value },
    useEffect(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const old = cells[i]; cells[i] = { deps, cleanup: old?.cleanup, effect: fn }; effects.push(() => { old?.cleanup?.(); cells[i].cleanup = fn() }) } },
  }
  const jsx = (type, props, key) => ({ type, props: props || {}, key })
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, name) => String(name) }),
    '../../lib/teachingCourseModules': contracts,
    '../../lib/useTeachingVisibilityRefresh': { useTeachingVisibilityRefresh(callback, options) { visibility = { callback, options } } },
    './TeachingUI': { TeachingButton: 'TeachingButton', TeachingField: 'TeachingField', TeachingModal: 'TeachingModal', teachingInput: 'input' }, './teaching-course-modules.css': {},
    './TeachingLectureEditor': { TeachingLectureEditor: 'TeachingLectureEditor' },
    './TeachingLectureStatistics': { TeachingLectureStatistics: 'TeachingLectureStatistics' },
    './TeachingLecturePlayer': { TeachingLecturePlayer: 'TeachingLecturePlayer' },
  }
  const compiled = load('src/components/teaching/' + name + '.tsx', imports, { crypto: { randomUUID: () => `new-${++uuids}` } })
  const props = { courseId: 'course-one', groupId: 'group-one', userId: 'actor-one', ...properties }
  const render = () => { for (let pass = 0; pass < 30; pass++) { index = 0; dirty = false; tree = compiled[name](props); effects.splice(0).forEach(fn => fn()); if (!dirty) return tree } throw Error('Component hooks did not settle') }
  render()
  if (strict) { cells.forEach(cell => { if (cell?.effect) { cell.cleanup?.(); cell.cleanup = cell.effect() } }); render() }
  return { props, render, get tree() { return tree }, get visibility() { return visibility },
    find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected component element'); return node },
    button(label) { return this.find(node => ['button', 'TeachingButton'].includes(node.type) && text(node).replace(/\s+/g, ' ').trim() === label) },
    aria(label) { return this.find(node => node.props['aria-label'] === label) },
    field(label) { return nodes(this.find(node => node.type === 'TeachingField' && node.props.label === label)).find(node => ['input', 'textarea', 'select'].includes(node.type)) },
    change(label, value) { this.field(label).props.onChange({ target: { value } }); render() },
    click(label) { const button = this.button(label); button.props.onClick(); render() },
    async settle() { for (let pass = 0; pass < 25; pass++) { await Promise.resolve(); render() } },
    unmount() { mounted = false; cells.forEach(cell => cell?.cleanup?.()) },
  }
}
const item = changes => ({ id: 'item-one', resource_type: 'material', resource_id: 'material-one', title: 'Підготовка до заняття', required: true, completion: 'acknowledged', pass_percent: null, prerequisite_item_ids: [], position: 0, ...changes })
const moduleRow = changes => ({ id: 'module-one', course_id: 'course-one', title: 'Перший модуль', description: 'Опис теми', status: 'draft', group_ids: ['group-one'], position: 0, version: 2, prerequisite_item_ids: [], items: [item()], ...changes })
const resources = [
  { id: 'material-one', resource_type: 'material', title: 'Підготовка до заняття', status: 'published', group_ids: ['group-one'], max_points: null },
  { id: 'assignment-one', resource_type: 'assignment', title: 'Практична робота', status: 'published', group_ids: ['group-one'], max_points: 10 },
  { id: 'test-one', resource_type: 'test', title: 'Перевірка знань', status: 'draft', group_ids: ['group-one'], max_points: 20 },
]
const teacherData = changes => ({ course_id: 'course-one', can_manage: true, modules: [moduleRow()], resources, groups: [{ id: 'group-one', name: 'ТЕСТ-1' }], progress: [], ...changes })
const learningItem = changes => ({ ...item(), locked: false, reason: '', completed: false, available: true, score: null, max_points: null, ...changes })
const learningData = changes => ({ course_id: 'course-one', group_id: 'group-one', course_title: 'Навчальний курс', completed: 0, total: 1, percent: 0, modules: [{ ...moduleRow({ status: 'published' }), items: [learningItem()], locked: false, reason: '', completed: 0, total: 1, percent: 0 }], ...changes })
const teacherRepo = overrides => ({ teacher: async () => teacherData(), save() { throw Error('Unexpected save') }, reorder() { throw Error('Unexpected reorder') }, ...overrides })
const studentRepo = overrides => ({ student: async () => learningData(), acknowledge() { throw Error('Unexpected acknowledgement') }, ...overrides })

test('owner links existing sources without copying or autosaving; explicit draft save includes actor, source IDs and version', async () => {
  const saves = [], events = []
  const f = fixture('TeachingCourseModules', { repository: teacherRepo({ teacher: async () => teacherData({ modules: [] }), save: async payload => { saves.push(plain(payload)); return teacherData({ modules: [{ ...payload, version: 1, items: payload.items.map(entry => ({ ...entry, title: resources.find(resource => resource.id === entry.resource_id).title })) }] }) } }), onChanged: () => events.push('changed') })
  await f.settle(); f.click('Додати модуль')
  f.change('Назва модуля', 'Старт курсу'); f.change('Короткий опис', 'Спочатку прочитайте матеріал.')
  assert.equal(f.find(node => node.type === 'input' && node.props.type === 'checkbox').props.checked, true)
  f.change('Матеріал, завдання або тест', 'material:material-one'); f.click('Додати крок')
  assert.equal(saves.length, 0); assert.match(text(f.tree), /Позначено прочитаним/)
  f.click('Зберегти чернетку'); await f.settle()
  assert.equal(saves.length, 1); assert.equal(saves[0].expected_user_id, 'actor-one'); assert.equal(saves[0].version, 0); assert.equal(saves[0].status, 'draft')
  assert.equal(saves[0].items[0].resource_id, 'material-one'); assert.equal(saves[0].items[0].resource_type, 'material'); assert.equal('title' in saves[0].items[0], false)
  assert.deepEqual(saves[0].group_ids, ['group-one']); assert.equal(events.length, 1); assert.match(text(f.tree), /Студентам її не опубліковано/)
  f.unmount()
})

test('publishing needs a separate review checkbox and confirmation; double clicks cannot make parallel writes', async () => {
  const pending = deferred(), saves = [], f = fixture('TeachingCourseModules', { repository: teacherRepo({ save: payload => { saves.push(plain(payload)); return pending.promise } }) })
  await f.settle(); f.click('Опублікувати модуль'); assert.equal(saves.length, 0)
  assert.equal(f.button('Підтвердити публікацію').props.disabled, true)
  f.click('Підтвердити публікацію'); assert.equal(saves.length, 0)
  const modal = f.find(node => node.type === 'TeachingModal')
  const check = nodes(modal).find(node => node.type === 'input' && node.props.type === 'checkbox')
  check.props.onChange({ target: { checked: true } }); f.render()
  const commit = f.button('Підтвердити публікацію').props.onClick
  commit(); commit(); f.render(); assert.equal(saves.length, 1)
  assert.equal(saves[0].version, 2); assert.equal(saves[0].status, 'published'); assert.equal(saves[0].expected_user_id, 'actor-one')
  pending.resolve(teacherData({ modules: [moduleRow({ status: 'published', version: 3 })] })); await f.settle()
  assert.match(text(f.tree), /Модуль опубліковано/); assert.equal(nodes(f.tree).some(node => node.type === 'TeachingModal'), false)
  f.unmount()
})

test('module reordering is local until explicit save and sends every current version with the captured actor', async () => {
  const second = moduleRow({ id: 'module-two', title: 'Друга тема', position: 1, version: 4, items: [] }), calls = []
  const f = fixture('TeachingCourseModules', { repository: teacherRepo({ teacher: async () => teacherData({ modules: [moduleRow(), second] }), reorder: async (...args) => { calls.push(plain(args)); return teacherData({ modules: [{ ...second, position: 0, version: 5 }, moduleRow({ position: 1, version: 3 })] }) } }) })
  await f.settle(); f.aria('Опустити модуль «Перший модуль»').props.onClick(); f.render()
  assert.equal(calls.length, 0); assert.equal(f.field('Назва модуля').props.disabled, true)
  f.click('Зберегти порядок'); await f.settle()
  assert.deepEqual(calls, [['course-one', ['module-two', 'module-one'], { 'module-one': 2, 'module-two': 4 }, 'actor-one']])
  f.unmount()
})

test('criteria, thresholds, prerequisite links and exact version survive saving, while source identity is not editable', async () => {
  const saves = [], earlier = moduleRow({ id: 'module-zero', title: 'Вступ', position: -1, items: [item({ id: 'intro-item', resource_id: 'intro-source', title: 'Вступний матеріал' })] })
  const main = moduleRow({ items: [item({ resource_type: 'assignment', resource_id: 'assignment-one', title: 'Практична робота', completion: 'submitted' })] })
  const f = fixture('TeachingCourseModules', { repository: teacherRepo({ teacher: async () => teacherData({ modules: [main, earlier] }), save: async payload => { saves.push(plain(payload)); return teacherData({ modules: [earlier, { ...payload, version: 3, items: payload.items.map(entry => ({ ...entry, title: 'Практична робота' })) }] }) } }) })
  await f.settle(); f.find(node => node.type === 'button' && node.props.className === 'tcm-module-select' && /Перший модуль/.test(text(node))).props.onClick(); f.render()
  f.aria('Умови кроку «Практична робота»').props.onClick(); f.render()
  f.change('Умова виконання', 'passed'); f.change('Мінімальний результат, %', '75')
  const prereq = f.find(node => node.type === 'details' && /Відкрити модуль після/.test(text(node)))
  nodes(prereq).find(node => node.type === 'input').props.onChange({ target: { checked: true } }); f.render()
  f.click('Зберегти чернетку'); await f.settle()
  assert.equal(saves[0].version, 2); assert.deepEqual(saves[0].prerequisite_item_ids, ['intro-item'])
  assert.equal(saves[0].items[0].completion, 'passed'); assert.equal(saves[0].items[0].pass_percent, 75); assert.equal(saves[0].items[0].resource_id, 'assignment-one')
  assert.equal(nodes(f.tree).some(node => node.props?.label === 'ID ресурсу'), false)
  f.unmount()
})

test('delegates cannot manage structure and see only returned progress, without assuming progress access', async () => {
  const f = fixture('TeachingCourseModules', { repository: teacherRepo({ teacher: async () => teacherData({ can_manage: false, progress: [{ user_id: 'synthetic-student', full_name: 'Тестовий студент', group_id: 'group-one', group_name: 'ТЕСТ-1', completed: 0, total: 1, percent: 0, items: [{ item_id: 'item-one', completed: false, locked: false, reason: '', score: null, max_points: 10 }] }] }) }) })
  await f.settle(); assert.match(text(f.tree), /Персональний прогрес доступний з правом роботи з журналом/)
  assert.equal(nodes(f.tree).some(node => node.type === 'TeachingButton' && /Додати модуль|Зберегти чернетку|Опублікувати/.test(text(node))), false)
  assert.equal(f.field('Назва модуля').props.disabled, true); assert.match(text(f.tree), /Тестовий студент/); assert.doesNotMatch(text(f.tree), /0 \/ 10/)
  f.unmount()
  const r = fixture('TeachingCourseModules', { readonly: true, repository: teacherRepo() }); await r.settle()
  assert.equal(nodes(r.tree).some(node => node.type === 'TeachingButton' && /Додати модуль/.test(text(node))), false); r.unmount()
})

test('save conflicts preserve local edits and require explicit refresh; failure never reports a successful save', async () => {
  const f = fixture('TeachingCourseModules', { repository: teacherRepo({ save: async () => { throw Error('COURSE_MODULE_CONFLICT') } }) })
  await f.settle(); f.change('Назва модуля', 'Моя незбережена правка'); f.click('Зберегти чернетку'); await f.settle()
  assert.equal(f.field('Назва модуля').props.value, 'Моя незбережена правка'); assert.match(text(f.tree), /Структуру вже змінили/)
  assert.doesNotMatch(text(f.tree), /Чернетку модуля збережено/)
  f.click('Оновити модулі'); assert.equal(f.find(node => node.type === 'TeachingModal').props.title, 'Залишилися незбережені зміни')
  f.click('Залишитися'); assert.equal(f.field('Назва модуля').props.value, 'Моя незбережена правка'); f.unmount()
})

test('old teacher callbacks cannot save after switching accounts, and late responses never render private old data', async () => {
  const pending = deferred(), saves = [], f = fixture('TeachingCourseModules', { repository: teacherRepo({ save: payload => { saves.push(payload); return pending.promise } }) })
  await f.settle(); f.change('Назва модуля', 'Змінена тема')
  const save = f.button('Зберегти чернетку').props.onClick; save(); f.render()
  f.props.userId = 'actor-two'; f.render(); save(); assert.equal(saves.length, 1)
  assert.doesNotMatch(text(f.tree), /Змінена тема/)
  pending.resolve(teacherData({ modules: [moduleRow({ title: 'PRIVATE_OLD_TEACHER' })] })); await f.settle()
  assert.doesNotMatch(text(f.tree), /PRIVATE_OLD_TEACHER/); assert.equal(f.field('Назва модуля').props.value, 'Перший модуль')
  f.unmount()
})

test('strict effect remount still fetches teacher and student data, and discards the first obsolete read', async () => {
  for (const name of ['TeachingCourseModules', 'TeachingCourseLearning']) {
    let calls = 0
    const repository = name === 'TeachingCourseModules' ? teacherRepo({ teacher: async () => { calls++; return teacherData() } }) : studentRepo({ student: async () => { calls++; return learningData() } })
    const f = fixture(name, { repository, onOpen() {} }, { strict: true }); await f.settle()
    assert.equal(calls, 2); assert.match(text(f.tree), /Перший модуль/); f.unmount()
  }
})

test('student reads metadata only, cannot open locked or unpublished resources and never acknowledges on rendering/open', async () => {
  const opens = [], acks = [], course = learningData()
  course.modules[0].items.push(learningItem({ id: 'locked-item', title: 'Закрита контрольна', resource_type: 'test', resource_id: 'test-one', locked: true, reason: 'Спочатку прочитайте матеріал.', completion: 'submitted' }), learningItem({ id: 'draft-item', title: 'PRIVATE_DRAFT_TITLE', resource_id: 'draft-source', available: false }))
  const f = fixture('TeachingCourseLearning', { repository: studentRepo({ student: async () => course, acknowledge: async (...args) => { acks.push(args); return course } }), onOpen: entry => opens.push(plain(entry)) })
  await f.settle(); assert.equal(acks.length, 0); assert.match(text(f.tree), /Спочатку прочитайте матеріал/); assert.doesNotMatch(text(f.tree), /PRIVATE_DRAFT_TITLE/)
  assert.equal(nodes(f.tree).filter(node => node.type === 'TeachingButton' && text(node).includes('Відкрити тест')).length, 0)
  f.click('Відкрити матеріал'); await f.settle(); assert.equal(opens.length, 1); assert.equal(opens[0].id, 'item-one'); assert.equal(acks.length, 0)
  f.unmount()
})

test('explicit read passes exact actor and group, serializes writes and consumes server progress to unlock the next step', async () => {
  const pending = deferred(), calls = [], course = learningData()
  course.modules[0].items.push(learningItem({ id: 'next-item', resource_type: 'test', resource_id: 'test-one', title: 'Наступний тест', completion: 'submitted', locked: true, reason: 'Спочатку прочитайте матеріал.' }))
  const f = fixture('TeachingCourseLearning', { repository: studentRepo({ student: async () => course, acknowledge: (...args) => { calls.push(plain(args)); return pending.promise } }), onOpen() {} })
  await f.settle(); const acknowledge = f.button('Позначити прочитаним').props.onClick
  acknowledge(); acknowledge(); f.render(); assert.equal(calls.length, 1); assert.deepEqual(calls[0], ['item-one', 'group-one', 'actor-one'])
  const unlocked = plain(course); unlocked.completed = 1; unlocked.total = 2; unlocked.percent = 50; unlocked.modules[0].completed = 1; unlocked.modules[0].total = 2; unlocked.modules[0].items[0].completed = true; unlocked.modules[0].items[1].locked = false
  pending.resolve(unlocked); await f.settle()
  assert.match(text(f.tree), /50\s*%/); assert.equal(f.button('Відкрити тест').props.disabled, false)
  assert.equal(nodes(f.tree).some(node => node.type === 'TeachingButton' && text(node).includes('Позначити прочитаним')), false)
  f.unmount()
})

test('student criteria are projections of published results, and refresh after runner close does not mark work submitted locally', async () => {
  let calls = 0
  const start = learningData({ modules: [{ ...learningData().modules[0], items: [learningItem({ resource_type: 'assignment', resource_id: 'assignment-one', completion: 'graded', max_points: 10 })] }] })
  const after = plain(start); after.completed = 1; after.percent = 100; after.modules[0].items[0].completed = true; after.modules[0].items[0].score = 8
  const f = fixture('TeachingCourseLearning', { repository: studentRepo({ student: async () => ++calls === 1 ? start : after }), refreshKey: 0, onOpen() {} })
  await f.settle(); assert.doesNotMatch(text(f.tree), /Опублікований результат/)
  assert.equal(nodes(f.tree).some(node => node.type === 'TeachingButton' && text(node).includes('Позначити прочитаним')), false)
  f.click('Відкрити завдання'); await f.settle(); assert.equal(calls, 1); assert.doesNotMatch(text(f.tree), /Опублікований результат/)
  f.props.refreshKey = 1; f.render(); await f.settle(); assert.equal(calls, 2); assert.match(text(f.tree), /Опублікований результат:\s+8\s+\/ 10/)
  f.unmount()
})

test('captured student actions and late private results are isolated from a new account', async () => {
  const pending = deferred(), calls = []
  const f = fixture('TeachingCourseLearning', { repository: studentRepo({ acknowledge: (...args) => { calls.push(args); return pending.promise } }), onOpen() {} })
  await f.settle(); const read = f.button('Позначити прочитаним').props.onClick; read(); f.render()
  f.props.userId = 'student-two'; f.render(); read(); assert.equal(calls.length, 1)
  pending.resolve(learningData({ course_title: 'PRIVATE_OLD_RESULT', percent: 100 })); await f.settle()
  assert.doesNotMatch(text(f.tree), /PRIVATE_OLD_RESULT/); assert.match(text(f.tree), /Навчальний курс/); f.unmount()
})

test('captured open callback rechecks the latest gate, so a refresh can close access without opening old content', async () => {
  let locked = false, opens = 0
    const f = fixture('TeachingCourseLearning', { repository: studentRepo({ student: async () => { const data = learningData(); data.modules[0].locked = locked; data.modules[0].items[0].locked = locked; data.modules[0].reason = 'Умови змінилися.'; return data } }), onOpen() { opens++ } })
  await f.settle(); const open = f.button('Відкрити матеріал').props.onClick
  locked = true; f.click('Оновити прогрес'); await f.settle(); open(); await f.settle()
  assert.equal(opens, 0); assert.match(text(f.tree), /Умови змінилися/); f.unmount()
})

test('a server-preserved existing attempt can resume inside a module whose future steps are locked', async () => {
  const course = learningData(), opens = []
  course.modules[0].locked = true; course.modules[0].reason = 'Нові умови застосовано до наступних кроків.'
  course.modules[0].items = [
    learningItem({ id: 'started-test', resource_type: 'test', resource_id: 'test-one', title: 'Розпочата спроба', completion: 'submitted', locked: false }),
    learningItem({ id: 'new-test', resource_type: 'test', resource_id: 'test-two', title: 'Наступна робота', completion: 'submitted', locked: true }),
  ]
  const f = fixture('TeachingCourseLearning', { repository: studentRepo({ student: async () => course }), onOpen: entry => opens.push(plain(entry)) })
  await f.settle(); assert.match(text(f.tree), /Нові умови застосовано/)
  assert.equal(nodes(f.tree).filter(node => node.type === 'TeachingButton' && text(node).includes('Продовжити роботу')).length, 1)
  f.click('Продовжити роботу'); await f.settle()
  assert.equal(opens.length, 1); assert.equal(opens[0].id, 'started-test')
  assert.equal(nodes(f.tree).some(node => node.type === 'TeachingButton' && text(node).includes('Відкрити тест')), false)
  f.unmount()
})

test('unmet conditions name only available metadata and distinguish reading, published score and percentage', async () => {
  const course = learningData()
  course.modules[0].items.push(
    learningItem({ id: 'score-item', title: 'Практична робота', resource_type: 'assignment', resource_id: 'assignment-one', completion: 'passed', pass_percent: 60 }),
    learningItem({ id: 'grade-item', title: 'Самостійна робота', resource_type: 'assignment', resource_id: 'assignment-two', completion: 'graded' }),
    learningItem({ id: 'hidden-item', title: 'PRIVATE_DRAFT_DEPENDENCY', available: false, resource_id: 'draft-source' }),
    learningItem({ id: 'target-item', title: 'Наступний крок', locked: true, reason: 'Спочатку виконайте умови.', prerequisite_item_ids: ['item-one', 'score-item', 'grade-item', 'hidden-item', 'missing-item'] }),
  )
  const f = fixture('TeachingCourseLearning', { repository: studentRepo({ student: async () => course }), onOpen() {} }); await f.settle()
  assert.match(text(f.tree), /підтвердити прочитання «Підготовка до заняття»/)
  assert.match(text(f.tree), /опублікований результат від 60% за «Практична робота»/)
  assert.match(text(f.tree), /опублікований бал за «Самостійна робота»/)
  assert.match(text(f.tree), /попередній крок, який готується/)
  assert.doesNotMatch(text(f.tree), /PRIVATE_DRAFT_DEPENDENCY/)
  assert.match(text(f.tree), /Умова: Позначено прочитаним/)
  f.unmount()
})

test('grading criteria cannot be selected for a resource with no positive canonical maximum', async () => {
  const source = { ...resources[1], max_points: null }, current = moduleRow({ items: [item({ resource_type: 'assignment', resource_id: source.id, title: source.title, completion: 'submitted' })] })
  const f = fixture('TeachingCourseModules', { repository: teacherRepo({ teacher: async () => teacherData({ modules: [current], resources: [source] }) }) })
  await f.settle(); f.aria('Умови кроку «Практична робота»').props.onClick(); f.render()
  const options = nodes(f.field('Умова виконання')).filter(node => node.type === 'option')
  assert.equal(options.find(node => node.props.value === 'submitted').props.disabled, false)
  assert.equal(options.find(node => node.props.value === 'graded').props.disabled, true)
  assert.equal(options.find(node => node.props.value === 'passed').props.disabled, true)
  f.change('Умова виконання', 'passed'); assert.equal(f.field('Умова виконання').props.value, 'submitted')
  assert.match(text(f.tree), /спочатку задайте максимальний бал/); f.unmount()
})

const lectureVideo = { storage_path: 'synthetic-course/teacher/lecture.mp4', name: 'Лекція.mp4', mime_type: 'video/mp4', size: 2048 }

test('lecture authoring links an actual test and allows draft save before test publication', async () => {
  const saves = []
  const f = fixture('TeachingCourseModules', { repository: teacherRepo({
    teacher: async () => teacherData({ modules: [] }),
    save: async payload => {
      saves.push(plain(payload))
      return teacherData({ modules: [{ ...payload, version: 1, items: payload.items.map(entry => ({ ...entry, title: resources[2].title })) }] })
    },
  }) })
  await f.settle()
  f.click('Додати відеолекцію')
  f.change('Назва модуля', 'Відеолекція курсу')
  let editor = f.find(node => node.type === 'TeachingLectureEditor')
  editor.props.onVideo(lectureVideo, 120)
  f.render()
  editor = f.find(node => node.type === 'TeachingLectureEditor')
  editor.props.onTest('test-one')
  f.render()
  editor = f.find(node => node.type === 'TeachingLectureEditor')
  assert.equal(editor.props.linkedTest.required, true)
  assert.equal(editor.props.linkedTest.completion, 'submitted')
  assert.equal(f.button('Опублікувати модуль').props.disabled, true)
  assert.equal(f.button('Зберегти чернетку').props.disabled, false)
  f.click('Зберегти чернетку')
  await f.settle()
  assert.equal(saves.length, 1)
  assert.deepEqual(saves[0].lecture, { file: lectureVideo, duration_seconds: 120, test_item_id: saves[0].items[0].id })
  assert.equal(saves[0].items[0].resource_id, 'test-one')
  f.unmount()
})

test('lecture completion refreshes the real server gate and links the one test below the video', async () => {
  const lecture = { file: lectureVideo, duration_seconds: 100, test_item_id: 'test-item', watched_seconds: 50, required_seconds: 90, completed: false }
  const testItem = learningItem({ id: 'test-item', resource_type: 'test', resource_id: 'test-one', completion: 'submitted', locked: true })
  const data = learningData()
  data.modules[0] = { ...data.modules[0], lecture, items: [testItem] }
  const calls = [], opens = []
  const f = fixture('TeachingCourseLearning', { repository: studentRepo({
    student: async () => data,
    recordLectureProgress: async (...args) => {
      calls.push(args)
      return { ...data, modules: [{ ...data.modules[0], lecture: { ...lecture, watched_seconds: 90, completed: true }, items: [{ ...testItem, locked: false }] }] }
    },
  }), onOpen: value => opens.push(value) })
  await f.settle()
  assert.match(text(f.tree), /Завершіть перегляд, щоб відкрити тест/)
  assert.equal(nodes(f.tree).some(node => node.type === 'TeachingButton' && text(node).includes('Відкрити тест')), false)
  const record = f.find(node => node.type === 'TeachingLecturePlayer').props.recordProgress
  await record(90); await f.settle()
  assert.deepEqual(calls, [['module-one', 'group-one', 'actor-one', 90, lectureVideo.storage_path]])
  assert.equal(nodes(f.tree).filter(node => node.type === 'TeachingButton' && text(node).includes('Відкрити тест')).length, 1)
  f.click('Відкрити тест'); await f.settle()
  assert.equal(opens[0].resource_id, 'test-one')
  f.props.userId = 'other-actor'; f.render()
  await assert.rejects(record(91), /COURSE_LECTURE_LOCKED/)
  assert.equal(calls.length, 1)
  f.unmount()
})
