import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { PERSONAL_DATA_CONSENT_VERSION, PRIVACY_POLICY_VERSION } from '../lib/legal'
import { registrationPrivacyFailure } from '../lib/authRegistration'
import { supabase } from '../lib/supabase'
import { PrivacyConsent } from './PrivacyConsent'

const receiptFields = 'user_id, privacy_policy_version, consent_version, accepted_at, source'
type Phase = 'loading' | 'missing' | 'error' | 'accepted' | 'dismissed'

function validAcceptance(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return row.privacy_policy_version === PRIVACY_POLICY_VERSION
    && row.consent_version === PERSONAL_DATA_CONSENT_VERSION
    && typeof row.accepted_at === 'string' && row.accepted_at.length > 0
    && Number.isFinite(Date.parse(row.accepted_at))
    && (row.source === 'account' || row.source === 'signup')
}

function validReceipt(value: unknown, userId: string): boolean {
  return validAcceptance(value) && value.user_id === userId
}

function dismissed(key: string): boolean {
  try { return sessionStorage.getItem(key) === 'dismissed' } catch { return false }
}

export function PrivacyConsentNotice() {
  const { authUser, isPasswordRecovery } = useAuth()
  if (!authUser?.id || isPasswordRecovery) return null
  return <AccountPrivacyConsentNotice key={authUser.id} userId={authUser.id} />
}

function AccountPrivacyConsentNotice({ userId }: { userId: string }) {
  const titleId = useId()
  const dismissKey = `xelay:privacy-notice-dismissed:${userId}:${PRIVACY_POLICY_VERSION}:${PERSONAL_DATA_CONSENT_VERSION}`
  const [phase, setPhase] = useState<Phase>(() => dismissed(dismissKey) ? 'dismissed' : 'loading')
  const [consent, setConsent] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const mounted = useRef(false)
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const mutation = useRef(false)

  const loadReceipt = useCallback(async () => {
    if (mutation.current) return
    const request = ++sequence.current
    controller.current?.abort()
    const pending = new AbortController()
    controller.current = pending
    const timeout = window.setTimeout(() => pending.abort(), 15_000)
    const current = () => mounted.current && sequence.current === request
    setPhase('loading')
    setError('')
    try {
      const { data, error: readError } = await supabase.from('user_privacy_consents')
        .select(receiptFields).eq('user_id', userId).eq('privacy_policy_version', PRIVACY_POLICY_VERSION)
        .eq('consent_version', PERSONAL_DATA_CONSENT_VERSION).limit(1).abortSignal(pending.signal).maybeSingle()
      if (!current()) return
      if (readError || data !== null && !validReceipt(data, userId)) throw new Error('PRIVACY_RECEIPT_UNAVAILABLE')
      setPhase(data ? 'accepted' : 'missing')
    } catch {
      if (current()) {
        setPhase('error')
        setError('Не вдалося перевірити вашу згоду. Спробуйте ще раз. Доступ до Xelay залишається відкритим.')
      }
    } finally {
      window.clearTimeout(timeout)
      if (controller.current === pending) controller.current = null
    }
  }, [userId])

  useEffect(() => {
    mounted.current = true
    if (!dismissed(dismissKey)) void loadReceipt()
    return () => { mounted.current = false; sequence.current += 1; controller.current?.abort() }
  }, [dismissKey, loadReceipt])

  const postpone = () => {
    if (mutation.current) return
    try { sessionStorage.setItem(dismissKey, 'dismissed') } catch { /* A dismissal is optional local UI state, never consent. */ }
    setPhase('dismissed')
    setConsent(false)
  }

  const accept = async () => {
    if (mutation.current || !consent || phase !== 'missing') return
    mutation.current = true
    setSaving(true)
    setError('')
    const request = ++sequence.current
    controller.current?.abort()
    const pending = new AbortController()
    controller.current = pending
    const timeout = window.setTimeout(() => pending.abort(), 20_000)
    const current = () => mounted.current && sequence.current === request
    try {
      const { data, error: saveError } = await supabase.rpc('xelay_accept_privacy_consent', {
        p_policy_version: PRIVACY_POLICY_VERSION,
        p_consent_version: PERSONAL_DATA_CONSENT_VERSION,
        p_consent: true,
      }).abortSignal(pending.signal)
      if (!current()) return
      if (saveError) throw saveError
      if (!validAcceptance(data)) throw new Error('PRIVACY_RECEIPT_UNAVAILABLE')
      setPhase('accepted')
      setConsent(false)
    } catch (failure) {
      if (current()) setError(registrationPrivacyFailure(failure)?.message
        || 'Не вдалося підтвердити збереження згоди. Спробуйте ще раз. Ви можете продовжити користуватися Xelay.')
    } finally {
      window.clearTimeout(timeout)
      if (controller.current === pending) controller.current = null
      if (current()) { mutation.current = false; setSaving(false) }
    }
  }

  if (phase !== 'missing' && phase !== 'error') return null
  return (
    <aside aria-labelledby={titleId} className="fixed bottom-3 right-3 z-[35] max-h-[75dvh] w-[calc(100%_-_1.5rem)] max-w-md overflow-y-auto rounded-2xl border border-primary/20 bg-background p-4 shadow-xl sm:bottom-5 sm:right-5 sm:p-5">
      <h2 id={titleId} className="flex items-start gap-2 text-base font-semibold"><ShieldCheck size={19} aria-hidden="true" className="mt-0.5 shrink-0 text-primary" />Оновили документи про персональні дані</h2>
      <p className="mb-3 mt-2 text-xs leading-relaxed text-muted-foreground">Перегляньте документи й підтвердьте свою згоду. Ви можете зробити це пізніше та продовжити користуватися платформою.</p>
      {phase === 'missing' && <PrivacyConsent checked={consent} onChange={setConsent} disabled={saving} name="account-privacy-consent" />}
      {error && <p role="status" className="mt-3 text-sm leading-relaxed text-destructive">{error}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {phase === 'error' ? <button type="button" onClick={() => { void loadReceipt() }} className="min-h-11 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90">Повторити перевірку</button>
          : <button type="button" disabled={!consent || saving} onClick={() => { void accept() }} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{saving && <Loader2 size={16} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}{saving ? 'Зберігаємо…' : 'Підтвердити згоду'}</button>}
        <button type="button" disabled={saving} onClick={postpone} className="min-h-11 rounded-full px-4 py-2 text-sm font-medium text-muted-foreground hover:bg-muted disabled:opacity-50">Не зараз</button>
      </div>
    </aside>
  )
}
