import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { AcademicSpecialtySelect } from './AcademicSpecialtySelect'
import { academicSpecialtyMatches, useAcademicSpecialties } from '../lib/academicSpecialties'

type UniversityOption = { id: string; name: string; slug: string }
type AcademicUnitOption = { id: string; university_id: string; name: string; unit_type: string }

export function AcademicScopePicker({
  initialUniversityId,
  initialAcademicUnitId,
  initialSpecialtyId,
  initialSpecialtyName,
  onSave,
}: {
  initialUniversityId?: string | null
  initialAcademicUnitId?: string | null
  initialSpecialtyId?: string | null
  initialSpecialtyName?: string | null
  onSave: (universityId: string, academicUnitId: string, academicUnitName: string, specialtyId: string, specialtyName: string) => Promise<void>
}) {
  const [universities, setUniversities] = useState<UniversityOption[]>([])
  const [units, setUnits] = useState<AcademicUnitOption[]>([])
  const [universityId, setUniversityId] = useState(initialUniversityId || '')
  const [unitId, setUnitId] = useState(initialAcademicUnitId || '')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [optionsError, setOptionsError] = useState('')
  const [optionsRefresh, setOptionsRefresh] = useState(0)
  const savingLock = useRef(false)
  const specialtySelection = useAcademicSpecialties(universityId, unitId, { id: initialSpecialtyId, name: initialSpecialtyName })

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    setLoading(true)
    setOptionsError('')
    const load = async () => {
      try {
        const [universityResult, unitResult] = await Promise.all([
          supabase.from('universities').select('id, name, slug').eq('is_active', true).order('name').abortSignal(controller.signal),
          supabase.from('academic_units').select('id, university_id, name, unit_type').eq('is_active', true).order('name').abortSignal(controller.signal),
        ])
        if (!active) return
        if (universityResult.error || unitResult.error) throw new Error('Academic options unavailable')
        const nextUniversities = (universityResult.data || []) as UniversityOption[]
        setUniversities(nextUniversities)
        setUnits((unitResult.data || []) as AcademicUnitOption[])
        if (!initialUniversityId) {
          setUniversityId((previous) => previous || nextUniversities.find((university) => university.slug === 'knu')?.id || nextUniversities[0]?.id || '')
        }
      } catch {
        if (active) {
          setUniversities([])
          setUnits([])
          setOptionsError('Не вдалося завантажити університети та факультети. Перевірте з’єднання та спробуйте ще раз.')
        }
      } finally {
        window.clearTimeout(timeout)
        if (active) setLoading(false)
      }
    }
    void load()
    return () => { active = false; window.clearTimeout(timeout); controller.abort() }
  }, [initialUniversityId, optionsRefresh])

  const availableUnits = units.filter((unit) => unit.university_id === universityId)

  const save = async () => {
    if (savingLock.current) return
    const selectedUnit = availableUnits.find((unit) => unit.id === unitId)
    if (loading || optionsError || !universities.some((university) => university.id === universityId) || !selectedUnit) {
      setError('Оберіть університет і факультет або інститут.')
      return
    }
    if (!academicSpecialtyMatches(specialtySelection, universityId, unitId)) {
      setError('Оберіть освітню програму зі списку свого факультету або інституту.')
      return
    }
    const selectedSpecialty = specialtySelection.selected!
    savingLock.current = true
    setSaving(true)
    setError('')
    try {
      await onSave(universityId, selectedUnit.id, selectedUnit.name, selectedSpecialty.id, selectedSpecialty.name)
    } catch (saveError) {
      console.error('Could not save academic profile:', saveError)
      setError('Не вдалося зберегти університет, факультет і освітню програму. Спробуйте ще раз.')
    } finally {
      savingLock.current = false
      setSaving(false)
    }
  }

  return (
    <div className="xelay-card mx-auto max-w-2xl p-5 sm:p-7">
      <div className="mb-5">
        <h2 className="text-lg font-semibold">Де ви навчаєтеся?</h2>
        <p className="mt-1 text-sm text-muted-foreground">Оберіть університет, факультет та освітню програму. Новини у стрічці підбиратимуться за вашим факультетом або інститутом.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Університет
          <select
            value={universityId}
            onChange={(event) => { specialtySelection.clear(); setUniversityId(event.target.value); setUnitId('') }}
            required
            disabled={loading || saving}
            className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal"
          >
            <option value="">Оберіть університет</option>
            {universities.map((university) => <option key={university.id} value={university.id}>{university.name}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">
          Факультет або інститут
          <select
            value={unitId}
            onChange={(event) => { specialtySelection.clear(); setUnitId(event.target.value) }}
            required
            disabled={loading || saving || !universityId}
            className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal"
          >
            <option value="">Оберіть підрозділ</option>
            {availableUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
          </select>
        </label>
        <AcademicSpecialtySelect selection={specialtySelection} disabled={loading || saving} legacyName={initialSpecialtyName} className="sm:col-span-2" />
      </div>
      {optionsError && <div role="alert" className="mt-3 space-y-2 text-sm text-destructive"><p>{optionsError}</p><button type="button" onClick={() => setOptionsRefresh((previous) => previous + 1)} disabled={saving || loading} className="min-h-9 rounded-full border border-border px-3 py-1.5 text-xs font-medium text-primary disabled:opacity-50">Оновити список університетів</button></div>}
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <button
        type="button"
        onClick={() => void save()}
        disabled={loading || saving || Boolean(optionsError) || !universityId || !availableUnits.some((unit) => unit.id === unitId) || !academicSpecialtyMatches(specialtySelection, universityId, unitId)}
        className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition-opacity hover:opacity-85 disabled:opacity-50"
      >
        {loading || saving ? <Loader2 size={16} className="animate-spin" /> : null}
        Зберегти
      </button>
    </div>
  )
}
