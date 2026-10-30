import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const [callbackSource, pageSource, statusSource, workspaceSource, noticeSource] = await Promise.all([
  'src/pages/AuthCallbackPage.tsx', 'src/pages/TeachingPage.tsx', 'src/components/TeacherStatusCard.tsx',
  'src/components/teaching/TeachingWorkspace.tsx', 'src/components/teaching/TeachingLaunchNotice.tsx',
].map(read))
const textOf = tree => tree === undefined || tree === null || typeof tree === 'boolean' ? '' : ['string', 'number'].includes(typeof tree) ? String(tree) : Array.isArray(tree) ? tree.map(textOf).join(' ') : (tree.type === 'TeachingEmpty' ? `${tree.props.title} ${tree.props.description} ` : '') + textOf(tree.props?.children)
const nodes = tree => !tree || typeof tree !== 'object' ? [] : Array.isArray(tree) ? tree.flatMap(nodes) : [tree, ...nodes(tree.props?.children)]
const plain = value => JSON.parse(JSON.stringify(value))
const jsx = (type, props, key) => ({ type, props, key })
const runtime = { jsx, jsxs: jsx, Fragment: 'fragment' }
const icons = Object.fromEntries(['ArrowLeft', 'Archive', 'BookOpen', 'Check', 'ChevronDown', 'ChevronRight', 'ClipboardList', 'ExternalLink', 'FolderOpen', 'GraduationCap', 'Plus', 'RefreshCw', 'Search', 'Settings2', 'UsersRound', 'X', 'CheckCircle2', 'Loader2', 'MailWarning', 'BadgeCheck', 'Clock3', 'Info'].map(name => [name, name]))
function load(source, imports, globals = {}) {
  const module = { exports: {} }
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText
  vm.runInNewContext(code, { module, exports: module.exports, ...globals, require(name) { assert.ok(name in imports, name); return imports[name] } })
  return module.exports
}
const groupDirectory = load(await read('src/lib/teachingGroupDirectory.ts'), {})
const groupVisibility = load(await read('src/lib/studyGroupVisibility.ts'), {})
const homeNavigation = load(await read('src/lib/teachingHomeNavigation.ts'), {})
const readRepository = load(await read('src/lib/teachingReadRepository.ts'), {})
const grading = load(await read('src/lib/teachingGrading.ts'), {})
const semesterJournal = load(await read('src/lib/teachingSemesterJournal.ts'), { './teachingGrading': grading })
const departments = load(await read('src/lib/academicDepartments.ts'), { '../data/knuAcademicDepartments.json': JSON.parse(await read('src/data/knuAcademicDepartments.json')) })
const visibilitySource = await read('src/lib/useTeachingVisibilityRefresh.ts')
const courseId = '11111111-1111-4111-8111-111111111111'
const groupOne = '22222222-2222-4222-8222-222222222222', groupTwo = '33333333-3333-4333-8333-333333333333', groupThree = '44444444-4444-4444-8444-444444444444'
function runner() {
  let index = 0, dirty = false, component, props, tree
  const cells = [], effects = []
  const same = (left, right) => left && right && left.length === right.length && left.every((value, i) => Object.is(value, right[i]))
  const react = {
    memo: component => component,
    useState(initial) { const i = index++; cells[i] ??= { value: typeof initial === 'function' ? initial() : initial }; return [cells[i].value, update => { const next = typeof update === 'function' ? update(cells[i].value) : update; if (!Object.is(cells[i].value, next)) { cells[i].value = next; dirty = true } }] },
    useRef(initial) { const i = index++; cells[i] ??= { current: initial }; return cells[i] },
    useId() { const i = index++; cells[i] ??= { value: 'field-' + i }; return cells[i].value },
    useCallback(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: callback, deps }; return cells[i].value },
    useMemo(factory, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) cells[i] = { value: factory(), deps }; return cells[i].value },
    useEffect(callback, deps) { const i = index++; if (!cells[i] || !same(cells[i].deps, deps)) { const previous = cells[i]; cells[i] = { deps, cleanup: previous?.cleanup }; effects.push(() => { previous?.cleanup?.(); cells[i].cleanup = callback() }) } },
  }
  const render = () => {
    for (let turn = 0; turn < 35; turn++) {
      index = 0; dirty = false; tree = component(props)
      effects.splice(0).forEach(effect => effect())
      if (!dirty) return tree
    }
    throw Error('Too many component renders')
  }
  return { react, render, start(next, nextProps = {}) { component = next; props = nextProps; return render() },
    get tree() { return tree },
    async flush() { for (let turn = 0; turn < 20; turn++) { await Promise.resolve(); render() } return tree },
    unmount() { cells.forEach(cell => cell?.cleanup?.()) },
  }
}

