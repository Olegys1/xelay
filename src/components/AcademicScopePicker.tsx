import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { supabase } from '../lib/supabase'

type UniversityOption = { id: string; name: string; slug: string }
type AcademicUnitOption = { id: string; university_id: string; name: string; unit_type: string }

export function AcademicScopePicker({
  initialUniversityId,
  initialAcademicUnitId,
  onSave,
}: {
  initialUniversityId?: string | null
  initialAcademicUnitId?: string | null
  onSave: (universityId: string, academicUnitId: string, academicUnitName: string) => Promise<void>
}) {
  const [universities, setUniversities] = useState<UniversityOption[]>([])
  const [units, setUnits] = useState<AcademicUnitOption[]>([])
  const [universityId, setUniversityId] = useState(initialUniversityId || '')
  const [unitId, setUnitId] = useState(initialAcademicUnitId || '')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const load = async () => {
      const [universityResult, unitResult] = await Promise.all([
        supabase.from('universities').select('id, name, slug').eq('is_active', true).order('name'),
        supabase.from('academic_units').select('id, university_id, name, unit_type').eq('is_active', true).order('name'),
      ])
      if (universityResult.error || unitResult.error) {
        setError('Не вдалося завантажити список університетів. Перевірте, чи застосована міграція Xelay.')
      } else {
        const nextUniversities = (universityResult.data || []) as UniversityOption[]
        setUniversities(nextUniversities)
        setUnits((unitResult.data || []) as AcademicUnitOption[])
        if (!initialUniversityId) {
          setUniversityId(nextUniversities.find((university) => university.slug === 'knu')?.id || nextUniversities[0]?.id || '')
        }
      }
      setLoading(false)
    }
    void load()
  }, [initialUniversityId])

  const availableUnits = units.filter((unit) => unit.university_id === universityId)

  const save = async () => {
    const selectedUnit = availableUnits.find((unit) => unit.id === unitId)
    if (!universityId || !selectedUnit) {
      setError('Оберіть університет і факультет або інститут.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await onSave(universityId, selectedUnit.id, selectedUnit.name)
    } catch (saveError) {
      console.error('Could not save academic profile:', saveError)
      setError('Не вдалося зберегти ваш університет і факультет. Спробуйте ще раз.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="xelay-card mx-auto max-w-2xl p-5 sm:p-7">
      <div className="mb-5">
        <h2 className="text-lg font-semibold">Оберіть свій університет</h2>
        <p className="mt-1 text-sm text-muted-foreground">Новини у стрічці підбиратимуться за вашим факультетом або інститутом.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block text-sm font-medium">
          Університет
          <select
            value={universityId}
            onChange={(event) => { setUniversityId(event.target.value); setUnitId('') }}
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
            onChange={(event) => setUnitId(event.target.value)}
            disabled={loading || saving || !universityId}
            className="mt-1.5 w-full rounded-xl border border-border bg-background px-3 py-2.5 font-normal"
          >
            <option value="">Оберіть підрозділ</option>
            {availableUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
          </select>
        </label>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <button
        type="button"
        onClick={() => void save()}
        disabled={loading || saving || !universityId || !unitId}
        className="mt-5 inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-foreground px-5 py-2.5 text-sm font-semibold text-background transition-opacity hover:opacity-85 disabled:opacity-50"
      >
        {loading || saving ? <Loader2 size={16} className="animate-spin" /> : null}
        Зберегти
      </button>
    </div>
  )
}
