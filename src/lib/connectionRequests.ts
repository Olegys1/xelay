import { supabase } from './supabase'
import { isMissingDatabaseFunction } from './databaseCompatibility'

export interface ConnectionQuota {
  limit: number
  used: number
  remaining: number | null
  unlimited: boolean
  recipientExempt: boolean
  resetsAt: string
}

export async function loadConnectionQuota(recipientId?: string): Promise<ConnectionQuota | null> {
  const { data, error } = await supabase.rpc('xelay_connection_request_status', { p_recipient_id: recipientId ?? null })
  // During an incremental deployment, old servers continue to own authorization.
  if (isMissingDatabaseFunction(error)) return null
  if (error) throw error
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.limit !== 3
    || !Number.isSafeInteger(data.used) || data.used < 0
    || (data.remaining !== null && (!Number.isSafeInteger(data.remaining) || data.remaining < 0 || data.remaining > 3))
    || typeof data.unlimited !== 'boolean' || typeof data.recipient_exempt !== 'boolean'
    || typeof data.resets_at !== 'string' || !Number.isFinite(Date.parse(data.resets_at))) {
    throw new Error('Invalid connection quota')
  }
  return { limit: data.limit, used: data.used, remaining: data.remaining, unlimited: data.unlimited,
    recipientExempt: data.recipient_exempt, resetsAt: data.resets_at }
}

export function connectionRequestError(error: unknown): string {
  const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  if (message.includes('CONNECTION_REQUEST_WEEKLY_LIMIT')) return '3 безкоштовні запити на цей тиждень використано. Нові будуть доступні в понеділок за київським часом. Учасникам вашої навчальної групи можна писати без цього ліміту.'
  if (message.includes('CONNECTION_REQUEST_RATE_LIMIT')) return 'Забагато запитів за короткий час. Зачекайте перед наступною спробою. Після відхилення запит можна повторити через добу.'
  return 'Не вдалося надіслати запит. Спробуйте ще раз.'
}