function callbackFixture({ accountType, verified = false } = {}) {
  const run = runner(), refreshes = []
  const api = load(callbackSource, { react: run.react, 'react/jsx-runtime': runtime, '@tanstack/react-router': { Link: 'Link' }, 'lucide-react': icons,
    '../context/AuthContext': { useAuth: () => ({ authUser: accountType ? { user_metadata: { account_type: accountType } } : null, xelayUser: accountType ? { accountType, isTeacher: verified } : null, refreshUser: async () => refreshes.push(true) }) },
    '../lib/authEmail': { initialAuthEmailLink: { isConfirmation: true, hasError: false } }, '../lib/authRegistration': { registrationUsernameNotice: () => null },
    '../lib/authGoogle': { initialGoogleCallback: { active: false } }, '../components/GoogleRegistrationGate': { GoogleRegistrationGate: 'GoogleRegistrationGate' }, '../lib/supabase': { supabase: {} },
    '../components/EmailLinkConfirmation': { EmailLinkConfirmation: 'EmailLinkConfirmation' }, '../components/AuthModal': { AuthModal: 'AuthModal' },
  })
  run.start(() => { const route = api.AuthCallbackPage(); return typeof route.type === 'function' ? route.type(route.props) : route })
  return { ...run, refreshes, async confirm(type) { await nodes(run.tree).find(node => node.type === 'EmailLinkConfirmation').props.onAccepted({ user: { user_metadata: { account_type: type } } }); run.render() },
    get tree() { return run.tree },
  }
}

test('teacher email confirmation returns to teaching even before AuthContext refresh supplies the profile', async () => {
  const fx = callbackFixture()
  assert.ok(!nodes(fx.tree).some(node => node.type === 'Link' && ['/teaching', '/news'].includes(node.props.to)))
  await fx.confirm('teacher')
  const next = nodes(fx.tree).find(node => node.type === 'Link' && node.props.to === '/teaching')
  assert.ok(next); assert.equal(textOf(next), 'Перейти до викладання'); assert.equal(fx.refreshes.length, 1)
  assert.match(textOf(fx.tree), /подати заявку з Telegram або телефоном/); fx.unmount()
})

test('student email confirmation retains news destination; an already verified teacher also receives the teaching route', async () => {
  const student = callbackFixture(); await student.confirm('student')
  assert.ok(nodes(student.tree).some(node => node.type === 'Link' && node.props.to === '/news' && textOf(node) === 'Перейти до Xelay'))
  assert.ok(!nodes(student.tree).some(node => node.type === 'Link' && node.props.to === '/teaching')); student.unmount()
  const teacher = callbackFixture({ accountType: 'student', verified: true }); await teacher.confirm('student')
  assert.ok(nodes(teacher.tree).some(node => node.type === 'Link' && node.props.to === '/teaching')); teacher.unmount()
})

