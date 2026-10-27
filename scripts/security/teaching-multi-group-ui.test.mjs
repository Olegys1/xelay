// Execute the real editor handlers and pure draft/target helpers. Synthetic
// repositories and session storage only; no browser account or network calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'

const read = name => readFile(new URL('../../' + name, import.meta.url), 'utf8')
const source = await read('src/components/teaching/TeachingPublications.tsx')
const targetSource = await read('src/components/teaching/TeachingMultiAssignmentTargets.tsx')
function load(source, imports = {}, globals = {}) {
  const module = { exports: {} }
  const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(output, { module, exports: module.exports, Intl, Date, URL, Error, DOMException, AbortController, TextEncoder,
    crypto: { randomUUID }, ...globals, require(name) { assert.ok(name in imports, 'Known dependency ' + name); return imports[name] } })
  return module.exports
}
const labels = load(await read('src/lib/resourceLinkLabels.ts'))
const grading = load(await read('src/lib/teachingGrading.ts'))
const legal = load(await read('src/lib/legal.ts'))
const directory = load(await read('src/lib/teachingGroupDirectory.ts'))
const multi = load(await read('src/lib/teachingMultiAssignments.ts'))
const colleagues = load(await read('src/lib/teachingColleagues.ts'), { './supabase': { supabase: {} } })
const times = load(await read('src/lib/scheduleCopyTimes.ts'))
const timetable = load(await read('src/lib/studyGroupTimetable.ts'), { './supabase': { supabase: {} }, './scheduleCopyTimes': times })
const seminars = load(await read('src/lib/seminars.ts'), { './supabase': { supabase: {} }, './profiles': {}, './seminarResources': {}, './studyGroupTimetable': timetable, './scheduleSubjects': {} })
const teaching = load(await read('src/lib/teaching.ts'), {
  './supabase': { supabase: {} }, './resourceLinkLabels': labels, './teachingGrading': grading,
  './teachingFileUpload': { uploadTeachingStorageFile() {} }, './teachingMaterialPreview': {},
  './teachingColleagues': colleagues,
  './seminars': seminars,
})
const timingSource = await read('src/components/teaching/TeachingPublicationTimingFields.tsx')
const draftSource = await read('src/lib/teachingPublicationDraft.ts')
const plain = value => JSON.parse(JSON.stringify(value))
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const text = tree => tree == null || typeof tree === 'boolean' ? '' : Array.isArray(tree) ? tree.map(text).join('') : typeof tree === 'object' ? text(tree.props?.children) : String(tree)
const snapshot = () => ({ course: { id: 'course-a', owner_id: 'teacher-a', title: 'Synthetic subject', version: 1,
  starts_on: '2026-09-01', ends_on: '2026-12-31', archived_at: null, permissions: ['assignments', 'grades', 'materials'], grading_rules: { categories: [] } },
  groups: ['group-a', 'group-b', 'group-c'].map((id, index) => ({ group_id: id, status: 'accepted', group_name: 'Synthetic ' + index, permissions: ['assignments', 'grades', 'materials'] })), assignments: [], materials: [] })
const target = (groupId = 'group-b', patch = {}) => ({ ...multi.emptyMultiAssignmentTarget(groupId), placementMode: 'unplaced', lessonDate: '2026-11-03', deadline: '2026-11-03T18:00', closesAt: '2026-11-04T18:00', ...patch })

