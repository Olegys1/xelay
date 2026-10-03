export interface ParticipantStatus {
  isPremium: boolean
  expiresAt: string | null
  emojiStatus: string | null
  textStatus: string | null
  searchUsed: number
  searchRemaining: number
  searchUnlimited: boolean
}

export const EMPTY_PARTICIPANT_STATUS: ParticipantStatus = {
  isPremium: false, expiresAt: null, emojiStatus: null, textStatus: null,
  searchUsed: 0, searchRemaining: 5, searchUnlimited: false,
}

export function currentParticipantStatus(status: ParticipantStatus, now = Date.now()): ParticipantStatus {
  if (status.isPremium && status.expiresAt && Date.parse(status.expiresAt) > now) return status
  return {
    ...status, isPremium: false, emojiStatus: null, textStatus: null, searchUnlimited: false,
    searchRemaining: Math.max(0, 5 - status.searchUsed),
  }
}

export function parseParticipantStatus(value: unknown, now = Date.now()): ParticipantStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid billing status')
  const data = value as Record<string, unknown>
  if (typeof data.is_premium !== 'boolean' || typeof data.search_unlimited !== 'boolean'
    || data.search_limit !== 5 || typeof data.search_used !== 'number'
    || !Number.isSafeInteger(data.search_used) || data.search_used < 0
    || (data.emoji_status !== null && typeof data.emoji_status !== 'string')
    || (data.status_text !== undefined && data.status_text !== null && typeof data.status_text !== 'string')) {
    throw new Error('Invalid billing status')
  }
  const expiresAt = typeof data.expires_at === 'string' ? data.expires_at : null
  if (data.is_premium && (!expiresAt || !Number.isFinite(Date.parse(expiresAt)))) {
    throw new Error('Invalid subscription expiry')
  }
  const isPremium = data.is_premium && Boolean(expiresAt && Date.parse(expiresAt) > now)
  return {
    isPremium, expiresAt,
    emojiStatus: isPremium && typeof data.emoji_status === 'string' ? data.emoji_status : null,
    textStatus: isPremium && typeof data.status_text === 'string' ? data.status_text : null,
    searchUsed: data.search_used,
    searchRemaining: isPremium ? 0 : Math.max(0, 5 - data.search_used),
    searchUnlimited: isPremium && data.search_unlimited,
  }
}

export interface GroupBillingStatus {
  is_active: boolean
  source: 'free' | 'payment' | 'admin_grant' | 'trial' | null
  can_edit: boolean
  payment_required: boolean
  enforcement_enabled: boolean
  expires_at: string | null
  is_lifetime: boolean
  can_renew: boolean
  trial_started_at: string | null
  trial_expires_at: string | null
  trial_active: boolean
  trial_expired: boolean
  can_participate: boolean
  trial_used: boolean
  server_now: string | null
  remaining_seconds: number | null
}

/** Group access is granted by the server; client time can only restrict it. */
export function parseGroupBillingStatus(value: unknown): GroupBillingStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid group billing status')
  const data = value as Record<string, unknown>
  if (['is_active', 'can_edit', 'payment_required', 'enforcement_enabled'].some((key) => typeof data[key] !== 'boolean')
    || ![null, 'free', 'payment', 'admin_grant', 'trial'].includes(data.source as string | null)) {
    throw new Error('Invalid group billing status')
  }
  const date = (key: string): string | null => {
    const field = data[key]
    if (field === undefined || field === null) return null
    if (typeof field !== 'string' || !Number.isFinite(Date.parse(field))) throw new Error('Invalid group access expiry')
    return field
  }
  const bool = (key: string, fallback: boolean): boolean => {
    if (data[key] === undefined) return fallback
    if (typeof data[key] !== 'boolean') throw new Error('Invalid group billing status')
    return data[key]
  }
  const expiresAt = date('expires_at')
  const trialStartedAt = date('trial_started_at')
  const trialExpiresAt = date('trial_expires_at')
  const isLifetime = bool('is_lifetime', data.source === 'free' || data.source === 'admin_grant')
  const trialActive = bool('trial_active', data.source === 'trial' && data.is_active === true)
  const remainingSeconds = data.remaining_seconds === undefined || data.remaining_seconds === null ? null : data.remaining_seconds
  if (remainingSeconds !== null && (typeof remainingSeconds !== 'number' || !Number.isSafeInteger(remainingSeconds) || remainingSeconds < 0)) throw new Error('Invalid group access duration')
  if (Boolean(trialStartedAt) !== Boolean(trialExpiresAt)
    || (trialStartedAt && trialExpiresAt && Date.parse(trialExpiresAt) <= Date.parse(trialStartedAt))) throw new Error('Invalid group trial period')
  if (data.is_active && !isLifetime && !expiresAt) throw new Error('Invalid group access expiry')
  if (trialActive && (!trialStartedAt || !trialExpiresAt || data.source !== 'trial'
    || Date.parse(trialExpiresAt) <= Date.parse(trialStartedAt))) throw new Error('Invalid group trial period')
  return {
    is_active: data.is_active as boolean, source: data.source as GroupBillingStatus['source'],
    can_edit: data.can_edit as boolean, payment_required: data.payment_required as boolean,
    enforcement_enabled: data.enforcement_enabled as boolean, expires_at: expiresAt,
    is_lifetime: isLifetime, can_renew: bool('can_renew', false),
    trial_started_at: trialStartedAt, trial_expires_at: trialExpiresAt,
    trial_active: trialActive, trial_expired: bool('trial_expired', false),
    can_participate: bool('can_participate', data.is_active === true || data.enforcement_enabled === false),
    trial_used: bool('trial_used', Boolean(trialStartedAt)), server_now: date('server_now'),
    remaining_seconds: remainingSeconds as number | null,
  }
}

export function groupContentAccess(status: GroupBillingStatus, now = Date.now()): boolean {
  if (!status.can_participate) return false
  if (!status.enforcement_enabled) return true
  return status.is_active && (status.is_lifetime || Boolean(status.expires_at && Date.parse(status.expires_at) > now))
}
