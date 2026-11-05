// Real journal handlers and filtering helpers, fictional records, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFileSync(new URL('../../' + path, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const nodes = node => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(nodes) : [node, ...nodes(node.props?.children)]
const text = node => node == null || typeof node === 'boolean' ? '' : Array.isArray(node) ? node.map(text).join(' ') : typeof node === 'object' ? text(node.props?.children) : String(node)
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
function load(source, imports = {}) {
  const module = { exports: {} }, code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, Intl, Date, Promise, Error, localStorage: { getItem: () => null, setItem() {} }, require(name) { assert.ok(name in imports, 'Explicit journal dependency ' + name); return imports[name] } })
  return module.exports
}
const helpers = load(read('src/lib/teachingJournalPreferences.ts'))
const grading = load(read('src/lib/teachingGrading.ts'))
const semester = load(read('src/lib/teachingSemesterJournal.ts'), { './teachingGrading': grading })
const followup = load(read('src/lib/teachingGradeFollowup.ts'))
const visibility = load(read('src/lib/studyGroupVisibility.ts'))
const schedule = load(read('src/lib/teachingJournalSchedule.ts'))
const activity = (id, type) => ({ id, course_id: 'course', group_id: 'group', title: id, activity_date: '2026-11-05', category: '', max_points: 10, version: 1, ...(type ? { schedule_item_id: 'schedule-' + id, schedule_lesson_type: type } : {}) })
const activities = [activity('Lecture', 'lecture'), activity('Seminar', 'seminar'), activity('Practical', 'practical'), activity('Lab', 'lab'), activity('Unscheduled assignment'), activity('Unscheduled test'), activity('Scheduled exam', 'final_assessment')]
const base = () => ({ course: { id: 'course', title: 'Курс', starts_on: '2026-09-01', ends_on: '2026-12-31', archived_at: null, grading_rules: { categories: [] }, permissions: ['grades'] },
  groups: [{ id: 'group-link', course_id: 'course', group_id: 'group', group_name: 'ТЕСТ-1', status: 'accepted' }], entries: [{ id: 'entry', course_id: 'course', group_id: 'group', user_id: 'student', full_name: 'Тестова студентка', active: true }],
  activities: plain(activities), grades: [{ id: 'grade', activity_id: 'Lecture', entry_id: 'entry', draft_score: 5, draft_comment: '', published_score: 5, published_comment: '', published_at: '2026-11-05', version: 1 }], audit: [], assignments: [], materials: [], members: [], teachers: [], roster_claims: [] })

