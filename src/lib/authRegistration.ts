export const REGISTRATION_USERNAME_NOTE = 'Якщо нік зайнятий, ми створимо унікальний. Його можна змінити в налаштуваннях профілю.'

export function normalizeRegistrationUsername(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA') : ''
}

export function registrationUsernameNotice(
  user: { id: string; user_metadata?: Record<string, unknown> } | null,
  profile: { id: string; username?: string | null } | null,
): string | null {
  if (!user || !profile || user.id !== profile.id || String(user.user_metadata?.xelay_registration_version) !== '1') return null
  const requested = normalizeRegistrationUsername(user.user_metadata?.username)
  const canonical = normalizeRegistrationUsername(profile.username)
  if (!requested || !canonical || requested === canonical) return null
  return `Для профілю створено нік @${profile.username}. Його можна змінити в налаштуваннях профілю.`
}

type RegistrationFailure = { type: 'existing-account' } | { type: 'error'; message: string; field?: string }

export function registrationPrivacyFailure(error: unknown): { type: 'error'; message: string; field: string } | null {
  const value = error && typeof error === 'object' ? error as { code?: unknown; message?: unknown } : null
  const code = typeof value?.code === 'string' ? value.code.toUpperCase() : ''
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : typeof error === 'string' ? error.toLowerCase() : ''
  if (code === 'PRIVACY_VERSION_OUTDATED' || message.includes('privacy_version_outdated')) {
    return { type: 'error', message: 'Документи про обробку даних оновлено. Оновіть сторінку, перегляньте актуальні документи та знову надайте згоду.', field: 'reg-privacy-consent' }
  }
  if (code === 'PRIVACY_CONSENT_REQUIRED' || message.includes('privacy_consent_required') || message.includes('signup requires valid')) {
    return { type: 'error', message: 'Для реєстрації потрібно ознайомитися з документами та надати згоду на обробку персональних даних.', field: 'reg-privacy-consent' }
  }
  return null
}

export function registrationFailure(error: unknown): RegistrationFailure {
  const privacyFailure = registrationPrivacyFailure(error)
  if (privacyFailure) return privacyFailure
  const value = error && typeof error === 'object' ? error as { code?: unknown; status?: unknown; name?: unknown; message?: unknown } : null
  const code = typeof value?.code === 'string' ? value.code : ''
  const status = typeof value?.status === 'number' ? value.status : undefined
  const name = typeof value?.name === 'string' ? value.name : ''
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : ''

  if (code === 'over_email_send_rate_limit') {
    return { type: 'error', message: 'Листи надсилаються надто часто. Зачекайте кілька хвилин і спробуйте ще раз.' }
  }
  if (code === 'over_request_rate_limit' || status === 429) {
    return { type: 'error', message: 'Забагато спроб реєстрації. Зачекайте кілька хвилин і спробуйте ще раз.' }
  }
  if (code === 'weak_password') {
    return { type: 'error', message: 'Цей пароль не відповідає вимогам безпеки. Спробуйте довший та унікальний пароль.', field: 'reg-password' }
  }
  if (code === 'email_address_invalid') {
    return { type: 'error', message: 'Перевірте адресу електронної пошти.', field: 'reg-email' }
  }
  if (code === 'request_timeout' || status === 408 || name === 'AbortError'
    || (name === 'AuthRetryableFetchError' && status === 0)
    || (name === 'TypeError' && /failed to fetch|fetch failed|networkerror|network request failed|load failed/.test(message))) {
    return { type: 'error', message: 'Не вдалося з’єднатися з Xelay. Перевірте з’єднання та спробуйте ще раз.' }
  }
  if (message.includes('profiles_username_lower_unique')) {
    return { type: 'error', message: 'Такий нік уже зайнятий. Спробуйте інший.', field: 'reg-username' }
  }
  if (code === 'user_already_exists' || code === 'email_exists'
    || message === 'user already registered' || message === 'user already exists') {
    return { type: 'existing-account' }
  }
  if (message === 'registration session changed') {
    return { type: 'error', message: 'Сесію реєстрації змінено. Увійдіть до створеного акаунта й повторіть спробу.' }
  }
  if (code === 'unexpected_failure' || status !== undefined && status >= 500) {
    return { type: 'error', message: 'Сервер не зміг завершити реєстрацію. Оновіть сторінку, перегляньте актуальні документи та спробуйте ще раз. Якщо помилка повториться, зверніться до підтримки.' }
  }
  return { type: 'error', message: 'Не вдалося створити обліковий запис. Спробуйте ще раз.' }
}
