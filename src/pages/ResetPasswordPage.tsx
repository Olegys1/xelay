import { useId, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, KeyRound, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { initialAuthEmailLink } from '../lib/authEmail'
import { AuthModal } from '../components/AuthModal'

export function ResetPasswordPage() {
  const { authUser, isLoading, isPasswordRecovery, clearPasswordRecovery, signOut } = useAuth()
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [complete, setComplete] = useState(false)
  const [showAuth, setShowAuth] = useState<'login' | 'recovery' | null>(null)
  const passwordId = useId()
  const confirmationId = useId()
  const submitting = useRef(false)
  const recoveryReady = Boolean(authUser && isPasswordRecovery && !initialAuthEmailLink.hasError)

  const updatePassword = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting.current || !recoveryReady) return
    setError('')
    if (password.length < 8) {
      setError('Пароль має містити щонайменше 8 символів.')
      return
    }
    if (password !== confirmation) {
      setError('Паролі не збігаються. Перевірте повторний пароль.')
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
      } catch {
        setError('Пароль уже змінено. Не вдалося завершити сесію автоматично: вийдіть зі свого акаунта та увійдіть знову.')
      }
    } catch (updateError) {
      const code = typeof updateError === 'object' && updateError !== null && 'code' in updateError ? String(updateError.code) : ''
      if (code === 'same_password') {
        setError('Новий пароль має відрізнятися від попереднього.')
      } else if (code === 'weak_password') {
        setError('Цей пароль недостатньо надійний. Використайте довший пароль із літерами, цифрами та символами.')
      } else if (['session_not_found', 'refresh_token_not_found', 'bad_jwt', 'reauthentication_needed'].includes(code)) {
        clearPasswordRecovery()
        setError('Час дії посилання минув. Запросіть новий лист для відновлення пароля.')
      } else {
        setError('Не вдалося змінити пароль. Перевірте з’єднання або запросіть нове посилання.')
      }
    } finally {
      submitting.current = false
      setSaving(false)
    }
  }

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12 sm:py-20">
      {showAuth && <AuthModal initialView={showAuth === 'recovery' ? 'recovery' : 'form'} onClose={() => setShowAuth(null)} />}
      <section className="w-full max-w-md rounded-3xl border border-border bg-card px-5 py-8 shadow-[var(--panel-shadow)] sm:px-8">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {isLoading && !complete ? <Loader2 size={30} className="animate-spin" aria-hidden="true" /> : complete ? <CheckCircle2 size={30} aria-hidden="true" /> : <KeyRound size={30} aria-hidden="true" />}
        </div>
        <h1 className="text-center text-2xl font-semibold text-foreground">{complete ? 'Пароль змінено' : isLoading ? 'Перевіряємо посилання…' : recoveryReady ? 'Створіть новий пароль' : 'Посилання недійсне'}</h1>
        <p className="mt-3 text-center text-sm leading-relaxed text-muted-foreground">
          {complete ? 'Увійдіть до Xelay з новим паролем.' : isLoading ? 'Зачекайте кілька секунд.' : recoveryReady ? 'Оберіть надійний пароль, який ви ще не використовували.' : 'Відкрийте свіже посилання з листа. Воно одноразове та має обмежений час дії.'}
        </p>
        {error && <p role="alert" className="mt-5 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm leading-relaxed text-destructive">{error}</p>}
        {!complete && !isLoading && recoveryReady && <form onSubmit={updatePassword} className="mt-6 space-y-4">
          <div>
            <label htmlFor={passwordId} className="mb-2 block text-sm font-medium text-foreground">Новий пароль</label>
            <input id={passwordId} type="password" autoComplete="new-password" minLength={8} required value={password} disabled={saving} onChange={(event) => setPassword(event.target.value)} className="min-h-[3rem] w-full rounded-xl border border-border bg-background px-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60" />
            <p className="mt-2 text-xs text-muted-foreground">Щонайменше 8 символів.</p>
          </div>
          <div>
            <label htmlFor={confirmationId} className="mb-2 block text-sm font-medium text-foreground">Повторіть пароль</label>
            <input id={confirmationId} type="password" autoComplete="new-password" minLength={8} required value={confirmation} disabled={saving} onChange={(event) => setConfirmation(event.target.value)} className="min-h-[3rem] w-full rounded-xl border border-border bg-background px-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60" />
          </div>
          <button type="submit" disabled={saving} className="flex min-h-[3rem] w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 xelay-btn">
            {saving && <Loader2 size={18} className="animate-spin" aria-hidden="true" />}{saving ? 'Зберігаємо…' : 'Зберегти новий пароль'}
          </button>
        </form>}
        {complete && <button type="button" disabled={saving} onClick={() => setShowAuth('login')} className="mt-6 min-h-[3rem] w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60 xelay-btn">Увійти</button>}
        {!complete && !isLoading && !recoveryReady && <button type="button" onClick={() => setShowAuth('recovery')} className="mt-6 min-h-[3rem] w-full rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 xelay-btn">Запросити нове посилання</button>}
        {!isLoading && <div className="mt-3 text-center"><Link to="/" className="inline-flex min-h-[2.5rem] items-center justify-center rounded-full px-4 text-sm text-muted-foreground hover:bg-muted xelay-btn">На головну</Link></div>}
      </section>
    </main>
  )
}