function backend(initial = {}) {
  const values = new Map(Object.entries(initial)), calls = [], writes = []
  const key = (actor, course, group) => `${actor}:${course}:${group}`
  const repository = actor => ({ mode: 'supabase', journalPreferences: async (course, group) => plain(values.get(key(actor, course, group)) || { activity_ids: [], version: 0, view_settings: helpers.teachingJournalView() }),
    saveJournalView: async (course, group, view, version, expected) => { assert.equal(expected, actor); calls.push(plain([course, group, view, version, expected])); const previous = values.get(key(actor, course, group)) || { activity_ids: [], version: 0 }; if (previous.version !== version) throw Error('TEACHING_CONFLICT'); const next = { ...previous, view_settings: plain(view), version: version + 1 }; values.set(key(actor, course, group), next); return plain(next) },
    saveJournalPreferences: async (course, group, ids, version, expected) => { assert.equal(expected, actor); writes.push(plain([course, group, ids, version, expected])); const previous = values.get(key(actor, course, group)); assert.equal(previous.version, version); const next = { ...previous, activity_ids: plain(ids), version: version + 1 }; values.set(key(actor, course, group), next); return { activity_ids: ids, version: next.version } },
    mutate() { throw Error('Journal view must never mutate grades') },
  })
  return { values, calls, writes, repository }
}
function fixture(properties) {
  const cells = [], effects = [], csv = [], excel = []
  let index = 0, dirty = false, tree
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, update => { const value = typeof update === 'function' ? update(cells[i].value) : update; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { return cells[index++] ??= { current: initial } },
    useMemo(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: callback() }; return cells[i].value },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const prior = cells[i]; cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { prior?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const jsx = (type, props, key) => ({ type, props, key })
  const imports = { react: hooks, 'react/jsx-runtime': { jsx, jsxs: jsx }, 'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '../../lib/teaching': { teachingDate: value => value, teachingError: error => error.message, gradeHasDraft: () => false, teachingTotal: snapshot => { assert.equal(snapshot.activities.length, activities.length, 'Totals always receive the unfiltered course snapshot'); return 5 }, exportTeachingJournal: (...args) => csv.push(plain(args)) },
    '../../lib/teachingJournalPreferences': helpers, '../../lib/teachingGrading': grading, '../../lib/teachingGradeFollowup': followup,
    '../../lib/teachingSemesterJournal': semester, '../../lib/studyGroupVisibility': visibility, '../../lib/teachingJournalSchedule': schedule,
    '../../lib/teachingJournalWorkbook': { exportTeachingJournalWorkbook: async (...args) => excel.push(args) }, '../../lib/seminars': { kyivToday: () => '2026-11-05' },
    '../../lib/assistant-v2/pageContext': { publishAssistantPageContext() {}, releaseAssistantPageContext() {} },
    './TeachingUI': { TeachingButton: 'TeachingButton', TeachingEmpty: 'TeachingEmpty', TeachingField: 'TeachingField', TeachingModal: 'TeachingModal', teachingInput: 'input' },
    './TeachingLaunchNotice': { TeachingLaunchNotice: 'TeachingLaunchNotice' }, './TeachingStatement': { TeachingStatement: 'TeachingStatement' },
    './TeachingGradingRulesEditor': { TeachingGradingRulesSummary: 'TeachingGradingRulesSummary', TeachingWorkTypeField: 'TeachingWorkTypeField' },
    './TeachingGroupGradingSettings': { TeachingGroupGradingSettings: 'TeachingGroupGradingSettings' }, './TeachingJournalScheduleSync': { TeachingJournalScheduleSync: 'TeachingJournalScheduleSync' }, './teaching-journal-order.css': {},
  }
  const api = load(read('src/components/teaching/TeachingGradebook.tsx'), imports)
  const props = { snapshot: base(), userId: 'teacher', onRefresh: async () => {}, ...properties }
  function render() { for (let pass = 0; pass < 30; pass++) { index = 0; dirty = false; tree = api.TeachingGradebook(props); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree } throw Error('Hooks did not settle') }
  render()
  return { props, render, csv, excel, get tree() { return tree },
    find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected journal element'); return node },
    button(label) { return this.find(node => ['button', 'TeachingButton'].includes(node.type) && text(node).replace(/\s+/g, ' ').trim() === label) },
    click(label) { this.button(label).props.onClick(); render() },
    pickLayout(value) { this.find(node => node.type === 'input' && node.props.name === 'journal-layout' && node.props.value === value).props.onChange(); render() },
    columns() { return nodes(tree).filter(node => node.type === 'th' && Object.hasOwn(node.props, 'data-work-tone')).map(node => node.key) },
    async settle() { for (let pass = 0; pass < 20; pass++) { await Promise.resolve(); render() } },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

test('only canonical lecture types are hidden; unscheduled works and nonteaching-type exams stay in both separate views without changing order', () => {
  const order = [...activities].reverse(), before = plain(order)
  const seminars = helpers.teachingJournalVisibleActivities(order, { layout: 'separate', show_lectures: true, section: 'seminars' })
  const lectures = helpers.teachingJournalVisibleActivities(order, { layout: 'separate', show_lectures: true, section: 'lectures' })
  assert.deepEqual(plain(seminars.map(row => row.id)), ['Scheduled exam', 'Unscheduled test', 'Unscheduled assignment', 'Lab', 'Practical', 'Seminar'])
  assert.deepEqual(plain(lectures.map(row => row.id)), ['Scheduled exam', 'Unscheduled test', 'Unscheduled assignment', 'Lecture'])
  assert.deepEqual(plain(helpers.teachingJournalVisibleActivities(order, { layout: 'combined', show_lectures: false, section: 'all' }).map(row => row.id)), plain(seminars.map(row => row.id)))
  assert.equal(helpers.teachingJournalActivitySection({ ...activities[4], work_type: 'Лекція' }), 'shared', 'Do not guess timetable types from a manually named work')
  assert.deepEqual(plain(order), before)
})

test('separate layout is saved only explicitly, reloads with same section, retains unscheduled work and never changes grades', async () => {
  const store = backend(), repository = store.repository('teacher'), original = base()
  const f = fixture({ repository, snapshot: original }); await f.settle()
  f.pickLayout('separate'); assert.equal(store.calls.length, 0); assert.equal(f.columns().length, activities.length)
  f.click('Зберегти вигляд журналу'); await f.settle()
  assert.deepEqual(store.calls[0], ['course', 'group', { layout: 'separate', show_lectures: true, section: 'seminars' }, 0, 'teacher'])
  assert.equal(f.columns().includes('Lecture'), false); assert.equal(f.columns().includes('Unscheduled test'), true)
  assert.match(text(f.tree), /Сума «Разом» враховує всі роботи семестру/); assert.match(text(f.tree), /залишаються доступними в обох розділах/)
  f.click('Лекції'); await f.settle(); assert.equal(f.columns().includes('Lecture'), true); assert.equal(f.columns().includes('Seminar'), false)
  f.unmount(); const reload = fixture({ repository, snapshot: original }); await reload.settle()
  assert.equal(reload.button('Лекції').props['aria-pressed'], true); assert.equal(reload.columns().includes('Seminar'), false)
  assert.deepEqual(original, base()); reload.unmount()
})

test('column movement preserves every hidden column and the selected view when legacy save returns only order/version', async () => {
  const store = backend({ 'teacher:course:group': { activity_ids: activities.map(row => row.id), version: 3, view_settings: { layout: 'separate', show_lectures: true, section: 'lectures' } } })
  const f = fixture({ repository: store.repository('teacher') }); await f.settle()
  const down = f.find(node => node.type === 'button' && node.props['aria-label'] === 'Колонку «Lecture» нижче')
  down.props.onClick(); f.render(); await f.settle()
  assert.equal(store.writes.length, 1); assert.equal(store.writes[0][2].length, activities.length)
  assert.deepEqual(new Set(store.writes[0][2]), new Set(activities.map(row => row.id)))
  assert.equal(f.button('Лекції').props['aria-pressed'], true); assert.equal(f.columns().includes('Seminar'), false)
  f.click('CSV'); assert.equal(f.csv[0][3].length, activities.length)
  f.click('Excel .xlsx'); await f.settle(); assert.equal(f.excel[0][3].activityIds.length, activities.length)
  f.click('Для відомості'); assert.equal(f.find(node => node.type === 'TeachingStatement').props.snapshot.activities.length, activities.length)
  f.unmount()
})

test('hiding lectures remains personal and a dated hidden class is explained instead of reported missing', async () => {
  const store = backend(), f = fixture({ repository: store.repository('teacher'), initialDate: '2026-11-06', snapshot: { ...base(), activities: activities.map(row => ({ ...row, activity_date: row.id === 'Lecture' ? '2026-11-06' : '2026-11-05' })) } }); await f.settle()
  f.find(node => node.type === 'input' && node.props.name === 'journal-show-lectures').props.onChange({ target: { checked: false } }); f.render()
  f.click('Зберегти вигляд журналу'); await f.settle()
  assert.equal(f.columns().includes('Lecture'), false); assert.match(text(f.tree), /Потрібне заняття приховане вашим налаштуванням/)
  assert.doesNotMatch(text(f.tree), /На 2026-11-06 робіт для оцінювання ще немає/)
  f.props.userId = 'another-teacher'; f.props.repository = store.repository('another-teacher'); f.render(); await f.settle()
  assert.equal(f.columns().includes('Lecture'), true); assert.equal(store.calls.length, 1); f.unmount()
})

test('double clicks and a late response after account switch cannot overwrite the current personal view', async () => {
  const store = backend(), pending = deferred(), repository = store.repository('teacher')
  repository.saveJournalView = (...args) => { store.calls.push(plain(args)); return pending.promise }
  const f = fixture({ repository }); await f.settle(); f.pickLayout('separate')
  const save = f.button('Зберегти вигляд журналу').props.onClick; save(); save(); f.render(); assert.equal(store.calls.length, 1)
  f.props.userId = 'another-teacher'; f.props.repository = store.repository('another-teacher'); f.render(); await f.settle()
  save(); assert.equal(store.calls.length, 1)
  pending.resolve({ activity_ids: [], version: 1, view_settings: { layout: 'separate', show_lectures: false, section: 'seminars' } }); await f.settle()
  assert.equal(f.columns().includes('Lecture'), true); assert.doesNotMatch(text(f.tree), /Особистий вигляд журналу збережено/); f.unmount()
})

test('captured personal-setting callbacks cannot write after unmount or repository replacement for the same actor', async () => {
  for (const change of ['unmount', 'repository']) {
    const store = backend(), f = fixture({ repository: store.repository('teacher') }); await f.settle(); f.pickLayout('separate')
    const save = f.button('Зберегти вигляд журналу').props.onClick
    if (change === 'unmount') f.unmount()
    else { f.props.repository = store.repository('teacher'); f.render(); await f.settle() }
    save(); await Promise.resolve(); assert.equal(store.calls.length, 0, change)
    if (change !== 'unmount') f.unmount()
  }
})
