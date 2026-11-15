// Real personal-role settings and calendar handlers, synthetic users/data only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = name => readFileSync(new URL('../../src/components/teaching/' + name + '.tsx', import.meta.url), 'utf8')
const content = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(content).join(' ') : typeof node === 'object' ? content(node.props?.children) : String(node)
const nodes = node => node == null || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const plain = value => JSON.parse(JSON.stringify(value))
const types = { lecture: 'Лекція', seminar: 'Семінар', practical: 'Практичне', lab: 'Лабораторна', makeup: 'Відпрацювання', replacement: 'Заміна', module: 'Модуль', final_assessment: 'Підсумкова робота', test: 'Контрольна робота', other: 'Заняття' }
const role = changes => ({ course_id: 'course', course_title: 'Економіка', group_id: 'group', group_name: 'ТЕСТ-1', lesson_types: [], version: 0, ...changes })
const lesson = changes => ({ id: 'lecture-slot', course_id: 'course', course_title: 'Економіка', group_id: 'group', group_name: 'ТЕСТ-1', subject_name: 'Економіка', lesson_date: '2026-11-04', starts_at: '08:00:00', ends_at: '09:20:00', lesson_type: 'lecture', location: null, assigned_to_me: false, assignment_source: 'none', source: 'timetable', homework: [], homework_count: 0, ...changes })
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

