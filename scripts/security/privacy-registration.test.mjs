// Run the real client helpers with synthetic SDK responses. No network, mail or accounts.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { AuthApiError, AuthRetryableFetchError } from '@supabase/auth-js'

const root = new URL('../../', import.meta.url)
async function loadModule(path, imports = {}) {
  const source = await readFile(new URL(path, root), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const exports = {}
  vm.runInNewContext(output, {
    exports, Error, URL,
    require(name) {
      assert.ok(Object.hasOwn(imports, name), `Unexpected import ${name}; live imports are forbidden`)
      return imports[name]
    },
  }, { filename: path })
  return exports
}
const legal = await loadModule('src/lib/legal.ts')
const registration = await loadModule('src/lib/authRegistration.ts')
const failure = error => {
  const value = registration.registrationFailure(error)
  assert.equal(value.type, 'error')
  return value
}

test('privacy requirement errors focus explicit consent and preserve their meaning through SDK errors', () => {
  for (const error of [
    new AuthApiError('PRIVACY_CONSENT_REQUIRED', 400, 'validation_failed'),
    { code: 'PRIVACY_CONSENT_REQUIRED', message: 'Different provider message' },
    { message: 'Signup requires valid privacy consent' },
    vm.runInNewContext('new Error("PRIVACY_CONSENT_REQUIRED")'),
    'PRIVACY_CONSENT_REQUIRED',
  ]) {
    const result = failure(error)
    assert.equal(result.field, 'reg-privacy-consent')
    assert.match(result.message, /надати згоду/)
    assert.doesNotMatch(result.message, /PRIVACY_|Different provider message/)
  }
})

test('outdated document errors request a refresh and renewed consent', () => {
  for (const error of [
    new AuthApiError('PRIVACY_VERSION_OUTDATED', 400, 'validation_failed'),
    { code: 'privacy_version_outdated', message: 'Different provider message' },
    { message: 'Trigger rejected: PRIVACY_VERSION_OUTDATED' },
  ]) {
    const result = failure(error)
    assert.equal(result.field, 'reg-privacy-consent')
    assert.match(result.message, /Оновіть сторінку/)
    assert.match(result.message, /актуальні документи/)
    assert.match(result.message, /знову надайте згоду/)
  }
})

test('opaque Auth server failures retain a safe refresh hint without claiming a specific consent failure', () => {
  for (const error of [
    new AuthApiError('Database error saving new user', 500, 'unexpected_failure'),
    new AuthRetryableFetchError('Service unavailable', 503),
    { code: 'unexpected_failure', status: 400, message: 'Private server details' },
    { status: 502, message: 'Internal private detail' },
  ]) {
    const result = failure(error)
    assert.equal(result.field, undefined)
    assert.match(result.message, /Оновіть сторінку/)
    assert.match(result.message, /підтримки/)
    assert.doesNotMatch(result.message, /Private|private|Database error|PRIVACY_|Ви не надали/)
  }
})

test('password, existing-account, email, rate and network registration errors retain their original flows', () => {
  assert.equal(failure(new AuthApiError('Weak password', 422, 'weak_password')).field, 'reg-password')
  assert.match(failure(new AuthApiError('Weak password', 422, 'weak_password')).message, /довший та унікальний пароль/)
  assert.equal(failure(new AuthApiError('Invalid email', 400, 'email_address_invalid')).field, 'reg-email')
  for (const error of [
    new AuthApiError('User already registered', 422, 'user_already_exists'),
    { code: 'email_exists' }, { message: 'User already registered' },
  ]) assert.equal(registration.registrationFailure(error).type, 'existing-account')
  for (const error of [
    new AuthRetryableFetchError('Network unavailable', 0),
    new TypeError('Failed to fetch'), { name: 'AbortError' }, { status: 408 },
  ]) assert.match(failure(error).message, /Не вдалося з’єднатися/)
  assert.match(failure({ code: 'over_email_send_rate_limit', status: 429 }).message, /Листи надсилаються надто часто/)
  assert.match(failure({ code: 'over_request_rate_limit', status: 429 }).message, /Забагато спроб реєстрації/)
  assert.equal(registration.registrationPrivacyFailure({ code: 'weak_password' }), null)
  assert.equal(registration.registrationPrivacyFailure(new TypeError('Failed to fetch')), null)
})

const companyInput = {
  fullName: ' Synthetic Company Person ', companyName: ' Synthetic Company ', email: ' Company.Person@Example.Test ',
  password: 'SYNTHETIC-TEST-NOT-A-REAL-SECRET', consent: true, privacyConsent: true,
}
async function companyFixture(response = { data: { session: null }, error: null }) {
  const calls = []
  const repository = await loadModule('src/lib/opportunities/supabaseRepository.ts', {
    '../supabase': { supabase: { auth: { signUp: async input => { calls.push(input); return response } } } },
    '../authEmail': { authEmailRedirect: path => 'https://example.test' + path },
    '../authRegistration': registration,
    '../legal': legal,
  })
  return { calls, register: repository.registerOpportunityCompanyAccount }
}

test('company signup without explicit privacy consent never calls Auth despite accepted company terms', async () => {
  const fx = await companyFixture()
  for (const privacyConsent of [false, undefined, null, 'true', 1]) {
    await assert.rejects(fx.register({ ...companyInput, privacyConsent }), /окрему згоду на обробку персональних даних/)
  }
  assert.equal(fx.calls.length, 0)
})

test('company signup without company terms never calls Auth despite explicit privacy consent', async () => {
  const fx = await companyFixture()
  for (const consent of [false, undefined, null]) {
    await assert.rejects(fx.register({ ...companyInput, consent }), /Підтвердьте умови реєстрації/)
  }
  assert.equal(fx.calls.length, 0)
})

test('company signup sends both exact versioned consent fields with no client acceptance time', async () => {
  const fx = await companyFixture()
  const result = await fx.register(companyInput)
  assert.equal(result.confirmationRequired, true)
  assert.equal(result.email, 'company.person@example.test')
  assert.equal(fx.calls.length, 1)
  const sent = fx.calls[0]
  assert.equal(sent.email, 'company.person@example.test')
  assert.equal(sent.options.emailRedirectTo, 'https://example.test/auth/callback')
  assert.deepEqual(JSON.parse(JSON.stringify(sent.options.data)), {
    registration_kind: 'company', xelay_registration_version: 'company-1',
    full_name: 'Synthetic Company Person', company_name: 'Synthetic Company', company_terms_version: 'opportunities-v1',
    xelay_privacy_consent: true,
    xelay_privacy_policy_version: legal.PRIVACY_POLICY_VERSION,
    xelay_privacy_consent_version: legal.PERSONAL_DATA_CONSENT_VERSION,
  })
  for (const key of Object.keys(sent.options.data)) assert.doesNotMatch(key, /accepted_at|timestamp|consent_date/)
  assert.ok(!Object.hasOwn(sent.options.data, 'email'))
  assert.ok(!Object.hasOwn(sent.options.data, 'password'))
})

test('company signup maps named privacy errors without leaking raw errors', async () => {
  for (const [message, expected] of [
    ['PRIVACY_CONSENT_REQUIRED', /надати згоду/],
    ['PRIVACY_VERSION_OUTDATED', /Оновіть сторінку/],
  ]) {
    const fx = await companyFixture({ data: null, error: new AuthApiError(message, 400, 'validation_failed') })
    await assert.rejects(fx.register(companyInput), error => expected.test(error.message) && !/PRIVACY_/.test(error.message))
    assert.equal(fx.calls.length, 1)
  }
})

test('student and teacher forms start unchecked, block unchecked submit and send current versions', async () => {
  const source = await readFile(new URL('src/components/AuthModal.tsx', root), 'utf8')
  assert.match(source, /\[studentPrivacyConsent, setStudentPrivacyConsent\] = useState\(false\)/)
  assert.match(source, /\[teacherPrivacyConsent, setTeacherPrivacyConsent\] = useState\(false\)/)
  assert.match(source, /if \(!regPrivacyConsent\)[^\n]*return/)
  assert.ok(source.indexOf('if (!regPrivacyConsent)') < source.indexOf('await supabase.auth.signUp('))
  assert.match(source, /xelay_privacy_consent: true/)
  assert.match(source, /xelay_privacy_policy_version: PRIVACY_POLICY_VERSION/)
  assert.match(source, /xelay_privacy_consent_version: PERSONAL_DATA_CONSENT_VERSION/)
  assert.doesNotMatch(source, /xelay_privacy_accepted_at\s*:/)
  const checkbox = await readFile(new URL('src/components/PrivacyConsent.tsx', root), 'utf8')
  assert.match(checkbox, /type="checkbox"[\s\S]*?required[\s\S]*?checked=\{checked\}/)
  for (const path of ['privacy-policy', 'personal-data-consent']) assert.ok(checkbox.includes(`href="/${path}" target="_blank" rel="noopener noreferrer"`))
})
