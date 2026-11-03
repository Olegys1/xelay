// Actual registration callbacks with synthetic SDK responses. No mail, accounts or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const source = await readFile(new URL('src/components/AuthModal.tsx', root), 'utf8')
const parsed = ts.createSourceFile('AuthModal.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AuthModal')
const declaration = name => component.body.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(parsed) === name).initializer.getText(parsed)
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const dependencies = ['submitting','setError','setLoginSupportReference','setInvalidField','dismiss','regPrivacyConsent','showError',
  'regName','normalizeRegistrationUsername','regUsername','regCity','selectedAcademicUnits','regAcademicUnitId',
  'academicOptionsLoading','academicOptionsError','universities','regUniversityId','regAccountType','specialtySelection',
  'academicSpecialtyMatches','isAcademicStatus','regAcademicStatus','regActiveStudent','regStudyYear','regCategories',
  'regDepartment','regPosition','regPassword','setLoading','regEmail','pendingRegistration','supabase','authEmailRedirect',
  'PRIVACY_POLICY_VERSION','PERSONAL_DATA_CONSENT_VERSION','regBio','setConfirmationEmail','setEmailNotice','setView',
  'startAuthEmailCooldown','setSignupCooldown','authEmailCooldown','setRegPassword','notify','refreshUser',
  'registrationUsernameNotice','navigate','onClose','registrationFailure','normalizeKnuEmail','KNU_EMAIL_REQUIRED_MESSAGE',
  'googleCompletion','completeGoogleRegistration','onCompleted','academicDepartmentMatches','academicDepartmentsForScope',
  'validateTeacherAcademicProfile','regTeacherProfile','supabaseTeacherAcademicRepository','stagePendingTeacherAcademicProfile','TEACHER_APPLICATION_NEXT_STEP',
  'loginEmail','loginPassword','loginFailure','loginErrorDiagnostic','loginErrorReference',
  'recoveryEmail','recoveryCooldown','setRecoveryCooldown','signupCooldown','confirmationEmail']
const callbacks = {}
const methods = ['handleRegister', 'handleLogin', 'requestRecovery', 'resendConfirmation']
vm.runInNewContext(compile(methods.map(name => `export function ${name}(context:any) { const {${dependencies.join(',')}}=context; return ${declaration(name)}; }`).join('\n')), { exports: callbacks })
async function loadHelper(name, imports = {}) {
  const exports = {}
  vm.runInNewContext(compile(await readFile(new URL(`src/lib/${name}.ts`, root), 'utf8')), { exports, require(key) {
    assert.ok(Object.hasOwn(imports, key), `Unexpected dependency ${key}`); return imports[key]
  } })
  return exports
}
const policy = await loadHelper('knuEmailPolicy')
const helpers = await loadHelper('authRegistration', { './knuEmailPolicy': policy })
const login = await loadHelper('authLogin')

function fixture(overrides = {}, withSession = false) {
  const events = [], state = {}
  const account = { id: 'synthetic-user', email: 'synthetic@knu.ua', user_metadata: {} }
  const context = {
    submitting: { current: false }, pendingRegistration: { current: null },
    regPrivacyConsent: true, regName: ' Synthetic Student ', regUsername: 'student', regCity: 'Київ',
    regBio: '', regEmail: ' Synthetic@KNU.UA ', regPassword: 'SYNTHETIC-TEST-NOT-A-REAL-SECRET',
    regUniversityId: 'university', regAcademicUnitId: 'faculty', selectedAcademicUnits: [{ id: 'faculty', name: 'Факультет' }],
    universities: [{ id: 'university' }], academicOptionsLoading: false, academicOptionsError: '',
    specialtySelection: { loading: false, error: '', selected: { id: 'program', name: 'Економіка' } },
    regAccountType: 'student', regAcademicStatus: 'bachelor', regActiveStudent: true, regStudyYear: '2',
    regCategories: ['General'], regDepartment: '', regPosition: '',
    academicSpecialtyMatches: () => true, isAcademicStatus: value => ['bachelor','master','postgraduate','graduate'].includes(value),
    authEmailRedirect: path => 'https://example.test' + path,
    PRIVACY_POLICY_VERSION: 'policy-current', PERSONAL_DATA_CONSENT_VERSION: 'consent-current',
    normalizeRegistrationUsername: helpers.normalizeRegistrationUsername, registrationUsernameNotice: () => null,
    registrationFailure: helpers.registrationFailure,
    ...policy, ...login,
    googleCompletion: undefined,
    completeGoogleRegistration: async (...args) => events.push(['google-complete', ...args]),
    onCompleted: () => events.push(['completed']),
    regTeacherProfile: {}, academicDepartmentMatches: () => true, academicDepartmentsForScope: () => [],
    validateTeacherAcademicProfile: () => null, stagePendingTeacherAcademicProfile: (...args) => { events.push(['teacher-stage', ...args]); return true },
    supabaseTeacherAcademicRepository: { save: async value => events.push(['teacher-save', value]) },
    TEACHER_APPLICATION_NEXT_STEP: 'Подайте заявку на підтвердження статусу.',
    loginEmail: ' Legacy.User@Gmail.Com ', loginPassword: 'SYNTHETIC-TEST-NOT-A-REAL-SECRET', recoveryEmail: ' Legacy.User@Gmail.Com ', recoveryCooldown: 0,
    signupCooldown: 0, confirmationEmail: 'legacy.user@gmail.com',
    authEmailCooldown: () => 60, startAuthEmailCooldown: value => events.push(['cooldown', value]),
    dismiss() {}, notify: value => events.push(['toast', value]),
    showError: (message, field) => events.push(['error', message, field]),
    refreshUser: async () => events.push(['refresh']), navigate: value => events.push(['navigate', value]),
    onClose: () => events.push(['close']),
    supabase: {
      auth: {
        signUp: async input => { events.push(['signup', input]); return { data: { user: account, session: withSession ? { user: account } : null }, error: null } },
        getUser: async () => { events.push(['auth-user']); return { data: { user: { ...account, email: context.googleCompletion?.email || account.email } }, error: null } },
        signInWithPassword: async input => { events.push(['login', input]); return { error: null } },
        resetPasswordForEmail: async (...args) => { events.push(['recovery', ...args]); return { error: null } },
        resend: async input => { events.push(['resend', input]); return { error: null } },
      },
      from(table) {
        assert.equal(table, 'profiles')
        return {
          upsert: async (input, options) => { events.push(['upsert', input, options]); return { error: null } },
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: account.id, username: 'student' }, error: null }) }) }),
        }
      },
    },
    ...overrides,
  }
  for (const setter of ['setError','setLoginSupportReference','setInvalidField','setLoading','setConfirmationEmail','setEmailNotice','setView','setSignupCooldown','setRecoveryCooldown','setRegPassword']) context[setter] = value => { state[setter] = value }
  const invoke = name => callbacks[name](context)({ preventDefault() {} })
  return { context, events, state, submit: () => invoke('handleRegister'), signIn: () => invoke('handleLogin'), recover: () => invoke('requestRecovery'), resend: () => invoke('resendConfirmation') }
}

