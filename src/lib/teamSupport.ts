// The merchant's last confirmed single-payment ceiling is 149,999 UAH.
// Changing this ceiling also requires updating the database constraint.
export const SUPPORT_MIN_KOPIYKAS = 100
export const SUPPORT_MAX_KOPIYKAS = 14_999_900
export const SUPPORT_TERMS_VERSION = '2026-10-06.support.1'
export const SUPPORT_ORDER_REFERENCE = /^xelay_support_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export function validSupportAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value)
    && value >= SUPPORT_MIN_KOPIYKAS && value <= SUPPORT_MAX_KOPIYKAS
}

/** Parse decimal input as integer kopiykas, without rounding a user's amount. */
export function parseSupportAmount(value: string): number | null {
  const text = value.trim().replace(',', '.')
  if (!/^\d{1,6}(?:\.\d{1,2})?$/.test(text)) return null
  const [hryvnias, fraction = ''] = text.split('.')
  const amount = Number(hryvnias) * 100 + Number(fraction.padEnd(2, '0'))
  return validSupportAmount(amount) ? amount : null
}

export function formatSupportAmount(kopiykas: number): string {
  return new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2 }).format(kopiykas / 100)
}
