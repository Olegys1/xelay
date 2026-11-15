export const KNU_EMAIL_DOMAIN = 'knu.ua'
export const KNU_EMAIL_REQUIRED_MESSAGE = 'Для нового акаунта використайте корпоративну пошту @knu.ua. Якщо акаунт уже є, увійдіть зі своєю звичною поштою.'

/** One exact institutional domain. This is UI validation; Auth enforces it too. */
export function normalizeKnuEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const raw = input.trim()
  if (raw.length > 254 || /[^\x21-\x7e]/.test(raw)) return null
  const email = raw.toLowerCase()
  const parts = email.split('@')
  if (parts.length !== 2 || parts[1] !== KNU_EMAIL_DOMAIN) return null
  const local = parts[0]
  if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local)
    || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null
  return email
}

export function isKnuEmail(input: unknown): boolean {
  return normalizeKnuEmail(input) !== null
}
