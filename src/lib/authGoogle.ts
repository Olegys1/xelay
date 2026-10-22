import { createClient } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { createSupabaseTransport } from './supabaseTransport'

// Enable only after the Google provider, redirect allowlist and registration
// migration are configured. This is a public capability flag, never a secret.
export const googleAuthEnabled = import.meta.env.VITE_GOOGLE_AUTH_ENABLED === 'true'

const STORAGE_KEY = 'xelay-google-pkce-v1'
const ATTEMPT_KEY = 'xelay:google-attempt:v1'
const ATTEMPT_TTL = 15 * 60 * 1000
const CALLBACK_PATH = '/auth/callback'
const MARKER = 'xelay_oauth'
type Attempt = { nonce: string; startedAt: number; origin: string }

function allowedOrigin(origin: string): boolean {
  if (['https://www.xelay.ink', 'https://xelay.ink'].includes(origin)) return true
  if (!import.meta.env.DEV) return false
  try {
    const url = new URL(origin)
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  } catch { return false }
}

function readAttempt(): Attempt | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(ATTEMPT_KEY) || 'null')
    if (!value || typeof value !== 'object') return null
    const row = value as Partial<Attempt>
    if (typeof row.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(row.nonce)
      || typeof row.startedAt !== 'number' || row.startedAt > Date.now()
      || Date.now() - row.startedAt > ATTEMPT_TTL || row.origin !== window.location.origin
      || !allowedOrigin(row.origin)) return null
    return row as Attempt
  } catch { return null }
}

function clearAttempt() {
  try {
    sessionStorage.removeItem(ATTEMPT_KEY)
    sessionStorage.removeItem(`${STORAGE_KEY}-code-verifier`)
  } catch { /* Missing storage is handled as an expired attempt. */ }
}

// This module is imported by authEmail before its URL parser. Capture the code
// once, then remove it before routing, analytics or email-link handling runs.
function captureCallback() {
  const url = new URL(window.location.href)
  const active = url.pathname === CALLBACK_PATH && url.searchParams.get(MARKER) === 'google'
  if (!active) return { active: false, code: null, nonce: null, hasError: false, cancelled: false }
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''))
  const result = {
    active: true,
    code: url.searchParams.get('code'),
    nonce: url.searchParams.get('attempt'),
    hasError: ['error', 'error_code', 'error_description'].some((key) => url.searchParams.has(key) || hash.has(key)),
    cancelled: ['error', 'error_code'].some((key) => [url.searchParams.get(key), hash.get(key)].some((value) => value === 'access_denied' || value === 'user_cancelled_authorize')),
  }
  url.hash = ''
  for (const key of [MARKER, 'attempt', 'code', 'error', 'error_code', 'error_description', 'access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'token_hash', 'type', 'expires_in', 'expires_at', 'token_type']) url.searchParams.delete(key)
  window.history.replaceState(window.history.state, '', url.pathname + url.search)
  return result
}

const callback = captureCallback()
export const initialGoogleCallback = { active: callback.active, hasError: callback.hasError }

// Only the PKCE verifier survives the redirect, in this tab. OAuth sessions and
// provider credentials are never persisted by this isolated client. The main
// client receives only a deliberately accepted Supabase session afterwards.
const verifierStorage = {
  getItem: (key: string) => key === `${STORAGE_KEY}-code-verifier` ? sessionStorage.getItem(key) : null,
  setItem: (key: string, value: string) => { if (key === `${STORAGE_KEY}-code-verifier`) sessionStorage.setItem(key, value) },
  removeItem: (key: string) => { if (key === `${STORAGE_KEY}-code-verifier`) sessionStorage.removeItem(key) },
}
let verifierClient: ReturnType<typeof createClient> | null = null
function googleVerifier() {
  verifierClient ??= createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
    global: { fetch: createSupabaseTransport(import.meta.env.VITE_SUPABASE_URL) },
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storageKey: STORAGE_KEY, storage: verifierStorage },
  })
  return verifierClient
}

export async function beginGoogleSignIn(): Promise<void> {
  if (!googleAuthEnabled || !allowedOrigin(window.location.origin)) throw new Error('GOOGLE_AUTH_UNAVAILABLE')
  const { data, error } = await supabase.auth.getSession()
  if (error) throw new Error('GOOGLE_AUTH_UNAVAILABLE')
  if (data.session) throw new Error('GOOGLE_ALREADY_SIGNED_IN')
  clearAttempt()
  const attempt = { nonce: crypto.randomUUID(), startedAt: Date.now(), origin: window.location.origin }
  // Fail before leaving the page if this browser cannot retain the verifier.
  try {
    sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify(attempt))
    if (readAttempt()?.nonce !== attempt.nonce) throw new Error('Storage unavailable')
  } catch { throw new Error('GOOGLE_STORAGE_UNAVAILABLE') }
  const redirect = new URL(CALLBACK_PATH, attempt.origin)
  redirect.searchParams.set(MARKER, 'google')
  redirect.searchParams.set('attempt', attempt.nonce)
  try {
    const result = await googleVerifier().auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: redirect.toString(), skipBrowserRedirect: true, scopes: 'openid email profile', queryParams: { prompt: 'select_account' } },
    })
    if (result.error || !result.data.url) throw new Error('GOOGLE_AUTH_UNAVAILABLE')
    const destination = new URL(result.data.url)
    const expected = new URL(import.meta.env.VITE_SUPABASE_URL)
    if (destination.origin !== expected.origin || destination.pathname !== '/auth/v1/authorize' || destination.searchParams.get('provider') !== 'google') throw new Error('GOOGLE_AUTH_UNAVAILABLE')
    window.location.assign(destination.toString())
  } catch (error) { clearAttempt(); throw error }
}

