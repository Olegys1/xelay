import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ArrowRight, BriefcaseBusiness, Building2, CheckCircle2, Eye, EyeOff, FileText, LoaderCircle, Mail, ShieldCheck, X } from 'lucide-react'
import { CareerModal, Field } from './shared'
import { OPPORTUNITIES_TERMS, OPPORTUNITIES_TERMS_UPDATED_AT, OPPORTUNITIES_TERMS_VERSION } from '../../lib/opportunities/opportunitiesTerms'
import './Opportunities.css'
import './BusinessPanels.css'

interface CompanyAccountPanelProps {
  mode: 'local' | 'supabase'
  onReady: () => void
  onClose?: () => void
}
type AccountView = 'form' | 'confirmation' | 'ready' | 'recovery' | 'recoverySent'

/** Separate business entry point. Local mode never calls auth, persists a
 * password, creates an account or sends email; production stays unmounted. */
export function CompanyAccountPanel({ mode, onReady, onClose }: CompanyAccountPanelProps) {
  const prefix = useId(); const generation = useRef(0); const submitting = useRef(false)
  const [formMode, setFormMode] = useState<'register' | 'login'>('register')
  const [view, setView] = useState<AccountView>('form'); const [fullName, setFullName] = useState(''); const [companyName, setCompanyName] = useState('')
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [consent, setConsent] = useState(false); const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [terms, setTerms] = useState(false); const [resendWait, setResendWait] = useState(0)
  const local = mode === 'local'
  useEffect(() => { generation.current += 1; submitting.current = false; setBusy(false); setError(''); setNotice(''); setView('form'); setPassword(''); return () => { generation.current += 1 } }, [mode])
  useEffect(() => { if (resendWait <= 0) return; const timer = setTimeout(() => setResendWait(value => Math.max(0, value - 1)), 1000); return () => clearTimeout(timer) }, [resendWait])
  function switchMode(next: typeof formMode) { if (busy) return; setFormMode(next); setView('form'); setError(''); setNotice(''); setPassword(''); setVisible(false) }
  const validEmail = () => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  async function submit(event: FormEvent) {
    event.preventDefault(); if (submitting.current) return
    setError(''); setNotice('')
    if (!validEmail()) { setError('Вкажіть коректну робочу електронну пошту.'); return }
    if (password.length < 8) { setError('Пароль має містити щонайменше 8 символів.'); return }
    if (formMode === 'register' && (fullName.trim().length < 2 || companyName.trim().length < 2 || !consent)) { setError('Заповніть ім’я та назву компанії й підтвердьте умови.'); return }
    submitting.current = true; setBusy(true); const current = generation.current
    try {
      if (local) {
        await new Promise(resolve => setTimeout(resolve, 300))
        if (current !== generation.current) return
        setPassword(''); setVisible(false)
        if (formMode === 'register') setView('confirmation'); else onReady()
        return
      }
      if (formMode === 'register') {
        const { registerOpportunityCompanyAccount } = await import('../../lib/opportunities/supabaseRepository')
        if (current !== generation.current) return
        const result = await registerOpportunityCompanyAccount({ fullName, companyName, email, password, consent })
        if (current !== generation.current) return
        setEmail(result.email); setPassword(''); setVisible(false)
        if (result.confirmationRequired) { const { startAuthEmailCooldown } = await import('../../lib/authEmail'); if (current !== generation.current) return; startAuthEmailCooldown('signup'); setResendWait(60); setView('confirmation') } else setView('ready')
      } else {
        const { supabase } = await import('../../lib/supabase')
        if (current !== generation.current) return
        const result = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password })
        if (result.error) throw result.error
        if (current !== generation.current) return
        setPassword(''); setVisible(false); onReady()
      }
    } catch (reason) {
      if (current !== generation.current) return
      const message = reason instanceof Error ? reason.message : ''
      if (/email.*not.*confirmed/i.test(message)) { setView('confirmation'); setPassword(''); setNotice('Підтвердьте пошту, щоб відкрити кабінет компанії.') }
      else if (/invalid.*credentials|invalid.*login|credentials/i.test(message)) setError('Неправильна пошта або пароль. Перевірте дані та спробуйте ще раз.')
      else if (/rate|too many|after.*seconds/i.test(message)) setError('Забагато спроб. Зачекайте хвилину й повторіть дію.')
      else if (/fetch|network|connection/i.test(message)) setError('Не вдалося з’єднатися з Xelay. Перевірте інтернет і спробуйте ще раз.')
      else setError(formMode === 'register' && message ? message : 'Не вдалося увійти. Перевірте дані та спробуйте ще раз.')
    } finally { if (current === generation.current) { submitting.current = false; setBusy(false) } }
  }
  async function resend() {
    if (local || busy || resendWait > 0 || !validEmail()) return
    submitting.current = true; setBusy(true); setError(''); setNotice(''); const current = generation.current
    try {
      const [{ supabase }, { authEmailRedirect, authEmailCooldown, startAuthEmailCooldown }] = await Promise.all([import('../../lib/supabase'), import('../../lib/authEmail')])
      if (current !== generation.current) return
      const remaining = authEmailCooldown('signup'); if (remaining) { setResendWait(remaining); return }
      const { error: resendError } = await supabase.auth.resend({ type: 'signup', email: email.trim().toLowerCase(), options: { emailRedirectTo: authEmailRedirect('/auth/callback') } })
      if (resendError) throw resendError
      if (current !== generation.current) return
      startAuthEmailCooldown('signup'); setResendWait(60); setNotice('Лист надіслано повторно. Відкрийте посилання з найновішого листа.')
    } catch { if (current === generation.current) setError('Не вдалося надіслати лист повторно. Зачекайте хвилину та спробуйте ще раз.') }
    finally { if (current === generation.current) { submitting.current = false; setBusy(false) } }
  }
  async function recovery(event: FormEvent) {
    event.preventDefault(); if (submitting.current || !validEmail()) return
    submitting.current = true; setBusy(true); setError(''); const current = generation.current
    try {
      if (local) { setView('recoverySent'); return }
      const [{ supabase }, { authEmailRedirect, authEmailCooldown, startAuthEmailCooldown }] = await Promise.all([import('../../lib/supabase'), import('../../lib/authEmail')])
      if (current !== generation.current) return
      const remaining = authEmailCooldown('recovery'); if (remaining) { setError(`Новий лист можна запросити через ${remaining} с.`); return }
      const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo: authEmailRedirect('/reset-password') })
      if (recoveryError) throw recoveryError
      if (current !== generation.current) return
      startAuthEmailCooldown('recovery'); setView('recoverySent')
    } catch { if (current === generation.current) setError('Не вдалося запросити лист. Перевірте з’єднання та спробуйте пізніше.') }
    finally { if (current === generation.current) { submitting.current = false; setBusy(false) } }
  }
  return <section className="op-workspace op-company-account">
    <header className="op-company-account-top"><span className="op-company-account-wordmark">Xelay <small>для компаній</small></span>{onClose && <button type="button" className="op-icon-button" onClick={onClose} aria-label="Закрити реєстрацію компанії"><X size={20} /></button>}</header>
    {local && <div className="op-company-account-local"><ShieldCheck size={17} /><p><strong>Локальна демонстрація.</strong> Використовуйте тестові дані й тестовий пароль. Обліковий запис не створюється, пароль не зберігається, листи й платежі не надсилаються.</p></div>}
    <div className="op-company-account-grid"><aside className="op-company-account-about"><span className="op-eyebrow">МОЖЛИВОСТІ XELAY</span><h1>Команда, яку<br />студенти<br /><em>запам’ятають.</em></h1><p>Окремий кабінет бізнесу для знайомства зі студентами та публікації корисних пропозицій.</p><ul><li><Building2 size={20} /><div><strong>Сторінка компанії</strong><span>Зрозуміла інформація та перевірка представника.</span></div></li><li><BriefcaseBusiness size={20} /><div><strong>Вакансії та стажування</strong><span>Чіткі умови, строки й добровільні відгуки.</span></div></li><li><FileText size={20} /><div><strong>Резюме за згодою студента</strong><span>Окремо від його навчального профілю.</span></div></li></ul><div className="op-company-account-next"><span>Після входу</span><p>Заповніть сторінку компанії → пройдіть перевірку → подайте першу пропозицію.</p></div></aside>
      <div className="op-card op-company-account-card">
        {view === 'form' && <><nav className="op-company-account-tabs" aria-label="Вхід для компаній"><button disabled={busy} className={formMode === 'register' ? 'is-active' : ''} onClick={() => switchMode('register')}>Реєстрація компанії</button><button disabled={busy} className={formMode === 'login' ? 'is-active' : ''} onClick={() => switchMode('login')}>Увійти</button></nav><div className="op-company-account-title"><h2>{formMode === 'register' ? 'Почнемо зі знайомства' : 'Раді бачити вас знову'}</h2><p>{formMode === 'register' ? 'Створіть обліковий запис представника. Дані самої компанії заповнюються наступним кроком.' : 'Увійдіть до кабінету представника компанії.'}</p></div><form className="op-business-form" onSubmit={event => void submit(event)}>
          {formMode === 'register' && <><Field label="Ім’я та прізвище *"><input id={`${prefix}-name`} name="fullName" autoComplete="name" autoFocus required minLength={2} maxLength={120} disabled={busy} value={fullName} onChange={event => setFullName(event.target.value)} placeholder="Як до вас звертатися" /></Field><Field label="Назва компанії *"><input id={`${prefix}-company`} name="companyName" autoComplete="organization" required minLength={2} maxLength={180} disabled={busy} value={companyName} onChange={event => setCompanyName(event.target.value)} placeholder="Назва вашої команди" /></Field></>}
          <Field label="Робоча електронна пошта *"><input id={`${prefix}-email`} name="email" type="email" autoComplete="email" required disabled={busy} maxLength={254} value={email} onChange={event => setEmail(event.target.value)} placeholder={local ? 'company@example.com' : 'name@company.ua'} /></Field><Field label={local ? 'Тестовий пароль *' : 'Пароль *'} hint="Щонайменше 8 символів."><div className="op-company-account-password"><input id={`${prefix}-password`} name="password" aria-label={local ? 'Тестовий пароль' : 'Пароль'} type={visible ? 'text' : 'password'} autoComplete={local ? 'off' : formMode === 'register' ? 'new-password' : 'current-password'} required minLength={8} maxLength={128} disabled={busy} value={password} onChange={event => setPassword(event.target.value)} /><button type="button" className="op-icon-button" aria-label={visible ? 'Приховати пароль' : 'Показати пароль'} aria-pressed={visible} onClick={event => { event.preventDefault(); setVisible(value => !value) }}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></Field>
          {formMode === 'register' && <div className="op-company-account-consent"><label><input type="checkbox" required disabled={busy} checked={consent} onChange={event => setConsent(event.target.checked)} /><span>Я представляю цю компанію та погоджуюся з умовами використання розділу «Можливості».</span></label><button type="button" onClick={() => setTerms(true)}>Переглянути проєкт умов</button></div>}
          {error && <div className="op-company-account-error" role="alert">{error}</div>}<button type="submit" className="op-button" disabled={busy}>{busy ? <LoaderCircle size={17} className="op-company-account-spinner" /> : <ArrowRight size={17} />}{busy ? 'Зачекайте…' : formMode === 'register' ? local ? 'Переглянути реєстрацію' : 'Створити обліковий запис' : local ? 'Увійти в локальний приклад' : 'Увійти до кабінету'}</button>{formMode === 'login' && <button type="button" className="op-company-account-text-button" disabled={busy} onClick={() => { setError(''); setView('recovery'); setPassword('') }}>Забули пароль?</button>}<p className="op-company-account-caption">Реєстрація не надає статус перевіреної компанії чи доступ до резюме всіх студентів.</p>
        </form></>}
        {view === 'confirmation' && <div className="op-company-account-state"><span className="op-company-account-state-icon"><Mail size={29} /></span><h2>{local ? 'Так виглядатиме підтвердження' : 'Підтвердьте свою пошту'}</h2><p>{local ? 'У робочому сервісі представник отримає лист і підтвердить адресу. У цьому перегляді лист не надсилався.' : 'Перевірте вхідні та папку «Спам». Відкрийте посилання з найновішого листа, а потім увійдіть до кабінету.'}</p><strong className="op-company-account-email">{email.trim().toLowerCase()}</strong>{notice && <p className="op-company-account-notice" role="status">{notice}</p>}{error && <div className="op-company-account-error" role="alert">{error}</div>}{local ? <button className="op-button" onClick={onReady}>Продовжити в локальний кабінет<ArrowRight size={17} /></button> : <><button className="op-button" onClick={() => switchMode('login')}>Пошту підтверджено — увійти<ArrowRight size={17} /></button><button className="op-button op-button-secondary" disabled={busy || resendWait > 0} onClick={() => void resend()}>{resendWait > 0 ? `Повторний лист через ${resendWait} с` : busy ? 'Надсилаємо…' : 'Надіслати лист повторно'}</button></>}<button className="op-company-account-text-button" disabled={busy} onClick={() => { setView('form'); setError(''); setNotice('') }}>Змінити адресу</button></div>}
        {view === 'ready' && <div className="op-company-account-state"><span className="op-company-account-state-icon"><CheckCircle2 size={30} /></span><h2>Обліковий запис готовий</h2><p>Тепер заповніть сторінку компанії: опис, офіційний сайт і контакти для перевірки.</p><button className="op-button" onClick={onReady}>До кабінету компанії<ArrowRight size={17} /></button></div>}
        {view === 'recovery' && <div className="op-company-account-title"><h2>Відновити доступ</h2><p>Вкажіть пошту облікового запису представника.</p><form className="op-business-form" onSubmit={event => void recovery(event)}><Field label="Електронна пошта"><input autoFocus name="recoveryEmail" type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></Field>{error && <div className="op-company-account-error" role="alert">{error}</div>}<button className="op-button" disabled={busy}>{busy ? 'Зачекайте…' : local ? 'Переглянути наступний крок' : 'Надіслати посилання'}</button><button type="button" className="op-company-account-text-button" disabled={busy} onClick={() => switchMode('login')}>Повернутися до входу</button></form></div>}
        {view === 'recoverySent' && <div className="op-company-account-state"><span className="op-company-account-state-icon"><Mail size={29} /></span><h2>{local ? 'Приклад наступного кроку' : 'Перевірте пошту'}</h2><p>{local ? 'У робочому сервісі лист міститиме посилання для встановлення нового пароля. У локальному перегляді жодного листа не надсилали.' : 'Якщо для цієї адреси доступне відновлення, ви отримаєте лист із наступними кроками. Перевірте також папку «Спам».'}</p><strong className="op-company-account-email">{email.trim().toLowerCase()}</strong><button className="op-button op-button-secondary" onClick={() => switchMode('login')}>Повернутися до входу</button></div>}
      </div>
    </div>
    {terms && <CareerModal title="Проєкт умов · Можливості" description={`Версія ${OPPORTUNITIES_TERMS_VERSION} · ${OPPORTUNITIES_TERMS_UPDATED_AT}. Для погодження перед публічним запуском.`} wide onClose={() => setTerms(false)}><div className="op-company-account-terms">{OPPORTUNITIES_TERMS.map(section => <section key={section.id}><h3>{section.title}</h3>{section.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}</section>)}<button className="op-button op-button-secondary" onClick={() => setTerms(false)}>Повернутися до форми</button></div></CareerModal>}
  </section>
}
