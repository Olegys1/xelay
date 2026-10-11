// Execute the real login helper using SDK error objects; no network or accounts.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
import { AuthApiError, AuthRetryableFetchError, AuthUnknownError } from '@supabase/auth-js'

const source = await readFile(new URL('../../src/lib/authLogin.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { loginFailure, loginErrorDiagnostic, loginErrorReference } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

function failureMessage(error) {
  const result = loginFailure(error)
  assert.equal(result.type, 'error')
  assert.equal(typeof result.message, 'string')
  return result.message
}

test('real SDK and plain cross-realm confirmation errors preserve the confirmation flow', () => {
  for (const error of [
    new AuthApiError('Email not confirmed', 400, 'email_not_confirmed'),
    { code: 'email_not_confirmed', message: 'Different server wording', status: 400 },
    vm.runInNewContext('new Error("Email not confirmed")'),
  ]) assert.deepEqual(loginFailure(error), { type: 'confirmation' })
})

test('invalid credentials remain generic and offer password recovery without account enumeration', () => {
  for (const error of [
    new AuthApiError('Invalid login credentials', 400, 'invalid_credentials'),
    { code: 'invalid_credentials', status: 400 },
    vm.runInNewContext('new Error("Invalid login credentials")'),
  ]) {
    const message = failureMessage(error)
    assert.match(message, /Неправильна електронна пошта або пароль/)
    assert.match(message, /Забули пароль/)
    assert.doesNotMatch(message, /акаунт не існує|не зареєстровано/)
  }
})

test('rate limits explain waiting instead of blaming credentials', () => {
  for (const error of [
    new AuthApiError('Too many requests', 429, 'over_request_rate_limit'),
    { status: 429, message: 'Invalid request frequency' },
  ]) {
    const message = failureMessage(error)
    assert.match(message, /Забагато спроб входу/)
    assert.match(message, /Зачекайте/)
    assert.doesNotMatch(message, /Неправильна|Перевірте дані/)
  }
})

test('real API and retryable service errors show service unavailability', () => {
  for (const error of [
    new AuthApiError('Database error querying schema', 500, 'unexpected_failure'),
    new AuthRetryableFetchError('Service temporarily unavailable', 503),
    { code: 'unexpected_failure', status: 400, message: 'Invalid backend state' },
    { status: 502, message: 'Bad gateway' },
  ]) {
    const message = failureMessage(error)
    assert.match(message, /Сервіс входу тимчасово недоступний/)
    assert.doesNotMatch(message, /Неправильна|Перевірте дані/)
  }
})

test('Safari, SDK fetch and cross-realm failures describe a connection problem', () => {
  for (const error of [
    new TypeError('Load failed'),
    new TypeError('Failed to fetch'),
    new AuthRetryableFetchError('Load failed', 0),
    vm.runInNewContext('new TypeError("Load failed")'),
    new AuthUnknownError('Initialization failed', new TypeError('Load failed')),
    { name: 'TypeError', message: 'NetworkError when attempting to fetch resource.' },
  ]) assert.match(failureMessage(error), /Не вдалося з’єднатися з Xelay/)
})

test('timeouts and aborts describe connection problems', () => {
  for (const error of [
    { code: 'request_timeout', status: 400 },
    { status: 408 },
    new DOMException('Request aborted', 'AbortError'),
    new DOMException('Timed out', 'TimeoutError'),
  ]) assert.match(failureMessage(error), /Не вдалося з’єднатися з Xelay/)
})

test('direct and SDK-wrapped storage exceptions explain session persistence', () => {
  for (const name of ['SecurityError', 'QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED']) {
    const error = new DOMException('Private browser storage detail', name)
    assert.match(failureMessage(error), /Браузер не зміг зберегти сесію входу/)
    assert.match(failureMessage(new AuthUnknownError('Auth failed', error)), /Браузер не зміг зберегти сесію входу/)
  }
})

test('only one known SDK wrapper is inspected and diagnostic stays on the outer error', () => {
  const nested = new AuthUnknownError('Outer', new AuthUnknownError('Inner', new DOMException('Storage private', 'SecurityError')))
  assert.match(failureMessage(nested), /Не вдалося завершити вхід/)
  assert.match(failureMessage({ name: 'Error', originalError: new DOMException('Private', 'SecurityError') }), /Не вдалося завершити вхід/)
  const wrapped = new AuthUnknownError('Contains private details', new DOMException('Private', 'SecurityError'))
  assert.deepEqual(loginErrorDiagnostic(wrapped), { code: null, status: null, name: 'AuthUnknownError' })
})

test('specific unsupported or security cases give safe guidance', () => {
  assert.match(failureMessage(new AuthApiError('Captcha verification failed', 400, 'captcha_failed')), /перевірити безпеку входу/)
  assert.match(failureMessage(new AuthApiError('User is banned', 403, 'user_banned')), /тимчасово недоступний/)
  for (const code of ['email_provider_disabled', 'provider_disabled', 'user_sso_managed']) {
    assert.match(failureMessage(new AuthApiError('Provider detail', 400, code)), /Вхід за електронною поштою та паролем зараз недоступний/)
  }
})

test('unknown errors and unrelated invalid wording do not become credential failures', () => {
  for (const error of [null, undefined, 'Private string', {}, new Error('Invalid backend callback'), new AuthApiError('Invalid API key', 401, 'unknown_code')]) {
    const message = failureMessage(error)
    assert.match(message, /Не вдалося завершити вхід/)
    assert.doesNotMatch(message, /Неправильна|Invalid|Private/)
  }
})

test('diagnostic contains only sanitized code, status and name, never sensitive error data', () => {
  const secret = 'example-secret-token'
  const email = 'private@example.test'
  const error = {
    code: 'unexpected_failure', status: 500, name: 'AuthApiError',
    message: `${email} ${secret}`, email, password: secret, access_token: secret,
    originalError: { name: 'SecurityError', message: secret },
  }
  assert.deepEqual(loginErrorDiagnostic(error), { code: 'unexpected_failure', status: 500, name: 'AuthApiError' })
  const serialized = JSON.stringify(loginErrorDiagnostic(error))
  assert.doesNotMatch(serialized, /private@|secret|message|password|token|originalError/)
  assert.deepEqual(loginErrorDiagnostic({ code: email, name: `Error\n${secret}`, status: NaN }), { code: null, status: null, name: null })
  for (const status of [-1, 600, 200.5, '500', Infinity]) assert.equal(loginErrorDiagnostic({ status }).status, null)
})

test('phone-visible support reference uses sanitized identifiers and status only', () => {
  assert.equal(loginErrorReference(new AuthApiError('Private details', 500, 'unexpected_failure')), 'unexpected_failure/500')
  assert.equal(loginErrorReference(new AuthRetryableFetchError('Private details', 0)), 'AuthRetryableFetchError/0')
  assert.equal(loginErrorReference(new TypeError('Load failed')), 'TypeError')
  assert.equal(loginErrorReference(new AuthUnknownError('Private details', new DOMException('Private details', 'SecurityError'))), 'AuthUnknownError')
  assert.equal(loginErrorReference({ code: 'private@example.test', name: 'Private\nsecret-token', status: 429, message: 'secret-token' }), 'unknown_error/429')
  assert.equal(loginErrorReference(null), 'unknown_error')
})
