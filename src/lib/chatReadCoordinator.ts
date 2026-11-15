export interface ChatReadContext {
  signal: AbortSignal
  current: () => boolean
}

type ChatReadWork = (context: ChatReadContext) => Promise<void>
type Flight = { controller: AbortController; dirty: boolean; promise: Promise<void> }

/** Component/session-local in-flight work, never a cache of private results. */
export function createChatReadCoordinator() {
  const flights = new Map<string, Flight>()

  function invalidate(prefix = '') {
    for (const [key, flight] of flights) if (key.startsWith(prefix)) {
      flights.delete(key)
      flight.controller.abort()
    }
  }

  function read(key: string, work: ChatReadWork, fresh = false): Promise<void> {
    const pending = flights.get(key)
    if (pending) {
      // An event after a request began may refer to a newer server version.
      // Keep one pending follow-up rather than lose it or start parallel reads.
      if (fresh) pending.dirty = true
      return pending.promise
    }
    const flight: Flight = { controller: new AbortController(), dirty: false, promise: Promise.resolve() }
    flights.set(key, flight)
    const context = { signal: flight.controller.signal, current: () => flights.get(key) === flight && !flight.controller.signal.aborted }
    flight.promise = (async () => {
      do {
        flight.dirty = false
        await work(context)
      } while (context.current() && flight.dirty)
    })().finally(() => { if (flights.get(key) === flight) flights.delete(key) })
    return flight.promise
  }

  return { read, invalidate }
}

export interface ChatRealtimeChange {
  eventType?: string
  new?: Record<string, unknown>
  old?: Record<string, unknown>
}

export function chatEventSpaceId(table: 'chat_spaces' | 'chat_posts' | 'chat_members' | 'chat_invitations' | 'chat_join_requests', payload: ChatRealtimeChange): string | null {
  const field = table === 'chat_spaces' ? 'id' : 'space_id'
  const value = payload.new?.[field] ?? payload.old?.[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function chatEventAffectsSelected(table: Parameters<typeof chatEventSpaceId>[0], payload: ChatRealtimeChange, selectedId: string): boolean {
  if (!selectedId) return false
  const id = chatEventSpaceId(table, payload)
  // DELETE events can contain only a primary key. An unknown scope is not
  // evidence that the selected chat is unaffected.
  return id === null || id === selectedId
}

export function chatMembershipAccessChanged(payload: ChatRealtimeChange, known: { status?: string; role?: string; visible_from?: string | null } | null | undefined): boolean {
  if (payload.eventType === 'DELETE') return true
  const row = payload.new
  if (!row || row.status !== 'active' || !known || known.status !== 'active') return true
  if (typeof row.role !== 'string' || row.role !== known.role) return true
  return 'visible_from' in row && row.visible_from !== known.visible_from
}

export function chatAccessDenied(failure: unknown): boolean {
  const error = failure as { code?: string; message?: string; status?: number } | null
  return [401, 403].includes(error?.status || 0)
    || ['42501', '28000', '28P01', 'PGRST301', 'PGRST302', 'PGRST303'].includes(error?.code || '')
    || /CHAT_(?:AUTH_REQUIRED|MEMBER_REQUIRED|BANNED|NOT_FOUND|FACULTY_SCOPE_REQUIRED)/.test(error?.message || '')
}

export function chatAuthRejected(failure: unknown): boolean {
  const error = failure as { code?: string; message?: string; status?: number } | null
  return error?.status === 401
    || ['28000', '28P01', 'PGRST301', 'PGRST302', 'PGRST303'].includes(error?.code || '')
    || /CHAT_AUTH_REQUIRED/.test(error?.message || '')
}
