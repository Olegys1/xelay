import { useEffect, useState, useRef, useId } from 'react'
import { X, Camera, Loader2, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { useToast } from '../context/ToastContext'
import { CATEGORIES } from '../types'
import { categoryLabel } from '../translations/categories'
import { ACADEMIC_STATUS_OPTIONS, isAcademicStatus } from '../lib/academicStatus'
import { profileText, profileTextArray } from '../lib/profileText'
import { AcademicSpecialtySelect } from './AcademicSpecialtySelect'
import { academicSpecialtyMatches, useAcademicSpecialties } from '../lib/academicSpecialties'
import { uploadPublicMediaFiles, publicMediaValidationError, publicMediaUploadError } from '../lib/publicMedia'

interface ProfileSettingsModalProps {
  onClose: () => void
}

type UniversityOption = { id: string; name: string; slug: string }
type AcademicUnitOption = { id: string; university_id: string; name: string; unit_type: string }
type ProfileField = 'name' | 'username' | 'university' | 'academicUnit' | 'specialty'
type ProfileErrors = Partial<Record<ProfileField, string>>
const FIELD_IDS: Record<ProfileField, string> = {
  name: 'profile-name', username: 'profile-username', university: 'profile-university',
  academicUnit: 'profile-academic-unit', specialty: 'profile-specialty',
}

export function ProfileSettingsModal({ onClose }: ProfileSettingsModalProps) {
  const { authUser, xelayUser, refreshUser } = useAuth()
  const { notify } = useToast()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const alive = useRef(true)
  const saveInFlight = useRef(false)
  const uploadInFlight = useRef(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestOnClose = useRef(onClose)
  latestOnClose.current = onClose

  const [name, setName] = useState(xelayUser?.name || '')
  const [username, setUsername] = useState(xelayUser?.username || '')
  const [country, setCountry] = useState(xelayUser?.country || '')
  const [city, setCity] = useState(xelayUser?.city || '')
  const [universityId, setUniversityId] = useState(xelayUser?.universityId || '')
  const [academicUnitId, setAcademicUnitId] = useState(xelayUser?.academicUnitId || '')
  const [universities, setUniversities] = useState<UniversityOption[]>([])
  const [academicUnits, setAcademicUnits] = useState<AcademicUnitOption[]>([])
  const [academicOptionsLoading, setAcademicOptionsLoading] = useState(true)
  const [academicOptionsError, setAcademicOptionsError] = useState('')
  const [academicOptionsRefresh, setAcademicOptionsRefresh] = useState(0)
  const specialtySelection = useAcademicSpecialties(universityId, academicUnitId, { id: xelayUser?.specialtyId, name: xelayUser?.specialty })
  const [studyYear, setStudyYear] = useState(xelayUser?.studyYear?.toString() || '')
  const [bio, setBio] = useState(xelayUser?.bio || '')
  const [academicStatus, setAcademicStatus] = useState(xelayUser?.experience || '')
  const [categories, setCategories] = useState<string[]>(xelayUser?.categories || [])
  const [skills, setSkills] = useState(() => profileText(xelayUser?.skills))
  const [helpWith, setHelpWith] = useState(() => profileText(xelayUser?.helpWith))
  const [wantToLearn, setWantToLearn] = useState(() => profileText(xelayUser?.wantToLearn))
  const [avatarUrl, setAvatarUrl] = useState(xelayUser?.avatarUrl || '')
  const [avatarPreview, setAvatarPreview] = useState(xelayUser?.avatarUrl || '')

  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [fieldErrors, setFieldErrors] = useState<ProfileErrors>({})
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    alive.current = true
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const overflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    dialogRef.current?.focus()
    return () => {
      alive.current = false
      if (closeTimer.current) clearTimeout(closeTimer.current)
      document.body.style.overflow = overflow
      previous?.focus()
    }
  }, [])

  const clearFieldError = (field: ProfileField) => {
    setFieldErrors((current) => { const next = { ...current }; delete next[field]; return next })
    setError('')
  }
  const focusField = (field: ProfileField) => {
    requestAnimationFrame(() => {
      if (!alive.current) return
      const input = formRef.current?.querySelector<HTMLInputElement | HTMLSelectElement>(`#${FIELD_IDS[field]}`)
      const target = input?.disabled ? input.closest<HTMLElement>('[data-profile-field-container]') : input
      const focusTarget = target || dialogRef.current
      focusTarget?.focus({ preventScroll: true })
      focusTarget?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })
    })
  }
  const showFailure = (message: string, tone: 'error' | 'warning' = 'error') => {
    setError(message)
    notify({ id: 'profile-save', title: tone === 'warning' ? 'Перевірте профіль' : 'Профіль не збережено', description: message, tone })
  }

  useEffect(() => {
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
        setUniversities((universityResult.data || []) as UniversityOption[])
        setAcademicUnits((unitResult.data || []) as AcademicUnitOption[])
      } catch {
        if (active) {
          setUniversities([])
          setAcademicUnits([])
          setAcademicOptionsError('Не вдалося завантажити університети та факультети. Спробуйте ще раз.')
        }
      } finally {
        window.clearTimeout(timeout)
        if (active) setAcademicOptionsLoading(false)
      }
    }
    void loadAcademicOptions()
    return () => { active = false; window.clearTimeout(timeout); controller.abort() }
  }, [academicOptionsRefresh])

  const selectedAcademicUnits = academicUnits.filter((unit) => unit.university_id === universityId)

  const toggleCategory = (cat: string) => {
    setCategories((prev) =>
      prev.includes(cat)
        ? prev.filter((c) => c !== cat)
        : [...prev, cat]
    )
  }

  const handleAvatarChange = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0]

    if (!file || !xelayUser?.id || uploadInFlight.current || saveInFlight.current) return

    const mediaProblem = publicMediaValidationError([file], 'avatars')
    if (mediaProblem) {
      const message = mediaProblem
      setError(message)
      notify({ id: 'profile-avatar', title: 'Перевірте фото', description: message, tone: 'warning' })
      e.target.value = ''
      return
    }

    const localUrl = URL.createObjectURL(file)

    setAvatarPreview(localUrl)
    uploadInFlight.current = true
    setUploading(true)
    setError('')

    try {
      const [{ url: publicUrl }] = await uploadPublicMediaFiles(xelayUser.id, 'avatars', [file], 'avatars')

      if (!alive.current) return
      setAvatarUrl(publicUrl)
      setAvatarPreview(publicUrl)
      notify({ id: 'profile-avatar', title: 'Фото завантажено', description: 'Натисніть «Зберегти зміни», щоб оновити фото у профілі.', tone: 'info' })
    } catch (err) {
      console.error(err)
      if (alive.current) {
        const message = publicMediaUploadError(err, 'Не вдалося завантажити фото профілю. Ваше попереднє фото збережено.')
        setError(message)
        setAvatarPreview(avatarUrl)
        notify({ id: 'profile-avatar', title: 'Фото не завантажено', description: message, tone: 'error' })
      }
    } finally {
      URL.revokeObjectURL(localUrl)
      uploadInFlight.current = false
      if (alive.current) setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()

    if (saveInFlight.current || uploadInFlight.current || saved) return
    if (!xelayUser?.id || authUser?.id !== xelayUser.id) {
      showFailure('Увійдіть знову, щоб зберегти зміни профілю.')
      return
    }

    setError('')
    const selectedUnit = selectedAcademicUnits.find((unit) => unit.id === academicUnitId)
    const normalizedUsername = username.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA')
    const problems: ProfileErrors = {}
    if (!name.trim()) problems.name = 'Вкажіть ім’я та прізвище.'
    if (!normalizedUsername) problems.username = 'Вкажіть нік, щоб інші учасники могли знайти вас.'
    else if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{2,29}$/u.test(normalizedUsername)) problems.username = 'Нік має містити 3–30 літер, цифр, крапок, дефісів або підкреслень і починатися з літери або цифри.'
    if (academicOptionsLoading) problems.university = 'Список університетів ще завантажується. Зачекайте й збережіть профіль ще раз.'
    else if (academicOptionsError) problems.university = 'Не вдалося завантажити університети. Оновіть список і повторіть збереження.'
    else if (!universities.some((university) => university.id === universityId)) problems.university = 'Оберіть університет зі списку.'
    if (!selectedUnit) problems.academicUnit = universityId ? 'Оберіть факультет або інститут свого університету.' : 'Спочатку оберіть університет, а потім факультет або інститут.'
    if (!academicSpecialtyMatches(specialtySelection, universityId, academicUnitId)) {
      problems.specialty = !universityId || !academicUnitId ? 'Оберіть університет і факультет, щоб вибрати освітню програму.'
        : specialtySelection.loading ? 'Освітні програми ще завантажуються. Зачекайте й повторіть збереження.'
          : specialtySelection.error ? 'Не вдалося завантажити освітні програми. Оновіть список нижче.'
            : !specialtySelection.options.length ? 'Для цього факультету поки немає освітніх програм. Оновіть список або зверніться до підтримки.'
              : 'Оберіть освітню програму зі списку свого факультету або інституту.'
    }
    setFieldErrors(problems)
    const firstProblem = (Object.keys(FIELD_IDS) as ProfileField[]).find((field) => problems[field])
    if (firstProblem) {
      showFailure(problems[firstProblem]!, 'warning')
      focusField(firstProblem)
      return
    }
    const selectedSpecialty = specialtySelection.selected!

    saveInFlight.current = true
    setSaving(true)

    try {
      const { error: saveError } = await supabase
        .from('profiles')
        .update({
          full_name: name.trim(), username: normalizedUsername,
          country: country.trim(), city: city.trim(), faculty: selectedUnit!.name,
          university_id: universityId, academic_unit_id: academicUnitId,
          specialty_id: selectedSpecialty.id, specialty: selectedSpecialty.name,
          study_year: studyYear ? Number(studyYear) : null,
          bio: bio.trim(), experience: academicStatus, categories,
          skills: profileTextArray(skills), help_with: profileTextArray(helpWith), want_to_learn: profileTextArray(wantToLearn),
          avatar_url: avatarUrl,
        })
        .eq('id', xelayUser.id).select('id').single()

      if (saveError) throw saveError
      if (!alive.current) return
      setSaved(true)
      notify({ id: 'profile-save', title: 'Профіль оновлено', description: 'Ваші зміни збережено.', tone: 'success' })
      try { await refreshUser() } catch {
        if (alive.current) notify({ id: 'profile-save', title: 'Зміни профілю збережено', description: 'Не вдалося оновити вигляд профілю. Оновіть сторінку, щоб побачити зміни.', tone: 'warning' })
      }
      if (!alive.current) return
      closeTimer.current = setTimeout(() => { if (alive.current) latestOnClose.current() }, 1000)
    } catch (err) {
      console.error(err)
      if (!alive.current) return
      const value = err as { code?: string; message?: string }
      const message = (value?.message || '').toLowerCase()
      if (value?.code === '23505' || message.includes('duplicate key') || message.includes('profiles_username_lower_unique')) {
        const description = 'Такий нік уже зайнятий. Вкажіть інший нік і збережіть профіль ще раз.'
        setFieldErrors({ username: description }); showFailure(description); focusField('username')
      } else if (message.includes('academic_specialty')) {
        const description = 'Перевірте освітню програму: оберіть актуальну програму свого факультету зі списку.'
        setFieldErrors({ specialty: description }); showFailure(description); focusField('specialty')
      } else if (value?.code === '42501' || value?.code === 'PGRST301') showFailure('Сеанс завершився або доступ змінився. Увійдіть знову, щоб зберегти профіль.')
      else showFailure('Не вдалося зберегти профіль. Перевірте з’єднання та спробуйте ще раз. Введені дані залишаються у формі.')
    } finally {
      saveInFlight.current = false
      if (alive.current) setSaving(false)
    }
  }

  const initials = name
    ? name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : '?'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="xelay-dialog-backdrop absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => { if (!saving && !uploading) onClose() }}
      />

      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="profile-settings-title" tabIndex={-1} className="xelay-dialog-panel relative z-10 w-full max-w-lg bg-background border border-border rounded-xl p-6 max-h-[90dvh] overflow-y-auto outline-none" onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving && !uploading) onClose()
        if (event.key !== 'Tab') return
        const elements = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]') || []).filter((element) => element.offsetParent !== null)
        const first = elements[0]; const last = elements[elements.length - 1]
        if (!first) { event.preventDefault(); return }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) { event.preventDefault(); last.focus() }
        if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) { event.preventDefault(); first.focus() }
      }}>
        <div className="flex items-center justify-between mb-6">
          <h2 id="profile-settings-title" className="text-xl font-bold">Налаштування профілю</h2>

          <button type="button" disabled={saving || uploading} onClick={onClose} aria-label="Закрити налаштування профілю" className="inline-flex h-10 w-10 items-center justify-center rounded-full hover:bg-muted disabled:opacity-50">
            <X size={20} />
          </button>
        </div>

        <form ref={formRef} onSubmit={handleSave} noValidate aria-busy={saving || uploading} className="space-y-5">
          <p className="text-xs text-muted-foreground">Поля зі знаком * обов’язкові. Натисніть «Зберегти зміни» — підкажемо, якщо ще потрібно щось заповнити.</p>
          <fieldset disabled={saving || saved || uploading} className="min-w-0 space-y-5">
          <div className="flex items-center gap-5">
            <div className="relative">
              <div className="w-20 h-20 rounded-full overflow-hidden bg-primary text-primary-foreground flex items-center justify-center">
                {avatarPreview ? (
                  <img
                    src={avatarPreview}
                    alt="Ваше фото профілю"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="font-bold text-lg">
                    {initials}
                  </span>
                )}
              </div>

              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Змінити фото профілю"
                className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center"
              >
                {uploading ? (
                  <Loader2 size={14} className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <Camera size={14} />
                )}
              </button>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleAvatarChange}
              />
            </div>

            <div>
              <p className="font-medium">Фото профілю</p>
              <p className="text-sm text-muted-foreground">
                JPG, PNG, WEBP
              </p>
            </div>
          </div>

          {error && (
            <div role="alert" className="xelay-inline-feedback xelay-feedback-error text-sm">
              {error}
            </div>
          )}

          <SettingsField
            id="profile-name"
            label="Ім’я та прізвище"
            value={name}
            required
            error={fieldErrors.name}
            onChange={(value) => { setName(value); clearFieldError('name') }}
          />

          <SettingsField
            id="profile-username"
            label="Нік для пошуку"
            value={username}
            required
            error={fieldErrors.username}
            onChange={(value) => { setUsername(value); clearFieldError('username') }}
            maxLength={30}
            placeholder="наприклад, anna_shevchenko"
          />

          <div className="grid grid-cols-2 gap-3">
            <SettingsField
              label="Країна"
              value={country}
              onChange={setCountry}
            />

            <SettingsField
              label="Місто"
              value={city}
              onChange={setCity}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div data-profile-field-container tabIndex={-1} className="outline-none">
              <label className="block mb-2 text-sm font-medium" htmlFor="profile-university">Університет <span className="text-destructive">*</span></label>
              <select
                id="profile-university"
                value={universityId}
                onChange={(event) => { specialtySelection.clear(); setUniversityId(event.target.value); setAcademicUnitId(''); clearFieldError('university'); clearFieldError('academicUnit'); clearFieldError('specialty') }}
                required
                disabled={academicOptionsLoading || saving}
                aria-invalid={Boolean(fieldErrors.university) || undefined}
                aria-describedby={fieldErrors.university ? 'profile-university-error' : undefined}
                className={`w-full px-3 py-2 border border-border rounded-lg bg-background ${fieldErrors.university ? 'xelay-field-invalid' : ''}`}
              >
                <option value="">Оберіть університет</option>
                {universities.map((university) => <option key={university.id} value={university.id}>{university.name}</option>)}
              </select>
              {fieldErrors.university && <p id="profile-university-error" className="mt-1.5 text-xs text-destructive">{fieldErrors.university}</p>}
            </div>
            <div data-profile-field-container tabIndex={-1} className="outline-none">
              <label className="block mb-2 text-sm font-medium" htmlFor="profile-academic-unit">Факультет або інститут <span className="text-destructive">*</span></label>
              <select
                id="profile-academic-unit"
                value={academicUnitId}
                onChange={(event) => {
                  specialtySelection.clear()
                  setAcademicUnitId(event.target.value)
                  clearFieldError('academicUnit'); clearFieldError('specialty')
                }}
                required
                disabled={!universityId || academicOptionsLoading || saving}
                aria-invalid={Boolean(fieldErrors.academicUnit) || undefined}
                aria-describedby={fieldErrors.academicUnit ? 'profile-academic-unit-error' : undefined}
                className={`w-full px-3 py-2 border border-border rounded-lg bg-background ${fieldErrors.academicUnit ? 'xelay-field-invalid' : ''}`}
              >
                <option value="">Оберіть факультет або інститут</option>
                {selectedAcademicUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
              </select>
              {fieldErrors.academicUnit && <p id="profile-academic-unit-error" className="mt-1.5 text-xs text-destructive">{fieldErrors.academicUnit}</p>}
            </div>
            <div data-profile-field-container tabIndex={-1} className="outline-none sm:col-span-2"><AcademicSpecialtySelect id="profile-specialty" selection={specialtySelection} disabled={saving || academicOptionsLoading} legacyName={xelayUser?.specialty} error={fieldErrors.specialty} onClearError={() => clearFieldError('specialty')} /></div>
          </div>
          {academicOptionsError && <div role="alert" className="space-y-2 text-sm text-destructive"><p>{academicOptionsError}</p><button type="button" onClick={() => setAcademicOptionsRefresh((previous) => previous + 1)} disabled={saving || academicOptionsLoading} className="min-h-9 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-primary disabled:opacity-50">Оновити список університетів</button></div>}

          <div>
            <label className="block mb-2 text-sm font-medium" htmlFor="profile-study-year">
              Курс
            </label>
            <select
              id="profile-study-year"
              value={studyYear}
              onChange={(e) => setStudyYear(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg bg-background"
            >
              <option value="">Оберіть курс</option>
              {[1, 2, 3, 4, 5, 6].map((year) => (
                <option key={year} value={year}>{year} курс</option>
              ))}
            </select>
          </div>

<div>
  <label htmlFor="profile-bio" className="block mb-2 text-sm font-medium">
    Про себе
  </label>

  <textarea
    id="profile-bio"
    value={bio}
    onChange={(e) => setBio(e.target.value)}
    rows={4}
    maxLength={300}
    placeholder="Розкажіть спільноті про себе, свій досвід, інтереси та проєкти..."
    className="w-full px-3 py-2 border border-border rounded-lg bg-background resize-none"
  />

  <p className="text-xs text-muted-foreground mt-1">
    {bio.length}/300
  </p>
</div>
          <div>
            <label htmlFor="profile-academic-status" className="block mb-2 text-sm font-medium">
              Навчальний статус
            </label>

            <select
              id="profile-academic-status"
              value={academicStatus}
              onChange={(e) => setAcademicStatus(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg bg-background"
            >
              <option value="">Оберіть навчальний статус</option>
              {academicStatus && !isAcademicStatus(academicStatus) && (
                <option value={academicStatus} disabled hidden>Уточніть навчальний статус</option>
              )}
              {ACADEMIC_STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block mb-2 text-sm font-medium">
              Інтереси та теми спільноти
            </label>

            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((cat) => (
                <button
                  key={cat}
                  type="button"
                  onClick={() => toggleCategory(cat)}
                  aria-pressed={categories.includes(cat)}
                  className={`px-3 py-1.5 rounded-full border text-sm transition-all ${
                    categories.includes(cat)
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border'
                  }`}
                >
                  {categoryLabel(cat)}
                </button>
              ))}
            </div>
          </div>

          <ProfileTextField
            id="profile-skills"
            label="Навички"
            value={skills}
            onChange={setSkills}
            placeholder="Наприклад: Figma, Python, публічні виступи"
          />
          <ProfileTextField
            id="profile-help-with"
            label="Можу допомогти з"
            value={helpWith}
            onChange={setHelpWith}
            placeholder="Наприклад: підготовка до співбесіди, дизайн портфоліо"
          />
          <ProfileTextField
            id="profile-want-to-learn"
            label="Хочу дізнатися"
            value={wantToLearn}
            onChange={setWantToLearn}
            placeholder="Наприклад: запуск стартапу, data analytics"
          />
          </fieldset>

          {(saving || uploading || saved) && <p role="status" className={`xelay-inline-feedback text-sm ${saved ? 'xelay-feedback-success' : ''}`}>{saved ? 'Зміни профілю збережено.' : saving ? 'Зберігаємо зміни профілю…' : 'Завантажуємо фото профілю…'}</p>}

          <div className="flex gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              disabled={saving || uploading}
              className="flex-1 border border-border rounded-lg py-2.5"
            >
              {saved ? 'Закрити' : 'Скасувати'}
            </button>

            <button
              type="submit"
              disabled={saving || uploading || saved}
              className="flex-1 bg-primary text-primary-foreground rounded-lg py-2.5 font-medium hover:bg-primary/90"
            >
              {saved ? (
                <span className="flex items-center justify-center gap-2">
                  <Check size={16} />
                  Збережено
                </span>
              ) : saving ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
                  Зберігаємо…
                </span>
              ) : (
                'Зберегти зміни'
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function SettingsField({
  id,
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  required = false,
  error,
}: {
  id?: string
  label: string
  value: string
  onChange: (v: string) => void
  maxLength?: number
  placeholder?: string
  required?: boolean
  error?: string
}) {
  const generatedId = useId()
  const fieldId = id || generatedId
  return (
    <div>
      <label htmlFor={fieldId} className="block mb-2 text-sm font-medium">
        {label}{required && <span className="ml-1 text-destructive">*</span>}
      </label>

      <input
        id={fieldId}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        placeholder={placeholder}
        required={required}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={error ? `${fieldId}-error` : undefined}
        className={`w-full px-3 py-2 border border-border rounded-lg bg-background ${error ? 'xelay-field-invalid' : ''}`}
      />
      {error && <p id={`${fieldId}-error`} className="mt-1.5 text-xs text-destructive">{error}</p>}
    </div>
  )
}

function ProfileTextField({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <div>
      <label htmlFor={id} className="block mb-2 text-sm font-medium">{label}</label>
      <textarea
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        maxLength={5000}
        placeholder={placeholder}
        aria-describedby={`${id}-hint`}
        className="w-full px-3 py-2 border border-border rounded-lg bg-background text-base sm:text-sm resize-y"
      />
      <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">Пишіть у довільній формі. Коми та перенесення рядків збережуться.</p>
    </div>
  )
}
