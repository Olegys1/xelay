import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import * as jsxRuntime from 'react/jsx-runtime'
import ts from 'typescript'

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const uri = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const modelUrl = uri(compile(await read('src/lib/homeDashboardModel.ts')))
const linksUrl = uri(compile(await read('src/lib/studyGroupLinks.ts')))
const source = compile(await read('src/lib/homeLessonConference.ts'))
  .replace(/['"]\.\/homeDashboardModel['"]/g, JSON.stringify(modelUrl))
  .replace(/['"]\.\/studyGroupLinks['"]/g, JSON.stringify(linksUrl))
const { homeConferenceAccess, homeLessonConference, visibleHomeLessonConference } = await import(uri(source))

const group = { id: 'group-a', name: 'Group A', status: 'accepted', learning: true,
  teachingSubjectIds: ['course-a'], gradingSubjectIds: [], permissions: [], program: '', studyYear: 1, academicYear: '2026/2027' }
const lesson = { id: 'lesson-a', groupId: group.id, subjectId: 'course-a', subject: 'Mathematics',
  context: 'learning', date: '2026-10-28', startsAt: '09:40', endsAt: '11:00', type: 'Лекція',
  href: '/groups/group-a?tab=schedule', conference: { meetingId: '123 456 789', passcode: '000067' } }
const data = patch => ({ role: 'student', displayName: 'Synthetic person', initials: 'SP',
  clockIso: '2026-10-28T10:00:00+02:00', contexts: ['learning', 'teaching'], teachingVerified: true,
  status: 'ready', participantCount: 0, groups: [group], lessons: [lesson], tasks: [], updates: [],
  publications: [], community: [], news: [], ...patch })

test('a supplied primary web URL opens directly, with secondary-only access supported', () => {
  const primary = 'https://zoom.us/j/123456789?pwd=synthetic'
  const secondary = 'https://meet.google.com/synthetic-meet'
  assert.equal(homeLessonConference({ online_url: primary, online_url_secondary: secondary }).href, primary)
  assert.equal(homeLessonConference({ online_url_secondary: secondary }).href, secondary)
  assert.equal(homeLessonConference({ online_url: 'javascript:alert(1)', online_url_secondary: secondary }).href, secondary)
  assert.equal(homeLessonConference({ online_url: ' https://meet.google.com/synthetic-meet ' }).href, secondary)
})

test('access identifiers and leading-zero passcodes never become a guessed provider URL', () => {
  const access = homeLessonConference({ conference_id: ' 123 456 789 ', conference_access_code: ' 000067 ' })
  assert.deepEqual(access, { href: undefined, meetingId: '123 456 789', passcode: '000067' })
  assert.deepEqual(homeConferenceAccess({ passcode: '000067' }), { href: undefined, meetingId: undefined, passcode: '000067' })
  assert.deepEqual(homeConferenceAccess({ meetingId: 'synthetic Teams ID' }), { href: undefined, meetingId: 'synthetic Teams ID', passcode: undefined })
  assert.equal(homeConferenceAccess(undefined), undefined)
  assert.equal(homeConferenceAccess({}), undefined)
})

test('unsafe schemes, malformed URLs, hidden controls and URL credentials are never join targets', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///C:/x', 'zoommtg://zoom.us/join',
    '//zoom.us/j/123', '/groups/group-a', 'https://', 'https://user:secret@zoom.us/j/123',
    'https://zoom.us/\n123', 'https://zoom.us/\u202e123']) {
    assert.equal(homeConferenceAccess({ href }), undefined, href)
  }
  assert.equal(homeConferenceAccess({ meetingId: '123\n456', passcode: 'bad\u202ecode' }), undefined)
  assert.equal(homeConferenceAccess({ meetingId: 'x'.repeat(121) }), undefined)
  assert.equal(homeConferenceAccess({ href: 'javascript:bad', passcode: '000067' }).passcode, '000067')
})

test('the current visible lesson controls the access panel without any internal-group fallback', () => {
  const visible = visibleHomeLessonConference(data(), { context: 'learning', groupId: group.id, date: 'today' }, lesson.id)
  assert.equal(visible.lesson.id, lesson.id)
  assert.equal(visible.conference.meetingId, '123 456 789')
  assert.equal(visible.conference.href, undefined)
  assert.equal(visibleHomeLessonConference(data(), {}, 'missing-lesson'), null)
  assert.equal(visibleHomeLessonConference(data({ status: 'loading' }), {}, lesson.id), null)
  assert.equal(visibleHomeLessonConference(data({ lessons: [{ ...lesson, conference: undefined }] }), {}, lesson.id), null)
})

test('changing group, accepted membership, date or role closes access to a previous meeting', () => {
  assert.equal(visibleHomeLessonConference(data(), { groupId: 'another-group' }, lesson.id), null)
  assert.equal(visibleHomeLessonConference(data({ groups: [{ ...group, status: 'invited' }] }), {}, lesson.id), null)
  assert.equal(visibleHomeLessonConference(data(), { date: 'tomorrow' }, lesson.id), null)
  assert.equal(visibleHomeLessonConference(data(), { context: 'teaching' }, lesson.id), null)
  const teacherLesson = { ...lesson, id: 'teacher-lesson', context: 'teaching' }
  assert.ok(visibleHomeLessonConference(data({ lessons: [teacherLesson] }), { context: 'teaching' }, teacherLesson.id))
  assert.equal(visibleHomeLessonConference(data({ lessons: [teacherLesson], teachingVerified: false }), { context: 'teaching' }, teacherLesson.id), null)
  assert.equal(visibleHomeLessonConference(data({ lessons: [{ ...teacherLesson, subjectId: 'another-course' }] }), { context: 'teaching' }, teacherLesson.id), null)
  assert.equal(visibleHomeLessonConference(data({ groups: [{ ...group, learning: false }] }), { context: 'learning' }, lesson.id), null)
})

const liveJs = ts.transpileModule(await read('src/components/home/LiveHomeDashboard.tsx'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText

function liveFixture(input) {
  const slots = [], navigated = [], copied = []
  let cursor = 0, current = input
  const Home = () => null
  const nothing = () => null
  const modules = {
    react: { useEffect() {}, useRef: () => ({ current: null }), useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    } },
    'react/jsx-runtime': jsxRuntime,
    '@tanstack/react-router': { useNavigate: () => value => { navigated.push(value) } },
    '../../context/ThemeContext': { useTheme: () => ({ theme: 'light' }) },
    '../../context/OnboardingContext': { useOnboarding: () => ({ homeGuide: undefined }) },
    '../../hooks/useHomeDashboard': { useHomeDashboard: () => ({ data: current, refresh() {}, refreshing: false }) },
    '../../lib/groupQuickAccess': { readGroupQuickAccess: () => 'all' },
    '../../lib/homeLessonConference': { visibleHomeLessonConference },
    './HomeDashboard': { HomeDashboard: Home },
    './HomeIcons': { HomeIcon: nothing },
    '../SecretBadgeAnnouncement': { SecretBadgeAnnouncement: nothing },
    '../RectorateFeedbackAnnouncement': { RectorateFeedbackAnnouncement: nothing },
    '../OfflineStudyAnnouncement': { OfflineStudyAnnouncement: nothing },
    '../halloween/HalloweenPumpkin': { HalloweenPumpkin: nothing },
    './HomeDashboard.css': {},
  }
  const module = { exports: {} }
  runInNewContext(liveJs, { module, exports: module.exports,
    require(name) { assert.ok(name in modules, `Unexpected live import ${name}`); return modules[name] },
    navigator: { clipboard: { async writeText(value) { copied.push(value) } } },
  })
  const render = () => { cursor = 0; return module.exports.LiveHomeDashboard({ profile: { isTeacher: false }, userId: 'synthetic-user' }) }
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return null
    if (Array.isArray(node)) { for (const child of node) { const found = find(child, predicate); if (found) return found } return null }
    return predicate(node) ? node : find(node.props?.children, predicate)
  }
  return { render, find, Home, navigated, copied, setData(value) { current = value } }
}

test('the live credential action stays on home, copies exact data, and disappears with lost access', async () => {
  const fx = liveFixture(data())
  let tree = fx.render()
  fx.find(tree, node => node.type === fx.Home).props.onJoinLesson(lesson.id)
  tree = fx.render()
  assert.ok(fx.find(tree, node => node.props?.role === 'dialog'))
  assert.deepEqual(fx.navigated, [])
  const copyCode = fx.find(tree, node => node.type === 'button' && node.props.children === 'Скопіювати код')
  assert.ok(copyCode)
  copyCode.props.onClick()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(fx.copied, ['000067'])
  assert.ok(fx.find(fx.render(), node => node.type === 'button' && node.props.children === 'Скопійовано'))
  fx.setData(data({ groups: [{ ...group, status: 'invited' }] }))
  assert.equal(fx.find(fx.render(), node => node.props?.role === 'dialog'), null)
  assert.deepEqual(fx.navigated, [])
})

test('a passcode-only live join opens its details, while missing and URL joins never fall back to the group', () => {
  const fx = liveFixture(data({ lessons: [{ ...lesson, conference: { passcode: '000067' } }] }))
  fx.find(fx.render(), node => node.type === fx.Home).props.onJoinLesson(lesson.id)
  assert.ok(fx.find(fx.render(), node => node.type === 'button' && node.props.children === 'Скопіювати код'))
  assert.equal(fx.find(fx.render(), node => node.type === 'dt' && node.props.children === 'Ідентифікатор конференції'), null)
  const url = liveFixture(data({ lessons: [{ ...lesson, conference: { href: 'https://meet.google.com/synthetic-meet' } }] }))
  const props = url.find(url.render(), node => node.type === url.Home).props
  props.onJoinLesson(lesson.id)
  props.onJoinLesson('missing')
  assert.equal(url.find(url.render(), node => node.props?.role === 'dialog'), null)
  assert.deepEqual(url.navigated, [])
})
