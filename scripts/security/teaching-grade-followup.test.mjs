// Real client handlers and data-selection helpers; synthetic data only.
// No browser session, production API, email or student record is used here.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
function load(source, imports = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, Date, Intl, Error, window: { setInterval: () => 1, clearInterval() {} }, crypto: { randomUUID }, require(name) { assert.ok(name in imports, 'Known import: ' + name); return imports[name] } })
  return module.exports
}
const helpers = load(await read('src/lib/teachingGradeFollowup.ts'))
const groupVisibility = load(await read('src/lib/studyGroupVisibility.ts'))
const gradebookSource = await read('src/components/teaching/TeachingGradebook.tsx')
const reviewSource = await read('src/components/teaching/TeachingSubmissionReview.tsx')
const calendarSource = await read('src/components/teaching/TeachingCalendar.tsx')
const plain = value => JSON.parse(JSON.stringify(value))
const entry = { id: 'entry', course_id: 'course', group_id: 'group', user_id: 'student', full_name: 'Тестова студентка', active: true, version: 1 }
const activity = { id: 'activity', course_id: 'course', group_id: 'group', title: 'Захист роботи', category: 'seminars', max_points: 10, activity_date: '2026-10-27', item_id: 'assignment', version: 2 }
const grade = { id: 'grade', activity_id: activity.id, entry_id: entry.id, draft_score: 4, draft_comment: 'Коментар', published_score: 4, published_comment: 'Коментар', published_at: '2026-10-26', version: 5 }
const assignment = { id: 'assignment', course_id: 'course', title: activity.title, submission_format: 'defense', status: 'published', targets: [{ group_id: 'group', lesson_date: '2026-10-27' }] }
const submission = { id: 'submission', item_id: 'assignment', course_id: 'course', group_id: 'group', user_id: 'student', status: 'submitted', student_name: entry.full_name, body: 'Тестова відповідь', attempt: 1, version: 3, published_score: null, published_comment: '', grade_version: 0, submitted_at: '2026-10-27T08:00:00Z' }
const rules = { categories: [{ id: 'seminars', name: 'Семінари', max_points: 40, coefficient: 0.5 }] }
function snapshot(overrides = {}) {
  return { course: { id: 'course', title: 'Математика', permissions: ['grades', 'assignments'], grading_rules: rules, starts_on: '2026-09-01', ends_on: '2026-12-31', archived_at: null },
    groups: [{ id: 'link', group_id: 'group', course_id: 'course', group_name: 'ТЕСТ-1', status: 'accepted' }],
    entries: [entry], activities: [activity], assignments: [assignment], grades: [grade], audit: [], roster_claims: [], members: [{ ...entry, group_id: 'group' }],
    seminars: { questions: [{ title: 'PRIVATE_QUESTION' }], reservations: [{ answer: 'PRIVATE_RESERVATION' }], teams: [{ name: 'PRIVATE_TEAM' }] }, ...overrides }
}
const classroom = { item: assignment, group: { id: 'group', group_name: 'ТЕСТ-1' }, permissions: ['grades', 'assignments'], students: [{ user_id: 'student', full_name: entry.full_name }], submissions: [], history: [], is_assessed: true, activity_id: 'activity', max_points: 10, can_review: true }
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
function content(tree) {
  if (tree == null || typeof tree === 'boolean') return ''
  if (Array.isArray(tree)) return tree.map(content).join('')
  return typeof tree === 'object' ? content(tree.props?.children) : String(tree)
}
function fixture(component, overrides = {}) {
  const cells = [], effects = [], calls = [], completions = [], focuses = []
  let index = 0, tree, dirty = false, closes = 0, refreshes = 0
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const hooks = {
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, next => { const value = typeof next === 'function' ? next(cells[i].value) : next; if (!Object.is(value, cells[i].value)) { cells[i].value = value; dirty = true } }] },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const prior = cells[i]; cells[i] = { deps }; effects.push(() => { prior?.cleanup?.(); cells[i].cleanup = callback() }) } },
    useCallback(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, callback }; return cells[i].callback },
    useMemo(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { deps, value: callback() }; return cells[i].value },
  }
  const ui = Object.fromEntries(['TeachingButton', 'TeachingEmpty', 'TeachingField', 'TeachingModal'].map(name => [name, name])); ui.teachingInput = 'input'
  const teaching = { teachingDate: value => value || '—', teachingError: error => error.message, teachingTotal: () => 4, gradeHasDraft: item => item.draft_score !== item.published_score || item.draft_comment !== item.published_comment, exportTeachingJournal() {} }
  const imports = { react: hooks, 'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    'lucide-react': new Proxy({}, { get: (_, name) => String(name) }), '../../lib/teaching': teaching, './TeachingUI': ui,
    '../../lib/studyGroupVisibility': groupVisibility,
    '../../lib/teachingGradeFollowup': helpers, '../../lib/seminars': { kyivToday: () => '2026-10-27', seminarStartMilliseconds: ({ lesson_date, starts_at }) => Date.parse(lesson_date + 'T' + starts_at + 'Z') },
    '../../lib/studyGroupTimetable': { addTimetableDays: (date, days) => { const value = new Date(date + 'T12:00:00Z'); value.setUTCDate(value.getUTCDate() + days); return value.toISOString().slice(0, 10) }, LESSON_TYPES: { seminar: 'Семінар' } }, './teaching-workflow.css': {},
    './TeachingLaunchNotice': { TeachingLaunchNotice: 'TeachingLaunchNotice' }, '../../lib/teachingJournalWorkbook': { exportTeachingJournalWorkbook() {} },
    '../../lib/teachingGrading': { teachingRulesForGroup: () => rules }, './TeachingGradingRulesEditor': { TeachingGradingRulesSummary: 'TeachingGradingRulesSummary', TeachingWorkTypeField: 'TeachingWorkTypeField' },
    './TeachingGroupGradingSettings': { TeachingGroupGradingSettings: 'TeachingGroupGradingSettings' },
    './TeachingSubmissionPanel': { TeachingSubmissionHistoryList: 'TeachingSubmissionHistoryList', TeachingSubmissionResources: 'TeachingSubmissionResources', TeachingSubmissionStatusBadge: 'TeachingSubmissionStatusBadge', teachingSubmissionError: error => error.message },
    './teaching-submissions.css': {}, './TeachingSubmissionExtension': { TeachingSubmissionExtension: 'TeachingSubmissionExtension' },
    './TeachingPublicationTimingFields': { SUBMISSION_FORMATS: [{ id: 'defense', label: 'Захист' }], submissionFormat: item => item.submission_format || 'written' },
  }
  const api = load(component === 'TeachingCalendar' ? calendarSource : component.includes('Submission') ? reviewSource + '\nexport { SubmissionReviewDialog };' : gradebookSource + '\nexport { GradeEditor };', imports)
  const repository = { mode: 'local', mutate: async (action, payload) => { calls.push({ action, payload }); if (overrides.failWrite) throw Error('Timeout after write'); return {} }, classroom: async () => ({ ...classroom, ...overrides.classroom }), classroomMutate: async (action, payload) => { calls.push({ action, payload }); if (overrides.failWrite) throw Error('Timeout after write'); return {} } }
  const props = { snapshot: snapshot(), target: { entry, activity, grade }, repository, userId: 'teacher', submission, data: classroom, canReview: true, courses: [{ id: 'course', title: 'Математика', semester: '2026' }, { id: 'course-b', title: 'Економіка', semester: '2026' }],
    onClose: () => closes++, onRefresh: async () => { refreshes++; if (overrides.failRefresh) throw Error('Refresh failed') },
    onSaved: async value => completions.push(value), onOpenJournal: value => focuses.push(value), ...overrides }
  function render() {
    for (let pass = 0; pass < 12; pass++) { dirty = false; index = 0; tree = api[component](props); effects.splice(0).forEach(effect => effect()); if (!dirty) return tree }
    throw Error('Unstable hook rendering')
  }
  render()
  return { calls, completions, focuses, props, render, get tree() { return tree }, get closes() { return closes }, get refreshes() { return refreshes },
    find(predicate) { const found = nodes(tree).find(predicate); assert.ok(found, 'Expected rendered element'); return found },
    input(name, value) { const node = this.find(item => item.props?.name === name); node.props.onChange({ target: { value, checked: value } }); render() },
    inputField(label, value) { const field = this.find(item => item.type === 'TeachingField' && item.props?.label === label); const node = nodes(field).find(item => ['input', 'select'].includes(item.type)); assert.ok(node); node.props.onChange({ target: { value, checked: value } }); render() },
    button(label) { return this.find(item => ['TeachingButton', 'button'].includes(item.type) && content(item) === label) },
    async save() { await this.find(item => item.type === 'form').props.onSubmit({ preventDefault() {} }); render() },
    async settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); render() },
  }
}

