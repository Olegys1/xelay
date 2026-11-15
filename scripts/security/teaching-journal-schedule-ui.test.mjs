// Current React handlers execute with synthetic repositories and identities.
// This test never imports a provider client, opens a browser or changes a DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

const read = name => readFileSync(new URL('../../' + name, import.meta.url), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const nodes = value => value == null || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(nodes) : [value, ...nodes(value.props?.children)]
const text = value => value == null || typeof value === 'boolean' ? '' : Array.isArray(value) ? value.map(text).join(' ') : typeof value === 'object' ? text(value.props?.children) : String(value)
function evaluate(source, imports = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  runInNewContext(code, { module, exports: module.exports, Date, Intl, Error,
    localStorage: { getItem: () => null, setItem() {} },
    require(name) { assert.ok(Object.hasOwn(imports, name), 'Explicit test import: ' + name); return imports[name] } })
  return module.exports
}
function hooks() {
  const cells = [], effects = []
  let index = 0, dirty = false, mounted = true, component, props, tree
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]))
  const api = {
    useState(initial) { const i = index++; if (!cells[i]) { const cell = { value: typeof initial === 'function' ? initial() : initial }; cell.set = next => { if (!mounted) return; const value = typeof next === 'function' ? next(cell.value) : next; if (!Object.is(value, cell.value)) { cell.value = value; dirty = true } }; cells[i] = cell } return [cells[i].value, cells[i].set] },
    useRef(initial) { const i = index++; return cells[i] ??= { current: initial } },
    useMemo(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: callback() }; return cells[i].value },
    useCallback(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: callback }; return cells[i].value },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const prior = cells[i]; cells[i] = { deps, cleanup: prior?.cleanup }; effects.push(() => { prior?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const render = () => { if (!mounted) return tree; for (let pass = 0; pass < 30; pass++) { dirty = false; index = 0; tree = component(props); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree } throw Error('Hooks did not settle') }
  return { api, start(fn, initial) { component = fn; props = initial; render(); return this }, render,
    update(patch) { props = { ...props, ...patch }; return render() }, get tree() { return tree },
    async flush() { for (let pass = 0; pass < 12; pass++) { await Promise.resolve(); render() } },
    unmount() { mounted = false; for (const cell of cells) cell?.cleanup?.() } }
}
const jsx = (type, props, key) => ({ type, props: props || {}, key })
const ui = { TeachingButton: 'TeachingButton', TeachingEmpty: 'TeachingEmpty', TeachingField: 'TeachingField', TeachingModal: 'TeachingModal', teachingInput: 'input' }
const teaching = { teachingDate: value => value || '—', teachingError: failure => failure.message, teachingTotal: () => 0, gradeHasDraft: () => false, exportTeachingJournal() {} }
const baseImports = run => ({ react: run.api, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
  'lucide-react': new Proxy({}, { get: (_, key) => String(key) }), '../../lib/teaching': teaching, './TeachingUI': ui })
const defaults = repository => ({ repository, userId: 'teacher', courseId: 'course', groupId: 'group', from: '2026-09-01', to: '2026-12-31', blocked: false, onRefresh: async () => {} })
function syncHarness(properties = {}) {
  const run = hooks(), module = evaluate(read('src/components/teaching/TeachingJournalScheduleSync.tsx'), baseImports(run))
  return run.start(module.TeachingJournalScheduleSync, { ...defaults({}), ...properties })
}
const result = changes => ({ created: 0, linked: 0, updated: 0, represented: 0, retained: 0, ...changes })
const deferred = () => { let resolve, reject; const promise = new Promise((accept, refuse) => { resolve = accept; reject = refuse }); return { promise, resolve, reject } }
function button(run) { const node = nodes(run.tree).find(node => node.type === 'TeachingButton' && /Оновити з розкладу/.test(text(node))); assert.ok(node); return node }

test('sync automatically runs once per mounted scope, never publishes grades, and unchanged results do not reload the journal', async () => {
  const calls = [], refreshes = []
  const repository = { syncJournalSchedule: async (...args) => { calls.push(args); return result({ represented: 2 }) } }
  const run = syncHarness({ repository, onRefresh: async () => refreshes.push('refresh') }); await run.flush()
  assert.deepEqual(plain(calls), [['course', 'group', '2026-09-01', '2026-12-31', 'teacher']])
  assert.equal(refreshes.length, 0)
  for (let index = 0; index < 10; index++) run.render()
  await run.flush()
  assert.equal(calls.length, 1)
  assert.match(text(run.tree), /враховані без зайвих колонок/)
  assert.match(text(run.tree), /початковий максимум — 5 балів/)
  assert.match(text(run.tree), /бали виставляєте й публікуєте ви/)
  run.unmount()
})

test('editor blocking postpones automatic sync and manual refresh remains disabled while busy', async () => {
  const pending = deferred(), calls = []
  const run = syncHarness({ blocked: true, repository: { syncJournalSchedule: (...args) => { calls.push(args); return pending.promise } } })
  await run.flush()
  assert.equal(calls.length, 0)
  assert.equal(button(run).props.disabled, true)
  run.update({ blocked: false }); await run.flush()
  assert.equal(calls.length, 1)
  assert.equal(button(run).props.disabled, true)
  assert.equal(button(run).props.busy, true)
  pending.resolve(result()); await run.flush()
  assert.equal(button(run).props.disabled, false)
  run.update({ blocked: true }); run.update({ blocked: false }); await run.flush()
  assert.equal(calls.length, 1, 'closing another editor does not trigger a sync loop')
  run.unmount()
})

test('created, linked, updated or retained-only lessons reload once and retain a clear note about existing grades and removed lessons', async () => {
  for (const field of ['created', 'linked', 'updated', 'retained']) {
    const refreshes = []
    const run = syncHarness({ repository: { syncJournalSchedule: async () => result({ [field]: 2, retained: 1 }) }, onRefresh: async () => refreshes.push('refresh') })
    await run.flush()
    assert.equal(refreshes.length, 1, field)
    assert.match(text(run.tree), /Збережено колонок для змінених або прибраних пар: 1/)
    assert.match(text(run.tree), /Особистий порядок колонок і попередні оцінки збережено/)
    run.unmount()
  }
})

test('failure does not automatically retry; an explicit retry can recover without hiding the journal', async () => {
  const calls = [], refreshes = []
  const run = syncHarness({ repository: { syncJournalSchedule: async () => { calls.push('sync'); if (calls.length === 1) throw Error('Synthetic timeout'); return result({ created: 1 }) } },
    onRefresh: async () => refreshes.push('refresh') })
  await run.flush()
  assert.equal(calls.length, 1)
  assert.match(text(run.tree), /Synthetic timeout/)
  assert.match(text(run.tree), /Збережені роботи й бали залишаються доступними/)
  for (let index = 0; index < 8; index++) run.render()
  await run.flush()
  assert.equal(calls.length, 1)
  assert.equal(button(run).props.disabled, false)
  button(run).props.onClick(); await run.flush()
  assert.equal(calls.length, 2)
  assert.equal(refreshes.length, 1)
  assert.doesNotMatch(text(run.tree), /Synthetic timeout/)
  run.unmount()
})

test('late results and failures from another account, group or repository cannot reload the current journal', async () => {
  for (const change of ['userId', 'courseId', 'groupId', 'repository']) for (const outcome of ['resolve', 'reject']) {
    const previous = deferred(), current = deferred(), calls = [], refreshed = []
    const originalRepository = { syncJournalSchedule: (...args) => { calls.push(args); return calls.length === 1 ? previous.promise : current.promise } }
    const replacementRepository = { syncJournalSchedule: (...args) => { calls.push(args); return current.promise } }
    const run = syncHarness({ repository: originalRepository, onRefresh: async () => refreshed.push('previous') }); await run.flush()
    const patch = change === 'repository' ? { repository: replacementRepository } : { [change]: 'second-' + change }
    run.update({ ...patch, onRefresh: async () => refreshed.push('current') }); await run.flush()
    assert.equal(calls.length, 2, change)
    if (outcome === 'resolve') previous.resolve(result({ created: 50 }))
    else previous.reject(Error('Stale previous account failure'))
    await run.flush()
    assert.deepEqual(refreshed, [], change)
    assert.doesNotMatch(text(run.tree), /Додано занять: 50/)
    assert.doesNotMatch(text(run.tree), /Stale previous account failure/)
    current.resolve(result({ created: 1 })); await run.flush()
    assert.deepEqual(refreshed, ['current'], change)
    assert.match(text(run.tree), /Додано занять: 1/)
    run.unmount()
  }
  const pending = deferred(), refreshed = []
  const run = syncHarness({ repository: { syncJournalSchedule: () => pending.promise }, onRefresh: async () => refreshed.push('refresh') })
  await run.flush(); run.unmount(); pending.reject(Error('Late removed scope'))
  await run.flush(); assert.equal(refreshed.length, 0)
})

test('repositories without schedule capability render no sync control and perform no work', async () => {
  const run = syncHarness(); await run.flush()
  assert.equal(run.tree, null)
  run.unmount()
})

const grading = evaluate(read('src/lib/teachingGrading.ts'))
const preferences = evaluate(read('src/lib/teachingJournalPreferences.ts'))
const labels = evaluate(read('src/lib/teachingJournalSchedule.ts'))
const followup = evaluate(read('src/lib/teachingGradeFollowup.ts'))
const semester = evaluate(read('src/lib/teachingSemesterJournal.ts'), { './teachingGrading': grading })
const visibility = evaluate(read('src/lib/studyGroupVisibility.ts'))
const lesson = { id: 'activity', course_id: 'course', group_id: 'group', title: 'Семінар', work_type: 'Семінар', category: '', activity_date: '2026-11-04', max_points: 5,
  schedule_item_id: 'schedule', schedule_lesson_type: 'seminar', schedule_starts_at: '09:40:00', schedule_ends_at: '11:00:00' }
function snapshot(changes = {}) {
  return { course: { id: 'course', title: 'Економіка', semester: 'Осінь', starts_on: '2026-09-01', ends_on: '2026-12-31', permissions: ['grades'], grading_rules: { categories: [] }, archived_at: null },
    groups: ['group', 'group-two'].map(id => ({ id: 'link-' + id, course_id: 'course', group_id: id, group_name: id, status: 'accepted' })),
    entries: [{ id: 'entry', course_id: 'course', group_id: 'group', user_id: 'student', full_name: 'Вигадана студентка', active: true }], activities: [lesson], grades: [], audit: [], roster_claims: [], members: [], teachers: [], assignments: [], materials: [], ...changes }
}
function gradebookHarness(properties = {}) {
  const run = hooks()
  const imports = { ...baseImports(run), '../../lib/seminars': { kyivToday: () => '2026-11-04' },
    './TeachingLaunchNotice': { TeachingLaunchNotice: 'TeachingLaunchNotice' },
    '../../lib/teachingJournalWorkbook': { exportTeachingJournalWorkbook() {} },
    '../../lib/teachingGrading': grading,
    './TeachingGradingRulesEditor': { TeachingGradingRulesSummary: 'TeachingGradingRulesSummary', TeachingWorkTypeField: 'TeachingWorkTypeField' },
    './TeachingGroupGradingSettings': { TeachingGroupGradingSettings: 'TeachingGroupGradingSettings' },
    '../../lib/teachingGradeFollowup': followup, '../../lib/teachingSemesterJournal': semester,
    './TeachingStatement': { TeachingStatement: 'TeachingStatement' }, '../../lib/studyGroupVisibility': visibility,
    '../../lib/teachingJournalPreferences': preferences, './teaching-journal-order.css': {},
    './TeachingJournalScheduleSync': { TeachingJournalScheduleSync: 'ScheduleSyncLeaf' }, '../../lib/teachingJournalSchedule': labels,
    '../../lib/assistant-v2/pageContext': { publishAssistantPageContext() {}, releaseAssistantPageContext() {} } }
  const module = evaluate(read('src/components/teaching/TeachingGradebook.tsx'), imports)
  return run.start(module.TeachingGradebook, { snapshot: snapshot(), repository: { syncJournalSchedule: async () => result() }, userId: 'teacher', onRefresh: async () => {}, ...properties })
}
const syncLeaf = run => nodes(run.tree).find(node => node.type === 'ScheduleSyncLeaf')

test('an exact calendar focus waits for its new schedule column and selects it after synchronization', async () => {
  const ordinary = snapshot()
  const other = { ...lesson, id: 'same-date-other-lesson', schedule_item_id: 'different-schedule' }
  const initialFocus = { courseId: 'course', groupId: 'group', date: lesson.activity_date, scheduleItemId: 'schedule', key: 'calendar-occurrence' }
  const run = gradebookHarness({ snapshot: { ...ordinary, activities: [other] }, initialFocus, initialDate: lesson.activity_date })
  await run.flush()
  const choice = () => nodes(run.tree).find(node => node.type === 'select' && node.props.name === 'journal-activity')
  assert.equal(choice().props.value, '')
  assert.equal(nodes(run.tree).some(node => node.type === 'TeachingButton' && /Ввести бали списком/.test(text(node))), false)
  assert.match(text(run.tree), /Колонку саме цього заняття ще не знайдено/)
  run.update({ snapshot: { ...ordinary, activities: [other, lesson] } }); await run.flush()
  assert.equal(choice().props.value, lesson.id)
  assert.doesNotMatch(text(run.tree), /Колонку саме цього заняття ще не знайдено/)
  run.unmount()
})

test('only active grading staff get automatic schedule columns; student, readonly, archive and inactive links never mount sync', async () => {
  const run = gradebookHarness(); await run.flush()
  const leaf = syncLeaf(run)
  assert.ok(leaf)
  assert.equal(leaf.props.courseId, 'course')
  assert.equal(leaf.props.groupId, 'group')
  assert.equal(leaf.props.userId, 'teacher')
  assert.equal(leaf.props.from, '2026-09-01')
  assert.equal(leaf.props.to, '2026-12-31')
  assert.match(text(run.tree), /Семінар · 09:40 до 11:00/)
  run.unmount()
  const ordinary = snapshot()
  for (const properties of [
    { readonly: true }, { snapshot: snapshot({ course: { ...ordinary.course, permissions: [] } }), userId: 'student' },
    { snapshot: snapshot({ course: { ...ordinary.course, archived_at: '2026-11-01T12:00:00Z' } }) },
    { snapshot: snapshot({ groups: [{ ...ordinary.groups[0], status: 'removed' }] }) }, { repository: {} },
  ]) {
    const excluded = gradebookHarness(properties); await excluded.flush(); assert.equal(syncLeaf(excluded), undefined); excluded.unmount()
  }
})

test('journal scopes key synchronization by teacher, course, group and semester; an open grade editor blocks refresh', async () => {
  const run = gradebookHarness(); await run.flush()
  const first = syncLeaf(run)
  const select = nodes(run.tree).find(node => node.type === 'select' && node.props.name === 'journal-group')
  select.props.onChange({ target: { value: 'group-two' } }); await run.flush()
  assert.notEqual(syncLeaf(run).key, first.key)
  assert.equal(syncLeaf(run).props.groupId, 'group-two')
  const second = syncLeaf(run)
  run.update({ userId: 'second-teacher' }); await run.flush()
  assert.notEqual(syncLeaf(run).key, second.key)
  const third = syncLeaf(run), changed = snapshot()
  const changedCourse = { ...changed, course: { ...changed.course, id: 'second-course' }, groups: changed.groups.map(group => ({ ...group, course_id: 'second-course' })), entries: [], activities: [] }
  run.update({ snapshot: changedCourse }); await run.flush()
  assert.notEqual(syncLeaf(run).key, third.key)
  assert.equal(syncLeaf(run).props.courseId, 'second-course')
  const fourth = syncLeaf(run)
  run.update({ snapshot: { ...changedCourse, course: { ...changedCourse.course, ends_on: '2026-12-30' } } }); await run.flush()
  assert.notEqual(syncLeaf(run).key, fourth.key)
  run.unmount()
  const editing = gradebookHarness(); await editing.flush()
  const add = nodes(editing.tree).find(node => node.type === 'TeachingButton' && /Додати роботу/.test(text(node)))
  add.props.onClick(); await editing.flush()
  assert.equal(syncLeaf(editing).props.blocked, true)
  editing.unmount()
})

test('lesson labels distinguish seminar, lecture, laboratory, unknown and changed schedule without labeling manual columns', () => {
  assert.equal(labels.teachingJournalLessonLabel(lesson), 'Семінар · 09:40 до 11:00')
  assert.equal(labels.teachingJournalLessonLabel({ ...lesson, schedule_lesson_type: 'lecture' }), 'Лекція · 09:40 до 11:00')
  assert.equal(labels.teachingJournalLessonLabel({ ...lesson, schedule_lesson_type: 'lab', schedule_missing: true }), 'Лабораторна · 09:40 до 11:00 · пару змінено або прибрано з розкладу')
  assert.equal(labels.teachingJournalLessonLabel({ ...lesson, schedule_lesson_type: 'future-type', schedule_starts_at: null }), 'Заняття')
  assert.equal(labels.teachingJournalLessonLabel({ ...lesson, schedule_item_id: null }), '')
})