function fixture(overrides = {}, component = 'PublicationEditor') {
  const cells = [], effects = [], calls = [], listeners = new Map(), storage = overrides.storage || new Map()
  let index = 0, tree, closes = 0
  const window = { sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name) }
  const depsEqual = (a, b) => a?.length === b?.length && a?.every((value, i) => Object.is(value, b[i]))
  const react = {
    lazy: () => 'LazyMaterial', Suspense: 'Suspense',
    useState(initial) { const i = index++; if (!cells[i]) cells[i] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { cells[i].value = typeof next === 'function' ? next(cells[i].value) : next }] },
    useRef(initial) { const i = index++; if (!cells[i]) cells[i] = { current: initial }; return cells[i] },
    useCallback(fn, deps) { const i = index++; if (!cells[i] || !depsEqual(cells[i].deps, deps)) cells[i] = { value: fn, deps }; return cells[i].value },
    useEffect(fn, deps) { const i = index++; if (!cells[i] || !depsEqual(cells[i].deps, deps)) { const previous = cells[i]; cells[i] = { deps }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = fn() }) } },
  }
  const jsx = { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
  const ui = Object.fromEntries(['TeachingButton', 'TeachingEmpty', 'TeachingField', 'TeachingModal'].map(name => [name, name])); ui.teachingInput = 'input'
  const icons = new Proxy({}, { get: (_, name) => name })
  const drafts = load(draftSource, { './teaching': teaching }, { window })
  const multiDrafts = load(awaitedMultiSource, {}, { window })
  const timing = load(timingSource, { react, 'react/jsx-runtime': jsx, 'lucide-react': icons, '../../lib/teaching': teaching, './TeachingUI': ui })
  const imports = { react, 'react/jsx-runtime': jsx, 'lucide-react': icons, '../../lib/teaching': teaching, '../../lib/resourceLinkLabels': labels,
    '../../lib/legal': legal, '../../lib/teachingPublicationDraft': drafts, '../../lib/teachingGroupDirectory': directory,
    '../../lib/teachingMultiAssignments': multiDrafts, '../../lib/teachingMaterialPreview': { canPreviewTeachingMaterial: () => true },
    '../../lib/teachingGrading': grading, '../../lib/studyGroupTimetable': timetable, './TeachingUI': ui,
    './TeachingSubmissionReview': { TeachingSubmissionReview: 'TeachingSubmissionReview' }, './TeachingMaterialWithdrawal': { TeachingMaterialWithdrawal: 'TeachingMaterialWithdrawal' },
    './TeacherSourceBadge': { TeacherSourceBadge: 'TeacherSourceBadge' }, './TeachingAssignmentLessonFields': { TeachingAssignmentLessonFields: 'TeachingAssignmentLessonFields' },
    './TeachingGradingRulesEditor': { TeachingWorkTypeField: 'TeachingWorkTypeField' }, './TeachingPublicationTimingFields': timing,
    './TeachingMultiAssignmentTargets': { TeachingMultiAssignmentTargets: 'TeachingMultiAssignmentTargets', TeachingMultiAssignmentPreview: 'TeachingMultiAssignmentPreview' },
  }
  const api = load(component === 'MultiAssignmentTargetFields' ? targetSource + '\nexport { MultiAssignmentTargetFields };' : source, imports, { window })
  const repository = { assignmentLessons: async () => ({ lessons: [] }), classroomMutate: async (action, payload) => { calls.push({ action, payload }); return { id: payload.id, version: 1 } }, mutate: async (action, payload) => { calls.push({ action, payload }); return {} }, upload: async () => { calls.push({ action: 'upload' }); throw Error('Unexpected upload') }, ...overrides.repository }
  const props = { kind: 'assignment', initial: null, groupId: 'group-a', snapshot: snapshot(), repository, userId: 'teacher-a', onClose: () => closes++, onRefresh: async () => {}, ...overrides, repository }
  function render() { index = 0; tree = api[component](props); effects.splice(0).forEach(effect => effect()); return tree }
  render()
  return { props, cells, calls, storage, render, get tree() { return tree }, get closes() { return closes },
    find(predicate) { const node = nodes(tree).find(predicate); assert.ok(node, 'Expected rendered node'); return node },
    input(name, value) { this.find(node => node.props?.name === name).props.onChange({ target: { value } }); render() },
    additional(value) { this.find(node => node.type === 'TeachingMultiAssignmentTargets').props.onChange(value); render() },
    valid(group, valid) { this.find(node => node.type === 'TeachingMultiAssignmentTargets').props.onValidityChange(group, valid); render() },
    async submit(intent = 'draft') { this.find(node => node.type === 'form').props.onSubmit({ preventDefault() {}, nativeEvent: { submitter: { getAttribute: () => intent } } }); for (let i = 0; i < 20; i++) await Promise.resolve(); render() },
    button(label) { return this.find(node => ['TeachingButton', 'button'].includes(node.type) && text(node) === label) },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}
const awaitedMultiSource = await read('src/lib/teachingMultiAssignments.ts')

test('target payload keeps each group placement and timestamps independent; duplicate and oversized target sets fail closed', () => {
  const first = target('group-a'), other = target('group-b', { lessonDate: '2026-11-05', deadline: '', closesAt: '' })
  const result = multi.multiAssignmentTargets(first, [other], teaching.kyivDeadline)
  assert.deepEqual(plain(result).map(row => row.group_id), ['group-a', 'group-b'])
  assert.equal(result[0].due_at, teaching.kyivDeadline(first.deadline)); assert.equal(result[1].due_at, null)
  assert.equal(result[1].lesson_date, '2026-11-05'); assert.equal(result[1].schedule_item_id, null)
  assert.throws(() => multi.multiAssignmentTargets(first, [first], teaching.kyivDeadline), /INVALID_INPUT/)
  assert.throws(() => multi.multiAssignmentTargets(first, Array.from({ length: 30 }, (_, i) => target('g' + i)), teaching.kyivDeadline), /INVALID_INPUT/)
})
test('first submit previews every target and exact condition; only explicit confirmation creates one shared assignment', async () => {
  const fx = fixture()
  fx.input('publication-title', 'Synthetic reviewed homework'); fx.additional([target()])
  await fx.submit('draft')
  assert.equal(fx.calls.length, 0)
  const preview = fx.find(node => node.type === 'TeachingMultiAssignmentPreview')
  assert.deepEqual(plain(preview.props.targets).map(row => row.groupId), ['group-a', 'group-b'])
  assert.ok(text(fx.tree).includes('Synthetic reviewed homework'))
  assert.ok(text(fx.tree).includes('Підтвердити чернетку для 2 груп'))
  await fx.submit('draft')
  assert.equal(fx.calls.length, 1); assert.equal(fx.calls[0].action, 'save_multi_group_assignment')
  assert.equal(fx.calls[0].payload.expected_user_id, 'teacher-a'); assert.equal(fx.calls[0].payload.version, 0)
  assert.equal(fx.calls[0].payload.targets.length, 2)
  assert.equal(fx.calls[0].payload.targets[1].due_at, teaching.kyivDeadline(target().deadline))
  assert.equal(fx.storage.size, 0); assert.equal(fx.closes, 1)
})
test('editing after preview invalidates the approval and needs another preview before a write', async () => {
  const fx = fixture()
  fx.input('publication-title', 'First condition'); fx.additional([target()]); await fx.submit()
  fx.button('Редагувати параметри').props.onClick(); fx.render()
  fx.input('publication-title', 'Changed condition'); await fx.submit()
  assert.equal(fx.calls.length, 0)
  assert.ok(text(fx.tree).includes('Changed condition'))
  await fx.submit()
  assert.equal(fx.calls[0].payload.title, 'Changed condition')
})
test('publication requires valid placement and timing for every group before preview or write', async () => {
  const fx = fixture()
  fx.input('publication-title', 'Synthetic publish'); fx.additional([target()])
  fx.find(node => node.type === 'TeachingAssignmentLessonFields').props.onValidityChange(true); fx.render()
  await fx.submit('published')
  assert.equal(fx.calls.length, 0); assert.ok(!nodes(fx.tree).some(node => node.type === 'TeachingMultiAssignmentPreview'))
  fx.valid('group-b', true); fx.additional([target('group-b', { closesAt: '2026-11-02T18:00' })]); await fx.submit('published')
  assert.equal(fx.calls.length, 0); assert.ok(text(fx.tree).includes('Остаточне закриття не може бути раніше'))
  fx.additional([target()]); await fx.submit('published')
  assert.ok(nodes(fx.tree).some(node => node.type === 'TeachingMultiAssignmentPreview'))
  assert.equal(fx.calls.length, 0)
  await fx.submit('published'); assert.equal(fx.calls[0].payload.status, 'published')
})
test('multi-target drafts restore only the same account/course/group/editor and discard unauthorized target snapshots', async () => {
  const storage = new Map(), first = fixture({ storage })
  first.input('publication-title', 'Synthetic recovered condition'); first.additional([target()]); first.unmount()
  const restored = fixture({ storage })
  assert.equal(restored.find(node => node.props?.name === 'publication-title').props.value, 'Synthetic recovered condition')
  assert.equal(restored.find(node => node.type === 'TeachingMultiAssignmentTargets').props.targets[0].groupId, 'group-b')
  const otherAccount = fixture({ storage, userId: 'teacher-other' })
  assert.equal(otherAccount.find(node => node.type === 'TeachingMultiAssignmentTargets').props.targets.length, 0)
  const otherGroup = fixture({ storage, groupId: 'group-c' })
  assert.equal(otherGroup.find(node => node.type === 'TeachingMultiAssignmentTargets').props.targets.length, 0)
  const differentCourse = snapshot(); differentCourse.course.id = 'course-other'
  const otherCourse = fixture({ storage, snapshot: differentCourse })
  assert.equal(otherCourse.find(node => node.type === 'TeachingMultiAssignmentTargets').props.targets.length, 0)
  const key = [...storage.keys()].find(key => key.endsWith(':multi-targets:v1'))
  assert.equal(multi.readMultiAssignmentDraft(key, 'wrong-editor', 0, ['group-b'], windowlessStorage(storage)), null)
  const record = JSON.parse(storage.get(key))
  assert.equal(multi.readMultiAssignmentDraft(key, record.editor_id, 1, ['group-b'], windowlessStorage(storage)), null)
  assert.equal(multi.readMultiAssignmentDraft(key, record.editor_id, 0, ['group-c'], windowlessStorage(storage)), null)
})
function windowlessStorage(storage) { return { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } }
test('stale account, removed target permission and material editor cannot reuse batch flow', async () => {
  const fx = fixture()
  fx.input('publication-title', 'Synthetic homework'); fx.additional([target()]); await fx.submit()
  fx.props.userId = 'another-account'; fx.render(); await fx.submit()
  assert.equal(fx.calls.length, 0); assert.ok(text(fx.tree).includes('Акаунт змінився'))
  const scoped = fixture(); scoped.input('publication-title', 'Scoped'); scoped.additional([target()])
  scoped.props.snapshot.groups[1].permissions = []; scoped.render(); await scoped.submit()
  assert.equal(scoped.calls.length, 0)
  const material = fixture({ kind: 'material' })
  assert.ok(!nodes(material.tree).some(node => node.type === 'TeachingMultiAssignmentTargets'))
})
test('ordinary single-group save retains its existing action and target contract without requiring batch confirmation', async () => {
  const fx = fixture(); fx.input('publication-title', 'Single synthetic homework'); await fx.submit()
  assert.equal(fx.calls.length, 1); assert.equal(fx.calls[0].action, 'save_group_assignment')
  assert.deepEqual(plain(fx.calls[0].payload.targets).map(row => row.group_id), ['group-a'])
})
test('account switch during a pending preview cannot install the old account’s approval', async () => {
  let release
  const fx = fixture({ repository: { assignmentLessons: async () => new Promise(resolve => { release = resolve }) } })
  fx.input('publication-title', 'Synthetic pending preview'); fx.additional([target()])
  const lessonFields = fx.find(node => node.type === 'TeachingAssignmentLessonFields')
  lessonFields.props.onDateChange('2026-11-03'); lessonFields.props.onLessonChange('slot-a'); lessonFields.props.onValidityChange(true); fx.render()
  await fx.submit()
  fx.props.userId = 'another-account'; fx.render()
  release({ lessons: [{ id: 'slot-a', group_id: 'group-a', subject: 'Synthetic subject', starts_at: '08:00', ends_at: '09:20' }] })
  for (let i = 0; i < 20; i++) await Promise.resolve()
  fx.render()
  assert.equal(fx.calls.length, 0)
  assert.ok(!nodes(fx.tree).some(node => node.type === 'TeachingMultiAssignmentPreview'))
  assert.ok(text(fx.tree).includes('Акаунт змінився'))
})
test('confirmed pending write is locked against a double click', async () => {
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  const fx = fixture({ repository: { classroomMutate: async () => { fx.calls.push({ action: 'pending' }); await gate; return {} } } })
  fx.input('publication-title', 'Synthetic once'); fx.additional([target()]); await fx.submit()
  const form = fx.find(node => node.type === 'form')
  const event = { preventDefault() {}, nativeEvent: { submitter: { getAttribute: () => 'draft' } } }
  const first = form.props.onSubmit(event), second = form.props.onSubmit(event)
  assert.equal(fx.calls.length, 1); finish(); await Promise.all([first, second]); fx.render()
  assert.equal(fx.calls.length, 1)
})
test('per-group lesson picker ignores an obsolete group response and uses independent field names', async () => {
  let oldResolve
  const course = snapshot().course, group = snapshot().groups[1], chosen = target('group-b', { placementMode: 'lesson', scheduleItemId: '', lessonDate: '2026-11-03' })
  const lesson = (id, groupId) => ({ id, group_id: groupId, weekday: 2, starts_at: '10:00', ends_at: '11:20', subject: 'Synthetic subject', lesson_type: 'practice', valid_from: '2026-09-01', valid_until: '2026-12-31', week_pattern: 'every', excluded_dates: [] })
  const fx = fixture({ course, group, target: chosen, disabled: false, onChange() {}, onValidityChange() {}, repository: { assignmentLessons: async (_, groupId) => groupId === 'group-b' ? new Promise(resolve => { oldResolve = resolve }) : { lessons: [lesson('new-slot', 'group-c')] } } }, 'MultiAssignmentTargetFields')
  fx.props.target = { ...chosen, groupId: 'group-c' }; fx.props.group = snapshot().groups[2]; fx.render()
  await Promise.resolve(); await Promise.resolve(); fx.render()
  oldResolve({ lessons: [lesson('old-slot', 'group-b')] }); await Promise.resolve(); await Promise.resolve(); fx.render()
  assert.ok(nodes(fx.tree).some(node => node.type === 'option' && node.props.value === 'new-slot'))
  assert.ok(!nodes(fx.tree).some(node => node.type === 'option' && node.props.value === 'old-slot'))
  assert.ok(nodes(fx.tree).filter(node => node.type === 'select' || node.type === 'input').every(node => node.props.name.startsWith('multi-assignment-group-c-')))
})
