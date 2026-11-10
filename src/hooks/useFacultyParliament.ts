import { useEffect, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { facultyParliament, type FacultyParliament } from '../lib/facultyParliament'
import { supabase } from '../lib/supabase'

export function useFacultyParliament(enabled = true): FacultyParliament | null {
  const { authUser, xelayUser, isAuthenticated, isLoading } = useAuth()
  const userId = authUser?.id
  const profile = !isLoading && isAuthenticated && userId && xelayUser?.userId === userId ? xelayUser : null
  const universityId = profile?.universityId
  const unitId = profile?.academicUnitId
  const scope = enabled && universityId && unitId ? `${userId}:${universityId}:${unitId}` : ''
  const [resolved, setResolved] = useState<{ scope: string; entry: FacultyParliament } | null>(null)

  useEffect(() => {
    if (!scope || !universityId || !unitId) return
    const controller = new AbortController()
    async function load() {
      try {
        const { data, error } = await supabase.from('academic_units')
          .select('name, slug, universities!inner(slug)')
          .eq('id', unitId!).eq('university_id', universityId!)
          .eq('is_active', true).eq('universities.is_active', true)
          .abortSignal(controller.signal).maybeSingle()
        if (controller.signal.aborted) return
        const unit = data as { name: string; slug: string; universities: { slug: string } } | null
        setResolved(!error && unit?.universities?.slug
          ? { scope, entry: facultyParliament(unit.universities.slug, unit) } : null)
      } catch {
        if (!controller.signal.aborted) setResolved(null)
      }
    }
    void load()
    return () => controller.abort()
  }, [scope, universityId, unitId])

  return resolved?.scope === scope ? resolved.entry : null
}