test('a verification or academic-scope change remounts teaching workspace with a fresh server snapshot', () => {
  const run = runner(); let user = { name: 'Викладач', isTeacher: false, teacherVerificationStatus: 'pending', universityId: 'u1', academicUnitId: 'f1' }
  const api = load(pageSource, { react: run.react, 'react/jsx-runtime': runtime, '@tanstack/react-router': { useSearch: () => ({ course: courseId }) },
    '../context/AuthContext': { useAuth: () => ({ authUser: { id: 'teacher1' }, xelayUser: user }) }, '../lib/teaching': { supabaseTeachingRepository: {} },
    '../components/AuthModal': { AuthModal: 'AuthModal' }, '../components/TeacherStatusCard': { TeacherStatusCard: 'TeacherStatusCard' },
    '../components/teaching/TeachingWorkspace': { TeachingWorkspace: 'TeachingWorkspace' }, '../components/teaching/TeachingUI': { TeachingButton: 'TeachingButton', TeachingEmpty: 'TeachingEmpty' },
    '../lib/teachingHomeNavigation': homeNavigation,
  })
  run.start(api.TeachingPage)
  const workspace = () => nodes(run.tree).find(node => node.type === 'TeachingWorkspace')
  const pendingKey = workspace().key
  assert.ok(nodes(run.tree).some(node => node.type === 'TeacherStatusCard'))
  user = { ...user, isTeacher: true, teacherVerificationStatus: 'approved' }; run.render()
  const verifiedKey = workspace().key
  assert.notEqual(verifiedKey, pendingKey); assert.ok(!nodes(run.tree).some(node => node.type === 'TeacherStatusCard'))
  assert.equal(workspace().props.initialCourseId, courseId)
  user = { ...user, academicUnitId: 'f2' }; run.render(); assert.notEqual(workspace().key, verifiedKey)
  const scopeKey = workspace().key; user = { ...user, isTeacher: false, teacherVerificationStatus: 'revoked' }; run.render(); assert.notEqual(workspace().key, scopeKey); run.unmount()
})

