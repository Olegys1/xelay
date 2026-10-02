import { useEffect, useState, useRef } from 'react'
import { X, Camera, Loader2, Check } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import { CATEGORIES } from '../types'
import { categoryLabel } from '../translations/categories'
import { experienceLabel } from '../lib/ukrainian'
import { profileText, profileTextArray } from '../lib/profileText'
import { AcademicSpecialtySelect } from './AcademicSpecialtySelect'
import { academicSpecialtyMatches, useAcademicSpecialties } from '../lib/academicSpecialties'

interface ProfileSettingsModalProps {
  onClose: () => void
}

const EXPERIENCE_OPTIONS = [
  'Student / Fresh Graduate',
  '1–3 years',
  '3–7 years',
  '7–15 years',
  '15+ years',
]

type UniversityOption = { id: string; name: string; slug: string }
type AcademicUnitOption = { id: string; university_id: string; name: string; unit_type: string }

export function ProfileSettingsModal({ onClose }: ProfileSettingsModalProps) {
  const { xelayUser, refreshUser } = useAuth()
  const fileInputRef = useRef<HTMLInputElement>(null)

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
  const [experience, setExperience] = useState(xelayUser?.experience || '')
  const [categories, setCategories] = useState<string[]>(xelayUser?.categories || [])
  const [skills, setSkills] = useState(() => profileText(xelayUser?.skills))
  const [helpWith, setHelpWith] = useState(() => profileText(xelayUser?.helpWith))
  const [wantToLearn, setWantToLearn] = useState(() => profileText(xelayUser?.wantToLearn))
  const [avatarUrl, setAvatarUrl] = useState(xelayUser?.avatarUrl || '')
  const [avatarPreview, setAvatarPreview] = useState(xelayUser?.avatarUrl || '')

  const [uploading, setUploading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

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

    if (!file || !xelayUser?.id) return

    if (!file.type.startsWith('image/')) {
      setError('Завантажте файл зображення.')
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      setError('Розмір зображення має бути меншим за 5 МБ.')
      return
    }

    const localUrl = URL.createObjectURL(file)

    setAvatarPreview(localUrl)
    setUploading(true)
    setError('')

    try {
      const ext = file.name.split('.').pop() || 'jpg'

      const fileName = `${xelayUser.id}-${Date.now()}.${ext}`

      const { error: uploadError } = await supabase.storage
        .from('avatars')
        .upload(fileName, file, {
          upsert: true,
        })

      if (uploadError) throw uploadError

      const {
        data: { publicUrl },
      } = supabase.storage
        .from('avatars')
        .getPublicUrl(fileName)

      setAvatarUrl(publicUrl)
      setAvatarPreview(publicUrl)
    } catch (err) {
      console.error(err)
      setError('Не вдалося завантажити фото профілю.')
      setAvatarPreview(xelayUser?.avatarUrl || '')
    } finally {
      setUploading(false)
    }
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault()

    if (!xelayUser?.id || saving || uploading) return

    setError('')

    if (!name.trim()) {
      setError("Вкажіть ім’я та прізвище.")
      return
    }

    const selectedUnit = selectedAcademicUnits.find((unit) => unit.id === academicUnitId)
    if (academicOptionsLoading || academicOptionsError || !universities.some((university) => university.id === universityId) || !selectedUnit) {
      setError('Оберіть університет і факультет або інститут.')
      return
    }
    if (!academicSpecialtyMatches(specialtySelection, universityId, academicUnitId)) {
      setError('Оберіть освітню програму зі списку свого факультету або інституту.')
      return
    }
    const selectedSpecialty = specialtySelection.selected!

    const normalizedUsername = username.trim().replace(/^@/, '').toLocaleLowerCase('uk-UA')
    if (!/^[\p{L}\p{N}][\p{L}\p{N}._-]{2,29}$/u.test(normalizedUsername)) {
      setError('Нік має містити 3–30 літер, цифр, крапок, дефісів або підкреслень.')
      return
    }

    setSaving(true)

    try {
      const { error } = await supabase
        .from('profiles')
        .update({
          full_name: name.trim(),
          username: normalizedUsername,
          country: country.trim(),
          city: city.trim(),
          faculty: selectedUnit.name,
          university_id: universityId,
          academic_unit_id: academicUnitId,
          specialty_id: selectedSpecialty.id,
          specialty: selectedSpecialty.name,
          study_year: studyYear ? Number(studyYear) : null,
          bio: bio.trim(),
          experience,
          categories,
          skills: profileTextArray(skills),
          help_with: profileTextArray(helpWith),
          want_to_learn: profileTextArray(wantToLearn),
          avatar_url: avatarUrl,
        })
        .eq('id', xelayUser.id)

      if (error) throw error

      await refreshUser()

      setSaved(true)

      setTimeout(() => {
        onClose()
      }, 1000)
    } catch (err) {
      console.error(err)
      const message = err instanceof Error ? err.message.toLowerCase() : ''
      setError(message.includes('duplicate key') || message.includes('profiles_username_lower_unique')
        ? 'Такий нік уже зайнятий. Спробуйте інший.'
        : 'Не вдалося зберегти профіль. Спробуйте ще раз.')
    } finally {
      setSaving(false)
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
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative z-10 w-full max-w-lg bg-background border border-border rounded-xl p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-xl font-bold">Налаштування профілю</h2>

          <button onClick={onClose}>
            <X size={20} />
          </button>
        </div>

        <form onSubmit={handleSave} className="space-y-5">
          <div className="flex items-center gap-5">
            <div className="relative">
              <div className="w-20 h-20 rounded-full overflow-hidden bg-primary text-primary-foreground flex items-center justify-center">
                {avatarPreview ? (
                  <img
                    src={avatarPreview}
                    alt="avatar"
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
                className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-primary text-primary-foreground flex items-center justify-center"
              >
                {uploading ? (
                  <Loader2 size={14} className="animate-spin" />
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
            <div className="text-sm text-red-500">
              {error}
            </div>
          )}

          <SettingsField
            label="Ім’я та прізвище"
            value={name}
            onChange={setName}
          />

          <SettingsField
            label="Нік для пошуку"
            value={username}
            onChange={setUsername}
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
            <div>
              <label className="block mb-2 text-sm font-medium" htmlFor="profile-university">Університет</label>
              <select
                id="profile-university"
                value={universityId}
                onChange={(event) => { specialtySelection.clear(); setUniversityId(event.target.value); setAcademicUnitId('') }}
                required
                disabled={academicOptionsLoading || saving}
                className="w-full px-3 py-2 border border-border rounded-lg bg-background"
              >
                <option value="">Оберіть університет</option>
                {universities.map((university) => <option key={university.id} value={university.id}>{university.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block mb-2 text-sm font-medium" htmlFor="profile-academic-unit">Факультет або інститут</label>
              <select
                id="profile-academic-unit"
                value={academicUnitId}
                onChange={(event) => {
                  specialtySelection.clear()
                  setAcademicUnitId(event.target.value)
                }}
                required
                disabled={!universityId || academicOptionsLoading || saving}
                className="w-full px-3 py-2 border border-border rounded-lg bg-background"
              >
                <option value="">Оберіть факультет або інститут</option>
                {selectedAcademicUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
              </select>
            </div>
            <AcademicSpecialtySelect selection={specialtySelection} disabled={saving || academicOptionsLoading} legacyName={xelayUser?.specialty} className="sm:col-span-2" />
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
  <label className="block mb-2 text-sm font-medium">
    Про себе
  </label>

  <textarea
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
            <label className="block mb-2 text-sm font-medium">
              Досвід
            </label>

            <select
              value={experience}
              onChange={(e) => setExperience(e.target.value)}
              className="w-full px-3 py-2 border border-border rounded-lg bg-background"
            >
              <option value="">Оберіть досвід</option>

              {EXPERIENCE_OPTIONS.map((opt) => (
                <option key={opt} value={opt}>
                  {experienceLabel(opt)}
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

          <div className="flex gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 border border-border rounded-lg py-2.5"
            >
              Скасувати
            </button>

            <button
              type="submit"
              disabled={saving || uploading || academicOptionsLoading || Boolean(academicOptionsError) || !universities.some((university) => university.id === universityId) || !selectedAcademicUnits.some((unit) => unit.id === academicUnitId) || !academicSpecialtyMatches(specialtySelection, universityId, academicUnitId)}
              className="flex-1 bg-primary text-primary-foreground rounded-lg py-2.5 font-medium hover:bg-primary/90"
            >
              {saved ? (
                <span className="flex items-center justify-center gap-2">
                  <Check size={16} />
                  Збережено
                </span>
              ) : saving ? (
                <span className="flex items-center justify-center gap-2">
                  <Loader2 size={16} className="animate-spin" />
                  Saving
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
  label,
  value,
  onChange,
  maxLength,
  placeholder,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  maxLength?: number
  placeholder?: string
}) {
  return (
    <div>
      <label className="block mb-2 text-sm font-medium">
        {label}
      </label>

      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        placeholder={placeholder}
        className="w-full px-3 py-2 border border-border rounded-lg bg-background"
      />
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
