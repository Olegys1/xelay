// Actual registration callbacks with synthetic SDK responses. No mail, accounts or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import * as names from '../../src/lib/profileNames.ts'
import { isKnuEmail, KNU_EMAIL_MESSAGE } from '../../src/lib/academicEmail.ts'

const root = new URL('../../', import.meta.url)
const source = await readFile(new URL('src/components/AuthModal.tsx', root), 'utf8')
const parsed = ts.createSourceFile('AuthModal.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
const component = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AuthModal')
const declaration = name => component.body.statements.filter(ts.isVariableStatement)
  .flatMap(node => [...node.declarationList.declarations]).find(node => node.name.getText(parsed) === name).initializer.getText(parsed)
const compile = code => ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const dependencies = ['submitting','setError','setLoginSupportReference','setInvalidField','dismiss','regPrivacyConsent','showError',
  'normalizeNamePart','composeProfileName','isValidProfileNamePart','PROFILE_NAME_MAX_LENGTH','regLastName','regFirstName',
  'isKnuEmail','KNU_EMAIL_MESSAGE','googleCompletion','completeGoogleRegistration','onCompleted',
  'academicDepartmentMatches','academicDepartmentsForScope','regTeacherProfile','validateTeacherAcademicProfile',
  'stagePendingTeacherAcademicProfile','supabaseTeacherAcademicRepository','TEACHER_APPLICATION_NEXT_STEP',
  'regName','normalizeRegistrationUsername','regUsername','regCountry','regCity','selectedAcademicUnits','regAcademicUnitId',
  'academicOptionsLoading','academicOptionsError','universities','regUniversityId','regAccountType','specialtySelection',
  'academicSpecialtyMatches','isAcademicStatus','regAcademicStatus','regActiveStudent','regStudyYear','regCategories',
  'regDepartment','regPosition','regPassword','setLoading','regEmail','pendingRegistration','supabase','authEmailRedirect',
  'PRIVACY_POLICY_VERSION','PERSONAL_DATA_CONSENT_VERSION','regBio','setConfirmationEmail','setEmailNotice','setView',
  'startAuthEmailCooldown','setSignupCooldown','authEmailCooldown','setRegPassword','notify','refreshUser',
  'registrationUsernameNotice','navigate','onClose','registrationFailure']
const callbacks = {}
vm.runInNewContext(compile(`export function make(context:any) { const {${dependencies.join(',')}}=context; return ${declaration('handleRegister')}; }`), { exports: callbacks })
const helpers = {}
vm.runInNewContext(compile(await readFile(new URL('src/lib/authRegistration.ts', root), 'utf8')), { exports: helpers })

function fixture(overrides = {}, withSession = false) {
  const events = [], state = {}
  const account = { id: 'synthetic-user', email: 'synthetic@knu.ua', user_metadata: {} }
  const context = {
    submitting: { current: false }, pendingRegistration: { current: null },
    regPrivacyConsent: true, regName: ' Synthetic Student ', regUsername: 'student', regCountry: 'Україна', regCity: 'Київ',
    ...names, isKnuEmail, KNU_EMAIL_MESSAGE, regLastName:'Student',regFirstName:'Synthetic',googleCompletion:undefined,onCompleted:undefined,
    academicDepartmentMatches:()=>true,academicDepartmentsForScope:()=>[],regTeacherProfile:{},validateTeacherAcademicProfile:()=>null,
    stagePendingTeacherAcademicProfile:()=>true,supabaseTeacherAcademicRepository:{save:async()=>{}},TEACHER_APPLICATION_NEXT_STEP:'Подайте заявку.',
    completeGoogleRegistration:async()=>events.push(['complete-google']),
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
    authEmailCooldown: () => 60, startAuthEmailCooldown: value => events.push(['cooldown', value]),
    dismiss() {}, notify: value => events.push(['toast', value]),
    showError: (message, field) => events.push(['error', message, field]),
    refreshUser: async () => events.push(['refresh']), navigate: value => events.push(['navigate', value]),
    onClose: () => events.push(['close']),
    supabase: {
      auth: { getUser:async()=>({data:{user:account},error:null}),signUp: async input => { events.push(['signup', input]); return { data: { user: account, session: withSession ? { user: account } : null }, error: null } } },
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
  for (const setter of ['setError','setLoginSupportReference','setInvalidField','setLoading','setConfirmationEmail','setEmailNotice','setView','setSignupCooldown','setRegPassword']) context[setter] = value => { state[setter] = value }
  return { context, events, state, submit: () => callbacks.make(context)({ preventDefault() {} }) }
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

test('new educational signup rejects a non-KNU address before Auth, while an existing Google identity can complete its profile', async () => {
  const blocked=fixture({regEmail:'personal@example.test'})
  await blocked.submit()
  assert.equal(blocked.events.find(([kind])=>kind==='error')[2],'reg-email')
  assert.equal(blocked.events.some(([kind])=>kind==='signup'),false)
  const legacy=fixture({googleCompletion:{userId:'synthetic-user',email:'old@example.test'},regEmail:'old@example.test'})
  await legacy.submit()
  assert.equal(legacy.events.some(([kind])=>kind==='complete-google'),true)
  assert.equal(legacy.events.some(([kind])=>kind==='signup'),false)
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