const baseCourse = { id: courseId, owner_id: 'teacher1', university_id: 'u1', academic_unit_id: 'f1', title: 'Економічна теорія', semester: 'Осінь 2026', starts_on: '2026-09-01', ends_on: '2026-12-31', archived_at: null, grading_rules: { categories: [] }, permissions: ['manage', 'materials', 'assignments', 'grades'] }
const link = status => ({ id: 'link1', course_id: courseId, group_id: groupOne, group_name: 'МА-2', representative_id: 'head1', status })
const snapshot = (course = baseCourse, groups = []) => ({ course, groups, teachers: [], entries: [], activities: [], grades: [], assignments: [], materials: [], audit: [], roster_claims: [], members: [], seminars: { seminars: [], questions: [], teams: [], reservations: [], profiles: {} } })
function workspaceFixture({ courses = [baseCourse], pending = [], groups = [], verified = true, classrooms = [] } = {}) {
  const run = runner(), calls = [], mutations = [], listeners = new Map()
  const state = { workspace: { teacher_status: { verified }, courses, pending_invites: pending, groups: [], teacher_directory: [], classrooms }, snapshots: Object.fromEntries(courses.map(course => [course.id, snapshot(course, groups.filter(group => group.course_id === course.id))])) }
  const unused = Object.fromEntries(['group', 'groupMaterials', 'groupAssignments', 'assignmentLessons', 'scheduledItems', 'teacherCalendar', 'gradeRequests', 'myMaterials', 'materialLibrary', 'groupContext', 'classroom', 'classroomSeminars', 'classroomMutate', 'setCalendarLesson', 'requestGrade', 'resolveGradeRequest', 'withdrawMaterial', 'findColleague', 'upload', 'fileUrl', 'materialFileInfo', 'materialFileChunk', 'uploadSubmission', 'submissionFileUrl'].map(name => [name, async () => { throw new Error('Unexpected repository operation: ' + name) }]))
  const repository = { ...unused, mode: 'supabase', workspace: async () => { calls.push('workspace'); return plain(state.workspace) }, course: async id => { calls.push(id); return plain(state.snapshots[id]) }, mutate: async (action, payload) => { mutations.push({ action, payload }); return {} } }
  const globals = { document: { visibilityState: 'visible', addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name), getElementById: () => null },
    window: { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) }, queueMicrotask }
  const visibility = load(visibilitySource, { react: run.react }, globals)
  const api = load(workspaceSource, { react: run.react, 'react/jsx-runtime': runtime, 'lucide-react': icons,
    '../../lib/teaching': { teachingDate: value => value || '', teachingError: error => error.message, EMPTY_TEACHING_SEMINARS: { seminars: [], questions: [], teams: [], reservations: [], profiles: {} }, TEACHING_PERMISSIONS: [{ id: 'materials', label: 'Матеріали' }, { id: 'assignments', label: 'Завдання' }, { id: 'grades', label: 'Журнал' }] },
    '../../lib/teachingGroupDirectory': groupDirectory,
    '../../lib/studyGroupVisibility': groupVisibility,
    '../../lib/teachingHomeNavigation': homeNavigation, '../../lib/teachingReadRepository': readRepository,
    '../../lib/useTeachingVisibilityRefresh': visibility, '../../lib/teachingSemesterJournal': semesterJournal,
    '../../lib/seminars': { kyivToday: () => '2026-10-29' }, './TeachingSentGroupRequests': { TeachingSentGroupRequests: 'TeachingSentGroupRequests' },
    './TeachingUI': { TeachingButton: 'TeachingButton', TeachingEmpty: 'TeachingEmpty', TeachingField: 'TeachingField', TeachingModal: 'TeachingModal', teachingInput: 'input' },
    './TeachingCourseForms': { TeachingCourseForms: 'TeachingCourseForms' }, './TeachingPublications': { TeachingPublications: 'TeachingPublications' }, './TeachingGradebook': { TeachingGradebook: 'TeachingGradebook' },
    './TeacherPermissionControl': { TeacherPermissionControl: 'TeacherPermissionControl' }, './TeachingClassroomGuide': { TeachingClassroomGuide: 'TeachingClassroomGuide' }, './TeachingClassroomSeminarsPanel': { TeachingClassroomSeminarsPanel: 'TeachingClassroomSeminarsPanel' },
    './TeachingMyMaterials': { TeachingMyMaterials: 'TeachingMyMaterials' }, './TeachingCalendar': { TeachingCalendar: 'TeachingCalendar' }, './TeachingScheduledPublications': { TeachingScheduledPublications: 'TeachingScheduledPublications' }, './TeachingGradeRequests': { TeachingGradeRequests: 'TeachingGradeRequests' }, './teaching-workflow.css': {},
  }, globals)
  const props = { repository, userId: 'teacher1', fullName: 'Олена Викладач' }
  run.start(api.TeachingWorkspace, props)
  const button = label => { const found = nodes(run.render()).find(node => ['button', 'TeachingButton'].includes(node.type) && textOf(node).trim() === label); assert.ok(found, 'Missing button: ' + label); return found }
  return { ...run, state, calls, mutations, button, props,
    get tree() { return run.tree },
    async click(label) { const target = button(label); assert.equal(Boolean(target.props.disabled), false); target.props.onClick(); run.render(); await run.flush() },
  }
}

