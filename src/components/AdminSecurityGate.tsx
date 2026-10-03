import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'

export function AdminSecurityGate({ children }: { children: ReactNode }) {
  const { xelayUser, authUser, isLoading, signOut, refreshUser } = useAuth()
  const [ready, setReady] = useState(false)
  const [factorId, setFactorId] = useState('')
  const [enrollment, setEnrollment] = useState<{ qr: string; secret: string } | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const mounted = useRef(false)
  const generation = useRef(0)
  const currentUser = useRef(authUser?.id)
  currentUser.current = authUser?.id
  const check = useCallback(async () => {
    if (!xelayUser?.isPlatformAdmin) return
    const request = ++generation.current
    const userId = authUser?.id
    const current = () => mounted.current && request === generation.current && currentUser.current === userId
    try {
      const [assurance, factors] = await Promise.all([supabase.auth.mfa.getAuthenticatorAssuranceLevel(), supabase.auth.mfa.listFactors()])
      if (!current()) return
      if (assurance.error || factors.error) throw new Error('MFA unavailable')
      const verified = factors.data.totp.find((factor) => factor.status === 'verified')
      setFactorId(verified?.id || '')
      setReady(Boolean(verified && assurance.data.currentLevel === 'aal2'))
      setError('')
    } catch { if (current()) { setReady(false); setError('Не вдалося перевірити захист акаунта. Спробуйте ще раз.') } }
  }, [xelayUser?.isPlatformAdmin, authUser?.id])
  useEffect(() => {
    mounted.current = true
    const timers = new Set<ReturnType<typeof setTimeout>>()
    setReady(false); setEnrollment(null); setCode(''); setFactorId('')
    void check()
    const { data: { subscription } } = supabase.auth.onAuthStateChange(() => {
      const timer = setTimeout(() => { timers.delete(timer); void check() }, 0)
      timers.add(timer)
    })
    return () => { mounted.current = false; generation.current += 1; timers.forEach(clearTimeout); subscription.unsubscribe() }
  }, [check])
  const enroll = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    const userId = authUser?.id
    const current = () => mounted.current && currentUser.current === userId
    try {
      // An interrupted unverified enrollment cannot grant admin privileges.
      const factors = await supabase.auth.mfa.listFactors()
      if (!current()) return
      if (factors.error) throw factors.error
      for (const factor of factors.data.all.filter((item) => item.factor_type === 'totp' && item.status === 'unverified')) {
        const removed = await supabase.auth.mfa.unenroll({ factorId: factor.id })
        if (!current()) return
        if (removed.error) throw removed.error
      }
      const result = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Xelay administrator' })
      if (!current()) return
      if (result.error) throw result.error
      setFactorId(result.data.id)
      setEnrollment({ qr: result.data.totp.qr_code, secret: result.data.totp.secret })
    } catch { if (current()) setError('Не вдалося налаштувати захист. Спробуйте ще раз.') }
    finally { lock.current = false; if (current()) setBusy(false) }
  }
  const verify = async (event: React.FormEvent) => {
    event.preventDefault()
    if (lock.current || !/^\d{6}$/.test(code) || !factorId) return
    lock.current = true; setBusy(true); setError('')
    const userId = authUser?.id
    const current = () => mounted.current && currentUser.current === userId
    try {
      const result = await supabase.auth.mfa.challengeAndVerify({ factorId, code })
      if (!current()) return
      if (result.error) throw result.error
      setEnrollment(null); setCode(''); await refreshUser(); await check()
    } catch { if (current()) setError('Код недійсний або час його дії минув. Введіть поточний код із застосунку.') }
    finally { lock.current = false; if (current()) setBusy(false) }
  }
  if (!xelayUser?.isPlatformAdmin) return <>{children}</>
  if (ready && !isLoading) return <>{children}</>
  return <main className="flex flex-1 items-center justify-center px-4 py-12">
    <section className="w-full max-w-md rounded-3xl border border-border bg-card p-6 text-center" aria-busy={busy}>
      <ShieldCheck className="mx-auto mb-4 text-primary" size={32} />
      <h1 className="text-xl font-semibold">Захист акаунта адміністратора</h1>
      <p className="mt-3 text-sm text-muted-foreground">Для адміністративного доступу потрібен код із застосунку автентифікації.</p>
      {enrollment && <div className="mt-5">
        <p className="mb-3 text-sm">Додайте Xelay до застосунку автентифікації: відскануйте QR-код або введіть ключ вручну.</p>
        <img src={enrollment.qr} alt="QR-код для налаштування захисту вашого акаунта" className="mx-auto h-48 w-48 bg-white p-2" />
        <code className="mt-3 block break-all rounded-xl bg-muted p-3 text-sm select-all">{enrollment.secret}</code>
      </div>}
      {factorId ? <form onSubmit={verify} className="mt-5 space-y-3">
        <label htmlFor="admin-totp-code" className="block text-sm font-medium">Код із застосунку</label>
        <input id="admin-totp-code" autoComplete="one-time-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g,''))} disabled={busy} className="min-h-12 w-full rounded-xl border border-border bg-background text-center text-xl tracking-widest" />
        <button disabled={busy || code.length !== 6} className="xelay-btn min-h-12 w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-60">{busy ? 'Перевіряємо…' : 'Підтвердити'}</button>
      </form> : <button type="button" disabled={busy || isLoading} onClick={() => void enroll()} className="xelay-btn mt-5 min-h-12 w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-60">Налаштувати захист</button>}
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex justify-center gap-4 text-sm">
        <button type="button" disabled={busy} onClick={() => void check()}>Перевірити знову</button>
        <button type="button" disabled={busy} onClick={() => void signOut().catch(() => setError('Не вдалося вийти. Спробуйте ще раз.'))}>Вийти</button>
      </div>
    </section>
  </main>
}
