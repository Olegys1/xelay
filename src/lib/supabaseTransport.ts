// Keep the SDK's original URL: its session storage key, file URLs and Realtime
// connection must not change when HTTP auth/data requests use our own domain.
export const SUPABASE_RELAY_UPSTREAM = 'https://baohfpadxvhqhhjjqtil.supabase.co'
export const SUPABASE_RELAY_PREFIX = '/api/supabase'

type Fetch = typeof fetch

export function createSupabaseTransport(
  supabaseUrl: string,
  pageOrigin: string | null = typeof window === 'undefined' ? null : window.location.origin,
  fetcher: Fetch = (input, init) => fetch(input, init),
): Fetch {
  let relayOrigin: string | null = null
  try {
    const upstream = new URL(supabaseUrl)
    const page = pageOrigin ? new URL(pageOrigin) : null
    // This deployment only relays its own configured project. Local development
    // and other Supabase projects retain their existing direct connection.
    if (upstream.origin === SUPABASE_RELAY_UPSTREAM && upstream.pathname === '/'
      && !upstream.username && !upstream.password && !upstream.search && !upstream.hash
      && page?.protocol === 'https:' && !page.username && !page.password) {
      relayOrigin = page.origin
    }
  } catch { /* Missing/invalid configuration is handled by the SDK as before. */ }

  let useRelay: boolean | undefined
  let routeProbe: Promise<boolean> | undefined
  const selectRoute = (input: RequestInfo | URL, init?: RequestInit): Promise<boolean> => {
    if (useRelay !== undefined) return Promise.resolve(useRelay)
    if (!routeProbe) routeProbe = (async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 4000)
      // A public, read-only health check chooses a route BEFORE a password,
      // refresh token or database write is transmitted. Any HTTP response is
      // reachable: never evade a real 401/403/429 by changing routes.
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      const publicKey = headers.get('apikey')
      try {
        await fetcher(`${SUPABASE_RELAY_UPSTREAM}/auth/v1/health`, {
          method: 'GET', headers: publicKey ? { apikey: publicKey } : undefined,
          signal: controller.signal, credentials: 'omit', cache: 'no-store',
          redirect: 'error', referrerPolicy: 'no-referrer',
        })
        useRelay = false
      } catch { useRelay = true }
      finally { clearTimeout(timer) }
      return useRelay === true
    })()
    return routeProbe
  }

  return async (input, init) => {
    if (!relayOrigin) return fetcher(input, init)
    const inputUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    let originalUrl: URL
    try {
      originalUrl = new URL(inputUrl)
    } catch { return fetcher(input, init) }
    const rawPath = inputUrl.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i)?.[1] || ''
    const apiFamily = /^\/(auth|rest)\/v1(?:\/|$)/
    if (originalUrl.origin === SUPABASE_RELAY_UPSTREAM && (apiFamily.test(rawPath) || apiFamily.test(originalUrl.pathname))
      && (inputUrl.split(/[?#]/, 1)[0].includes('\\') || /\/\/|%2f|%5c|%25|%2e|(?:^|\/)\.{1,2}(?:\/|$)/i.test(rawPath))) {
      throw new TypeError('Invalid Supabase API path')
    }
    // Never relay storage uploads, WebSockets, arbitrary origins or functions.
    if (originalUrl.origin !== SUPABASE_RELAY_UPSTREAM || originalUrl.username || originalUrl.password
      || !apiFamily.test(originalUrl.pathname)) {
      return fetcher(input, init)
    }
    if (!await selectRoute(input, init)) {
      try { return await fetcher(input, init) }
      catch (error) {
        const cancelled = init?.signal?.aborted || (input instanceof Request && input.signal.aborted)
        // The next explicit attempt can use the alternate route. This failed
        // request itself is never repeated, so writes cannot be duplicated.
        if (!cancelled) useRelay = true
        throw error
      }
    }
    const destination = `${relayOrigin}${SUPABASE_RELAY_PREFIX}${originalUrl.pathname}${originalUrl.search}`
    const original = new Request(input, init)
    const request = new Request(destination, original)
    // Choose the route before sending. Retrying a write after a lost response
    // could duplicate it; refresh tokens must not be replayed either.
    return fetcher(request, {
      credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
    })
  }
}