test('saved subjects without an accepted group are visible outside collapsed navigation and open without another create action', async () => {
  const fx = workspaceFixture(); await fx.flush()
  const visible = nodes(fx.tree).find(node => node.type === 'section' && node.props['aria-label'] === 'Предмети без підключеної групи')
  assert.ok(visible); assert.match(textOf(visible), /Економічна теорія/); assert.match(textOf(visible), /Групу ще не підключено/)
  assert.ok(!nodes(fx.tree).some(node => node.type === 'TeachingButton' && textOf(node).trim() === 'Створити предмет'))
  await fx.click('Підключити групу')
  assert.match(textOf(fx.tree), /Предмет уже збережено/)
  assert.ok(nodes(fx.tree).some(node => node.type === 'TeachingEmpty' && node.props.title === 'Підключіть першу групу до предмета'))
  assert.ok(fx.calls.includes(courseId)); assert.equal(fx.mutations.length, 0)
  await fx.click('Мої групи')
  assert.ok(nodes(fx.tree).some(node => node.type === 'section' && node.props['aria-label'] === 'Предмети без підключеної групи')); fx.unmount()
})

test('pending head confirmation is explicit at the top and after reopening the subject', async () => {
  const fx = workspaceFixture({ pending: [link('pending_group')], groups: [link('pending_group')] }); await fx.flush()
  const visible = nodes(fx.tree).find(node => node.type === 'section' && node.props['aria-label'] === 'Предмети без підключеної групи')
  assert.match(textOf(visible), /Очікуємо старосту/); assert.match(textOf(visible), /МА-2/)
  await fx.click('Переглянути підключення')
  assert.ok(nodes(fx.tree).some(node => node.type === 'TeachingEmpty' && node.props.title === 'Очікуємо підтвердження старости'))
  assert.match(textOf(fx.tree), /Повторно створювати предмет не потрібно/)
  assert.ok(nodes(fx.tree).some(node => node.type === 'TeachingButton' && textOf(node).trim() === 'Підключити іншу групу'))
  assert.equal(fx.mutations.length, 0); fx.unmount()
})

test('teacher invitation offers acceptance and the next step rather than suggesting a duplicate subject', async () => {
  const fx = workspaceFixture({ pending: [link('pending_teacher')], groups: [link('pending_teacher')] }); await fx.flush()
  assert.ok(nodes(fx.tree).some(node => node.type === 'TeachingButton' && textOf(node).trim() === 'Підключитися'))
  await fx.click('Переглянути підключення')
  assert.ok(nodes(fx.tree).some(node => node.type === 'TeachingEmpty' && node.props.title === 'Підтвердьте запрошення старости'))
  assert.match(textOf(fx.tree), /нижче натисніть «Прийняти»/)
  assert.ok(nodes(fx.tree).some(node => node.type === 'TeachingButton' && textOf(node).trim() === 'Прийняти'))
  assert.equal(fx.mutations.length, 0); fx.unmount()
})

test('workspace refresh reconciles accepted connections and does not mutate groups or publications', async () => {
  const fx = workspaceFixture({ pending: [link('pending_group')], groups: [link('pending_group')] }); await fx.flush()
  fx.state.workspace.pending_invites = []
  fx.state.workspace.classrooms = [{ group_id: groupOne, group_name: 'МА-2', courses: [{ course_id: courseId, status: 'accepted' }] }]
  fx.state.snapshots[courseId].groups = [link('accepted')]
  const before = fx.calls.length; await fx.click('Оновити викладання')
  assert.ok(fx.calls.length > before)
  assert.ok(!nodes(fx.tree).some(node => node.type === 'section' && node.props['aria-label'] === 'Предмети без підключеної групи'))
  const classroom = nodes(fx.tree).find(node => node.type === 'button' && node.props.className === 'teaching-card teaching-classroom-card')
  assert.ok(classroom); classroom.props.onClick(); fx.render(); await fx.flush()
  assert.ok(nodes(fx.tree).some(node => node.props?.role === 'tab' && textOf(node).includes('Завдання')))
  assert.ok(nodes(fx.tree).some(node => node.type === 'TeachingPublications' && node.props.groupId === groupOne))
  assert.ok(!nodes(fx.tree).some(node => node.props?.role === 'tab' && textOf(node).includes('Семінари')))
  assert.ok(!nodes(fx.tree).some(node => node.type === 'TeachingClassroomSeminarsPanel'))
  assert.equal(fx.mutations.length, 0); fx.unmount()
})

