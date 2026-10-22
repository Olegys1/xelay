import { useEffect, useId, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { User } from '@supabase/supabase-js'
import { ArrowLeft, CheckCircle2, GraduationCap, Mail, UserRound, X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { CATEGORIES } from '../types'
import { categoryLabel } from '../translations/categories'
import { ACADEMIC_STATUS_OPTIONS, isAcademicStatus } from '../lib/academicStatus'
import { isActiveStudentStatus } from '../lib/studyYearProgression'
import { authEmailCooldown, authEmailRedirect, startAuthEmailCooldown } from '../lib/authEmail'
import { AcademicSpecialtySelect } from './AcademicSpecialtySelect'
import { academicSpecialtyMatches, useAcademicSpecialties } from '../lib/academicSpecialties'
import { normalizeRegistrationUsername, REGISTRATION_USERNAME_NOTE, registrationFailure, registrationUsernameNotice } from '../lib/authRegistration'
import { loginErrorDiagnostic, loginErrorReference, loginFailure } from '../lib/authLogin'
import { PERSONAL_DATA_CONSENT_VERSION, PRIVACY_POLICY_VERSION } from '../lib/legal'
import { PrivacyConsent } from './PrivacyConsent'
import { beginGoogleSignIn, completeGoogleRegistration, googleAuthEnabled, googleAuthFailure } from '../lib/authGoogle'

interface AuthModalProps {
  onClose: () => void
  initialView?: 'form' | 'recovery'
  googleCompletion?: { userId: string; email: string; name: string }
  onCompleted?: () => void
}

type Tab = 'login' | 'register'
type UniversityOption = { id: string; name: string; slug: string }
type AcademicUnitOption = { id: string; university_id: string; name: string; unit_type: string }

export function AuthModal({ onClose, initialView = 'form', googleCompletion, onCompleted }: AuthModalProps) {
  const [tab, setTab] = useState<Tab>(googleCompletion ? 'register' : 'login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loginSupportReference, setLoginSupportReference] = useState('')
  const [invalidField, setInvalidField] = useState<string | null>(null)
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
  const { notify, dismiss } = useToast()
  const navigate = useNavigate()

  const [loginEmail, setLoginEmail] = useState('')
  const [loginPassword, setLoginPassword] = useState('')

  const [regName, setRegName] = useState(googleCompletion?.name.slice(0, 120) || '')
  const [regAccountType, setRegAccountType] = useState<'student' | 'teacher'>('student')
  const [studentPrivacyConsent, setStudentPrivacyConsent] = useState(false)
  const [teacherPrivacyConsent, setTeacherPrivacyConsent] = useState(false)
  const regPrivacyConsent = regAccountType === 'teacher' ? teacherPrivacyConsent : studentPrivacyConsent
  const [regDepartment, setRegDepartment] = useState('')
  const [regPosition, setRegPosition] = useState('')
  const [regUsername, setRegUsername] = useState('')
  const [regEmail, setRegEmail] = useState(googleCompletion?.email || '')
  const [regPassword, setRegPassword] = useState('')
  const [regCountry, setRegCountry] = useState('')
  const [regCity, setRegCity] = useState('')
  const [regBio, setRegBio] = useState('')
  const [regAcademicStatus, setRegAcademicStatus] = useState('')
  const [regStudyYear, setRegStudyYear] = useState('')
  const [regCategories, setRegCategories] = useState<string[]>([])
  const [universities, setUniversities] = useState<UniversityOption[]>([])
  const [academicUnits, setAcademicUnits] = useState<AcademicUnitOption[]>([])
  const [regUniversityId, setRegUniversityId] = useState('')
  const [regAcademicUnitId, setRegAcademicUnitId] = useState('')
  const [academicOptionsLoading, setAcademicOptionsLoading] = useState(true)
  const [academicOptionsError, setAcademicOptionsError] = useState('')
  const [academicOptionsRefresh, setAcademicOptionsRefresh] = useState(0)
  const specialtySelection = useAcademicSpecialties(regUniversityId, regAcademicUnitId, {}, regAcademicStatus)

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
  const regActiveStudent = regAccountType === 'student' && isActiveStudentStatus(regAcademicStatus)

  const showError = (message: string, field?: string, supportReference = '') => {
    setError(message)
    setLoginSupportReference(supportReference)
    setInvalidField(field || null)
    notify({ id: 'auth-feedback', tone: 'error', title: field ? 'Перевірте дані' : 'Не вдалося виконати дію', description: message })
    if (field) {
      const target = modalRef.current?.querySelector<HTMLElement>(`[name="${field}"], [data-auth-field="${field}"]`)
      const control = target?.matches('input, select, button') ? target : target?.querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)')
      control?.focus()
    }
  }

  useEffect(() => {
    const interval = window.setInterval(() => {
      setSignupCooldown(authEmailCooldown('signup'))
      setRecoveryCooldown(authEmailCooldown('recovery'))
    }, 1000)
    return () => window.clearInterval(interval)
  }, [])

  const changeTab = (nextTab: Tab) => {
    if (googleCompletion) return
    setTab(nextTab)
    setView('form')
    setError('')
    setLoginSupportReference('')
    setInvalidField(null)
    dismiss('auth-feedback')
    setEmailNotice('')
  }

  const handleGoogle = async () => {
    if (submitting.current || !googleAuthEnabled) return
    submitting.current = true
    setLoading(true)
    setError('')
    setLoginSupportReference('')
    dismiss('auth-feedback')
    try { await beginGoogleSignIn() }
    catch (failure) {
      showError(googleAuthFailure(failure))
      submitting.current = false
      setLoading(false)
    }
  }

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setError('')
    setLoginSupportReference('')
    setInvalidField(null)
    dismiss('auth-feedback')
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: loginEmail.trim().toLowerCase(),
        password: loginPassword,
      })
      if (error) throw error
      notify({ id: 'auth-feedback', tone: 'success', title: 'Ви увійшли до Xelay' })
      onClose()
    } catch (err: unknown) {
      const failure = loginFailure(err)
      console.warn('[Xelay] Login failed', loginErrorDiagnostic(err))
      if (failure.type === 'confirmation') {
        setConfirmationEmail(loginEmail.trim().toLowerCase())
        setEmailNotice('Підтвердьте електронну пошту, щоб увійти. Відкрийте посилання з листа або надішліть його повторно.')
        setView('confirmation')
        notify({ id: 'auth-feedback', tone: 'warning', title: 'Підтвердьте електронну пошту', description: 'Відкрийте посилання з листа або надішліть його повторно.' })
      } else {
        showError(failure.message, undefined, loginErrorReference(err))
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
    setLoginSupportReference('')
    setInvalidField(null)
    dismiss('auth-feedback')
    if (!regPrivacyConsent) { showError('Для реєстрації надайте згоду на обробку персональних даних.', 'reg-privacy-consent'); return }
    if (!regName.trim()) { showError("Вкажіть ім’я та прізвище.", 'reg-name'); return }
    if (regName.trim().length > 120) { showError('Ім’я та прізвище мають містити до 120 символів.', 'reg-name'); return }
    const normalizedUsername = normalizeRegistrationUsername(regUsername)
    if (normalizedUsername && !/^[\p{L}\p{N}][\p{L}\p{N}._-]{2,29}$/u.test(normalizedUsername)) {
      showError('Нік має містити 3–30 літер, цифр, крапок, дефісів або підкреслень.', 'reg-username')
      return
    }
    if (!regCountry.trim()) { showError('Вкажіть країну.', 'reg-country'); return }
    if (regCountry.trim().length > 80) { showError('Назва країни має містити до 80 символів.', 'reg-country'); return }
    if (regCity.trim().length > 120) { showError('Назва міста має містити до 120 символів.', 'reg-city'); return }
    const selectedUnit = selectedAcademicUnits.find((unit) => unit.id === regAcademicUnitId)
    if (academicOptionsLoading || academicOptionsError) return
    if (!universities.some((university) => university.id === regUniversityId)) {
      showError('Оберіть університет зі списку.', 'reg-university')
      return
    }
    if (!selectedUnit) {
      showError('Оберіть факультет або інститут свого університету.', 'reg-academic-unit')
      return
    }
    if (regAccountType === 'student' && (specialtySelection.loading || specialtySelection.error)) return
    if (regAccountType === 'student' && !academicSpecialtyMatches(specialtySelection, regUniversityId, regAcademicUnitId)) {
      showError(specialtySelection.hasScope && specialtySelection.options.length === 0
        ? 'Для цього факультету ще немає доступних освітніх програм. Оновіть список або зверніться до підтримки.'
        : 'Оберіть освітню програму зі списку свого факультету або інституту.', 'specialty')
      return
    }
    const selectedSpecialty = regAccountType === 'student' ? specialtySelection.selected : null
    if (regAccountType === 'student' && !isAcademicStatus(regAcademicStatus)) { showError('Оберіть навчальний статус.', 'reg-academic-status'); return }
    if (regActiveStudent && !/^[1-6]$/.test(regStudyYear)) { showError('Оберіть свій поточний курс.', 'reg-study-year'); return }
    if (regAccountType === 'student' && regCategories.length === 0) { showError('Оберіть принаймні одну тему.', 'reg-categories'); return }
    if (regAccountType === 'teacher' && regDepartment.trim().length < 2) { showError('Вкажіть кафедру для підтвердження статусу викладача (щонайменше 2 символи).', 'reg-department'); return }
    if (regDepartment.trim().length > 180 || regPosition.trim().length > 120) { showError('Скоротіть назву кафедри або посади.', 'reg-department'); return }
    if (!googleCompletion && regPassword.length < 8) { showError('Пароль має містити щонайменше 8 символів.', 'reg-password'); return }

    // Nickname uniqueness is enforced by the database during profile creation.
    // Do not expose an unmetered public profile lookup from registration.

    submitting.current = true
    setLoading(true)
    try {
      if (googleCompletion) {
        const current = await supabase.auth.getUser()
        if (current.error || current.data.user?.id !== googleCompletion.userId) throw new Error('Registration session changed')
        await completeGoogleRegistration({
          expected_user_id: googleCompletion.userId,
          account_type: regAccountType, full_name: regName.trim(), username: normalizedUsername,
          country: regCountry.trim(), city: regCity.trim(), bio: regBio.trim(),
          teacher_department: regAccountType === 'teacher' ? regDepartment.trim() : '',
          teacher_position: regAccountType === 'teacher' ? regPosition.trim() : '',
          experience: regAccountType === 'student' ? regAcademicStatus : '',
          study_year: regActiveStudent ? Number(regStudyYear) : null,
          categories: regAccountType === 'student' ? regCategories : [],
          university_id: regUniversityId, academic_unit_id: regAcademicUnitId,
          specialty_id: selectedSpecialty?.id || null, specialty: selectedSpecialty?.name || '',
        }, PRIVACY_POLICY_VERSION, PERSONAL_DATA_CONSENT_VERSION)
        await refreshUser()
        notify({ id: 'auth-feedback', tone: 'success', title: 'Профіль Xelay готовий', description: regAccountType === 'teacher' ? 'Можна продовжувати. Статус викладача перевіряється командою Xelay окремо.' : 'Можна приєднуватися до своєї групи.' })
        onCompleted?.()
        return
      }
      let uid: string
      let registrationUser: User
      const email = regEmail.trim().toLowerCase()
      if (pendingRegistration.current) {
        // Retry a failed profile insert without creating a second auth account.
        const { data, error } = await supabase.auth.getUser()
        if (error || data.user?.id !== pendingRegistration.current.id || email !== pendingRegistration.current.email) {
          throw new Error('Registration session changed')
        }
        uid = data.user.id
        registrationUser = data.user
      } else {
        const { data, error } = await supabase.auth.signUp({
          email,
          password: regPassword,
          options: {
            emailRedirectTo: authEmailRedirect('/auth/callback'),
            data: {
              xelay_registration_version: 1,
              xelay_privacy_consent: true,
              xelay_privacy_policy_version: PRIVACY_POLICY_VERSION,
              xelay_privacy_consent_version: PERSONAL_DATA_CONSENT_VERSION,
              account_type: regAccountType,
              teacher_department: regAccountType === 'teacher' ? regDepartment.trim() : '',
              teacher_position: regAccountType === 'teacher' ? regPosition.trim() : '',
              full_name: regName.trim(),
              username: normalizedUsername,
              country: regCountry.trim(),
              city: regCity.trim(),
              bio: regBio.trim(),
              experience: regAccountType === 'student' ? regAcademicStatus : '',
              study_year: regActiveStudent ? Number(regStudyYear) : null,
              categories: regAccountType === 'student' ? regCategories : [],
              university_id: regUniversityId,
              academic_unit_id: regAcademicUnitId,
              specialty_id: selectedSpecialty?.id || null,
              specialty: selectedSpecialty?.name || '',
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
          notify({ id: 'auth-feedback', tone: 'success', title: 'Перевірте електронну пошту', description: 'Відкрийте посилання з листа, щоб завершити реєстрацію.' })
          return
        }
        uid = data.user.id
        registrationUser = data.user
        pendingRegistration.current = { id: uid, email }
      }

      const { error: profileError } = await supabase
        .from('profiles')
        .upsert({
          id: uid,
          account_type: regAccountType,
          full_name: regName.trim(),
          username: normalizedUsername,
          email: regEmail.trim().toLowerCase(),
          country: regCountry.trim(),
          city: regCity.trim(),
          bio: regBio.trim(),
          experience: regAccountType === 'student' ? regAcademicStatus : '',
          study_year: regActiveStudent ? Number(regStudyYear) : null,
          categories: regAccountType === 'student' ? regCategories : [],
          university_id: regUniversityId,
          academic_unit_id: regAcademicUnitId,
          specialty_id: selectedSpecialty?.id || null,
          specialty: selectedSpecialty?.name || '',
          faculty: selectedUnit.name,
          avatar_url: '',
          created_at: new Date().toISOString(),
        }, { onConflict: 'id', ignoreDuplicates: true })
      if (profileError) throw profileError

      await refreshUser()
      let usernameNotice: string | null = null
      try {
        const { data: profile, error: noticeError } = await supabase.from('profiles').select('id, username').eq('id', uid).maybeSingle()
        if (!noticeError) usernameNotice = registrationUsernameNotice(registrationUser, profile)
      } catch { /* A notice lookup must not turn a completed registration into an error. */ }
      notify({ id: 'auth-feedback', tone: 'success', title: 'Обліковий запис створено', description: usernameNotice || (regAccountType === 'teacher' ? 'Заявку на підтвердження викладача передано команді Xelay.' : 'Ваш профіль збережено.'), duration: usernameNotice ? 10000 : undefined })
      navigate({ to: regAccountType === 'teacher' ? '/teaching' : '/news' })
      onClose()
    } catch (err: unknown) {
      const failure = registrationFailure(err)
      if (failure.type === 'existing-account') {
        setConfirmationEmail(regEmail.trim().toLowerCase())
        setEmailNotice('Перевірте пошту. Якщо ви вже реєструвалися з цією адресою, увійдіть або скористайтеся відновленням пароля.')
        setView('confirmation')
        notify({ id: 'auth-feedback', tone: 'info', title: 'Перевірте електронну пошту', description: 'Якщо ви вже маєте акаунт, увійдіть або відновіть пароль.' })
      } else {
        showError(failure.message, failure.field)
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
    setLoginSupportReference('')
    dismiss('auth-feedback')
    try {
      const { error: resendError } = await supabase.auth.resend({
        type: 'signup',
        email: confirmationEmail,
        options: { emailRedirectTo: authEmailRedirect('/auth/callback') },
      })
      if (resendError && (resendError.status === 429 || resendError.code === 'over_email_send_rate_limit')) {
        showError('Листи надсилаються надто часто. Зачекайте кілька хвилин і спробуйте ще раз.')
      } else if (resendError && resendError.status !== 400 && resendError.status !== 422) {
        showError('Не вдалося надіслати лист. Перевірте з’єднання та спробуйте ще раз.')
      } else {
        setEmailNotice('Якщо адреса очікує підтвердження, на неї надіслано нове посилання. Перевірте також папку «Спам».')
        notify({ id: 'auth-feedback', tone: 'success', title: 'Запит на лист надіслано', description: 'Перевірте вхідні листи та папку «Спам».' })
      }
    } catch {
      showError('Не вдалося надіслати лист. Перевірте з’єднання та спробуйте ще раз.')
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
    setLoginSupportReference('')
    dismiss('auth-feedback')
    try {
      const { error: recoveryError } = await supabase.auth.resetPasswordForEmail(recoveryEmail.trim().toLowerCase(), {
        redirectTo: authEmailRedirect('/reset-password'),
      })
      if (recoveryError) throw recoveryError
      setEmailNotice('Якщо акаунт із цією адресою існує, на пошту надіслано посилання для відновлення пароля. Перевірте також папку «Спам».')
      notify({ id: 'auth-feedback', tone: 'success', title: 'Запит на відновлення надіслано', description: 'Якщо акаунт існує, посилання надійде на вашу пошту.' })
    } catch (recoveryError) {
      const status = typeof recoveryError === 'object' && recoveryError !== null && 'status' in recoveryError ? recoveryError.status : undefined
      showError(status === 429
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
    setInvalidField(null)
    setError('')
    setLoginSupportReference('')
    setRegCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="xelay-dialog-backdrop absolute inset-0 bg-foreground/50 backdrop-blur-sm"
        onClick={loading ? undefined : onClose}
        aria-hidden="true"
      />
      <div ref={modalRef} tabIndex={-1} role="dialog" aria-modal="true" aria-busy={loading} aria-labelledby="auth-modal-title" onChange={() => { setInvalidField(null); setError(''); setLoginSupportReference(''); setEmailNotice('') }} onKeyDown={(event) => {
        if (event.key === 'Escape' && !loading) { event.preventDefault(); onClose(); return }
        if (event.key !== 'Tab') return
        const controls = Array.from(modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || []).filter((control) => control.getClientRects().length > 0)
        const first = controls[0]
        const last = controls[controls.length - 1]
        if (event.shiftKey && (document.activeElement === first || document.activeElement === modalRef.current)) { event.preventDefault(); last?.focus() }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
      }} className="xelay-dialog-panel relative z-10 w-full max-w-md bg-background border border-border rounded-2xl shadow-[var(--shadow-2xl)] max-h-[90dvh] overflow-y-auto focus:outline-none">
        <button
          type="button"
          onClick={onClose}
          disabled={loading}
          className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-muted transition-colors xelay-btn"
          aria-label={googleCompletion ? 'Вийти з акаунта' : 'Закрити'}
        >
          <X size={18} className="text-foreground" />
        </button>

        <div className="px-5 sm:px-8 pt-8 pb-4 text-center">
          <p id="auth-modal-title" className="xelay-wordmark text-3xl text-foreground">Xelay</p>
          <p className="text-sm text-muted-foreground mt-1">{googleCompletion ? 'Завершіть створення профілю' : 'Університетська спільнота'}</p>
          {googleCompletion && <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Пошту підтверджено через Google. Оберіть, як ви долучаєтеся до спільноти, та заповніть профіль. Пароль створювати не потрібно.</p>}
        </div>

        {view === 'form' && !googleCompletion && <div className="flex border-b border-border mx-5 sm:mx-8">
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
          {view === 'form' && !googleCompletion && googleAuthEnabled && <div className="mb-5">
            <button type="button" disabled={loading} onClick={() => void handleGoogle()} className="xelay-btn flex min-h-12 w-full items-center justify-center gap-3 rounded-lg border border-[#747775] bg-white px-4 py-3 text-sm font-medium text-[#1f1f1f] hover:bg-[#f8fafd] disabled:opacity-60">
              <GoogleMark />{loading ? 'Зачекайте…' : 'Продовжити з Google'}
            </button>
            <div className="mt-4 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" /><span>або за допомогою пошти</span><span className="h-px flex-1 bg-border" /></div>
          </div>}
          {error && (
            <div role="alert" className="xelay-inline-feedback xelay-feedback-error mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
              {error}
              {view === 'form' && tab === 'login' && loginSupportReference && <p className="mt-2 break-all text-xs leading-relaxed">Код для підтримки: {loginSupportReference}</p>}
            </div>
          )}

          {view === 'confirmation' ? (
            <section className="space-y-4 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Mail size={26} aria-hidden="true" /></div>
              <h2 className="text-xl font-semibold text-foreground">Підтвердьте електронну пошту</h2>
              <p className="break-words text-sm font-medium text-foreground">{confirmationEmail}</p>
              <p role="status" className="text-sm leading-relaxed text-muted-foreground">{emailNotice}</p>
              {tab === 'register' && <p className="text-xs leading-relaxed text-muted-foreground">{REGISTRATION_USERNAME_NOTE}</p>}
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
              {emailNotice && <p role="status" className="xelay-inline-feedback xelay-feedback-success flex items-start gap-2 rounded-xl border border-primary/15 bg-primary/5 p-3 text-sm leading-relaxed text-foreground"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-primary" aria-hidden="true" />{emailNotice}</p>}
              <SubmitButton loading={loading} loadingLabel="Надсилаємо посилання…" disabled={recoveryCooldown > 0} label={recoveryCooldown > 0 ? `Повторно через ${recoveryCooldown} с` : 'Надіслати посилання'} />
              <div className="text-center"><button type="button" disabled={loading} onClick={() => changeTab('login')} className="inline-flex min-h-[2.5rem] items-center gap-2 rounded-full px-3 text-sm text-primary hover:bg-primary/5 xelay-btn"><ArrowLeft size={16} aria-hidden="true" />До входу</button></div>
            </form>
          ) : tab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <Field label="Електронна пошта" type="email" value={loginEmail} onChange={setLoginEmail} autoComplete="email" required />
              <Field label="Пароль" type="password" value={loginPassword} onChange={setLoginPassword} autoComplete="current-password" required />
              <div className="text-right"><button type="button" disabled={loading} onClick={() => { setRecoveryEmail(loginEmail); setEmailNotice(''); setError(''); setLoginSupportReference(''); setView('recovery') }} className="min-h-[2.25rem] rounded-full px-2 text-sm font-medium text-primary hover:bg-primary/5 xelay-btn">Забули пароль?</button></div>
              <SubmitButton loading={loading} loadingLabel="Входимо…" label="Увійти" />
              <p className="text-center text-sm text-muted-foreground">
                Ще не маєте облікового запису?{' '}
                <button type="button" disabled={loading} onClick={() => changeTab('register')} className="text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
                  Зареєструватися
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              <fieldset disabled={loading || Boolean(pendingRegistration.current)}>
                <legend className="mb-2 text-sm font-medium">Як ви долучаєтеся до Xelay?</legend>
                <div className="grid grid-cols-2 gap-2">
                  {([['student', 'Студент / студентка', UserRound], ['teacher', 'Викладач / викладачка', GraduationCap]] as const).map(([value, label, Icon]) => <label key={value} className={`flex cursor-pointer items-center gap-2 rounded-xl border p-3 text-xs font-medium transition-colors focus-within:ring-2 focus-within:ring-primary/30 sm:text-sm ${regAccountType === value ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:bg-muted'}`}><input type="radio" name="reg-account-type" checked={regAccountType === value} onChange={() => { setRegAccountType(value); setError(''); setInvalidField(null) }} className="sr-only" /><Icon size={19} className="shrink-0" /><span>{label}</span></label>)}
                </div>
                {regAccountType === 'teacher' && <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Після реєстрації команда підтвердить ваш статус. Навчальний статус можна додати пізніше, якщо ви також навчаєтеся.</p>}
              </fieldset>
              <Field name="reg-name" invalid={invalidField === 'reg-name'} label="Ім’я та прізвище" value={regName} onChange={setRegName} maxLength={120} required />
              <Field name="reg-username" invalid={invalidField === 'reg-username'} label="Нік для пошуку (необов’язково)" value={regUsername} onChange={setRegUsername} maxLength={30} placeholder="наприклад, anna_shevchenko" hint={REGISTRATION_USERNAME_NOTE} />
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5" htmlFor="register-university">
                  Університет <span className="text-destructive">*</span>
                </label>
                <select
                  id="register-university"
                  name="reg-university"
                  aria-invalid={invalidField === 'reg-university' || undefined}
                  value={regUniversityId}
                  onChange={(event) => { specialtySelection.clear(); setRegUniversityId(event.target.value); setRegAcademicUnitId('') }}
                  required
                  disabled={loading || academicOptionsLoading || universities.length === 0}
                  className={`w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 disabled:opacity-60 ${invalidField === 'reg-university' ? 'xelay-field-invalid' : ''}`}
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
                  name="reg-academic-unit"
                  aria-invalid={invalidField === 'reg-academic-unit' || undefined}
                  value={regAcademicUnitId}
                  onChange={(event) => { specialtySelection.clear(); setRegAcademicUnitId(event.target.value) }}
                  required
                  disabled={loading || !regUniversityId || academicOptionsLoading}
                  className={`w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 disabled:opacity-60 ${invalidField === 'reg-academic-unit' ? 'xelay-field-invalid' : ''}`}
                >
                  <option value="">Оберіть факультет або інститут</option>
                  {selectedAcademicUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                </select>
              </div>
              {academicOptionsError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{academicOptionsError}</p><button type="button" onClick={() => setAcademicOptionsRefresh((previous) => previous + 1)} disabled={loading || academicOptionsLoading} className="min-h-9 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-primary disabled:opacity-50">Оновити список університетів</button></div>}
              {regAccountType === 'student' && <div className="grid gap-4 sm:grid-cols-2"><div>
                <label htmlFor="reg-academic-status" className="block text-sm font-medium text-foreground mb-1.5">
                  Навчальний статус <span className="text-destructive">*</span>
                </label>
                <select
                  id="reg-academic-status"
                  name="reg-academic-status"
                  aria-invalid={invalidField === 'reg-academic-status' || undefined}
                  value={regAcademicStatus}
                  onChange={(event) => { setRegAcademicStatus(event.target.value); setRegStudyYear(''); if (invalidField === 'reg-academic-status' || invalidField === 'reg-study-year') { setInvalidField(null); setError('') } }}
                  required
                  disabled={loading}
                  className={`w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 transition-colors ${invalidField === 'reg-academic-status' ? 'xelay-field-invalid' : ''}`}
                >
                  <option value="">Оберіть навчальний статус</option>
                  {ACADEMIC_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="reg-study-year" className="block text-sm font-medium text-foreground mb-1.5">
                  Курс {regActiveStudent && <span className="text-destructive">*</span>}
                </label>
                <select
                  id="reg-study-year"
                  name="reg-study-year"
                  value={regStudyYear}
                  onChange={(event) => { setRegStudyYear(event.target.value); if (invalidField === 'reg-study-year') { setInvalidField(null); setError('') } }}
                  required={regActiveStudent}
                  disabled={loading || !regActiveStudent}
                  aria-invalid={invalidField === 'reg-study-year' || undefined}
                  aria-describedby="reg-study-year-note"
                  className={`w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 disabled:opacity-60 ${invalidField === 'reg-study-year' ? 'xelay-field-invalid' : ''}`}
                >
                  <option value="">{regAcademicStatus === 'graduate' ? 'Не застосовується' : 'Оберіть курс'}</option>
                  {[1, 2, 3, 4, 5, 6].map((year) => <option key={year} value={year}>{year} курс</option>)}
                </select>
                <p id="reg-study-year-note" className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{regAcademicStatus === 'graduate'
                  ? 'Для випускників курс не вказується.'
                  : !regActiveStudent ? 'Спочатку оберіть навчальний статус.' : 'Поточний курс збережеться у профілі. Налаштування щорічного переходу можна змінити пізніше.'}</p>
              </div></div>}
              {regAccountType === 'student' ? <div data-auth-field="specialty"><AcademicSpecialtySelect
                id="register-specialty"
                selection={specialtySelection}
                disabled={loading || academicOptionsLoading}
                error={invalidField === 'specialty' ? error : undefined}
                onClearError={() => { setInvalidField(null); setError('') }}
              /></div> : <>
                <Field name="reg-department" invalid={invalidField === 'reg-department'} label="Кафедра" value={regDepartment} onChange={setRegDepartment} required maxLength={180} placeholder="Назва вашої кафедри" />
                <Field name="reg-position" label="Посада (необов’язково)" value={regPosition} onChange={setRegPosition} maxLength={120} placeholder="Доцент, асистент, професор…" />
              </>}
              <Field name="reg-email" invalid={invalidField === 'reg-email'} label={googleCompletion ? 'Пошта, підтверджена Google' : 'Електронна пошта'} type="email" value={regEmail} onChange={setRegEmail} autoComplete="email" disabled={Boolean(googleCompletion || pendingRegistration.current)} required />
              {!googleCompletion && <Field name="reg-password" invalid={invalidField === 'reg-password'} label="Пароль (від 8 символів)" type="password" value={regPassword} onChange={setRegPassword} autoComplete="new-password" disabled={Boolean(pendingRegistration.current)} required minLength={8} />}
              <Field name="reg-country" invalid={invalidField === 'reg-country'} label="Країна" value={regCountry} onChange={setRegCountry} maxLength={80} required />
              <Field name="reg-city" invalid={invalidField === 'reg-city'} label="Місто (необов’язково)" value={regCity} onChange={setRegCity} maxLength={120} />
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

              {regAccountType === 'student' && <>

              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  Теми, які вас цікавлять <span className="text-destructive">*</span>
                  <span className="ml-1 text-xs text-muted-foreground">(оберіть принаймні одну)</span>
                </label>
                <div data-auth-field="reg-categories" className={`flex flex-wrap gap-2 ${invalidField === 'reg-categories' ? 'xelay-field-invalid rounded-lg p-2' : ''}`}>
                  {CATEGORIES.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      aria-pressed={regCategories.includes(cat)}
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

              {!googleCompletion && <p className="text-xs leading-relaxed text-muted-foreground">Після реєстрації підтвердьте електронну пошту за посиланням у листі.</p>}
              </>}
              {regAccountType === 'teacher' && <p className="text-xs leading-relaxed text-muted-foreground">{googleCompletion ? 'Статус викладача перевіряється командою Xelay окремо від входу через Google.' : 'Спочатку підтвердьте електронну пошту за посиланням у листі. Статус викладача перевіряється окремо.'}</p>}
              <PrivacyConsent
                key={regAccountType}
                name="reg-privacy-consent"
                checked={regPrivacyConsent}
                disabled={loading}
                invalid={invalidField === 'reg-privacy-consent'}
                onChange={(checked) => {
                  if (regAccountType === 'teacher') setTeacherPrivacyConsent(checked)
                  else setStudentPrivacyConsent(checked)
                  if (invalidField === 'reg-privacy-consent') { setInvalidField(null); setError('') }
                }}
              />
              <SubmitButton loading={loading} loadingLabel={googleCompletion ? 'Зберігаємо профіль…' : 'Створюємо обліковий запис…'} disabled={academicOptionsLoading || Boolean(academicOptionsError) || regAccountType === 'student' && (specialtySelection.loading || Boolean(specialtySelection.error))} label={googleCompletion ? 'Завершити реєстрацію' : 'Створити обліковий запис'} />
              {googleCompletion ? <p className="text-center text-xs text-muted-foreground"><button type="button" disabled={loading} onClick={onClose} className="min-h-10 rounded-full px-3 underline underline-offset-4">Вийти й завершити пізніше</button></p> : <p className="text-center text-sm text-muted-foreground">
                Уже маєте обліковий запис?{' '}
                <button type="button" disabled={loading} onClick={() => changeTab('login')} className="text-primary underline underline-offset-4 hover:text-primary/80 transition-colors">
                  Увійти
                </button>
              </p>}
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function GoogleMark() {
  return <img src="https://developers.google.com/static/identity/images/g-logo.png" width={20} height={20} alt="" aria-hidden="true" referrerPolicy="no-referrer" className="shrink-0 bg-white" />
}

function Field({
  label, type = 'text', value, onChange, required, minLength, maxLength, placeholder, disabled, autoComplete, name, invalid = false, hint,
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
  name?: string
  invalid?: boolean
  hint?: string
}) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-foreground mb-1.5">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      <input
        id={id}
        name={name}
        aria-invalid={invalid || undefined}
        aria-describedby={hint ? `${id}-hint` : undefined}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        minLength={minLength}
        maxLength={maxLength}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className={`w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors ${invalid ? 'xelay-field-invalid' : ''}`}
      />
      {hint && <p id={`${id}-hint`} className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  )
}

function SubmitButton({ loading, label, loadingLabel, disabled = false }: { loading: boolean; label: string; loadingLabel: string; disabled?: boolean }) {
  return (
    <button
      type="submit"
      disabled={loading || disabled}
      className="w-full py-3 bg-primary text-primary-foreground font-semibold rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed text-sm xelay-btn"
    >
      {loading ? (
        <span className="flex items-center justify-center gap-2">
          <span className="w-4 h-4 border-2 border-background/30 border-t-background rounded-full animate-spin" />
          {loadingLabel}
        </span>
      ) : label}
    </button>
  )
}
