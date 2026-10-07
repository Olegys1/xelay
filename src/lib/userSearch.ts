export interface SearchProfile {
  id: string
  username: string
  full_name: string | null
  avatar_url: string | null
  faculty: string | null
  specialty: string | null
  study_year: number | null
  is_premium?: boolean
  emoji_status?: string | null
  status_text?: string | null
}

export interface UserSearchResult {
  profiles: SearchProfile[]
  hasMore: boolean
  limitReached: boolean
  used: number
}

export function normalizeUserSearch(query: string) {
  return query.trim().replace(/^@+/, '').toLocaleLowerCase('uk-UA')
}

export function isValidUserSearch(term: string) {
  return term.length >= 2 && term.length <= 30 && /^[\p{L}\p{N}._-]+$/u.test(term)
}

export function parseUserSearchResult(value: unknown): UserSearchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid search result')
  const data = value as Record<string, unknown>
  if (!Array.isArray(data.profiles) || data.profiles.length > 30
    || !Number.isSafeInteger(data.used) || (data.used as number) < 0
    || ['has_more', 'limit_reached', 'unlimited'].some((key) => data[key] !== undefined && typeof data[key] !== 'boolean')
    || (data.limit !== undefined && data.limit !== 3 && data.limit !== 5)
    || (data.remaining !== undefined && data.remaining !== null
      && (!Number.isSafeInteger(data.remaining) || (data.remaining as number) < 0 || (data.remaining as number) > (data.limit === 3 ? 3 : 5)))
    || data.profiles.some((person) => !isSearchProfile(person))) {
    throw new Error('Invalid search result')
  }
  return {
    profiles: data.profiles as SearchProfile[],
    hasMore: typeof data.has_more === 'boolean' ? data.has_more : data.profiles.length === 30,
    limitReached: data.limit_reached === true,
    used: data.used as number,
  }
}

function isSearchProfile(value: unknown): value is SearchProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const person = value as Record<string, unknown>
  return typeof person.id === 'string' && Boolean(person.id)
    && typeof person.username === 'string' && Boolean(person.username)
    && ['full_name', 'avatar_url', 'faculty', 'specialty'].every((key) => person[key] === null || typeof person[key] === 'string')
    && (person.study_year === null || (Number.isSafeInteger(person.study_year) && (person.study_year as number) > 0))
    && (person.is_premium === undefined || typeof person.is_premium === 'boolean')
    && (person.emoji_status === undefined || person.emoji_status === null || typeof person.emoji_status === 'string')
    && (person.status_text === undefined || person.status_text === null || typeof person.status_text === 'string')
}

export function splitUsernameMatch(username: string, term: string): [string, string, string] {
  const start = username.toLocaleLowerCase('uk-UA').indexOf(term)
  return start < 0 || !term
    ? [username, '', '']
    : [username.slice(0, start), username.slice(start, start + term.length), username.slice(start + term.length)]
}
