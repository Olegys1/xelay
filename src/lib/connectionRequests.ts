import { supabase } from './supabase'
import { isMissingDatabaseFunction } from './databaseCompatibility'

export interface ConnectionQuota {
  limit: number | null
  used: number
  remaining: number | null
  unlimited: boolean
  recipientExempt: boolean
  resetsAt: string | null
}

export async function loadConnectionQuota(recipientId?: string): Promise<ConnectionQuota | null> {
  const { data, error } = await supabase.rpc('xelay_connection_request_status', { p_recipient_id: recipientId ?? null })
  // During an incremental deployment, old servers continue to own authorization.
  if (isMissingDatabaseFunction(error)) return null
  if (error) throw error
  if (!data || typeof data !== 'object' || Array.isArray(data) || (data.limit !== null && data.limit !== 3)
    || (data.limit === null && data.unlimited !== true)
    || !Number.isSafeInteger(data.used) || data.used < 0
    || (data.remaining !== null && (!Number.isSafeInteger(data.remaining) || data.remaining < 0 || data.remaining > 3))
    || typeof data.unlimited !== 'boolean' || typeof data.recipient_exempt !== 'boolean'
    || (data.resets_at !== null && (typeof data.resets_at !== 'string' || !Number.isFinite(Date.parse(data.resets_at))))) {
    throw new Error('Invalid connection quota')
  }
  return { limit: data.unlimited ? null : data.limit, used: data.used, remaining: data.unlimited ? null : data.remaining, unlimited: data.unlimited,
    recipientExempt: data.recipient_exempt, resetsAt: data.unlimited ? null : data.resets_at }
}

export function connectionRequestError(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  if (message.includes('CONNECTION_REQUEST_WEEKLY_LIMIT')) return 'Надсилання запитів тимчасово недоступне. Оновіть сторінку або спробуйте пізніше.'
  if (message.includes('CONNECTION_REQUEST_RATE_LIMIT')) return 'Забагато запитів за короткий час. Зачекайте перед наступною спробою. Після відхилення запит можна повторити через добу.'
  return 'Не вдалося надіслати запит. Спробуйте ще раз.'
}