test('active student registration refuses a missing or malformed course before calling Auth', async () => {
  for (const regStudyYear of ['', '0', '7', '-1', '1.0', '1e0', '02', ' 2', '2x']) {
    const fx = fixture({ regStudyYear })
    await fx.submit()
    assert.equal(fx.events.some(([kind]) => kind === 'signup' || kind === 'upsert'), false)
    assert.equal(fx.events.find(([kind]) => kind === 'error')[2], 'reg-study-year')
  }
})

test('every supported student course is sent numerically before the email-confirmation return', async () => {
  for (const regAcademicStatus of ['bachelor', 'master', 'postgraduate']) {
    for (const year of [1,2,3,4,5,6]) {
      const fx = fixture({ regAcademicStatus, regStudyYear: String(year) })
      await fx.submit()
      const signup = fx.events.find(([kind]) => kind === 'signup')[1]
      assert.equal(signup.options.data.study_year, year)
      assert.equal(signup.options.data.experience, regAcademicStatus)
      assert.equal(signup.options.data.xelay_privacy_consent, true)
      assert.equal(signup.options.data.xelay_privacy_policy_version, 'policy-current')
      assert.equal(signup.email, 'synthetic@knu.ua')
      assert.equal(fx.state.setView, 'confirmation')
      assert.equal(fx.events.some(([kind]) => kind === 'upsert'), false)
      assert.equal(fx.state.setRegPassword, '')
    }
  }
})

test('session-backed fallback sends the same course while keeping existing-profile duplicate protection', async () => {
  const fx = fixture({ regStudyYear: '3' }, true)
  await fx.submit()
  assert.equal(fx.events.find(([kind]) => kind === 'signup')[1].options.data.study_year, 3)
  const upsert = fx.events.find(([kind]) => kind === 'upsert')
  assert.equal(upsert[1].study_year, 3)
  assert.equal(upsert[2].ignoreDuplicates, true)
  assert.equal(upsert[2].onConflict, 'id')
  assert.equal(fx.events.some(([kind]) => kind === 'refresh'), true)
})

test('graduate and teacher signup never attach a stale student course in either creation path', async () => {
  for (const withSession of [false, true]) for (const override of [
    { regAcademicStatus: 'graduate', regActiveStudent: false },
    { regAccountType: 'teacher', regActiveStudent: false, regDepartment: 'Synthetic department' },
  ]) {
    const fx = fixture({ ...override, regStudyYear: '4' }, withSession)
    await fx.submit()
    assert.equal(fx.events.find(([kind]) => kind === 'signup')[1].options.data.study_year, null)
    if (withSession) assert.equal(fx.events.find(([kind]) => kind === 'upsert')[1].study_year, null)
  }
})