test('review focus resolves exact course, group, assignment and active student without title/date substitution', () => {
  const other = { ...activity, id: 'other-activity', group_id: 'other-group' }
  const snap = snapshot({ activities: [other, activity] })
  const focus = { courseId: 'course', groupId: 'group', assignmentId: 'assignment', studentId: 'student' }
  assert.equal(helpers.resolveTeachingJournalFocus(snap, focus).activity.id, 'activity')
  assert.equal(helpers.resolveTeachingJournalFocus(snap, focus).entry.id, 'entry')
  for (const patch of [{ activityId: 'other-activity' }, { assignmentId: 'missing' }, { activityId: 'missing' }]) {
    const resolved = helpers.resolveTeachingJournalFocus(snap, { ...focus, ...patch })
    assert.equal(resolved.activity, undefined); assert.ok(resolved.problem)
  }
  for (const patch of [{ courseId: 'other-course' }, { groupId: 'other-group' }]) assert.equal(helpers.resolveTeachingJournalFocus(snap, { ...focus, ...patch }).groupId, '')
  assert.equal(helpers.resolveTeachingJournalFocus(snapshot({ course: { ...snap.course, permissions: ['materials'] } }), focus).groupId, '')
  assert.equal(helpers.resolveTeachingJournalFocus(snapshot({ entries: [{ ...entry, active: false }] }), focus).entry, undefined)
})

