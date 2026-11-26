import { useEffect, useId, useRef, useState } from 'react'
import { Mail, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase, emailLinkVerifier } from '../lib/supabase'
import { requestAcademicEmailChange } from '../lib/academicEmailChange'
import { authEmailRedirect } from '../lib/authEmail'
import { academicEmailChangeError, isKnuEmail } from '../lib/academicEmail'

export function AcademicEmailSettings() {
  const { authUser, xelayUser, businessAccount, refreshUser } = useAuth()
  if (!authUser || !xelayUser || businessAccount || authUser.app_metadata?.dean_service === true) return null
  return <EmailChangeForm key={authUser.id} userId={authUser.id} currentEmail={authUser.email || ''} pendingEmail={authUser.new_email || ''} onRefresh={refreshUser} />
}

function EmailChangeForm({ userId, currentEmail, pendingEmail, onRefresh }: { userId: string; currentEmail: string; pendingEmail: string; onRefresh: () => Promise<void> }) {
  const inputId = useId()
  const [email, setEmail] = useState(pendingEmail)
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(Boolean(pendingEmail))
  const [error, setError] = useState('')
  const [cooldown, setCooldown] = useState(0)
  const alive = useRef(true)
  const locked = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { if (!cooldown) return; const timer = window.setTimeout(() => setCooldown(value => Math.max(0, value - 1)), 1000); return () => window.clearTimeout(timer) }, [cooldown])
  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (locked.current || cooldown) return
    const next = email.trim().toLowerCase()
    if (!isKnuEmail(next)) { setError('Введіть адресу своєї пошти @knu.ua.'); return }
    if (next === currentEmail.toLowerCase()) { setError('Ця пошта вже використовується для входу.'); return }
    locked.current = true; setBusy(true); setError('')
    try {
      await requestAcademicEmailChange({ client: supabase, createIsolated: emailLinkVerifier, userId, email: next, redirectTo: authEmailRedirect('/auth/callback'), isActive: () => alive.current })
      if (!alive.current) return
      setSent(true); setCooldown(60)
      await onRefresh()
    } catch (failure) { if (alive.current) setError(academicEmailChangeError(failure)) }
    finally { locked.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="mb-6 rounded-xl border border-border p-4" aria-labelledby={inputId + '-title'}>
    <h3 id={inputId + '-title'} className="flex items-center gap-2 font-semibold"><Mail size={17} aria-hidden="true" />Пошта для входу</h3>
    <p className="mt-2 break-all text-sm">{currentEmail}</p>
    {!isKnuEmail(currentEmail) && <p className="mt-2 text-sm text-muted-foreground">Перейдіть на пошту КНУ в цьому ж акаунті. Групи, оцінки, підписка й історія збережуться. Створювати новий профіль не потрібно.</p>}
    <details className="mt-3" open={pendingEmail ? true : undefined}>
      <summary className="cursor-pointer py-2 text-sm font-medium text-primary">{isKnuEmail(currentEmail) ? 'Змінити адресу' : 'Підключити пошту КНУ'}</summary>
      <form onSubmit={event => void submit(event)} className="mt-3 space-y-3" aria-busy={busy}>
        <label htmlFor={inputId} className="block text-sm">Нова пошта КНУ</label>
        <input id={inputId} type="email" autoComplete="email" required maxLength={254} value={email} onChange={event => { setEmail(event.target.value); setError(''); setSent(false) }} disabled={busy} className="min-h-11 w-full rounded-lg border border-border bg-background px-3 text-sm" placeholder="name@knu.ua" aria-invalid={Boolean(error)} aria-describedby={inputId + '-status'} />
        <p className="text-xs leading-relaxed text-muted-foreground">Підтвердіть зміну за посиланнями з листів. До завершення підтвердження для входу залишається поточна адреса.</p>
        <button type="submit" disabled={busy || cooldown > 0} className="inline-flex min-h-11 items-center gap-2 rounded-full bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60">{busy && <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />}{busy ? 'Надсилаємо…' : cooldown ? 'Повторити через ' + cooldown + ' с' : 'Надіслати підтвердження'}</button>
        <div id={inputId + '-status'}>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : sent ? <p role="status" className="text-sm">Перевірте стару й нову пошту та підтвердіть зміну. Потім оновіть профіль.</p> : null}</div>
      </form>
    </details>
  </section>
}
