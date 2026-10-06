import { useId, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { supabase } from '../lib/supabase'
import { initialAuthEmailLink } from '../lib/authEmail'
import { AuthModal } from '../components/AuthModal'
import { EmailLinkConfirmation } from '../components/EmailLinkConfirmation'
import { PasswordRecoveryMfa } from '../components/PasswordRecoveryMfa'

export function ResetPasswordPage() {
  const { authUser, isLoading, isPasswordRecovery, markPasswordRecovery, refreshUser, clearPasswordRecovery, signOut } = useAuth()
  const { notify } = useToast()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [complete, setComplete] = useState(false)
  const [linkAccepted, setLinkAccepted] = useState(false)
  const [mfaRetry, setMfaRetry] = useState(0)
  const [showAuth, setShowAuth] = useState<'login' | 'recovery' | null>(null)
  const passwordId = useId()
  const confirmationId = useId()
  const errorId = useId()
  const passwordRef = useRef<HTMLInputElement>(null)
  const confirmationRef = useRef<HTMLInputElement>(null)
  const [invalidField, setInvalidField] = useState<'password' | 'confirmation' | null>(null)
  const submitting = useRef(false)
  const pendingLink = initialAuthEmailLink.isRecovery && !initialAuthEmailLink.hasError && !linkAccepted
  const recoveryReady = Boolean(authUser && isPasswordRecovery && !initialAuthEmailLink.hasError && !pendingLink)

  const updatePassword = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting.current || !recoveryReady) return
    setError('')
    setInvalidField(null)
    if (password.length < 8) {
      const message = 'Пароль має містити щонайменше 8 символів.'
      setError(message)
      setInvalidField('password')
      passwordRef.current?.focus()
      notify({ id: 'reset-password', title: 'Перевірте новий пароль', description: message, tone: 'warning' })
      return
    }
    if (password !== confirmation) {
      const message = 'Паролі не збігаються. Перевірте повторний пароль.'
      setError(message)
      setInvalidField('confirmation')
      confirmationRef.current?.focus()
      notify({ id: 'reset-password', title: 'Паролі не збігаються', description: message, tone: 'warning' })
      return
    }
    submitting.current = true
    setSaving(true)
    try {
      const { error: updateError } = await supabase.auth.updateUser({ password })
      if (updateError) throw updateError
      setPassword('')
      setConfirmation('')
      setComplete(true)
      clearPasswordRecovery()
      try {
        await signOut()
        notify({ id: 'reset-password', title: 'Пароль змінено', description: 'Увійдіть до Xelay з новим паролем.', tone: 'success' })
      } catch {
        const message = 'Пароль уже змінено. Не вдалося завершити сесію автоматично: вийдіть зі свого акаунта та увійдіть знову.'
        setError(message)
        notify({ id: 'reset-password', title: 'Пароль змінено. Завершіть поточну сесію', description: message, tone: 'warning' })
      }
    } catch (updateError) {
      const code = typeof updateError === 'object' && updateError !== null && 'code' in updateError ? String(updateError.code) : ''
      let message: string
      if (code === 'same_password') {
        message = 'Новий пароль має відрізнятися від попереднього.'
        setInvalidField('password')
      } else if (code === 'weak_password') {
        message = 'Цей пароль недостатньо надійний. Використайте довший пароль із літерами, цифрами та символами.'
        setInvalidField('password')
      } else if (code === 'insufficient_aal') {
        setMfaRetry((value) => value + 1)
        message = 'Підтвердіть код із застосунку автентифікації, щоб змінити пароль.'
      } else if (['session_not_found', 'session_expired', 'refresh_token_not_found', 'refresh_token_already_used', 'bad_jwt', 'reauthentication_needed'].includes(code)) {
        clearPasswordRecovery()
        message = 'Час дії посилання минув. Запросіть новий лист для відновлення пароля.'
      } else {
        message = 'Не вдалося змінити пароль. Перевірте з’єднання або запросіть нове посилання.'
      }
      setError(message)
      notify({ id: 'reset-password', title: 'Не вдалося змінити пароль', description: message, tone: 'error' })
      if (code === 'same_password' || code === 'weak_password') requestAnimationFrame(() => passwordRef.current?.focus())
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12 sm:py-20">
      {showAuth && <AuthModal initialView={showAuth === 'recovery' ? 'recovery' : 'form'} onClose={() => setShowAuth(null)} />}
      <section aria-busy={saving || isLoading} className="w-full max-w-md rounded-3xl border border-border bg-card px-5 py-8 shadow-[var(--panel-shadow)] sm:px-8">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {isLoading && !complete ? <Loader2 size={30} className="animate-spin" aria-hidden="true" /> : complete ? <CheckCircle2 size={30} aria-hidden="true" /> : <KeyRound size={30} aria-hidden="true" />}
        </div>
        <h1 className="text-center text-2xl font-semibold text-foreground">{complete ? 'Пароль змінено' : pendingLink ? 'Підтвердіть акаунт' : isLoading ? 'Перевіряємо посилання…' : recoveryReady ? 'Створіть новий пароль' : 'Посилання недійсне'}</h1>
        <p role={isLoading ? 'status' : undefined} className="mt-3 text-center text-sm leading-relaxed text-muted-foreground">
          {complete ? 'Увійдіть до Xelay з новим паролем.' : pendingLink ? 'Перевірте адресу пошти перед зміною пароля.' : isLoading ? 'Зачекайте кілька секунд.' : recoveryReady ? 'Оберіть надійний пароль, який ви ще не використовували.' : 'Відкрийте свіже посилання з листа. Воно одноразове та має обмежений час дії.'}
        </p>
        {pendingLink && <EmailLinkConfirmation recovery onAccepted={async (session) => { await refreshUser(); markPasswordRecovery(session); setLinkAccepted(true) }} />}
        {error && <p id={errorId} role="alert" className="xelay-inline-feedback xelay-feedback-error mt-5 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm leading-relaxed text-destructive">{error}</p>}
        {!complete && !isLoading && recoveryReady && authUser && <PasswordRecoveryMfa key={`${authUser.id}:${mfaRetry}`} userId={authUser.id} required={mfaRetry > 0}><form onSubmit={updatePassword} aria-busy={saving} className="mt-6 space-y-4">
          <div>
            <label htmlFor={passwordId} className="mb-2 block text-sm font-medium text-foreground">Новий пароль</label>
            <input ref={passwordRef} id={passwordId} type="password" autoComplete="new-password" minLength={8} required value={password} disabled={saving} aria-invalid={invalidField === 'password' || undefined} aria-describedby={invalidField === 'password' ? errorId : undefined} onChange={(event) => { setPassword(event.target.value); if (invalidField) { setInvalidField(null); setError('') } }} className={`${invalidField === 'password' ? 'xelay-field-invalid' : ''} min-h-[3rem] w-full rounded-xl border border-border bg-background px-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60`} />
            <p className="mt-2 text-xs text-muted-foreground">Щонайменше 8 символів.</p>
          </div>
          <div>
            <label htmlFor={confirmationId} className="mb-2 block text-sm font-medium text-foreground">Повторіть пароль</label>
            <input ref={confirmationRef} id={confirmationId} type="password" autoComplete="new-password" minLength={8} required value={confirmation} disabled={saving} aria-invalid={invalidField === 'confirmation' || undefined} aria-describedby={invalidField === 'confirmation' ? errorId : undefined} onChange={(event) => { setConfirmation(event.target.value); if (invalidField === 'confirmation') { setInvalidField(null); setError('') } }} className={`${invalidField === 'confirmation' ? 'xelay-field-invalid' : ''} min-h-[3rem] w-full rounded-xl border border-border bg-background px-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60`} />
          </div>
          <button type="submit" disabled={saving} className="flex min-h-[3rem] w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 xelay-btn">
            {saving && <Loader2 size={18} className="animate-spin" aria-hidden="true" />}<span role={saving ? 'status' : undefined}>{saving ? 'Зберігаємо…' : 'Зберегти новий пароль'}</span>
          </button>
        </form></PasswordRecoveryMfa>}
        {complete && <button type="button" disabled={saving} onClick={() => setShowAuth('login')} className="mt-6 min-h-[3rem] w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 xelay-btn">Увійти</button>}
        {!complete && !isLoading && !recoveryReady && <button type="button" onClick={() => setShowAuth('recovery')} className="mt-6 min-h-[3rem] w-full rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 xelay-btn">Запросити нове посилання</button>}
        {!isLoading && <div className="mt-3 text-center"><Link to="/" className="inline-flex min-h-[2.5rem] items-center justify-center rounded-full px-4 text-sm text-muted-foreground hover:bg-muted xelay-btn">На головну</Link></div>}
      </section>
    </main>
  )
}