test('oral defence can add points up to the existing maximum, preserving category and coefficient rules', () => {
  const snap = snapshot(), before = JSON.stringify(snap)
  const payload = helpers.teachingGradeDraftPayload('course', entry, activity, grade, { score: '1,5', comment: 'Захищено', reason: 'Доповнено усний захист', mode: 'add' })
  assert.deepEqual(plain(payload), { course_id: 'course', activity_id: 'activity', entry_id: 'entry', score: 5.5, comment: 'Захищено', reason: 'Доповнено усний захист', version: 5 })
  assert.equal(JSON.stringify(snap), before)
  assert.equal(helpers.teachingGradeEditScore('0,2', activity, { ...grade, draft_score: 0.1 }, 'add'), 0.3)
  assert.equal(helpers.parseTeachingGradeScore('0', 10), 0)
  assert.equal(helpers.parseTeachingGradeScore('', 10), null)
  for (const raw of ['-1', 'NaN', '1e2', '11', '1.001', '1,2,3']) assert.throws(() => helpers.parseTeachingGradeScore(raw, 10))
  for (const input of [{ score: '7', reason: 'Захист' }, { score: '1', reason: '' }, { score: '0', reason: 'Захист' }]) assert.throws(() => helpers.teachingGradeDraftPayload('course', entry, activity, grade, { comment: '', mode: 'add', ...input }))
  assert.throws(() => helpers.teachingGradeDraftPayload('course', { ...entry, group_id: 'foreign' }, activity, grade, { score: '5', comment: '', reason: 'Зміна' }))
  assert.throws(() => helpers.teachingGradeDraftPayload('course', entry, activity, { ...grade, entry_id: 'foreign' }, { score: '5', comment: '', reason: 'Зміна' }))
})

