import { supabase } from './supabase'

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

// Capture only the link type/errors. Never retain access tokens or confirmation codes.
export const initialAuthEmailLink = (() => {
  const query = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''))
  const type = hash.get('type') || query.get('type')
  return {
    hasError: ['error', 'error_code', 'error_description'].some((key) => Boolean(hash.get(key) || query.get(key))),
    // This client uses Supabase's default implicit flow. A bare code/token_hash
    // must not be mistaken for success from a previously signed-in account.
    isConfirmation: window.location.pathname === '/auth/callback'
      && ['signup', 'email'].includes(type || '')
      && Boolean(hash.get('access_token') && hash.get('refresh_token')),
  }
})()

let confirmedLinkUserId: string | null = null

if (initialAuthEmailLink.isConfirmation && !initialAuthEmailLink.hasError) {
  // Register before React mounts so an immediately consumed email link is observed.
  const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.user.email_confirmed_at) {
      confirmedLinkUserId = session.user.id
      subscription.unsubscribe()
    }
  })
}

export function authEmailConfirmedUserId() {
  return confirmedLinkUserId
}
