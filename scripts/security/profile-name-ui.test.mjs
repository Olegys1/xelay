import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
function evaluate(source, context = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
    { module, exports: module.exports, ...context })
  return module.exports
}
const names = evaluate(await read('src/lib/profileNames.ts'))
const profileText = evaluate(await read('src/lib/profileText.ts'))
function handler(source, name, context) {
  const parsed = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX)
  let found
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(parsed) === name) found = node.initializer.getText(parsed); ts.forEachChild(node, visit) }
  visit(parsed); assert.ok(found, name)
  return evaluate(`module.exports = ${found}`, context)
}
const profileSource = await read('src/components/ProfileSettingsModal.tsx')
const authSource = await read('src/components/AuthModal.tsx')
const plain = value => JSON.parse(JSON.stringify(value))
const noop = () => {}
function profile(overrides = {}) {
  const result = { payload: null, errors: null, failure: null }
  const chain = { update(value) { result.payload = plain(value); return chain }, eq() { return chain }, select() { return chain }, single: async () => ({ error: null }) }
  const context = {
    ...names, ...profileText, nameChanged: false, hasStructuredName: false, lastName: '', firstName: '',
    saveInFlight: { current: false }, uploadInFlight: { current: false }, saved: false, birthdaySaving: false,
    xelayUser: { id: 'synthetic' }, authUser: { id: 'synthetic' }, alive: { current: true },
    academicDirty: { current: { status: false, course: false, duration: false, automatic: false } },
    academicSnapshot: { current: { academicYear: 2026 } }, currentAcademicYear: () => 2026,
    selectedAcademicUnits: [{ id: 'unit', name: 'Приклад' }], academicUnitId: 'unit', username: 'synthetic',
    academicOptionsLoading: false, academicOptionsError: '', universities: [{ id: 'university' }], universityId: 'university',
    hasStudentProfile: false, preserveExistingSpecialty: true, specialtySelection: { selected: null }, studyYear: '',
    progressionAvailable: false, activeStudent: false, city: '', bio: '', categories: [], skills: '', helpWith: '', wantToLearn: '', avatarUrl: '',
    setError: noop, setFieldErrors(value) { result.errors = plain(value) }, focusField: noop,
    showFailure(value) { result.failure = value }, FIELD_IDS: { lastName: '', firstName: '', username: '', university: '', academicUnit: '' },
    setSaving: noop, setSaved: noop, notify: noop, refreshUser: async () => {},
    closeTimer: { current: null }, latestOnClose: { current: noop }, setTimeout: () => 1,
    console, supabase: { from(name) { assert.equal(name, 'profiles'); return chain } }, ...overrides,
  }
  return { result, run: () => handler(profileSource, 'handleSave', context)({ preventDefault: noop }) }
}

test('unrelated profile edits preserve the legacy display name without guessing or clearing parts', async () => {
  const current = profile(); await current.run()
  assert.ok(current.result.payload)
  for (const name of ['first_name', 'last_name', 'full_name']) assert.equal(name in current.result.payload, false)
})

test('explicit name edits save two normalized parts and surname-first display together', async () => {
  const current = profile({ nameChanged: true, firstName: '  Олена ', lastName: ' Прикладенко  ' }); await current.run()
  assert.equal(current.result.payload.first_name, 'Олена'); assert.equal(current.result.payload.last_name, 'Прикладенко')
  assert.equal(current.result.payload.full_name, 'Прикладенко Олена')
})

test('incomplete or invalid name edits never submit a profile update', async () => {
  for (const changes of [{ nameChanged: true, firstName: 'Олена' }, { nameChanged: true, firstName: 'Олена', lastName: '<script>' }, { hasStructuredName: true }]) {
    const current = profile(changes); await current.run()
    assert.equal(current.result.payload, null); assert.ok(current.result.failure)
  }
})

function registration(mode) {
  const result = { metadata: null, profile: null, google: null }
  const chain = { upsert: async value => { result.profile = plain(value); return { error: null } }, select() { return chain }, eq() { return chain }, maybeSingle: async () => ({ data: { id: 'synthetic', username: 'synthetic' }, error: null }) }
  const context = { ...names, regLastName: ' Прикладенко ', regFirstName: '  Олена ', regPrivacyConsent: true,
    submitting: { current: false }, setError: noop, setLoginSupportReference: noop, setInvalidField: noop, dismiss: noop,
    showError(message) { throw new Error(message) }, normalizeRegistrationUsername: value => value.trim(),
    regUsername: 'synthetic', regCity: '', selectedAcademicUnits: [{ id: 'unit', name: 'Приклад' }], regAcademicUnitId: 'unit',
    academicOptionsLoading: false, academicOptionsError: '', universities: [{ id: 'university' }], regUniversityId: 'university',
    regAccountType: 'student', specialtySelection: { selected: { id: 'specialty', name: 'Приклад' }, loading: false, error: '' },
    academicSpecialtyMatches: () => true, isAcademicStatus: () => true, regAcademicStatus: 'bachelor', regActiveStudent: true, regStudyYear: '1', regCategories: ['science'],
    regDepartment: '', regPosition: '', regPassword: 'synthetic test only', regEmail: 'synthetic@example.invalid', regBio: '',
    googleCompletion: mode === 'google' ? { userId: 'synthetic', email: 'synthetic@example.invalid' } : null,
    pendingRegistration: { current: null }, setLoading: noop, PRIVACY_POLICY_VERSION: 'test', PERSONAL_DATA_CONSENT_VERSION: 'test',
    completeGoogleRegistration: async value => { result.google = plain(value) }, refreshUser: async () => {}, notify: noop,
    navigate: noop, onCompleted: noop, onClose: noop,
    supabase: { from() { return chain }, auth: { getUser: async () => ({ data: { user: { id: 'synthetic' } }, error: null }),
      signUp: async value => { result.metadata = plain(value.options.data); return { data: { user: { id: 'synthetic' }, session: mode === 'session' ? {} : null }, error: null } } } },
    setConfirmationEmail: noop, setEmailNotice: noop, setView: noop, authEmailRedirect: () => 'https://example.invalid/auth/callback', startAuthEmailCooldown: noop, authEmailCooldown: () => 0, setSignupCooldown: noop, setRegPassword: noop,
    registrationUsernameNotice: () => null, registrationFailure(error) { throw error }, console,
  }
  return { result, run: () => handler(authSource, 'handleRegister', context)({ preventDefault: noop }) }
}

test('email confirmation, immediate signup and Google completion preserve explicit name parts', async () => {
  for (const mode of ['confirmation', 'session', 'google']) {
    const current = registration(mode); await current.run()
    const payloads = mode === 'google' ? [current.result.google] : [current.result.metadata, ...(mode === 'session' ? [current.result.profile] : [])]
    for (const payload of payloads) {
      assert.equal(payload.first_name, 'Олена'); assert.equal(payload.last_name, 'Прикладенко'); assert.equal(payload.full_name, 'Прикладенко Олена')
    }
  }
})
