// Execute the actual audience helper and announcement entry points with fake
// authenticated profiles. No browser, user data or provider requests are used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const compile = source => ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText
const audience = { exports: {} }
vm.runInNewContext(compile(await read('src/lib/accountExperience.ts')), {
  module: audience, exports: audience.exports,
})
const { isTeacherExperience, isStudentAnnouncementAudience } = audience.exports
const sources = await Promise.all([
  'StudyGroupJoinReminder', 'FreeGroupsAnnouncement', 'SocialLaunchAnnouncement',
].map(async name => ({ name, source: await read(`src/components/${name}.tsx`) })))
const student = extra => ({ id: 'student', accountType: 'student', isTeacher: false,
  teacherVerificationStatus: 'none', isPlatformAdmin: false, ...extra })

function announcement(entry) {
  let auth = { authUser: { id: 'student' }, xelayUser: student(), isLoading: false, isPasswordRecovery: false }
  let suspended = false, location = { pathname: '/', searchStr: '' }, requests = 0
  const exports = {}
  const jsx = (type, props, key) => ({ type, props, key })
  vm.runInNewContext(compile(entry.source), {
    exports, URLSearchParams,
    require(name) {
      if (name === 'react') return {}
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'react-dom') return {}
      if (name === 'lucide-react') return {}
      if (name === '@tanstack/react-router') return { useRouterState: ({ select }) => select({ location }) }
      if (name === '../context/AuthContext') return { useAuth: () => auth }
      if (name === '../context/OnboardingContext') return { useOnboarding: () => ({ suspended }) }
      if (name === '../lib/accountExperience') return audience.exports
      if (name === '../lib/studyGroupJoinReminder') return { isGroupJoinReminderAudience: isStudentAnnouncementAudience }
      if (name === '../lib/supabase') return { supabase: { from() { requests++; throw Error('Unexpected provider request') } } }
      if (name === '../lib/announcementSlot' || name === './StudyGroupJoinNotice' || name.endsWith('.css')) return {}
      throw Error('Unexpected announcement import: ' + name)
    },
  })
  return {
    auth(value) { auth = value },
    profile(value) { auth = { ...auth, xelayUser: value } },
    suspended(value) { suspended = value },
    location(value) { location = value },
    render: props => exports[entry.name](props || {}),
    requests: () => requests,
  }
}

test('teacher presentation recognizes unverified teacher registration and every teacher request state without granting access', () => {
  assert.equal(isTeacherExperience(null), false)
  assert.equal(isStudentAnnouncementAudience(undefined), false)
  assert.equal(isTeacherExperience(student()), false)
  assert.equal(isTeacherExperience(student({ accountType: 'teacher' })), true)
  assert.equal(isTeacherExperience(student({ isTeacher: true })), true)
  for (const teacherVerificationStatus of ['pending', 'approved', 'rejected', 'revoked']) {
    const profile = student({ teacherVerificationStatus })
    assert.equal(isTeacherExperience(profile), true, teacherVerificationStatus)
    assert.equal(isStudentAnnouncementAudience(profile), false, teacherVerificationStatus)
    assert.equal(profile.isTeacher, false, 'The UI classifier never grants a verified role')
    assert.equal(profile.accountType, 'student', 'Existing account data is not mutated')
  }
})

test('students and headmen keep announcements while administrators do not receive student onboarding', () => {
  for (const profile of [student(), student({ isClassRepresentative: true }),
    student({ accountType: undefined, teacherVerificationStatus: undefined })]) {
    assert.equal(isStudentAnnouncementAudience(profile), true)
    assert.equal(isTeacherExperience(profile), false)
  }
  assert.equal(isStudentAnnouncementAudience(student({ isPlatformAdmin: true })), false)
})

for (const entry of sources) {
  test(`${entry.name}: no student popup for email/Google teacher registrations or a student applying for verification`, () => {
    const fx = announcement(entry)
    for (const profile of [student({ accountType: 'teacher' }),
      student({ accountType: 'teacher', teacherVerificationStatus: 'pending' }),
      ...['pending', 'approved', 'rejected', 'revoked'].map(teacherVerificationStatus => student({ teacherVerificationStatus })),
      student({ isTeacher: true }), student({ isPlatformAdmin: true })]) {
      fx.profile(profile)
      assert.equal(fx.render(), null, JSON.stringify(profile))
    }
    assert.equal(fx.requests(), 0, 'Ineligible teachers never mount the account controller')
  })

  test(`${entry.name}: waits for matching hydrated account and preserves onboarding/payment exclusions`, () => {
    const fx = announcement(entry)
    for (const auth of [
      { authUser: null, xelayUser: null },
      { authUser: { id: 'student' }, xelayUser: null },
      { authUser: { id: 'teacher' }, xelayUser: student() },
      { authUser: { id: 'student' }, xelayUser: student(), isLoading: true },
      { authUser: { id: 'student' }, xelayUser: student(), isPasswordRecovery: true },
    ]) { fx.auth(auth); assert.equal(fx.render(), null) }
    fx.auth({ authUser: { id: 'student' }, xelayUser: student(), isLoading: false, isPasswordRecovery: false })
    assert.equal(fx.render({ blocked: true }), null)
    fx.suspended(true); assert.equal(fx.render(), null); fx.suspended(false)
    for (const pathname of ['/support', '/subscription']) {
      fx.location({ pathname, searchStr: '?orderReference=synthetic' })
      assert.equal(fx.render(), null)
    }
    fx.location({ pathname: '/', searchStr: '' })
    const mounted = fx.render()
    assert.equal(mounted.key, 'student')
    assert.equal(mounted.props.userId, 'student')
    assert.equal(fx.requests(), 0)
  })

  test(`${entry.name}: same-account teacher transition removes its queued controller and account swap cannot reuse student state`, () => {
    const fx = announcement(entry)
    assert.ok(fx.render(), 'Ordinary student remains eligible')
    fx.profile(student({ teacherVerificationStatus: 'pending' }))
    assert.equal(fx.render(), null, 'Submitting teacher request removes the student controller immediately')
    fx.profile(student({ isTeacher: true, teacherVerificationStatus: 'approved' }))
    assert.equal(fx.render(), null, 'Approval cannot restart a queued student announcement')
    fx.auth({ authUser: { id: 'teacher' }, xelayUser: student(), isLoading: false })
    assert.equal(fx.render(), null, 'Stale student profile is never shown for the next account')
    fx.auth({ authUser: { id: 'teacher' }, xelayUser: student({ id: 'teacher', accountType: 'teacher' }), isLoading: false })
    assert.equal(fx.render(), null)
    fx.auth({ authUser: { id: 'other-student' }, xelayUser: student({ id: 'other-student', isClassRepresentative: true }), isLoading: false })
    assert.equal(fx.render().key, 'other-student', 'Next student receives its own fresh controller')
    assert.equal(fx.requests(), 0)
  })
}
