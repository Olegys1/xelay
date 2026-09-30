import { useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { X } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { CATEGORIES } from '../types'
import { categoryLabel } from '../translations/categories'
import { experienceLabel } from '../lib/ukrainian'

interface AuthModalProps {
  onClose: () => void
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

export function AuthModal({ onClose }: AuthModalProps) {
  const [tab, setTab] = useState<Tab>('login')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const pendingRegistration = useRef<{ id: string; email: string } | null>(null)
  const submitting = useRef(false)
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

  useEffect(() => {
    const loadAcademicOptions = async () => {
      const [universityResult, unitResult] = await Promise.all([
        supabase.from('universities').select('id, name, slug').eq('is_active', true).order('name'),
        supabase.from('academic_units').select('id, university_id, name, unit_type').eq('is_active', true).order('name'),
      ])
      if (universityResult.error || unitResult.error) {
        setError('Не вдалося завантажити список університетів. Спробуйте оновити сторінку.')
      } else {
        const nextUniversities = (universityResult.data || []) as UniversityOption[]
        setUniversities(nextUniversities)
        setAcademicUnits((unitResult.data || []) as AcademicUnitOption[])
        const defaultUniversity = nextUniversities.find((item) => item.slug === 'knu') || nextUniversities[0]
        if (defaultUniversity) setRegUniversityId(defaultUniversity.id)
      }
      setAcademicOptionsLoading(false)
    }
    void loadAcademicOptions()
  }, [])

  const selectedAcademicUnits = academicUnits.filter((unit) => unit.university_id === regUniversityId)

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (submitting.current) return
    submitting.current = true
    setError('')
    setLoading(true)
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      })
      if (error) throw error
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : ''
      if (msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('credentials')) {
        setError('Неправильна електронна пошта або пароль.')
      } else if (msg.toLowerCase().includes('not found') || msg.toLowerCase().includes('no user')) {
        setError('Облікового запису з такою електронною поштою не знайдено.')
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
    const normalizedUsername = regUsername.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA')
    if (normalizedUsername && !/^[\p{L}\p{N}][\p{L}\p{N}._-]{2,29}$/u.test(normalizedUsername)) {
      setError('Нік має містити 3–30 літер, цифр, крапок, дефісів або підкреслень.')
      return
    }
    if (!regCountry.trim()) { setError('Вкажіть країну.'); return }
    if (!regUniversityId || !regAcademicUnitId) { setError('Оберіть університет і факультет або інститут.'); return }
    if (!regExperience) { setError('Оберіть досвід.'); return }
    if (regCategories.length === 0) { setError('Оберіть принаймні одну тему.'); return }
    if (regPassword.length < 6) { setError('Пароль має містити щонайменше 6 символів.'); return }

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
        const { data, error } = await supabase.auth.signUp({ email, password: regPassword })
        if (error) throw error
        if (!data.user?.id) throw new Error('Не вдалося створити обліковий запис.')
        if (!data.session) throw new Error('Email confirmation is enabled in Supabase.')
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
          faculty: selectedAcademicUnits.find((unit) => unit.id === regAcademicUnitId)?.name || '',
          avatar_url: '',
          created_at: new Date().toISOString(),
        })
      if (profileError) throw profileError

      await refreshUser()
      navigate({ to: '/news' })
      onClose()
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : typeof err === 'object' && err !== null && 'message' in err ? String(err.message) : ''
      if (msg.toLowerCase().includes('already') || msg.toLowerCase().includes('exists')) {
        setError('Обліковий запис із такою електронною поштою вже існує.')
      } else if (msg.toLowerCase().includes('email confirmation is enabled')) {
        setError('Підтвердження email ще ввімкнене в Supabase. Вимкніть його в налаштуваннях входу через Email.')
      } else if (msg.toLowerCase().includes('duplicate key') || msg.toLowerCase().includes('profiles_username_lower_unique')) {
        setError('Такий нік уже зайнятий. Спробуйте інший.')
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
      <div className="relative z-10 w-full max-w-md bg-background border border-border rounded-xl shadow-[var(--shadow-2xl)] animate-fade-in max-h-[90vh] overflow-y-auto">
        <button
          onClick={onClose}
          className="absolute top-4 right-4 p-1.5 rounded-full hover:bg-muted transition-colors xelay-btn"
          aria-label="Закрити"
        >
          <X size={18} className="text-foreground" />
        </button>

        <div className="px-8 pt-8 pb-4 text-center">
          <p className="text-3xl font-bold tracking-tight text-foreground">Xelay</p>
          <p className="text-sm text-muted-foreground mt-1">Університетська спільнота</p>
        </div>

        <div className="flex border-b border-border mx-8">
          {(['login', 'register'] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => { setTab(t); setError('') }}
              className={`flex-1 py-3 text-sm font-medium capitalize transition-colors border-b-2 -mb-px ${
                tab === t
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t === 'login' ? 'Вхід' : 'Реєстрація'}
            </button>
          ))}
        </div>

        <div className="px-8 py-6">
          {error && (
            <div className="mb-4 p-3 bg-destructive/10 border border-destructive/20 rounded-lg text-sm text-destructive">
              {error}
            </div>
          )}

          {tab === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <Field label="Електронна пошта" type="email" value={loginEmail} onChange={setLoginEmail} required />
              <Field label="Пароль" type="password" value={loginPassword} onChange={setLoginPassword} required />
              <SubmitButton loading={loading} label="Увійти" />
              <p className="text-center text-sm text-muted-foreground">
                Ще не маєте облікового запису?{' '}
                <button type="button" onClick={() => setTab('register')} className="text-foreground underline hover:text-muted-foreground transition-colors">
                  Зареєструватися
                </button>
              </p>
            </form>
          ) : (
            <form onSubmit={handleRegister} className="space-y-4">
              <Field label="Ім’я та прізвище" value={regName} onChange={setRegName} required />
              <Field label="Нік для пошуку (необов’язково)" value={regUsername} onChange={setRegUsername} maxLength={30} placeholder="наприклад, anna_shevchenko" />
              <div>
                <label className="block text-sm font-medium text-foreground mb-1.5" htmlFor="register-university">
                  Університет <span className="text-destructive">*</span>
                </label>
                <select
                  id="register-university"
                  value={regUniversityId}
                  onChange={(event) => { setRegUniversityId(event.target.value); setRegAcademicUnitId('') }}
                  required
                  disabled={academicOptionsLoading || universities.length === 0}
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
                  onChange={(event) => setRegAcademicUnitId(event.target.value)}
                  required
                  disabled={!regUniversityId || academicOptionsLoading}
                  className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 disabled:opacity-60"
                >
                  <option value="">Оберіть факультет або інститут</option>
                  {selectedAcademicUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                </select>
              </div>
              <Field label="Електронна пошта" type="email" value={regEmail} onChange={setRegEmail} disabled={Boolean(pendingRegistration.current)} required />
              <Field label="Пароль (від 6 символів)" type="password" value={regPassword} onChange={setRegPassword} disabled={Boolean(pendingRegistration.current)} required minLength={6} />
              <Field label="Країна" value={regCountry} onChange={setRegCountry} required />
              <Field label="Місто (необов’язково)" value={regCity} onChange={setRegCity} />
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

              <SubmitButton loading={loading} label="Створити обліковий запис" />
              <p className="text-center text-sm text-muted-foreground">
                Уже маєте обліковий запис?{' '}
                <button type="button" onClick={() => setTab('login')} className="text-foreground underline hover:text-muted-foreground transition-colors">
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
  label, type = 'text', value, onChange, required, minLength, maxLength, placeholder, disabled,
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
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-foreground mb-1.5">
        {label} {required && <span className="text-destructive">*</span>}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        minLength={minLength}
        maxLength={maxLength}
        placeholder={placeholder}
        className="w-full px-3 py-2.5 border border-border rounded-lg bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-foreground/20 placeholder:text-muted-foreground transition-colors"
      />
    </div>
  )
}

function SubmitButton({ loading, label }: { loading: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={loading}
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