test('same-named accepted groups remain distinguishable by course, degree, faculty and head in cards and the selector', async () => {
  const first = { ...link('accepted'), study_year: 1, study_level: 'bachelor', academic_unit_name: 'Економічний факультет', specialty: 'Менеджмент', representative_name: 'Анастасія Староста' }
  const second = { ...first, id: 'link2', group_id: groupTwo, study_year: 2, representative_name: 'Ірина Староста' }
  const third = { ...first, id: 'link3', group_id: groupThree, study_level: 'master', representative_name: 'Марія Староста' }
  const accepted = [first, second, third]
  const classrooms = accepted.map(item => ({ ...item, courses: [{ course_id: courseId, status: 'accepted' }] }))
  const fx = workspaceFixture({ groups: accepted, classrooms }); await fx.flush()
  const cards = nodes(fx.tree).filter(node => node.type === 'button' && node.props.className === 'teaching-card teaching-classroom-card')
  assert.equal(cards.length, 3)
  assert.match(textOf(cards[0]), /Менеджмент.*1 курс.*бак\..*ЕФ.*Анастасія Староста/)
  assert.match(textOf(cards[1]), /Менеджмент.*2 курс.*бак\..*ЕФ.*Ірина Староста/)
  assert.match(textOf(cards[2]), /Менеджмент.*1 курс.*маг\..*ЕФ.*Марія Староста/)
  // Compact labels retain a separate full identity for detailed search/selection.
  assert.match(groupDirectory.teachingGroupDirectoryFullLabel({ ...first, id: first.group_id }), /МА-2.*1 курс.*Бакалаврат.*Економічний факультет.*Менеджмент.*Анастасія Староста/)
  assert.match(groupDirectory.teachingGroupDirectoryFullLabel({ ...second, id: second.group_id }), /МА-2.*2 курс.*Бакалаврат.*Економічний факультет.*Ірина Староста/)
  assert.match(groupDirectory.teachingGroupDirectoryFullLabel({ ...third, id: third.group_id }), /МА-2.*1 курс.*Магістратура.*Економічний факультет.*Марія Староста/)
  cards[0].props.onClick(); fx.render(); await fx.flush()
  const selector = nodes(fx.tree).find(node => node.type === 'select' && node.props.name === 'classroom-group')
  assert.ok(selector)
  const options = nodes(selector).filter(node => node.type === 'option')
  assert.equal(options.length, 3)
  assert.match(textOf(options[0]), /МА-2.*Менеджмент.*1 курс.*бак\..*ЕФ.*Анастасія Староста/)
  assert.match(textOf(options[1]), /МА-2.*Менеджмент.*2 курс.*бак\..*ЕФ.*Ірина Староста/)
  assert.match(textOf(options[2]), /МА-2.*Менеджмент.*1 курс.*маг\..*ЕФ.*Марія Староста/)
  assert.deepEqual(options.map(option => option.props.value), [groupOne, groupTwo, groupThree])
  selector.props.onChange({ target: { value: groupThree } }); fx.render(); await fx.flush()
  assert.ok(nodes(fx.tree).some(node => node.type === 'TeachingPublications' && node.props.groupId === groupThree))
  assert.equal(fx.mutations.length, 0); fx.unmount()
})

test('a co-teacher sees an existing unconnected subject without controls to create group invitations', async () => {
  const shared = { ...baseCourse, owner_id: 'other-teacher', permissions: ['materials'] }
  const fx = workspaceFixture({ courses: [shared] }); await fx.flush(); await fx.click('Відкрити предмет')
  assert.match(textOf(fx.tree), /Групу підключає власник предмета/)
  assert.ok(!nodes(fx.tree).some(node => node.type === 'TeachingButton' && ['Підключити групу', 'Підключити іншу групу'].includes(textOf(node).trim())))
  assert.equal(fx.mutations.length, 0); fx.unmount()
})

