import { normalizeTelegramUsername } from './telegram'

export type TeacherVerificationContactKind = 'telegram' | 'phone'
export interface TeacherVerificationContact { kind: TeacherVerificationContactKind; value: string }
export interface TeacherVerificationContactSnapshot { contact_telegram?: string | null; contact_phone?: string | null }

export function normalizeTeacherVerificationContact(contact?: TeacherVerificationContact): TeacherVerificationContact | null {
  if (!contact || !['telegram', 'phone'].includes(contact.kind) || typeof contact.value !== 'string') return null
  const value = contact.value.trim()
  if (!value || /[\u0000-\u001f\u007f]/.test(contact.value)) return null
  if (contact.kind === 'telegram') {
    const username = normalizeTelegramUsername(value)
    return username && username.length >= 5 ? { kind: 'telegram', value: username } : null
  }
  const digits = value.replace(/\D/g, '').length
  return /^\+?[\d ().-]{7,40}$/.test(value) && digits >= 7 && digits <= 15 ? { kind: 'phone', value } : null
}

export function savedTeacherVerificationContact(request?: TeacherVerificationContactSnapshot | null): TeacherVerificationContact {
  if (request?.contact_telegram?.trim()) return { kind: 'telegram', value: request.contact_telegram.trim() }
  if (request?.contact_phone?.trim()) return { kind: 'phone', value: request.contact_phone.trim() }
  return { kind: 'telegram', value: '' }
}