test('grade editor saves one versioned draft after defence; it never publishes or adds the score twice on uncertain response', async () => {
  const fx = fixture('GradeEditor')
  fx.input('grade-edit-mode', 'add'); fx.input('grade-score', '2'); fx.input('grade-reason', 'Успішний захист')
  await fx.save()
  assert.equal(fx.calls.length, 1); assert.equal(fx.calls[0].action, 'save_grade'); assert.equal(fx.calls[0].payload.score, 6); assert.equal(fx.calls[0].payload.version, 5)
  assert.equal(fx.completions.length, 1); assert.equal(fx.closes, 1)
  const uncertain = fixture('GradeEditor', { failWrite: true })
  uncertain.input('grade-edit-mode', 'add'); uncertain.input('grade-score', '2'); uncertain.input('grade-reason', 'Успішний захист')
  await uncertain.save(); await uncertain.save()
  assert.equal(uncertain.calls.length, 1); assert.match(content(uncertain.tree), /повторне додавання балів заблоковано/)
})

test('published score edits require reason; read-only editor and over-maximum additions cannot mutate', async () => {
  const fx = fixture('GradeEditor')
  fx.input('grade-score', '5'); await fx.save(); assert.equal(fx.calls.length, 0)
  fx.input('grade-reason', 'Виправлення після захисту'); await fx.save(); assert.equal(fx.calls.length, 1)
  const readOnly = fixture('GradeEditor', { readonly: true }); await readOnly.save(); assert.equal(readOnly.calls.length, 0)
  const tooMany = fixture('GradeEditor'); tooMany.input('grade-edit-mode', 'add'); tooMany.input('grade-score', '8'); tooMany.input('grade-reason', 'Захист'); await tooMany.save(); assert.equal(tooMany.calls.length, 0); assert.match(content(tooMany.tree), /Максимум цієї роботи/)
  const unchangedDraft = fixture('GradeEditor', { target: { entry, activity, grade: { ...grade, draft_score: 5 } } }); await unchangedDraft.save(); assert.equal(unchangedDraft.calls.length, 0); assert.equal(unchangedDraft.closes, 1)
})

test('review publishes a canonical journal grade atomically only when explicitly selected', async () => {
  const feedbackOnly = fixture('SubmissionReviewDialog')
  feedbackOnly.input('submission-review-feedback', 'Прийнято без оцінки'); await feedbackOnly.save()
  assert.equal(feedbackOnly.calls.length, 1); assert.equal(feedbackOnly.calls[0].action, 'review_submission'); assert.ok(!('score' in feedbackOnly.calls[0].payload))
  assert.equal(feedbackOnly.completions[0].publishedGrade, false)
  const publish = fixture('SubmissionReviewDialog')
  publish.input('submission-review-publish-score', true); publish.input('submission-review-score', '0'); publish.input('submission-review-feedback', 'Виставлено нуль'); await publish.save()
  assert.equal(publish.calls.length, 1); assert.equal(publish.calls[0].action, 'review_submission'); assert.equal(publish.calls[0].payload.score, 0); assert.equal(publish.calls[0].payload.grade_version, 0)
  assert.equal(publish.completions[0].publishedGrade, true)
  const noPermission = fixture('SubmissionReviewDialog', { data: { ...classroom, permissions: ['assignments'] } })
  assert.ok(!nodes(noPermission.tree).some(node => node.props?.name === 'submission-review-publish-score'))
})

test('student without a submitted file opens the exact journal context without creating a fake submission or exposing seminar distribution', async () => {
  const fx = fixture('TeachingSubmissionReview'); await fx.settle()
  const row = fx.find(node => node.type === 'button' && node.props?.['aria-label'] === entry.full_name + ': виставити бали в журналі')
  assert.equal(row.props.disabled, false); row.props.onClick()
  assert.equal(fx.calls.length, 0); assert.equal(fx.focuses.length, 1)
  assert.deepEqual(plain(fx.focuses[0]), { courseId: 'course', groupId: 'group', assignmentId: 'assignment', activityId: 'activity', studentId: 'student', date: '2026-10-27', key: fx.focuses[0].key })
  assert.ok(!/PRIVATE_QUESTION|PRIVATE_RESERVATION|PRIVATE_TEAM/.test(content(fx.tree)))
})

