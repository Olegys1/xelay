import { supabase, emailLinkVerifier } from './supabase'
import { parseEmailLink } from './authEmailLinks'

type EmailRequestKind = 'signup' | 'recovery'

export const AUTH_EMAIL_COOLDOWN_SECONDS = 60

export function authEmailRedirect(path: '/auth/callback' | '/reset-password') {
  return new URL(path, window.location.origin).toString()
}

export function authEmailCooldown(kind: EmailRequestKind) {
  try {
    const until = Number(window.sessionStorage.getItem(`xelay_auth_email_${kind}`) || 0)
    return Number.isFinite(until) ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0
  } catch {
    return 0
  }
}

export function startAuthEmailCooldown(kind: EmailRequestKind) {
  try {
    window.sessionStorage.setItem(`xelay_auth_email_${kind}`, String(Date.now() + AUTH_EMAIL_COOLDOWN_SECONDS * 1000))
  } catch {
    // Supabase also enforces its own request limits when browser storage is unavailable.
  }
}

// Link credentials stay in memory until a deliberate confirmation, never storage.
let link = parseEmailLink(new URL(window.location.href))
export const initialAuthEmailLink = {
  hasError: link.hasError, isConfirmation: link.kind === 'confirmation', isRecovery: link.kind === 'recovery',
}
if (link.hasCredentials) {
  const clean = new URL(window.location.href)
  clean.hash = ''
  for (const key of ['access_token', 'refresh_token', 'code', 'token_hash', 'type', 'expires_in', 'expires_at', 'token_type']) clean.searchParams.delete(key)
  window.history.replaceState(window.history.state, '', clean.pathname + clean.search)
}

let identityPromise: ReturnType<typeof supabase.auth.getUser> | undefined
export async function emailLinkIdentity() {
  if (link.hasError || !link.tokens || !link.kind) throw new Error('Invalid email link')
  identityPromise ??= supabase.auth.getUser(link.tokens.access_token)
  const { data, error } = await identityPromise
  if (error || !data.user?.email || !data.user.email_confirmed_at) throw new Error('Invalid email link')
  return data.user
}

export async function acceptEmailLink() {
  const expected = await emailLinkIdentity()
  if (!link.tokens) throw new Error('Email link already used')
  const verifier = emailLinkVerifier()
  const verified = await verifier.auth.refreshSession({ refresh_token: link.tokens.refresh_token })
  if (verified.error || !verified.data.session || verified.data.user?.id !== expected.id) throw new Error('Invalid email session')
  const { data, error } = await supabase.auth.setSession({ access_token: verified.data.session.access_token, refresh_token: verified.data.session.refresh_token })
  if (error || !data.session || data.user?.id !== expected.id) throw new Error('Invalid email session')
  link = { ...link, tokens: null }
  return data.session
}
