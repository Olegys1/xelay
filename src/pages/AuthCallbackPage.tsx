import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { CheckCircle2, Loader2, MailWarning } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { initialAuthEmailLink } from '../lib/authEmail'
import { registrationUsernameNotice } from '../lib/authRegistration'
import { EmailLinkConfirmation } from '../components/EmailLinkConfirmation'
import { AuthModal } from '../components/AuthModal'
import { acceptGoogleCallback, beginGoogleSignIn, googleAuthEnabled, googleAuthFailure, initialGoogleCallback } from '../lib/authGoogle'
import { GoogleRegistrationGate } from '../components/GoogleRegistrationGate'
import { supabase } from '../lib/supabase'

export function AuthCallbackPage() {
  return initialGoogleCallback.active ? <GoogleAuthCallback /> : <EmailAuthCallback />
}

function GoogleAuthCallback() {
  const { refreshUser, authUser, xelayUser } = useAuth()
  const [status, setStatus] = useState<'checking' | 'confirmed' | 'error'>('checking')
  const [acceptedUserId, setAcceptedUserId] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [showAuth, setShowAuth] = useState(false)
  useEffect(() => {
    let active = true
    void acceptGoogleCallback().then(async (userId) => {
      const current = await supabase.auth.getSession()
      if (current.error || current.data.session?.user.id !== userId) throw new Error('GOOGLE_SESSION_CHANGED')
      await refreshUser()
      if (active) { setAcceptedUserId(userId); setStatus('confirmed') }
    }).catch((failure) => {
      if (active) { setError(googleAuthFailure(failure)); setStatus('error') }
    })
    return () => { active = false }
  }, [refreshUser])
  const retry = async () => {
    if (retrying) return
    setRetrying(true)
    try { await beginGoogleSignIn() }
    catch (failure) { setError(googleAuthFailure(failure)); setStatus('error'); setRetrying(false) }
  }
  const confirmed = status === 'confirmed' && acceptedUserId === authUser?.id
  const sessionEnded = status === 'confirmed' && !confirmed
  const content = <main className="flex flex-1 items-center justify-center px-4 py-12 sm:py-20">
    {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
    <section className="w-full max-w-md rounded-3xl border border-border bg-card px-5 py-8 text-center shadow-[var(--panel-shadow)] sm:px-8" aria-live="polite" aria-busy={status === 'checking' || retrying}>
      <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
        {status === 'checking' ? <Loader2 size={30} className="animate-spin" aria-hidden="true" /> : confirmed ? <CheckCircle2 size={30} aria-hidden="true" /> : <MailWarning size={30} aria-hidden="true" />}
      </div>
      <h1 className="text-2xl font-semibold text-foreground">{status === 'checking' ? 'Входимо через Google' : confirmed ? 'Ви увійшли до Xelay' : sessionEnded ? authUser ? 'Сеанс Xelay змінено' : 'Ви вийшли з акаунта' : 'Не вдалося завершити вхід'}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{status === 'checking' ? 'Перевіряємо вхід і готуємо ваш профіль.' : confirmed ? 'Ваш акаунт готовий. Можна продовжувати.' : sessionEnded ? authUser ? 'Поверніться на головну, щоб продовжити з поточним акаунтом.' : 'Завершити створення профілю можна після наступного входу.' : error}</p>
      {confirmed && <Link to={xelayUser?.accountType === 'teacher' ? '/teaching' : '/news'} className="xelay-btn mt-6 inline-flex min-h-12 w-full items-center justify-center rounded-xl bg-primary px-4 font-semibold text-primary-foreground hover:bg-primary/90">Перейти до Xelay</Link>}
      {(status === 'error' || sessionEnded && !authUser) && <>
        {googleAuthEnabled && <button type="button" disabled={retrying} onClick={() => void retry()} className="xelay-btn mt-6 min-h-12 w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-60">{retrying ? 'Зачекайте…' : 'Спробувати Google ще раз'}</button>}
        <button type="button" disabled={retrying} onClick={() => setShowAuth(true)} className="xelay-btn mt-3 min-h-12 w-full rounded-xl border border-border px-4 font-semibold">Увійти за допомогою пошти</button>
      </>}
      {status !== 'checking' && <Link to="/" className="xelay-btn mt-3 inline-flex min-h-10 items-center justify-center rounded-full px-4 text-sm text-muted-foreground hover:bg-muted">На головну</Link>}
    </section>
  </main>
  return confirmed ? <GoogleRegistrationGate>{content}</GoogleRegistrationGate> : content
}

function EmailAuthCallback() {
  const { refreshUser, authUser, xelayUser } = useAuth()
  const [status, setStatus] = useState<'checking' | 'confirmed' | 'invalid'>(initialAuthEmailLink.isConfirmation && !initialAuthEmailLink.hasError ? 'checking' : 'invalid')
  const [showAuth, setShowAuth] = useState(false)
  const [confirmedTeacher, setConfirmedTeacher] = useState(false)
  const usernameNotice = registrationUsernameNotice(authUser, xelayUser)
  // This selects the next page only; teaching permissions remain server checked.
  const teacherDestination = confirmedTeacher || xelayUser?.accountType === 'teacher' || xelayUser?.isTeacher === true || authUser?.user_metadata?.account_type === 'teacher'

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12 sm:py-20">
      {showAuth && <AuthModal onClose={() => setShowAuth(false)} />}
      <section className="w-full max-w-md rounded-3xl border border-border bg-card px-5 py-8 text-center shadow-[var(--panel-shadow)] sm:px-8" aria-live="polite">
        <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {status === 'checking' ? <Loader2 size={30} className="animate-spin" aria-hidden="true" /> : status === 'confirmed' ? <CheckCircle2 size={30} aria-hidden="true" /> : <MailWarning size={30} aria-hidden="true" />}
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{status === 'checking' ? 'Підтвердіть акаунт' : status === 'confirmed' ? 'Пошту підтверджено' : 'Посилання недійсне'}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
          {status === 'checking' ? 'Перевірте адресу пошти перед продовженням.' : status === 'confirmed' ? teacherDestination ? 'Пошту підтверджено. Перейдіть до викладання, щоб переглянути статус перевірки та наступний крок підключення групи.' : 'Реєстрацію завершено. Ваш профіль готовий — приєднуйтеся до університетської спільноти.' : 'Посилання могло застаріти або вже бути використаним. Спробуйте увійти: якщо пошту ще не підтверджено, можна повторно надіслати лист.'}
        </p>
        {status === 'checking' && <EmailLinkConfirmation onAccepted={async (session) => { setConfirmedTeacher(session.user.user_metadata?.account_type === 'teacher'); await refreshUser(); setStatus('confirmed') }} />}
        {status === 'confirmed' && usernameNotice && <p className="mt-4 break-words text-sm leading-relaxed text-foreground">{usernameNotice}</p>}
        {status === 'confirmed' && <Link to={teacherDestination ? '/teaching' : '/news'} className="mt-6 inline-flex min-h-[3rem] w-full items-center justify-center rounded-xl bg-primary px-4 font-semibold text-primary-foreground transition-colors hover:bg-primary/90 xelay-btn">{teacherDestination ? 'Перейти до викладання' : 'Перейти до Xelay'}</Link>}
        {status !== 'confirmed' && <button type="button" onClick={() => setShowAuth(true)} className="mt-6 min-h-[3rem] w-full rounded-xl border border-border px-4 font-semibold transition-colors hover:bg-muted xelay-btn">Перейти до входу</button>}
        {status !== 'checking' && <Link to="/" className="mt-3 inline-flex min-h-[2.5rem] items-center justify-center rounded-full px-4 text-sm text-muted-foreground hover:bg-muted xelay-btn">На головну</Link>}
      </section>
    </main>
  )
}
