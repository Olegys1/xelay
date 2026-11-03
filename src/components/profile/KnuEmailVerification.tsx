import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { BadgeCheck, ChevronDown, ChevronUp, GraduationCap, Loader2, Mail, RefreshCw, ShieldCheck } from 'lucide-react'
import { normalizeKnuEmail } from '../../lib/knuEmailPolicy'
import { KnuAffiliationError, knuAffiliationClient, knuAffiliationErrorMessage, type KnuAffiliationClient, type KnuAffiliationStatus } from '../../lib/knuAffiliation'

const inputClass = 'min-h-11 w-full rounded-xl border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/25 disabled:opacity-50'
const buttonClass = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50'

export interface KnuEmailVerificationProps {
  userId: string
  currentLoginEmail?: string
  client?: KnuAffiliationClient
  initialStatus?: KnuAffiliationStatus
  onVerified?(status: KnuAffiliationStatus): void | Promise<void>
}

/** The card never sends a letter before an explicit request button press. */
export function KnuEmailVerification(props: KnuEmailVerificationProps) {
  return <KnuEmailVerificationContent key={props.userId} {...props} />
}

function KnuEmailVerificationContent({ userId, currentLoginEmail, client = knuAffiliationClient, initialStatus, onVerified }: KnuEmailVerificationProps) {
  const id = useId()
  const [snapshot, setSnapshot] = useState<{ owner: string; status: KnuAffiliationStatus } | null>(initialStatus ? { owner: userId, status: initialStatus } : null)
  const status = snapshot?.owner === userId ? snapshot.status : null
  const [expanded, setExpanded] = useState(false)
  const [email, setEmail] = useState(''), [code, setCode] = useState('')
  const [busy, setBusy] = useState<'load' | 'request' | 'verify' | ''>('')
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [retryUntil, setRetryUntil] = useState(0), [now, setNow] = useState(Date.now())
  const [codeExpired, setCodeExpired] = useState(false), [editingEmail, setEditingEmail] = useState(false)
  const owner = useRef(userId); owner.current = userId
  const generation = useRef(0), lock = useRef(false), requestAbort = useRef<AbortController | null>(null)
  const initial = useRef(initialStatus); initial.current = initialStatus
  const codeInput = useRef<HTMLInputElement>(null)
  const challenge = status?.challenge && !editingEmail ? status.challenge : null
  const expired = Boolean(challenge && (codeExpired || Date.parse(challenge.expiresAt) <= now))
  const cooldown = Math.max(0, Math.ceil((Math.max(retryUntil, challenge ? Date.parse(challenge.resendAt) : 0) - now) / 1000))
  const remainingMinutes = challenge ? Math.max(0, Math.ceil((Date.parse(challenge.expiresAt) - now) / 60_000)) : 0

  useEffect(() => {
    const actor = userId, version = ++generation.current
    requestAbort.current?.abort(); requestAbort.current = null; lock.current = false
    setSnapshot(initial.current ? { owner: actor, status: initial.current } : null)
    setEmail(''); setCode(''); setError(''); setNotice(''); setBusy(''); setRetryUntil(0); setExpanded(false); setCodeExpired(false); setEditingEmail(false)
    const cleanup = () => { generation.current++; requestAbort.current?.abort(); lock.current = false }
    if (initial.current || !actor) return cleanup
    const controller = new AbortController(); requestAbort.current = controller
    setBusy('load'); lock.current = true
    void client.status(actor, controller.signal).then(value => {
      if (owner.current === actor && generation.current === version && !controller.signal.aborted) setSnapshot({ owner: actor, status: value })
    }).catch(failure => {
      if (owner.current === actor && generation.current === version && !controller.signal.aborted) setError(knuAffiliationErrorMessage(failure))
    }).finally(() => {
      if (owner.current === actor && generation.current === version) { lock.current = false; setBusy('') }
    })
    return cleanup
  }, [userId, client])

  useEffect(() => {
    if (!challenge && !retryUntil) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [challenge?.id, challenge?.expiresAt, retryUntil])

  async function run(kind: 'load' | 'request' | 'verify', action: (signal: AbortSignal) => Promise<KnuAffiliationStatus>) {
    if (lock.current || !userId) return
    const actor = userId, version = ++generation.current
    lock.current = true; setBusy(kind); setError(''); setNotice('')
    const controller = new AbortController(); requestAbort.current?.abort(); requestAbort.current = controller
    try {
      const next = await action(controller.signal)
      if (owner.current !== actor || generation.current !== version || controller.signal.aborted) return
      setSnapshot({ owner: actor, status: next }); setCode(''); setCodeExpired(false); setEditingEmail(false); setNow(Date.now()); setRetryUntil(0)
      if (kind === 'request') {
        setNotice('Код надіслано на університетську пошту. Перевірте також папку «Спам».')
        requestAnimationFrame(() => { if (owner.current === actor && generation.current === version) codeInput.current?.focus() })
      }
      if (kind === 'verify' && next.verifiedEmail) {
        setNotice('Пошту КНУ підтверджено для цього профілю.'); setExpanded(false)
        await onVerified?.(next)
      }
    } catch (failure) {
      if (owner.current !== actor || generation.current !== version || controller.signal.aborted) return
      setError(knuAffiliationErrorMessage(failure))
      if (failure instanceof KnuAffiliationError) {
        if (failure.retryAfterSeconds > 0) { setRetryUntil(Date.now() + failure.retryAfterSeconds * 1000); setNow(Date.now()) }
        if (failure.code === 'KNU_EMAIL_CODE_EXPIRED') setCodeExpired(true)
        if (failure.code === 'KNU_EMAIL_CODE_INVALID') { setCode(''); codeInput.current?.focus() }
      }
    } finally {
      if (owner.current === actor && generation.current === version) { lock.current = false; setBusy('') }
    }
  }

  function requestCode(event?: FormEvent, resend = false) {
    event?.preventDefault()
    if (cooldown || busy) return
    const target = normalizeKnuEmail(resend ? challenge?.email || '' : email)
    if (!target) { setError(knuAffiliationErrorMessage(new KnuAffiliationError('KNU_EMAIL_INVALID'))); return }
    void run('request', signal => client.request(userId, target, signal))
  }
  function verifyCode(event: FormEvent) {
    event.preventDefault()
    if (!challenge || expired || busy) return
    if (!/^\d{6}$/.test(code)) { setError('Введіть шість цифр із листа.'); codeInput.current?.focus(); return }
    void run('verify', signal => client.verify(userId, challenge.id, code, signal))
  }

  if (!userId) return null
  const opened = expanded || Boolean(challenge)
  return <section aria-labelledby={`${id}-title`} className="xelay-card mb-6 overflow-hidden border border-primary/20">
    <div className="flex items-start gap-3 p-4 sm:p-5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary" aria-hidden="true">{status?.verifiedEmail ? <BadgeCheck size={22} /> : <GraduationCap size={22} />}</span>
      <div className="min-w-0 flex-1">
        <h2 id={`${id}-title`} className="text-sm font-semibold">{status?.verifiedEmail ? 'Пошту КНУ підтверджено' : 'Підтвердьте належність до КНУ'}</h2>
        {status?.verifiedEmail ? <><p className="mt-1 break-all text-sm font-medium text-primary">{status.verifiedEmail}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Адресу додано до вашого поточного профілю. Вона не відображається у відкритому профілі.</p></> : <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Маєте університетську пошту? Додайте її до цього акаунта та підтвердьте кодом із листа.</p>}
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{currentLoginEmail ? <>Вхід залишається через <span className="break-all font-medium">{currentLoginEmail}</span>. </> : 'Спосіб входу залишається поточним. '}Ваші групи, матеріали та бали збережуться.</p>
      </div>
      {!status?.verifiedEmail && <button type="button" aria-expanded={opened} aria-controls={`${id}-content`} onClick={() => setExpanded(value => !value)} disabled={Boolean(challenge) || busy === 'load'} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-primary hover:bg-primary/10 disabled:opacity-40" aria-label={opened ? 'Згорнути підтвердження пошти КНУ' : 'Відкрити підтвердження пошти КНУ'}>{opened ? <ChevronUp size={18} /> : <ChevronDown size={18} />}</button>}
    </div>
    {busy === 'load' && <p role="status" className="flex items-center gap-2 px-4 pb-4 text-xs text-muted-foreground sm:px-5"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />Перевіряємо підтвердження пошти…</p>}
    {!opened && !status?.verifiedEmail && busy !== 'load' && <div className="px-4 pb-4 sm:px-5"><button type="button" onClick={() => setExpanded(true)} className={`${buttonClass} border border-primary/25 text-primary hover:bg-primary/5`}><Mail size={16} aria-hidden="true" />Додати пошту КНУ</button></div>}
    {opened && !status?.verifiedEmail && <div id={`${id}-content`} className="space-y-4 border-t border-border bg-muted/15 p-4 sm:p-5">
      {challenge ? <form onSubmit={verifyCode} className="space-y-3">
        <p className="text-sm leading-relaxed">Код підтвердження для <strong className="break-all">{challenge.email}</strong></p>
        <label htmlFor={`${id}-code`} className="block text-sm font-medium">Код із листа</label>
        <div className="flex flex-col gap-2 sm:flex-row"><input ref={codeInput} id={`${id}-code`} name="knu-email-code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} disabled={Boolean(busy) || expired} onChange={event => { setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6)); setError('') }} placeholder="000000" aria-describedby={`${id}-code-help`} className={`${inputClass} tracking-[0.3em] sm:max-w-52`} /><button type="submit" disabled={Boolean(busy) || expired || code.length !== 6} className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`}>{busy === 'verify' ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ShieldCheck size={16} aria-hidden="true" />}{busy === 'verify' ? 'Підтверджуємо…' : 'Підтвердити'}</button></div>
        <p id={`${id}-code-help`} className="text-xs leading-relaxed text-muted-foreground">{expired ? 'Термін дії цього коду завершився. Запросіть новий лист.' : `Код діє ще до ${remainingMinutes} хв. Використайте код з останнього листа.`}</p>
        <div className="flex flex-wrap gap-2"><button type="button" onClick={() => requestCode(undefined, true)} disabled={Boolean(busy) || cooldown > 0} className={`${buttonClass} border border-border hover:bg-muted`}>{busy === 'request' ? <Loader2 size={15} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}{cooldown > 0 ? `Новий лист через ${cooldown} с` : 'Надіслати код ще раз'}</button><button type="button" disabled={Boolean(busy)} onClick={() => { setEmail(challenge.email); setEditingEmail(true); setCode(''); setError(''); setNotice('') }} className={`${buttonClass} text-primary hover:bg-primary/5`}>Змінити адресу</button></div>
      </form> : <form onSubmit={event => requestCode(event)} className="space-y-3">
        <label htmlFor={`${id}-email`} className="block text-sm font-medium">Університетська пошта</label>
        <input id={`${id}-email`} name="knu-affiliation-email" type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={254} required value={email} disabled={Boolean(busy)} onChange={event => { setEmail(event.target.value); setError('') }} placeholder="name@knu.ua" aria-describedby={`${id}-email-help`} className={inputClass} />
        <p id={`${id}-email-help`} className="text-xs leading-relaxed text-muted-foreground">Використайте адресу з доменом @knu.ua. Ця адреса залишиться приватною.</p>
        <button type="submit" disabled={Boolean(busy) || cooldown > 0} className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`}>{busy === 'request' ? <Loader2 size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Mail size={16} aria-hidden="true" />}{busy === 'request' ? 'Надсилаємо…' : cooldown > 0 ? `Повторити через ${cooldown} с` : 'Надіслати код'}</button>
      </form>}
      <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground"><ShieldCheck size={14} className="mt-0.5 shrink-0" aria-hidden="true" />Підтвердження пошти не надає статус викладача або старости. Для цих ролей діє окрема перевірка.</p>
    </div>}
    {(error || notice) && <div className="px-4 pb-4 sm:px-5">{error && <p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs leading-relaxed text-destructive">{error}</p>}{notice && <p role="status" className="mt-2 text-xs leading-relaxed text-primary">{notice}</p>}{error && <button type="button" disabled={Boolean(busy)} onClick={() => void run('load', signal => client.status(userId, signal))} className="mt-2 inline-flex min-h-9 items-center gap-1.5 rounded-full px-2 text-xs font-medium text-primary hover:bg-primary/5 disabled:opacity-50"><RefreshCw size={13} aria-hidden="true" />Оновити статус</button>}</div>}
  </section>
}