let callbackPromise: Promise<string> | null = null
export function acceptGoogleCallback(): Promise<string> {
  // A single-use code must not be exchanged twice under React StrictMode.
  callbackPromise ??= finishGoogleCallback()
  return callbackPromise
}

async function finishGoogleCallback(): Promise<string> {
  const attempt = readAttempt()
  if (!googleAuthEnabled || !callback.active || !allowedOrigin(window.location.origin)
    || !attempt || attempt.nonce !== callback.nonce) { callback.code = null; clearAttempt(); throw new Error('GOOGLE_ATTEMPT_EXPIRED') }
  if (callback.hasError) { callback.code = null; clearAttempt(); throw new Error(callback.cancelled ? 'GOOGLE_CANCELLED' : 'GOOGLE_AUTH_UNAVAILABLE') }
  if (!callback.code || callback.code.length > 4096) { callback.code = null; clearAttempt(); throw new Error('GOOGLE_ATTEMPT_EXPIRED') }
  try {
    const result = await googleVerifier().auth.exchangeCodeForSession(callback.code)
    callback.code = null
    if (result.error || !result.data.session) throw new Error('GOOGLE_ATTEMPT_EXPIRED')
    const session = result.data.session
    // Ask Auth for the verified identity; editable profile metadata grants no
    // access or teacher status. Supabase performs same-email identity linking.
    const verified = await supabase.auth.getUser(session.access_token)
    if (verified.error || verified.data.user?.id !== session.user.id
      || !verified.data.user.email || !verified.data.user.email_confirmed_at
      || !verified.data.user.identities?.some((identity) => identity.provider === 'google'
        && identity.identity_data?.email_verified === true
        && typeof identity.identity_data.email === 'string'
        && identity.identity_data.email.trim().toLowerCase() === verified.data.user?.email?.trim().toLowerCase())) throw new Error('GOOGLE_IDENTITY_UNVERIFIED')
    const current = await supabase.auth.getSession()
    if (current.error || current.data.session && current.data.session.user.id !== session.user.id) throw new Error('GOOGLE_SESSION_CHANGED')
    const accepted = await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
    if (accepted.error || accepted.data.user?.id !== verified.data.user.id || !accepted.data.session) throw new Error('GOOGLE_AUTH_UNAVAILABLE')
    return accepted.data.user.id
  } finally { callback.code = null; clearAttempt() }
}

export function googleAuthFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message === 'GOOGLE_CANCELLED') return 'Вхід через Google скасовано. Ви можете спробувати ще раз або увійти за допомогою пошти.'
  if (message === 'GOOGLE_ATTEMPT_EXPIRED') return 'Спроба входу застаріла або відкрита в іншій вкладці. Почніть вхід через Google ще раз у цій вкладці.'
  if (message === 'GOOGLE_SESSION_CHANGED' || message === 'GOOGLE_ALREADY_SIGNED_IN') return 'У браузері вже відкрито інший сеанс Xelay. Спочатку вийдіть із нього, щоб змінити акаунт.'
  if (message === 'GOOGLE_STORAGE_UNAVAILABLE') return 'Дозвольте зберігання даних для Xelay у цьому браузері та повторіть вхід. Або скористайтеся поштою і паролем.'
  if (message === 'GOOGLE_IDENTITY_UNVERIFIED') return 'Не вдалося підтвердити адресу Google. Спробуйте інший акаунт або увійдіть за допомогою пошти.'
  return 'Зараз не вдалося увійти через Google. Спробуйте ще раз або скористайтеся поштою і паролем.'
}

export async function googleRegistrationRequired(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 15_000)
  try {
    const result = await supabase.rpc('xelay_google_registration_status').abortSignal(controller.signal)
    if (result.error || !result.data || typeof result.data.required !== 'boolean') throw new Error('GOOGLE_REGISTRATION_UNAVAILABLE')
    return result.data.required
  } finally { window.clearTimeout(timeout) }
}

export async function completeGoogleRegistration(profile: Record<string, unknown>, policyVersion: string, consentVersion: string): Promise<void> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 25_000)
  try {
    const result = await supabase.rpc('xelay_complete_google_registration', {
      p_profile: profile, p_policy_version: policyVersion, p_consent_version: consentVersion, p_consent: true,
    }).abortSignal(controller.signal)
    if (result.error) throw result.error
    if (result.data?.completed !== true) throw new Error('GOOGLE_REGISTRATION_UNAVAILABLE')
  } finally { window.clearTimeout(timeout) }
}
