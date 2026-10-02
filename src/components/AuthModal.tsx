import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowLeft, CheckCircle2, Mail, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { CATEGORIES } from '../types'
import { categoryLabel } from '../translations/categories'
import { experienceLabel } from '../lib/ukrainian'
import { authEmailCooldown, authEmailRedirect, startAuthEmailCooldown } from '../lib/authEmail'
import { AcademicSpecialtySelect } from './AcademicSpecialtySelect'
import { academicSpecialtyMatches, useAcademicSpecialties } from '../lib/academicSpecialties'

interface AuthModalProps {
  onClose: () => void
  initialView?: 'form' | 'recovery'
}

type Tab = 'login' | 'register'
type UniversityOption = { id: string; name: string; slug: string }
type AcademicUnitOption = { id: string; university_id: string; name: string; unit_type: string }

const EXPERIENCE_OPTIONS = [
  'Student / Fresh Graduate',
  '1–3 years',
  '3–7 years',
  '7–15 years',
  '15+ years',
]

export function AuthModal({ onClose, initialView = 'form' }: AuthModalProps) {
  const [tab, setTab] = useState<Tab>('login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [view, setView] = useState<'form' | 'confirmation' | 'recovery'>(initialView)
  const [confirmationEmail, setConfirmationEmail] = useState('')
  const [recoveryEmail, setRecoveryEmail] = useState('')
  const [emailNotice, setEmailNotice] = useState('')
  const [signupCooldown, setSignupCooldown] = useState(() => authEmailCooldown('signup'))
  const [recoveryCooldown, setRecoveryCooldown] = useState(() => authEmailCooldown('recovery'))
  const pendingRegistration = useRef<{ id: string; email: string } | null>(null)
  const submitting = useRef(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const { refreshUser } = useAuth()
  const navigate = useNavigate()

  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  const [regName, setRegName] = useState('')
  const [regUsername, setRegUsername] = useState('')
  const [regEmail, setRegEmail] = useState('')
  const [regPassword, setRegPassword] = useState('')
  const [regCountry, setRegCountry] = useState('')
  const [regCity, setRegCity] = useState('')
  const [regBio, setRegBio] = useState('')
  const [regExperience, setRegExperience] = useState('')
  const [regCategories, setRegCategories] = useState<string[]>([])
  const [universities, setUniversities] = useState<UniversityOption[]>([])
  const [academicUnits, setAcademicUnits] = useState<AcademicUnitOption[]>([])
  const [regUniversityId, setRegUniversityId] = useState('')
  const [regAcademicUnitId, setRegAcademicUnitId] = useState('')
  const [academicOptionsLoading, setAcademicOptionsLoading] = useState(true)
  const [academicOptionsError, setAcademicOptionsError] = useState('')
  const [academicOptionsRefresh, setAcademicOptionsRefresh] = useState(0)
  const specialtySelection = useAcademicSpecialties(regUniversityId, regAcademicUnitId)

  useEffect(() => {
    const previousFocus = document.activeElement
    modalRef.current?.focus()
    return () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus()
    }
  }, [])

  useEffect(() => {
    if (tab !== 'register' || view !== 'form') return
    let active = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    setAcademicOptionsLoading(true)
    setAcademicOptionsError('')
    const loadAcademicOptions = async () => {
      try {
        const [universityResult, unitResult] = await Promise.all([
          supabase.from('universities').select('id, name, slug').eq('is_active', true).order('name').abortSignal(controller.signal),
          supabase.from('academic_units').select('id, university_id, name, unit_type').eq('is_active', true).order('name').abortSignal(controller.signal),
        ])
        if (!active) return
        if (universityResult.error || unitResult.error) throw new Error('Academic options unavailable')
        const nextUniversities = (universityResult.data || []) as UniversityOption[]
        setUniversities(nextUniversities)
        setAcademicUnits((unitResult.data || []) as AcademicUnitOption[])
        const defaultUniversity = nextUniversities.find((item) => item.slug === 'knu') || nextUniversities[0]
        if (defaultUniversity) setRegUniversityId((previous) => previous || defaultUniversity.id)
      } catch {
        if (!active) return
        setUniversities([])
        setAcademicUnits([])
        setAcademicOptionsError('Не вдалося завантажити університети та факультети. Спробуйте ще раз.')
      } finally {
        window.clearTimeout(timeout)
        if (active) setAcademicOptionsLoading(false)
      }
    }
    void loadAcademicOptions()
    return () => { active = false; window.clearTimeout(timeout); controller.abort() }
  }, [tab, view, academicOptionsRefresh])

  const selectedAcademicUnits = academicUnits.filter((unit) => unit.university_id === regUniversityId)

  useEffect(() => {
    const interval = window.setInterval(() => {
      setSignupCooldown(authEmailCooldown('signup'))
      setRecoveryCooldown(authEmailCooldown('recovery'))
    }, 1000)
    return () => window.clearInterval(interval)
  }, [])

  const changeTab = (nextTab: Tab) => {
    setTab(nextTab)
    setView('form')
    setError('')
    setEmailNotice('')
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setError('')
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: loginEmail.trim().toLowerCase(),
        password: loginPassword,
      })
      if (error) throw error
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.toLowerCase().includes('email not confirmed')) {
        setConfirmationEmail(loginEmail.trim().toLowerCase())
        setEmailNotice('Підтвердьте електронну пошту, щоб увійти. Відкрийте посилання з листа або надішліть його повторно.')
        setView('confirmation')
      } else if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('credentials')) {
        setError('Неправильна електронна пошта або пароль.')
      } else {
        setError('Не вдалося увійти. Перевірте дані та спробуйте ще раз.')
      }
    } finally {
      submitting.current = false
      setLoading(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting.current) return
    setError('')
    if (!regName.trim()) { setError("Вкажіть ім’я та прізвище."); return }
    if (regName.trim().length > 120) { setError('Ім’я та прізвище мають містити до 120 символів.'); return }
    const normalizedUsername = regUsername.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA')
    if (normalizedUsername && !/^[\p{L}\p{N}][\p{L}\p{N}._-]{2,29}$/u.test(normalizedUsername)) {
      setError('Нік має містити 3–30 літер, цифр, крапок, дефісів або підкреслень.')
      return
    }
    if (!regCountry.trim()) { setError('Вкажіть країну.'); return }
    if (regCountry.trim().length > 80) { setError('Назва країни має містити до 80 символів.'); return }
    if (regCity.trim().length > 120) { setError('Назва міста має містити до 120 символів.'); return }
    const selectedUnit = selectedAcademicUnits.find((unit) => unit.id === regAcademicUnitId)
    if (academicOptionsLoading || academicOptionsError || !universities.some((university) => university.id === regUniversityId) || !selectedUnit) {
      setError('Оберіть університет і факультет або інститут.')
      return
    }
    if (!academicSpecialtyMatches(specialtySelection, regUniversityId, regAcademicUnitId)) {
      setError('Оберіть освітню програму зі списку свого факультету або інституту.')
      return
    }
    const selectedSpecialty = specialtySelection.selected!
    if (!regExperience) { setError('Оберіть досвід.'); return }
    if (regCategories.length === 0) { setError('Оберіть принаймні одну тему.'); return }
    if (regPassword.length < 8) { setError('Пароль має містити щонайменше 8 символів.'); return }

    // Nickname uniqueness is enforced by the database during profile creation.
    // Do not expose an unmetered public profile lookup from registration.

    submitting.current = true
    setLoading(true)
    try {
      let uid: string
      const email = regEmail.trim().toLowerCase()
      if (pendingRegistration.current) {
        // Retry a failed profile insert without creating a second auth account.
        const { data, error } = await supabase.auth.getUser()
        if (error || data.user?.id !== pendingRegistration.current.id || email !== pendingRegistration.current.email) {
          throw new Error('Registration session changed')
        }
        uid = data.user.id
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password: regPassword,
          options: {
            emailRedirectTo: authEmailRedirect('/auth/callback'),
            data: {
              xelay_registration_version: 1,
              full_name: regName.trim(),
              username: normalizedUsername,
              country: regCountry.trim(),
              city: regCity.trim(),
              bio: regBio.trim(),
              experience: regExperience,
              categories: regCategories,
              university_id: regUniversityId,
              academic_unit_id: regAcademicUnitId,
              specialty_id: selectedSpecialty.id,
              specialty: selectedSpecialty.name,
            },
          },
        })
        if (error) throw error
        if (!data.user?.id) throw new Error('Не вдалося створити обліковий запис.')
        if (!data.session) {
          setConfirmationEmail(email)
          setEmailNotice('Перевірте пошту та відкрийте посилання з листа, щоб завершити реєстрацію. Якщо ви вже маєте акаунт, увійдіть або відновіть пароль.')
          setView('confirmation')
          startAuthEmailCooldown('signup')
          setSignupCooldown(authEmailCooldown('signup'))
          setRegPassword('')
          return
        }
        uid = data.user.id
        pendingRegistration.current = { id: uid, email }
      }

      const { error: profileError } = await supabase
        .from('profiles')
        .upsert({
          id: uid,
          full_name: regName.trim(),
          username: normalizedUsername,
          email: regEmail.trim().toLowerCase(),
          country: regCountry.trim(),
          city: regCity.trim(),
          bio: regBio.trim(),
          experience: regExperience,
          categories: regCategories,
          university_id: regUniversityId,
          academic_unit_id: regAcademicUnitId,
          specialty_id: selectedSpecialty.id,
          specialty: selectedSpecialty.name,
          faculty: selectedUnit.name,
          avatar_url: '',
          created_at: new Date().toISOString(),
        }, { onConflict: 'id', ignoreDuplicates: true })
      if (profileError) throw profileError

      await refreshUser()
      navigate({ to: '/news' })
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : ''
      if (msg.toLowerCase().includes('duplicate key') || msg.toLowerCase().includes('profiles_username_lower_unique')) {
        setError('Такий нік уже зайнятий. Спробуйте інший.')
      } else if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists')) {
        setConfirmationEmail(regEmail.trim().toLowerCase())
        setEmailNotice('Перевірте пошту. Якщо ви вже реєструвалися з цією адресою, увійдіть або скористайтеся відновленням пароля.')
        setView('confirmation')
      } else if (msg === 'Registration session changed') {
        setError('Сесію реєстрації змінено. Увійдіть до створеного акаунта й повторіть спробу.')
      } else {
        setError('Не вдалося створити обліковий запис. Спробуйте ще раз.')
      }
    } finally {
      submitting.current = false
      setLoading(false)
    }
  }

  const resendConfirmation = async () => {
    if (submitting.current || signupCooldown > 0 || !confirmationEmail) return
    submitting.current = true
    setLoading(true)
    setError('')
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: 'signup',
        email: confirmationEmail,
        options: { emailRedirectTo: authEmailRedirect('/auth/callback') },
      })
      if (resendError && (resendError.status === 429 || resendError.code === 'over_email_send_rate_limit')) {
        setError('Листи надсилаються надто часто. Зачекайте кілька хвилин і спробуйте ще раз.')
      } else if (resendError && resendError.status !== 400 && resendError.status !== 422) {
        setError('Не вдалося надіслати лист. Перевірте з’єднання та спробуйте ще раз.')
      } else {
        setEmailNotice('Якщо адреса очікує підтвердження, на неї надіслано нове посилання. Перевірте також папку «Спам».')
      }
    } catch {
      setError('Не вдалося надіслати лист. Перевірте з’єднання та спробуйте ще раз.')
    } finally {
      startAuthEmailCooldown('signup')
      setSignupCooldown(authEmailCooldown('signup'))
      submitting.current = false
      setLoading(false)
    }
  }

  const requestRecovery = async (event: React.FormEvent) => {
    event.preventDefault()
    if (submitting.current || recoveryCooldown > 0) return
    submitting.current = true
    setLoading(true)
    setError('')
    try {
      const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(recoveryEmail.trim().toLowerCase(), {
        redirectTo: authEmailRedirect('/reset-password'),
      })
      if (recoveryError) throw recoveryError
      setEmailNotice('Якщо акаунт із цією адресою існує, на пошту надіслано посилання для відновлення пароля. Перевірте також папку «Спам».')
    } catch (recoveryError) {
      const status = typeof recoveryError === 'object' && recoveryError !== null && 'status' in recoveryError ? recoveryError.status : undefined
      setError(status === 429
        ? 'Забагато спроб. Зачекайте кілька хвилин і спробуйте ще раз.'
        : 'Не вдалося надіслати лист. Перевірте з’єднання та спробуйте ще раз.')
    } finally {
      startAuthEmailCooldown('recovery')
      setRecoveryCooldown(authEmailCooldown('recovery'))
      submitting.current = false
      setLoading(false)
    }
  }

  const toggleCategory = (cat: string) => {
    setRegCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-foreground/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="auth-modal-title" onKeyDown={(event) => {
        if (event.key === 'Escape' && !loading) { event.preventDefault(); onClose(); return }
        if (event.key !== 'Tab') return
        const controls = Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || []).filter((control) => control.getClientRects().length > 0)
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }} className="relative z-10 w-full max-w-md bg-background border border-border rounded-2xl shadow-[var(--shadow-2xl)] animate-fade-in max-h-[90dvh] overflow-y-auto focus:outline-none">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-muted transition-colors xelay-btn"
          aria-label="Закрити"
        >
          <X size={18} className="text-foreground" />
        </button>

        <div className="px-5 sm:px-8 pt-8 pb-4 text-center">
          <p id="auth-modal-title" className="xelay-wordmark text-3xl text-foreground">Xelay</p>
          <p className="text-sm text-muted-foreground mt-1">Університетська спільнота</p>
        </div>

        {view === 'form' && <div className="flex border-b border-border mx-5 sm:mx-8">
          {(['login', 'register'] as Tab[]).map((t) => (
            <button
              key={t}
              disabled={loading}
              onClick={() => changeTab(t)}
              className={`flex-1 py-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'border-primary text-primary'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'login' ? 'Вхід' : 'Реєстрація'}
            </button>
          ))}
        </div>}

        <div className="px-5 sm:px-8 py-6">
          {error && (
            <div role="alert" className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
              {error}
            </div>
          )}

          {view === 'confirmation' ? (
            <section className="space-y-4 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Mail size={26} aria-hidden="true" /></div>
              <h2 className="text-xl font-semibold text-foreground">Підтвердьте електронну пошту</h2>
              <p className="break-words text-sm font-medium text-foreground">{confirmationEmail}</p>
              <p role="status" className="text-sm leading-relaxed text-muted-foreground">{emailNotice}</p>
              <button type="button" onClick={() => void resendConfirmation()} disabled={loading || signupCooldown > 0} className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-60 xelay-btn">
                {loading ? 'Надсилання…' : signupCooldown > 0 ? `Надіслати повторно через ${signupCooldown} с` : 'Надіслати лист повторно'}
              </button>
              <button type="button" disabled={loading} onClick={() => changeTab('login')} className="inline-flex min-h-[2.5rem] items-center gap-2 rounded-full px-3 text-sm text-primary hover:bg-primary/5 xelay-btn"><ArrowLeft size={16} aria-hidden="true" />До входу</button>
            </section>
          ) : view === 'recovery' ? (
            <form onSubmit={requestRecovery} className="space-y-4">
              <div className="text-center">
                <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Mail size={26} aria-hidden="true" /></div>
                <h2 className="text-xl font-semibold text-foreground">Забули пароль?</h2>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">Вкажіть адресу, з якою ви реєструвалися. Ми надішлемо посилання для створення нового пароля.</p>
              </div>
              <Field label="Електронна пошта" type="email" value={recoveryEmail} onChange={setRecoveryEmail} autoComplete="email" required />
              {emailNotice && <p role="status" className="flex items-start gap-2 rounded-xl border border-primary/15 bg-primary/5 p-3 text-sm leading-relaxed text-foreground"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />{emailNotice}</p>}
              <SubmitButton loading={loading} disabled={recoveryCooldown > 0} label={recoveryCooldown > 0 ? `Повторно через ${recoveryCooldown} с` : 'Надіслати посилання'} />
              <div className="text-center"><button type="button" disabled={loading} onClick={() => changeTab('login')} className="inline-flex min-h-[2.5rem] items-center gap-2 rounded-full px-3 text-sm text-primary hover:bg-primary/5 xelay-btn"><ArrowLeft size={16} aria-hidden="true" />До входу</button></div>
            </form>
          ) : tab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <Field label="Електронна пошта" type="email" value={loginEmail} onChange={setLoginEmail} autoComplete="email" required />
              <Field label="Пароль" type="password" value={loginPassword} onChange={setLoginPassword} autoComplete="current-password" required />
              <div className="text-right"><button type="button" disabled={loading} onClick={() => { setRecoveryEmail(loginEmail); setEmailNotice(''); setError(''); setView('recovery') }} className="min-h-[2.25rem] rounded-full px-2 text-sm font-medium text-primary hover:bg-primary/5 xelay-btn">Забули пароль?</button></div>
              <SubmitButton loading={loading} label="Увійти" />
              <p className="text-center text-sm text-muted-foreground">
                Ще не маєте облікового запису?{' '}
                <button type="button" disabled={loading} onClick={() => changeTab('register')} className="text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
                  Зареєструватися
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              <Field label="Ім’я та прізвище" value={regName} onChange={setRegName} maxLength={120} required />
              <Field label="Нік для пошуку (необов’язково)" value={regUsername} onChange={setRegUsername} maxLength={30} placeholder="наприклад, anna_shevchenko" />
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5" htmlFor="register-university">
                  Університет <span className="text-destructive">*</span>
                </label>
                <select
                  id="register-university"
                  value={regUniversityId}
                  onChange={(event) => { specialtySelection.clear(); setRegUniversityId(event.target.value); setRegAcademicUnitId('') }}
                  required
                  disabled={loading || academicOptionsLoading || universities.length === 0}
                  className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 disabled:opacity-60"
                >
                  <option value="">{academicOptionsLoading ? 'Завантаження…' : 'Оберіть університет'}</option>
                  {universities.map((university) => <option key={university.id} value={university.id}>{university.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5" htmlFor="register-academic-unit">
                  Факультет або інститут <span className="text-destructive">*</span>
                </label>
                <select
                  id="register-academic-unit"
                  value={regAcademicUnitId}
                  onChange={(event) => { specialtySelection.clear(); setRegAcademicUnitId(event.target.value) }}
                  required
                  disabled={loading || !regUniversityId || academicOptionsLoading}
                  className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 disabled:opacity-60"
                >
                  <option value="">Оберіть факультет або інститут</option>
                  {selectedAcademicUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                </select>
              </div>
              {academicOptionsError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{academicOptionsError}</p><button type="button" onClick={() => setAcademicOptionsRefresh((previous) => previous + 1)} disabled={loading || academicOptionsLoading} className="min-h-9 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-primary disabled:opacity-50">Оновити список університетів</button></div>}
              <AcademicSpecialtySelect selection={specialtySelection} disabled={loading || academicOptionsLoading} />
              <Field label="Електронна пошта" type="email" value={regEmail} onChange={setRegEmail} autoComplete="email" disabled={Boolean(pendingRegistration.current)} required />
              <Field label="Пароль (від 8 символів)" type="password" value={regPassword} onChange={setRegPassword} autoComplete="new-password" disabled={Boolean(pendingRegistration.current)} required minLength={8} />
              <Field label="Країна" value={regCountry} onChange={setRegCountry} maxLength={80} required />
              <Field label="Місто (необов’язково)" value={regCity} onChange={setRegCity} maxLength={120} />
              <div>
  <label className="block text-sm font-medium text-foreground mb-1.5">
    Про себе
  </label>

  <textarea
    value={regBio}
    onChange={(e) =>
      setRegBio(e.target.value)
    }
    maxLength={300}
    rows={4}
    placeholder="Розкажіть спільноті про себе, свій досвід, інтереси та проєкти..."
    className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors resize-none"
  />

  <p className="text-xs text-muted-foreground mt-1">
    {regBio.length}/300
  </p>
</div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5">
                  Досвід <span className="text-destructive">*</span>
                </label>
                <select
                  value={regExperience}
                  onChange={(e) => setRegExperience(e.target.value)}
                  required
                  className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-colors"
                >
                  <option value="">Оберіть досвід...</option>
                  {EXPERIENCE_OPTIONS.map((opt) => (
                    <option key={opt} value={opt}>{experienceLabel(opt)}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Теми, які вас цікавлять <span className="text-destructive">*</span>
                  <span className="ml-1 text-xs text-muted-foreground">(оберіть принаймні одну)</span>
                </label>
                <div className="flex flex-wrap gap-2">
                  {CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      onClick={() => toggleCategory(cat)}
                      className={`px-3 py-1.5 rounded-full text-sm font-medium border transition-all duration-150 xelay-btn ${
                        regCategories.includes(cat)
                          ? 'bg-foreground text-background border-foreground'
                          : 'bg-background text-foreground border-border hover:border-foreground'
                      }`}
                    >
                      {categoryLabel(cat)}
                    </button>
                  ))}
                </div>
              </div>

              <p className="text-xs leading-relaxed text-muted-foreground">Після реєстрації підтвердьте електронну пошту за посиланням у листі.</p>
              <SubmitButton loading={loading} disabled={academicOptionsLoading || Boolean(academicOptionsError) || !academicSpecialtyMatches(specialtySelection, regUniversityId, regAcademicUnitId)} label="Створити обліковий запис" />
              <p className="text-center text-sm text-muted-foreground">
                Уже маєте обліковий запис?{' '}
                <button type="button" disabled={loading} onClick={() => changeTab('login')} className="text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
                  Увійти
                </button>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function Field({
  label, type = 'text', value, onChange, required, minLength, maxLength, placeholder, disabled, autoComplete,
}: {
  label: string
  type?: string
  value: string
  onChange: (v: string) => void
  required?: boolean
  minLength?: number
  maxLength?: number
  placeholder?: string
  disabled?: boolean
  autoComplete?: string
}) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-foreground mb-1.5">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        minLength={minLength}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors"
      />
    </div>
  )
}

function SubmitButton({ loading, label, disabled = false }: { loading: boolean; label: string; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="w-full py-3 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-sm xelay-btn"
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
          Обробка...
        </span>
      ) : label}
    </button>
  )
}