test('journal focus selects exact student and activity; missing work never opens an unrelated editor', () => {
  const focus = { courseId: 'course', groupId: 'group', assignmentId: 'assignment', studentId: 'student', key: '1' }
  const fx = fixture('TeachingGradebook', { initialFocus: focus })
  const editor = fx.find(node => typeof node.type === 'function' && node.type.name === 'GradeEditor')
  assert.equal(editor.props.target.entry.id, 'entry'); assert.equal(editor.props.target.activity.id, 'activity')
  const missing = fixture('TeachingGradebook', { initialFocus: { ...focus, activityId: 'missing' } })
  assert.ok(!nodes(missing.tree).some(node => typeof node.type === 'function' && node.type.name === 'GradeEditor'))
  assert.match(content(missing.tree), /ще немає роботи в журналі/)
  assert.ok(!/PRIVATE_QUESTION|PRIVATE_RESERVATION|PRIVATE_TEAM/.test(content(fx.tree)))
})

const calendarLesson = overrides => ({ id: 'slot-a', course_id: 'course', course_title: 'Математика', group_id: 'group', group_name: 'ТЕСТ-1', subject_name: 'Математика', lesson_date: '2026-10-27', starts_at: '08:00:00', ends_at: '09:20:00', lesson_type: 'seminar', location: '101', assigned_to_me: true, source: 'timetable', ...overrides })
const calendarLessons = [
  calendarLesson({}),
  calendarLesson({ id: 'slot-b', group_id: 'group-b', group_name: 'ТЕСТ-2', starts_at: '09:40:00', ends_at: '11:00:00', assigned_to_me: false }),
  calendarLesson({ id: 'slot-c', course_id: 'course-b', course_title: 'Економіка', subject_name: 'Економіка', group_id: 'group-b', group_name: 'ТЕСТ-2', starts_at: '11:20:00', ends_at: '12:40:00' }),
  calendarLesson({ id: 'slot-d', course_id: 'course-b', course_title: 'Економіка', subject_name: 'Економіка', group_id: 'group-c', group_name: 'ТЕСТ-3', starts_at: '12:50:00', ends_at: '14:10:00', assigned_to_me: false }),
]
const calendarArticles = fx => nodes(fx.tree).filter(node => node.type === 'article' && node.props?.className?.includes('teaching-calendar-lesson'))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

test('calendar defaults to all subjects/groups even with a current course/group; explicit current-group filter is reversible', async () => {
  const requests = [], repository = { teacherCalendar: async (...args) => { requests.push(args); return { lessons: calendarLessons } } }
  const fx = fixture('TeachingCalendar', { repository, initialCourseId: 'course', initialGroupId: 'group' }); await fx.settle()
  assert.equal(calendarArticles(fx).length, 4); assert.match(content(fx.tree), /Загальний розклад усіх ваших підключених груп і предметів/)
  assert.deepEqual(requests, [['2026-10-27', '2026-11-02']])
  fx.button('Лише поточна група').props.onClick(); fx.render()
  assert.equal(calendarArticles(fx).length, 1); assert.match(content(calendarArticles(fx)[0]), /ТЕСТ-1/)
  fx.button('Усі групи й предмети').props.onClick(); fx.render(); assert.equal(calendarArticles(fx).length, 4)
  assert.equal(requests.length, 1, 'Filters use the same authorized snapshot without extra requests')
})

