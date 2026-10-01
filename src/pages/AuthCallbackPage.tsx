import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, Loader2, MailWarning } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { authEmailConfirmedUserId, initialAuthEmailLink } from '../lib/authEmail'
import { AuthModal } from '../components/AuthModal'

export function AuthCallbackPage() {
  const { refreshUser } = useAuth()
  const [status, setStatus] = useState<'checking' | 'confirmed' | 'invalid'>('checking')
  const [showAuth, setShowAuth] = useState(false)

  useEffect(() => {
    let active = true
    const checkConfirmation = async () => {
      if (initialAuthEmailLink.hasError || !initialAuthEmailLink.isConfirmation) {
        setStatus('invalid')
        return
      }
      try {
        // Let URL session initialization emit its auth event before checking its user.
        await supabase.auth.getSession()
        await new Promise((resolve) => window.setTimeout(resolve, 0))
        const { data, error } = await supabase.auth.getUser()
        if (!active) return
        if (error || !data.user?.email_confirmed_at || data.user.id !== authEmailConfirmedUserId()) {
          setStatus('invalid')
          return
        }
        setStatus('confirmed')
        void refreshUser()
      } catch {
        if (active) setStatus('invalid')
      }
    }
    void checkConfirmation()
    return () => { active = false }
  }, [refreshUser])

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12 sm:py-20">
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      <section className="w-full max-w-md rounded-3xl border border-border bg-card px-5 py-8 text-center shadow-[var(--panel-shadow)] sm:px-8" aria-live="polite">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {status === 'checking' ? <Loader2 size={30} className="animate-spin" aria-hidden="true" /> : status === 'confirmed' ? <CheckCircle2 size={30} aria-hidden="true" /> : <MailWarning size={30} aria-hidden="true" />}
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{status === 'checking' ? 'Підтверджуємо пошту…' : status === 'confirmed' ? 'Пошту підтверджено' : 'Посилання недійсне'}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {status === 'checking' ? 'Зачекайте, перевіряємо посилання з листа.' : status === 'confirmed' ? 'Реєстрацію завершено. Ваш профіль готовий — приєднуйтеся до університетської спільноти.' : 'Посилання могло застаріти або вже бути використаним. Спробуйте увійти: якщо пошту ще не підтверджено, можна повторно надіслати лист.'}
        </p>
        {status === 'confirmed' && <Link to="/news" className="mt-6 inline-flex min-h-[3rem] w-full items-center justify-center rounded-xl bg-primary px-4 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 xelay-btn">Перейти до Xelay</Link>}
        {status === 'invalid' && <button type="button" onClick={() => setShowAuth(true)} className="mt-6 min-h-[3rem] w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 xelay-btn">Перейти до входу</button>}
        {status !== 'checking' && <Link to="/" className="mt-3 inline-flex min-h-[2.5rem] items-center justify-center rounded-full px-4 text-sm text-muted-foreground hover:bg-muted xelay-btn">На головну</Link>}
      </section>
    </main>
  )
}
