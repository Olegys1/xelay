export function parseEmailLink(url: URL) {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  const query = url.searchParams
  const type = hash.get('type') || query.get('type')
  const hasError = ['error', 'error_code', 'error_description'].some((key) => Boolean(hash.get(key) || query.get(key)))
  const access = hash.get('access_token')
  const refresh = hash.get('refresh_token')
  const kind = url.pathname === '/auth/callback' && ['signup', 'email'].includes(type || '') ? 'confirmation'
    : url.pathname === '/reset-password' && type === 'recovery' ? 'recovery' : null
  return {
    kind, hasError,
    hasCredentials: ['access_token', 'refresh_token', 'code', 'token_hash'].some((key) => hash.has(key) || query.has(key)),
    tokens: kind && !hasError && access && refresh ? { access_token: access, refresh_token: refresh } : null,
  }
}
