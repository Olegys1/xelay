import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from './supabase'

export type AcademicSpecialty = {
  id: string
  university_id: string
  academic_unit_id: string
  code: string
  specialty_name: string
  name: string
  source_url: string | null
  is_active: boolean
}

export type AcademicSpecialtySelection = {
  options: AcademicSpecialty[]
  selected: AcademicSpecialty | null
  value: string
  hasScope: boolean
  loading: boolean
  error: string
  choose: (id: string) => void
  clear: () => void
  retry: () => void
}

const normalizeProgramName = (name: string) => name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('uk-UA')

export async function loadAcademicSpecialties(universityId: string, academicUnitId: string, signal?: AbortSignal): Promise<AcademicSpecialty[]> {
  let query = supabase.from('academic_specialties')
    .select('id,university_id,academic_unit_id,code,specialty_name,name,source_url,is_active')
    .eq('university_id', universityId).eq('academic_unit_id', academicUnitId).eq('is_active', true)
    .order('name').order('code')
  if (signal) query = query.abortSignal(signal)
  const { data, error } = await query
  if (error) throw error
  return ((data || []) as AcademicSpecialty[]).filter((row) => row.university_id === universityId
    && row.academic_unit_id === academicUnitId && row.is_active === true)
}

export function useAcademicSpecialties(
  universityId: string,
  academicUnitId: string,
  initial: { id?: string | null; name?: string | null } = {},
): AcademicSpecialtySelection {
  const scope = `${universityId}:${academicUnitId}`
  const hasScope = Boolean(universityId && academicUnitId)
  const initialScope = useRef(scope)
  const initialSelection = useRef(initial)
  const mayResolveInitial = useRef(true)
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const [refresh, setRefresh] = useState(0)
  const [state, setState] = useState<{ scope: string; options: AcademicSpecialty[]; value: string; loading: boolean; error: string }>({
    scope, options: [], value: '', loading: hasScope, error: '',
  })

  useEffect(() => {
    let active = true
    const controller = new AbortController()
    if (scope !== initialScope.current) mayResolveInitial.current = false
    setState((previous) => ({ scope, options: [], value: previous.scope === scope ? previous.value : '', loading: hasScope, error: '' }))
    if (!hasScope) return () => { active = false }
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    const load = async () => {
      try {
        const options = await loadAcademicSpecialties(universityId, academicUnitId, controller.signal)
        if (!active || scopeRef.current !== scope) return
        setState((previous) => {
          let value = previous.scope === scope && options.some((row) => row.id === previous.value) ? previous.value : ''
          if (!value && mayResolveInitial.current && scope === initialScope.current) {
            const initialId = initialSelection.current.id
            if (initialId && options.some((row) => row.id === initialId)) value = initialId
            else if (!initialId && initialSelection.current.name?.trim()) {
              const name = normalizeProgramName(initialSelection.current.name)
              const matches = options.filter((row) => normalizeProgramName(row.name) === name)
              if (matches.length === 1) value = matches[0].id
            }
          }
          return { scope, options, value, loading: false, error: '' }
        })
      } catch (failure) {
        if (!active || scopeRef.current !== scope) return
        const code = failure && typeof failure === 'object' && 'code' in failure ? String(failure.code) : ''
        setState({ scope, options: [], value: '', loading: false, error: ['42P01', '42703', 'PGRST204', 'PGRST205'].includes(code)
          ? 'Список освітніх програм поки недоступний. Спробуйте пізніше або зверніться до підтримки.'
          : 'Не вдалося завантажити освітні програми. Перевірте з’єднання та спробуйте ще раз.' })
      } finally {
        window.clearTimeout(timeout)
      }
    }
    void load()
    return () => { active = false; window.clearTimeout(timeout); controller.abort() }
  }, [universityId, academicUnitId, scope, hasScope, refresh])

  const choose = useCallback((id: string) => {
    mayResolveInitial.current = false
    setState((previous) => previous.scope === scope && !previous.loading
      ? { ...previous, value: previous.options.some((row) => row.id === id) ? id : '' } : previous)
  }, [scope])
  const clear = useCallback(() => {
    mayResolveInitial.current = false
    setState((previous) => ({ ...previous, value: '' }))
  }, [])
  const options = hasScope && state.scope === scope && !state.loading ? state.options : []
  const selected = options.find((row) => row.id === state.value) || null
  return {
    options, selected, value: selected?.id || '', hasScope,
    loading: hasScope && (state.scope !== scope || state.loading),
    error: state.scope === scope ? state.error : '',
    choose, clear, retry: () => {
      setState((previous) => ({ ...previous, scope, options: [], loading: hasScope, error: '' }))
      setRefresh((previous) => previous + 1)
    },
  }
}

export function academicSpecialtyMatches(selection: AcademicSpecialtySelection, universityId: string, academicUnitId: string): boolean {
  return Boolean(!selection.loading && !selection.error && selection.selected?.is_active
    && selection.selected.university_id === universityId && selection.selected.academic_unit_id === academicUnitId)
}
