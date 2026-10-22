import { useState, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { AuthModal } from './AuthModal'

// Place inside AdminSecurityGate, before ordinary platform content. The callback
// also uses this gate so a first Google login cannot skip profile completion.
export function GoogleRegistrationGate({ children }: { children: ReactNode }) {
  const { authUser, googleRegistrationStatus, refreshUser, signOut, isPasswordRecovery } = useAuth()
  const { notify } = useToast()
  const [busy, setBusy] = useState(false)
  if (!authUser || isPasswordRecovery || googleRegistrationStatus === 'ready') return <>{children}</>
  const logout = async () => {
    if (busy) return
    setBusy(true)
    try { await signOut() }
    catch { notify({ id: 'google-signout', tone: 'error', title: 'Не вдалося вийти', description: 'Перевірте з’єднання та спробуйте ще раз.' }) }
    finally { setBusy(false) }
  }
  if (googleRegistrationStatus === 'required') {
    const name = typeof authUser.user_metadata?.full_name === 'string' ? authUser.user_metadata.full_name : ''
    return <AuthModal key={authUser.id} onClose={() => void logout()} googleCompletion={{ userId: authUser.id, email: authUser.email || '', name }} />
  }
  return <main className="flex flex-1 items-center justify-center px-4 py-12">
    <section className="w-full max-w-md rounded-3xl border border-border bg-card p-6 text-center" aria-busy={googleRegistrationStatus === 'checking' || busy}>
      {googleRegistrationStatus === 'checking' && <Loader2 size={28} className="mx-auto mb-4 animate-spin text-primary" aria-hidden="true" />}
      <h1 className="text-xl font-semibold">{googleRegistrationStatus === 'checking' ? 'Перевіряємо профіль Xelay' : 'Не вдалося перевірити профіль'}</h1>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{googleRegistrationStatus === 'checking' ? 'Ще мить — готуємо ваш акаунт.' : 'Перевірте з’єднання та повторіть спробу, щоб безпечно продовжити вхід.'}</p>
      {googleRegistrationStatus === 'error' && <button type="button" disabled={busy} onClick={() => { setBusy(true); void refreshUser().finally(() => setBusy(false)) }} className="xelay-btn mt-5 min-h-12 w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-60">Перевірити ще раз</button>}
      <button type="button" disabled={busy} onClick={() => void logout()} className="xelay-btn mt-3 min-h-10 rounded-full px-4 text-sm text-muted-foreground disabled:opacity-60">Вийти з акаунта</button>
    </section>
  </main>
}
