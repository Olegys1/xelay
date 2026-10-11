type LoginFailure = { type: 'confirmation' } | { type: 'error'; message: string }

type ErrorDetails = { code: string; status: number | null; name: string; message: string }

function errorDetails(error: unknown): ErrorDetails {
  const value = error && typeof error === 'object'
    ? error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown }
    : null
  return {
    code: typeof value?.code === 'string' ? value.code : '',
    status: typeof value?.status === 'number' && Number.isInteger(value.status) && value.status >= 0 && value.status <= 599 ? value.status : null,
    name: typeof value?.name === 'string' ? value.name : '',
    message: typeof value?.message === 'string' ? value.message.trim().toLowerCase() : '',
  }
}

// Keep messages, account details and credentials out of the browser diagnostic.
export function loginErrorDiagnostic(error: unknown) {
  const { code, status, name } = errorDetails(error)
  const identifier = (value: string) => /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(value) ? value : null
  return { code: identifier(code), status, name: identifier(name) }
}

export function loginErrorReference(error: unknown): string {
  const { code, status, name } = loginErrorDiagnostic(error)
  return `${code || name || 'unknown_error'}${status !== null ? `/${status}` : ''}`
}

export function loginFailure(error: unknown): LoginFailure {
  const { code, status, name, message } = errorDetails(error)
  // Some SDK paths wrap a browser exception. Inspect one known wrapper only;
  // never follow arbitrary causes or expose the original exception in diagnostics.
  const original = name === 'AuthUnknownError'
    ? errorDetails((error as { originalError?: unknown }).originalError)
    : null
  const browserError = original && [
    'SecurityError', 'QuotaExceededError', 'NS_ERROR_DOM_QUOTA_REACHED',
    'AbortError', 'TimeoutError', 'TypeError', 'AuthRetryableFetchError',
  ].includes(original.name) ? original : { name, message, status }
  if (code === 'email_not_confirmed' || message === 'email not confirmed') {
    return { type: 'confirmation' }
  }
  if (code === 'over_request_rate_limit' || status === 429) {
    return { type: 'error', message: 'Забагато спроб входу. Зачекайте кілька хвилин і спробуйте ще раз.' }
  }
  if (code === 'unexpected_failure' || (status !== null && status >= 500)) {
    return { type: 'error', message: 'Сервіс входу тимчасово недоступний. Спробуйте трохи пізніше. Якщо помилка повторюється, зверніться до підтримки Xelay.' }
  }
  if (code === 'request_timeout' || status === 408 || browserError.name === 'AbortError' || browserError.name === 'TimeoutError'
    || (browserError.name === 'AuthRetryableFetchError' && (browserError.status === 0 || browserError.status === null))
    || ((browserError.name === 'TypeError' || browserError.name === 'AuthRetryableFetchError') && [
      'failed to fetch', 'fetch failed', 'networkerror when attempting to fetch resource.',
      'network request failed', 'load failed',
    ].includes(browserError.message))) {
    return { type: 'error', message: 'Не вдалося з’єднатися з Xelay. Перевірте інтернет-з’єднання та спробуйте ще раз.' }
  }
  if (browserError.name === 'SecurityError' || browserError.name === 'QuotaExceededError' || browserError.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return { type: 'error', message: 'Браузер не зміг зберегти сесію входу. Відкрийте Xelay у звичайній вкладці браузера та перевірте, чи дозволене зберігання даних сайту.' }
  }
  if (code === 'invalid_credentials' || name === 'AuthInvalidCredentialsError'
    || message === 'invalid login credentials' || message === 'invalid credentials') {
    return { type: 'error', message: 'Неправильна електронна пошта або пароль. Перевірте їх або скористайтеся кнопкою «Забули пароль?».' }
  }
  if (code === 'captcha_failed') {
    return { type: 'error', message: 'Не вдалося перевірити безпеку входу. Оновіть сторінку та спробуйте ще раз.' }
  }
  if (code === 'user_banned' || message === 'user is banned') {
    return { type: 'error', message: 'Вхід до цього акаунта тимчасово недоступний. Зверніться до підтримки Xelay.' }
  }
  if (code === 'email_provider_disabled' || code === 'provider_disabled' || code === 'user_sso_managed') {
    return { type: 'error', message: 'Вхід за електронною поштою та паролем зараз недоступний. Зверніться до підтримки Xelay.' }
  }
  return { type: 'error', message: 'Не вдалося завершити вхід. Спробуйте ще раз. Якщо помилка повторюється, зверніться до підтримки Xelay.' }
}