test('unverified accounts cannot create a subject and empty verified accounts receive one clear first step', async () => {
  const pending = workspaceFixture({ courses: [], verified: false }); await pending.flush()
  assert.match(textOf(pending.tree), /Завершіть підтвердження статусу викладача/)
  assert.ok(!nodes(pending.tree).some(node => node.type === 'TeachingButton' && ['Новий предмет', 'Створити предмет'].includes(textOf(node).trim()))); pending.unmount()
  const ready = workspaceFixture({ courses: [] }); await ready.flush()
  assert.ok(nodes(ready.tree).some(node => node.type === 'TeachingEmpty' && node.props.title === 'Почнімо з першого предмета'))
  await ready.click('Створити предмет')
  assert.ok(nodes(ready.tree).some(node => node.type === 'TeachingCourseForms' && node.props.dialog === 'course'))
  assert.equal(ready.mutations.length, 0); ready.unmount()
})

test('early-access copy explains the actual connection requirements without implying official university status or a future-only block', () => {
  const api = load(noticeSource, { 'react/jsx-runtime': runtime, 'lucide-react': icons, './teaching.css': {} })
  const text = textOf(api.TeachingLaunchNotice())
  assert.match(text, /Ранній доступ до викладання/); assert.match(text, /підтверджений статус викладача та прийняте підключення/)
  assert.match(text, /поки не має статусу офіційної платформи університету/)
  assert.doesNotMatch(text, /на наступному етапі|заплановано разом з офіційним запуском/)
})

test('pending verification card explains both onboarding paths and refreshes profile plus its own status', async () => {
  const run = runner(), refreshes = [], loads = []
  const profile = { universityId: 'u1', academicUnitId: 'f1', isTeacher: false }
  const api = load(statusSource, { react: run.react, 'react/jsx-runtime': runtime, '@tanstack/react-router': { useNavigate: () => () => {} }, 'lucide-react': icons,
    '../context/AuthContext': { useAuth: () => ({ authUser: { id: 'teacher1', user_metadata: {} }, xelayUser: profile, refreshUser: async () => refreshes.push(true) }) },
    '../context/ToastContext': { useToast: () => ({ notify() {} }) }, './BadgeInfo': { BadgeInfo: 'BadgeInfo' },
    './TeacherAcademicSettings': { TeacherAcademicProfileEditor: 'TeacherAcademicProfileEditor', TeacherAcademicSettings: 'TeacherAcademicSettings' },
    './TeacherVerificationContact': { TeacherVerificationContactField: 'TeacherVerificationContactField' },
    './AcademicDepartmentSelect': { AcademicDepartmentSelect: 'AcademicDepartmentSelect' }, '../lib/academicDepartments': departments,
    '../lib/teacherAcademicProfile': { emptyTeacherAcademicProfile: () => ({}), teacherPositionLabel: () => '', validateTeacherAcademicProfile: () => null },
    '../lib/teacherVerification': { loadTeacherVerification: async () => { loads.push(true); return { status: 'pending', verified: false, scope_changed: false, request: { department: 'Кафедра', position: '', note: '', university_id: 'u1', academic_unit_id: 'f1' } } }, requestTeacherVerification: async () => { throw Error('Unexpected write') }, savedTeacherVerificationContact: () => ({ kind: 'telegram', value: '' }), normalizeTeacherVerificationContact: () => null, teacherVerificationError: error => error.message },
  })
  run.start(api.TeacherStatusCard); await run.flush()
  assert.match(textOf(run.tree), /створіть предмет і запросіть групу або прийміть запрошення старости/)
  const refresh = nodes(run.tree).find(node => node.type === 'button' && textOf(node).trim() === 'Оновити статус')
  refresh.props.onClick(); run.render(); await run.flush()
  assert.equal(refreshes.length, 1); assert.equal(loads.length, 2); run.unmount()
})
