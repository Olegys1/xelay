import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { supabase } from '../lib/supabase'

// The recovery email proves the first factor. Accounts with MFA still need AAL2.
// This gate verifies an existing factor; it never enrolls or removes factors.
export function PasswordRecoveryMfa({ userId, required = false, children }: {
  userId: string; required?: boolean; children: ReactNode
}) {
  const [state, setState] = useState<'checking' | 'ready' | 'challenge' | 'error'>('checking')
  const [factors, setFactors] = useState<{ id: string; name: string }[]>([])
  const [factorId, setFactorId] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const lock = useRef(false)
  const codeId = useId()
  const factorSelectId = useId()

  const check = useCallback(async () => {
    const request = ++generation.current
    const current = () => mounted.current && generation.current === request
    setState('checking')
    try {
      const [assurance, enrolled] = await Promise.all([
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(), supabase.auth.mfa.listFactors(),
      ])
      if (!current()) return
      if (assurance.error || enrolled.error || !assurance.data.currentLevel) throw new Error('MFA check failed')
      const verified = enrolled.data.all.filter((factor) => factor.status === 'verified')
      const totp = enrolled.data.totp.filter((factor) => factor.status === 'verified')
        .map((factor, index) => ({ id: factor.id, name: factor.friendly_name || `Застосунок ${index + 1}` }))
      setFactors(totp)
      setFactorId(totp[0]?.id || '')
      setError('')
      setState(assurance.data.currentLevel === 'aal2' || (!required && !verified.length && assurance.data.nextLevel !== 'aal2') ? 'ready' : 'challenge')
    } catch {
      if (current()) {
        setState('error')
        setError('Не вдалося перевірити двофакторний захист. Спробуйте ще раз.')
      }
    }
  }, [required])

  useEffect(() => {
    mounted.current = true
    const timers = new Set<ReturnType<typeof setTimeout>>()
    void check()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      // Auth callbacks must return before making another Auth request.
      const timer = setTimeout(() => { timers.delete(timer); if (!lock.current) void check() }, 0)
      timers.add(timer)
    })
    return () => {
      mounted.current = false
      generation.current += 1
      timers.forEach(clearTimeout)
      subscription.unsubscribe()
    }
  }, [check])

  const verify = async (event: React.FormEvent) => {
    event.preventDefault()
    if (lock.current || !factorId || !/^\d{6}$/.test(code)) return
    lock.current = true
    setBusy(true)
    setError('')
    try {
      const result = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
      if (!mounted.current) return
      if (result.error) throw result.error
      if (result.data.user.id !== userId) throw new Error('Recovery account changed')
      setCode('')
      await check()
    } catch (failure) {
      if (!mounted.current) return
      const errorCode = typeof failure === 'object' && failure !== null && 'code' in failure ? String(failure.code) : ''
      setError(['mfa_verification_failed', 'mfa_challenge_expired', 'mfa_ip_address_mismatch'].includes(errorCode)
        ? 'Код недійсний або час його дії минув. Введіть поточні 6 цифр із застосунку автентифікації.'
        : 'Не вдалося підтвердити двофакторний захист. Перевірте з’єднання та спробуйте ще раз.')
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }

  if (state === 'ready') return <>{children}</>
  if (state === 'checking') return <p role="status" className="mt-6 flex items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 size={16} className="animate-spin" aria-hidden="true" />Перевіряємо захист акаунта…</p>
  return <div className="mt-6 rounded-2xl border border-border bg-muted/30 p-4" aria-busy={busy}>
    <h2 className="flex items-center gap-2 text-sm font-semibold"><ShieldCheck size={18} className="text-primary" aria-hidden="true" />Підтвердіть двофакторний захист</h2>
    <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Для зміни пароля цього акаунта потрібен код із застосунку автентифікації. Після підтвердження відкриється форма нового пароля.</p>
    {state === 'challenge' && factors.length > 0 && <form onSubmit={verify} className="mt-4 space-y-3">
      {factors.length > 1 && <div><label htmlFor={factorSelectId} className="mb-2 block text-sm font-medium">Застосунок автентифікації</label><select id={factorSelectId} value={factorId} disabled={busy} onChange={(event) => { setFactorId(event.target.value); setCode(''); setError('') }} className="min-h-12 w-full rounded-xl border border-border bg-background px-3">{factors.map((factor) => <option key={factor.id} value={factor.id}>{factor.name}</option>)}</select></div>}
      <label htmlFor={codeId} className="block text-sm font-medium">Код із застосунку · 6 цифр</label>
      <input id={codeId} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} disabled={busy} onChange={(event) => { setCode(event.target.value.replace(/\D/g, '')); setError('') }} className="min-h-12 w-full rounded-xl border border-border bg-background text-center text-xl tracking-widest focus:outline-none focus:ring-2 focus:ring-primary/20" />
      <button disabled={busy || code.length !== 6} className="xelay-btn min-h-12 w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-60">{busy ? 'Перевіряємо…' : 'Підтвердити код'}</button>
    </form>}
    {state === 'challenge' && factors.length === 0 && <p role="alert" className="mt-3 text-sm leading-relaxed text-destructive">Немає доступного застосунку автентифікації для цього акаунта. Зверніться до підтримки Xelay для перевірки доступу.</p>}
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    <button type="button" disabled={busy} onClick={() => void check()} className="mt-3 min-h-10 rounded-full px-3 text-sm text-primary hover:bg-primary/5 disabled:opacity-60">Перевірити знову</button>
  </div>
}