function fixture(name, properties) {
  const cells = [], effects = []
  let index = 0, dirty = false, tree, mounted = true
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { if (!mounted) return; const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial } },
    useMemo(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: fn() }; return cells[i].value },
    useCallback(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: fn }; return cells[i].value },
    useEffect(fn, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const old = cells[i]; cells[i] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); cells[i].cleanup = fn() }) } },
  }
  const jsx = (type, props, key) => ({ type, props: props || {}, key })
  const imports = {
    react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' }, 'lucide-react': new Proxy({}, { get: (_, key) => String(key) }),
    '../../lib/assistant-v2/pageContext': { publishAssistantPageContext() {}, releaseAssistantPageContext() {} },
    '../../lib/seminars': { kyivToday: () => '2026-11-04', seminarStartMilliseconds: ({ lesson_date, starts_at }) => Date.parse(`${lesson_date}T${starts_at}Z`) },
    '../../lib/studyGroupTimetable': { LESSON_TYPES: types, addTimetableDays: (from, days) => { const date = new Date(`${from}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10) } },
    '../../lib/teaching': { teachingDate: value => value || '', teachingError: failure => failure.message },
    '../../lib/useTeachingVisibilityRefresh': { useTeachingVisibilityRefresh() {} }, '../../lib/teachingHomeNavigation': { teachingHomeDate: date => date },
    './TeachingUI': { TeachingButton: 'TeachingButton', TeachingEmpty: 'TeachingEmpty', TeachingField: 'TeachingField', teachingInput: 'input' },
    './TeachingOfflineCalendar': { TeachingOfflineCalendar: 'TeachingOfflineCalendar' },
    './TeachingLessonRoleSettings': { TeachingLessonRoleSettings: 'TeachingLessonRoleSettings' }, './teaching-workflow.css': {}, './teaching-lesson-roles.css': {},
  }
  const module = { exports: {} }
  const compiled = ts.transpileModule(read(name), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(compiled, { module, exports: module.exports, Date, Intl, Promise, Symbol, encodeURIComponent, window: { setInterval: () => 1, clearInterval() {} }, require(importName) { assert.ok(importName in imports, 'Explicit synthetic import: ' + importName); return imports[importName] } })
  const props = name === 'TeachingCalendar' ? { userId: 'teacher-one', courses: [], onOpenJournal() {}, ...properties } : { roles: [], busy: false, onSave: async () => true, ...properties }
  const render = () => { for (let pass = 0; pass < 25; pass++) { index = 0; dirty = false; tree = module.exports[name](props); effects.splice(0).forEach(fn => fn()); if (!dirty) return tree } throw Error('Synthetic hooks did not settle') }
  render()
  return { props, get tree() { return tree }, render,
    find: predicate => { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected UI element'); return node },
    button(label) { return this.find(node => ['button', 'TeachingButton'].includes(node.type) && content(node).replace(/\s+/g, ' ').trim() === label) },
    select(label, value) { const field = this.find(node => node.type === 'TeachingField' && node.props.label === label); nodes(field).find(node => node.type === 'select').props.onChange({ target: { value } }); render() },
    async settle() { for (let pass = 0; pass < 25; pass++) { await Promise.resolve(); render() } },
    unmount() { mounted = false; cells.forEach(cell => cell?.cleanup?.()) },
  }
}
const panel = f => f.find(node => node.type === 'TeachingLessonRoleSettings')
const articles = f => nodes(f.tree).filter(node => node.type === 'article')

test('settings preselect exact contextual pair, show every connected pair and do not save presets automatically', async () => {
  const calls = [], roles = [role({ group_id: 'another-group', group_name: 'ТЕСТ-2' }), role()]
  const f = fixture('TeachingLessonRoleSettings', { roles, preferredCourseId: 'course', preferredGroupId: 'group', onSave: async (...args) => { calls.push(plain(args)); return true } })
  assert.equal(f.find(node => node.type === 'select').props.value, 'course:group')
  assert.equal(nodes(f.tree).filter(node => node.type === 'option').length, 3)
  f.button('Семінари').props.onClick(); f.render()
  assert.equal(calls.length, 0)
  assert.equal(f.button('Зберегти мої заняття').props.disabled, false)
  await f.button('Зберегти мої заняття').props.onClick(); await f.settle()
  assert.equal(calls.length, 1); assert.deepEqual(calls[0][1], ['seminar']); assert.equal(calls[0][0].group_id, 'group'); assert.equal(calls[0][0].version, 0)
  assert.match(content(f.tree), /не змінює права викладачів/)
  assert.match(content(f.tree), /Ручні винятки залишилися без змін/)
  f.unmount()
})

test('seminar presets never include practical or lab silently; custom types and explicit manual-only reset remain selectable', async () => {
  const calls = [], f = fixture('TeachingLessonRoleSettings', { roles: [role()], onSave: async (r, value) => { calls.push(plain(value)); return false } })
  f.button('Лекції та семінари').props.onClick(); f.render()
  const checks = nodes(f.tree).filter(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(checks.length, 10); assert.equal(checks[0].props.checked, true); assert.equal(checks[1].props.checked, true)
  assert.equal(checks[2].props.checked, false); assert.equal(checks[3].props.checked, false)
  checks[3].props.onChange({ target: { checked: true } }); f.render()
  await f.button('Зберегти мої заняття').props.onClick(); f.render()
  assert.deepEqual(calls[0], ['lecture', 'seminar', 'lab'])
  f.props.roles = [role({ version: 1, lesson_types: ['lecture'] })]; f.render()
  f.button('Взяти актуальні налаштування').props.onClick(); f.render()
  f.button('Лише ручні позначки').props.onClick(); f.render()
  await f.button('Зберегти мої заняття').props.onClick(); f.render(); assert.deepEqual(calls[1], [])
  f.unmount()
})

test('an unset role can be explicitly configured as manual-only without selecting a type first', async () => {
  const calls = [], f = fixture('TeachingLessonRoleSettings', { roles: [role()], onSave: async (...args) => { calls.push(plain(args)); return true } })
  assert.equal(f.button('Зберегти мої заняття').props.disabled, true)
  assert.equal(f.button('Лише ручні позначки').props.disabled, false)
  f.button('Лише ручні позначки').props.onClick(); f.render()
  assert.equal(f.button('Зберегти мої заняття').props.disabled, false)
  await f.button('Зберегти мої заняття').props.onClick(); await f.settle()
  assert.equal(calls.length, 1); assert.deepEqual(calls[0][1], []); assert.equal(calls[0][0].version, 0)
  f.unmount()
})

test('a concurrent role update preserves local choices and requires reconciliation rather than overwriting a newer version', async () => {
  const calls = [], f = fixture('TeachingLessonRoleSettings', { roles: [role()], onSave: async (...args) => { calls.push(args); return false } })
  f.button('Лекції').props.onClick(); f.render()
  f.props.roles = [role({ lesson_types: ['lab'], version: 3 })]; f.render()
  assert.match(content(f.tree), /налаштування вже змінилося/)
  assert.equal(f.button('Зберегти мої заняття').props.disabled, true)
  await f.button('Зберегти мої заняття').props.onClick(); f.render(); assert.equal(calls.length, 0)
  f.button('Взяти актуальні налаштування').props.onClick(); f.render(); f.button('Семінари').props.onClick(); f.render()
  await f.button('Зберегти мої заняття').props.onClick(); f.render()
  assert.equal(calls[0][0].version, 3)
  f.props.roles = [role({ group_id: 'new-group' })]; f.render()
  assert.equal(f.find(node => node.type === 'select').props.value, '')
  assert.equal(nodes(f.tree).some(node => node.type === 'TeachingButton' && content(node) === 'Зберегти мої заняття'), false)
  f.unmount()
})

test('legacy calendar response shows no unsupported role editor; all role configurations survive an empty week', async () => {
  const legacy = fixture('TeachingCalendar', { repository: { teacherCalendar: async () => ({ lessons: [] }), saveLessonRole() { throw Error('No call expected') } } }); await legacy.settle()
  assert.equal(nodes(legacy.tree).some(node => node.type === 'TeachingLessonRoleSettings'), false); legacy.unmount()
  const roles = [role(), role({ group_id: 'group-two' })], reads = []
  const f = fixture('TeachingCalendar', { repository: { teacherCalendar: async (...args) => { reads.push(args); return { lessons: [], teaching_roles: roles } }, saveLessonRole() { throw Error('No implicit save') } } }); await f.settle()
  assert.equal(panel(f).props.roles.length, 2); assert.deepEqual(reads, [['2026-11-04', '2026-11-10']]); f.unmount()
})

test('explicit save passes captured actor/version, serializes against manual assignment and refreshes one calendar snapshot', async () => {
  const pending = deferred(), reads = [], saves = [], marks = []
  let currentRole = role()
  const repository = {
    teacherCalendar: async (...args) => { reads.push(args); return { lessons: [lesson({ assigned_to_me: currentRole.lesson_types.includes('lecture'), assignment_source: currentRole.version ? 'role' : 'none' }), lesson({ id: 'seminar-slot', starts_at: '09:40:00', lesson_type: 'seminar' })], teaching_roles: [currentRole] } },
    saveLessonRole: (...args) => { saves.push(args); return pending.promise }, setCalendarLesson: (...args) => { marks.push(args); return Promise.resolve({ assigned: true, assignment_source: 'manual' }) },
  }
  const f = fixture('TeachingCalendar', { repository }); await f.settle()
  const oldSave = panel(f).props.onSave, oldMark = f.button('Додати до моїх пар').props.onClick
  const saving = oldSave(currentRole, ['lecture']); f.render()
  assert.equal(panel(f).props.disabled, true)
  assert.equal(await oldSave(currentRole, ['seminar']), false)
  await oldMark(); await f.settle(); assert.equal(marks.length, 0)
  assert.deepEqual(saves[0], ['course', 'group', ['lecture'], 0, 'teacher-one'])
  currentRole = role({ version: 1, lesson_types: ['lecture'] }); pending.resolve(currentRole)
  assert.equal(await saving, true); await f.settle()
  assert.equal(saves.length, 1); assert.equal(reads.length, 2)
  assert.equal(articles(f)[0].props['data-my-lesson'], true); assert.match(content(articles(f)[0]), /Веду я/)
  assert.match(content(articles(f)[0]), /За моїм вибором видів занять/)
  assert.match(content(articles(f)[1]), /Не позначено як мою пару/)
  const filter = f.find(node => node.type === 'input' && node.props.type === 'checkbox')
  assert.equal(filter.props.checked, false); filter.props.onChange({ target: { checked: true } }); f.render(); assert.equal(articles(f).length, 1)
  f.unmount()
})

test('manual exceptions update repeated occurrences without erasing the selected lesson-type role', async () => {
  const calls = [], current = role({ version: 1, lesson_types: ['lecture'] })
  const rows = [lesson({ assigned_to_me: true, assignment_source: 'role' }), lesson({ lesson_date: '2026-11-05', assigned_to_me: true, assignment_source: 'role' })]
  const f = fixture('TeachingCalendar', { repository: { teacherCalendar: async () => ({ lessons: rows, teaching_roles: [current] }), saveLessonRole() { throw Error('Role must stay unchanged') }, setCalendarLesson: async (...args) => { calls.push(args); return { assigned: false, assignment_source: 'manual' } } } }); await f.settle()
  f.button('Веду я · прибрати позначку').props.onClick(); await f.settle()
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], ['course', 'group', 'lecture-slot', 'timetable', false])
  assert.ok(articles(f).every(node => node.props['data-my-lesson'] === false))
  assert.match(content(articles(f)[0]), /Особистий виняток/); assert.deepEqual(plain(panel(f).props.roles[0].lesson_types), ['lecture'])
  f.unmount()
})

test('captured old-account settings cannot write or display late saved data after switching identity', async () => {
  const pending = deferred(), saves = []
  const repository = { teacherCalendar: async () => ({ lessons: [], teaching_roles: [role()] }), saveLessonRole: (...args) => { saves.push(args); return pending.promise } }
  const f = fixture('TeachingCalendar', { repository }); await f.settle()
  const oldSave = panel(f).props.onSave, saving = oldSave(role(), ['lecture']); f.render()
  f.props.userId = 'teacher-two'; f.render()
  assert.equal(nodes(f.tree).some(node => node.type === 'TeachingLessonRoleSettings'), false)
  assert.equal(await oldSave(role(), ['seminar']), false); assert.equal(saves.length, 1)
  pending.resolve(role({ course_title: 'PRIVATE_OLD_ACCOUNT', version: 1, lesson_types: ['lecture'] }))
  assert.equal(await saving, false); await f.settle()
  assert.doesNotMatch(JSON.stringify(panel(f).props.roles), /PRIVATE_OLD_ACCOUNT/)
  assert.equal(panel(f).props.busy, false); f.unmount()
})

test('save failure stays visible with current role data intact and permits an explicit retry', async () => {
  let fail = true, saves = 0
  const current = role(), f = fixture('TeachingCalendar', { repository: { teacherCalendar: async () => ({ lessons: [], teaching_roles: [current] }), saveLessonRole: async () => { saves++; if (fail) throw Error('Налаштування вже змінилися. Оновіть розклад.'); return role({ version: 1, lesson_types: ['lecture'] }) } } }); await f.settle()
  assert.equal(await panel(f).props.onSave(current, ['lecture']), false); await f.settle()
  assert.match(panel(f).props.error, /Оновіть розклад/); assert.equal(panel(f).props.roles[0].version, 0)
  fail = false; assert.equal(await panel(f).props.onSave(current, ['lecture']), true); await f.settle()
  assert.equal(panel(f).props.error, ''); assert.equal(saves, 2); f.unmount()
})
