const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export function isPostgrestUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value)
}

function quoteFilterValue(value: string) {
  return '"' + value.replace(/["\\]/g, '\\$&') + '"'
}

export function conversationMemberFilter(userId: string) {
  if (!isPostgrestUuid(userId)) throw new Error('Invalid conversation member ID')
  return `user_one_id.eq.${userId},user_two_id.eq.${userId}`
}

export function olderRowsFilter(createdAt: string, id: string) {
  if (!TIMESTAMP.test(createdAt) || !isPostgrestUuid(id)) throw new Error('Invalid pagination cursor')
  const timestamp = quoteFilterValue(createdAt)
  return `created_at.lt.${timestamp},and(created_at.eq.${timestamp},id.lt.${id})`
}

export function organizerTextFilter(value: string) {
  // PostgREST treats * as another LIKE wildcard even if preceded by a backslash.
  // A quoted literal regex preserves the user's search for that character.
  const pattern = quoteFilterValue(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return `title.imatch.${pattern},notes.imatch.${pattern},subject.imatch.${pattern}`
}