test('calendar combines course/group/personal filters and course changes clear an incompatible group choice', async () => {
  const fx = fixture('TeachingCalendar', { repository: { teacherCalendar: async () => ({ lessons: calendarLessons }) } }); await fx.settle()
  fx.inputField('Ваш предмет', 'course-b'); assert.equal(calendarArticles(fx).length, 2)
  fx.inputField('Група', 'group-c'); assert.equal(calendarArticles(fx).length, 1)
  const personal = fx.find(node => node.type === 'input' && node.props?.type === 'checkbox')
  personal.props.onChange({ target: { checked: true } }); fx.render(); assert.equal(calendarArticles(fx).length, 0)
  fx.button('Усі групи й предмети').props.onClick(); fx.render()
  fx.find(node => node.type === 'input' && node.props?.type === 'checkbox').props.onChange({ target: { checked: true } }); fx.render(); assert.equal(calendarArticles(fx).length, 2)
  fx.inputField('Ваш предмет', 'course-b'); assert.equal(calendarArticles(fx).length, 1)
  fx.inputField('Група', 'group-b'); fx.inputField('Ваш предмет', 'course'); assert.equal(calendarArticles(fx).length, 1)
  assert.match(content(calendarArticles(fx)[0]), /ТЕСТ-1/)
  fx.button('Відкрити журнал').props.onClick(); assert.equal(fx.focuses[0].course_id, 'course'); assert.equal(fx.focuses[0].group_id, 'group')
})

test('calendar drops previous account/repository snapshots immediately and ignores late responses and errors', async () => {
  const requests = [], repository = { teacherCalendar: () => { const next = deferred(); requests.push(next); return next.promise } }
  const fx = fixture('TeachingCalendar', { repository, initialCourseId: 'course', initialGroupId: 'group' })
  fx.props.userId = 'second-teacher'; fx.render(); assert.equal(requests.length, 2)
  requests[0].resolve({ lessons: [calendarLesson({ subject_name: 'OLD_ACCOUNT' })] }); await fx.settle()
  assert.equal(calendarArticles(fx).length, 0); assert.ok(!content(fx.tree).includes('OLD_ACCOUNT'))
  requests[1].resolve({ lessons: [calendarLesson({ subject_name: 'CURRENT_ACCOUNT' })] }); await fx.settle()
  assert.equal(calendarArticles(fx).length, 1); assert.match(content(fx.tree), /CURRENT_ACCOUNT/)
  const nextRequest = deferred(); fx.props.repository = { teacherCalendar: () => nextRequest.promise }; fx.render()
  assert.equal(calendarArticles(fx).length, 0); assert.ok(!content(fx.tree).includes('CURRENT_ACCOUNT'))
  nextRequest.resolve({ lessons: [calendarLesson({ subject_name: 'CURRENT_REPOSITORY' })] }); await fx.settle(); assert.match(content(fx.tree), /CURRENT_REPOSITORY/)
  const oldError = deferred(), newSuccess = deferred()
  fx.props.repository = { teacherCalendar: () => oldError.promise }; fx.render()
  fx.props.repository = { teacherCalendar: () => newSuccess.promise }; fx.render()
  oldError.reject(Error('OLD_ACCOUNT_PRIVATE_ERROR')); await fx.settle(); assert.ok(!content(fx.tree).includes('OLD_ACCOUNT_PRIVATE_ERROR'))
  newSuccess.resolve({ lessons: calendarLessons }); await fx.settle(); assert.equal(calendarArticles(fx).length, 4)
})

test('calendar assignment from a previous account cannot alter the current account display', async () => {
  const marked = deferred(), writes = []
  const repository = { teacherCalendar: async () => ({ lessons: calendarLessons }), setCalendarLesson: (...args) => { writes.push(args); return marked.promise } }
  const fx = fixture('TeachingCalendar', { repository }); await fx.settle()
  fx.button('Додати до моїх пар').props.onClick(); fx.render(); assert.equal(writes.length, 1)
  assert.deepEqual(writes[0], ['course', 'group-b', 'slot-b', 'timetable', true])
  fx.props.userId = 'another-teacher'; fx.render(); await fx.settle()
  marked.resolve({ assigned: true }); await fx.settle()
  const second = calendarArticles(fx).find(node => content(node).includes('09:40'))
  assert.ok(second); assert.match(content(second), /Додати до моїх пар/); assert.ok(!content(second).includes('Веду я'))
})
