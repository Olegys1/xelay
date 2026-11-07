export function parseEmailLink(url: URL) {
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  const query = url.searchParams
  const type = hash.get('type') || query.get('type')
  const hasError = ['error', 'error_code', 'error_description'].some((key) => Boolean(hash.get(key) || query.get(key)))
  const access = hash.get('access_token')
  const refresh = hash.get('refresh_token')
  // Older invitations used the same parameter name as OAuth. Preserve only
  // this exact non-auth route and code shape, then move it out of that namespace.
  const authMarkers = ['access_token', 'refresh_token', 'token_hash', 'type', 'expires_in', 'expires_at', 'token_type',
    'error', 'error_code', 'error_description', 'xelay_oauth', 'attempt', 'state', 'nonce', 'scope', 'id_token',
    'provider_token', 'provider_refresh_token', 'code_verifier', 'code_challenge', 'session_state', 'response_type', 'client_id', 'redirect_uri', 'redirect_to']
  const legacyReferralCode = query.getAll('code')
  let referralHref: string | undefined
  if (url.pathname === '/referrals' && legacyReferralCode.length === 1 && /^[A-F0-9]{32}$/i.test(legacyReferralCode[0])
    && !query.has('ref') && !hash.has('code') && !hash.has('ref') && !authMarkers.some(key => query.has(key) || hash.has(key))) {
    const referral = new URL(url.href)
    referral.searchParams.delete('code')
    referral.searchParams.set('ref', legacyReferralCode[0].toUpperCase())
    referralHref = referral.pathname + referral.search + referral.hash
  }
  const kind = url.pathname === '/auth/callback' && ['signup', 'email'].includes(type || '') ? 'confirmation'
    : url.pathname === '/reset-password' && type === 'recovery' ? 'recovery' : null
  return {
    kind, hasError,
    hasCredentials: !referralHref && ['access_token', 'refresh_token', 'code', 'token_hash'].some((key) => hash.has(key) || query.has(key)),
    tokens: kind && !hasError && access && refresh ? { access_token: access, refresh_token: refresh } : null,
    ...(referralHref ? { referralHref } : {}),
  }
}
