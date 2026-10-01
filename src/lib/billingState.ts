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
