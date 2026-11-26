export const KNU_EMAIL_MESSAGE = 'Для нового навчального акаунта потрібна пошта @knu.ua.'

export function isKnuEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^\s@\x00-\x1f\x7f]{1,64}@knu\.ua$/i.test(value.trim())
}

export function academicEmailChangeError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  if (code === 'email_exists' || code === 'user_already_exists') return 'Ця адреса вже пов’язана з іншим акаунтом. Зверніться до підтримки, щоб перевірити обидва профілі.'
  if (code.includes('rate_limit')) return 'Листи надсилаються надто часто. Зачекайте кілька хвилин.'
  return 'Не вдалося надіслати підтвердження. Перевірте з’єднання й повторіть спробу.'
}
