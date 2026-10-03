import { useEffect, useRef, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { acceptEmailLink, emailLinkIdentity } from '../lib/authEmail'

export function EmailLinkConfirmation({ recovery = false, onAccepted }: { recovery?: boolean; onAccepted: (session: Session) => void | Promise<void> }) {
  const [email, setEmail] = useState('')
  const [invalid, setInvalid] = useState(false)
  const [busy, setBusy] = useState(false)
  const submitting = useRef(false)
  useEffect(() => {
    let active = true
    void emailLinkIdentity().then((user) => { if (active) setEmail(user.email!) }).catch(() => { if (active) setInvalid(true) })
    return () => { active = false }
  }, [])
  const accept = async () => {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    try { await onAccepted(await acceptEmailLink()) }
    catch { setInvalid(true) }
    finally { setBusy(false); submitting.current = false }
  }
  return <div className="mt-5 text-center" aria-live="polite">
    {invalid ? <p role="alert" className="text-sm text-destructive">Посилання недійсне або вже використане. Увійдіть до свого акаунта чи запросіть новий лист.</p>
      : !email ? <p className="text-sm text-muted-foreground">Перевіряємо посилання…</p>
        : <><p className="text-sm text-muted-foreground">{recovery ? 'Відновити пароль для цього акаунта?' : 'Продовжити з цим акаунтом?'}</p>
          <p className="mt-2 break-all font-semibold">{email}</p>
          <button type="button" disabled={busy} onClick={() => void accept()} className="xelay-btn mt-5 min-h-[3rem] w-full rounded-xl bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-60">{busy ? 'Зачекайте…' : 'Підтвердити та продовжити'}</button>
        </>}
  </div>
}