test('the visible course select is linked, conditionally required and resets when the degree changes', () => {
  const attrs = []
  const visit = node => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(parsed) === 'select') attrs.push(node.attributes)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  const select = id => attrs.find(attributes => attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.text === 'id' && attr.initializer?.text === id))
  const attr = (attributes, name) => attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.text === name)?.initializer
  const course = select('reg-study-year')
  assert.ok(course)
  assert.equal(attr(course, 'required').expression.getText(parsed), 'regActiveStudent')
  assert.equal(attr(course, 'disabled').expression.getText(parsed), 'loading || !regActiveStudent')
  assert.equal(attr(course, 'name').text, 'reg-study-year')
  assert.match(source, /htmlFor="reg-study-year"/)
  assert.match(source, /\[regStudyYear, setRegStudyYear\] = useState\(''\)/)
  assert.match(declaration('regActiveStudent'), /regAccountType === 'student' && isActiveStudentStatus\(regAcademicStatus\)/)
  const reset = {}
  vm.runInNewContext(compile(`export function make(context:any) { const {setRegAcademicStatus,setRegStudyYear,invalidField,setInvalidField,setError}=context; return ${attr(select('reg-academic-status'), 'onChange').expression.getText(parsed)}; }`), { exports: reset })
  const calls = []
  reset.make({ setRegAcademicStatus: value => calls.push(['status',value]), setRegStudyYear: value => calls.push(['year',value]), invalidField: null, setInvalidField() {}, setError() {} })({ target: { value: 'master' } })
  assert.deepEqual(calls, [['status','master'],['year','']])
})

test('server course-validation errors have a safe course-field message', () => {
  for (const error of [{ code: 'STUDY_YEAR_INVALID' }, { code: '23514', message: 'STUDY_YEAR_INVALID' }]) {
    const failure = helpers.registrationFailure(error)
    assert.equal(failure.field, 'reg-study-year')
    assert.match(failure.message, /від 1 до 6/)
    assert.doesNotMatch(failure.message, /STUDY_YEAR_INVALID/)
  }
})

test('new personal and lookalike addresses stop at the KNU email field before Auth signUp', async () => {
  for (const regEmail of ['new.user@gmail.com', 'student@univ.knu.ua', 'student@knu.ua.example.test']) {
    const fx = fixture({ regEmail })
    await fx.submit()
    assert.deepEqual(fx.events, [['error', policy.KNU_EMAIL_REQUIRED_MESSAGE, 'reg-email']])
    assert.equal(fx.context.submitting.current, false)
    assert.equal(fx.state.setView, undefined)
  }
})

test('a normalized new KNU signup still requires email confirmation and sends no profile mutation yet', async () => {
  const fx = fixture({ regEmail: ' Synthetic@KNU.UA ' })
  await fx.submit()
  const signup = fx.events.find(([kind]) => kind === 'signup')[1]
  assert.equal(signup.email, 'synthetic@knu.ua')
  assert.equal(signup.options.emailRedirectTo, 'https://example.test/auth/callback')
  assert.equal(fx.state.setConfirmationEmail, 'synthetic@knu.ua')
  assert.equal(fx.state.setView, 'confirmation'); assert.equal(fx.state.setRegPassword, '')
  assert.ok(!fx.events.some(([kind]) => kind === 'upsert' || kind === 'refresh' || kind === 'navigate'))
})

test('a personal address still signs in, requests recovery, and resends a legacy confirmation', async () => {
  const fx = fixture()
  await fx.signIn(); await fx.recover(); await fx.resend()
  assert.equal(fx.events.find(([kind]) => kind === 'login')[1].email, 'legacy.user@gmail.com')
  assert.equal(fx.events.find(([kind]) => kind === 'recovery')[1], 'legacy.user@gmail.com')
  assert.equal(fx.events.find(([kind]) => kind === 'resend')[1].email, 'legacy.user@gmail.com')
  assert.equal(fx.events.some(([kind]) => kind === 'error' || kind === 'signup'), false)
})

test('an existing personal Google session can finish its profile without a new signup or password', async () => {
  const email = 'legacy.user@gmail.com'
  const fx = fixture({ googleCompletion: { userId: 'synthetic-user', email, name: 'Synthetic Student' }, regEmail: email, regPassword: '' })
  await fx.submit()
  const completed = fx.events.find(([kind]) => kind === 'google-complete')
  assert.ok(completed)
  assert.equal(completed[1].expected_user_id, 'synthetic-user')
  assert.ok(!Object.hasOwn(completed[1], 'email') && !Object.hasOwn(completed[1], 'password'))
  assert.deepEqual(completed.slice(2), ['policy-current', 'consent-current'])
  assert.deepEqual(fx.events.map(([kind]) => kind), ['auth-user', 'google-complete', 'refresh', 'toast', 'completed'])
})

test('a server KNU signup rejection focuses the email field and does not disclose the raw hook message', async () => {
  const fx = fixture()
  fx.context.supabase.auth.signUp = async () => ({ data: null, error: { code: 'validation_failed', message: 'KNU_EMAIL_REQUIRED provider detail private@example.test', status: 400 } })
  await fx.submit()
  assert.deepEqual(fx.events, [['error', policy.KNU_EMAIL_REQUIRED_MESSAGE, 'reg-email']])
  assert.equal(fx.state.setView, undefined)
})
