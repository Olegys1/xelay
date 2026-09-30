import { supabase } from './supabase'
import { isMissingDatabaseFunction } from './databaseCompatibility'

const PUBLIC_PROFILE_FIELDS = 'id, full_name, username, avatar_url, faculty, specialty, study_year, country, city, bio, skills, help_with, want_to_learn, categories, experience, created_at, university_id, academic_unit_id'

// Public profiles are resolved by known IDs. Nickname discovery goes through
// the separate, metered search RPC rather than an enumerable profiles table.
export async function getPublicProfiles(ids: string[]): Promise<{ data: any[]; error: any }> {
  const uniqueIds = [...new Set(ids.filter(Boolean))]
  const profiles: any[] = []
  for (let offset = 0; offset < uniqueIds.length; offset += 100) {
    const batch = uniqueIds.slice(offset, offset + 100)
    const { data, error } = await supabase.rpc('xelay_profiles_by_ids', {
      p_user_ids: batch,
    })
    if (isMissingDatabaseFunction(error)) {
      // The previous database still supports existing public profiles. This
      // fallback is limited to known IDs and never searches by nickname.
      const legacy = await supabase.from('profiles').select(PUBLIC_PROFILE_FIELDS).in('id', batch)
      if (legacy.error) return { data: [], error: legacy.error }
      profiles.push(...(legacy.data || []))
      continue
    }
    if (error) return { data: [], error }
    if (Array.isArray(data)) profiles.push(...data)
  }
  return { data: profiles, error: null }
}

export async function getPublicProfile(id: string) {
  const result = await getPublicProfiles([id])
  return { data: result.data[0] || null, error: result.error }
}

export async function getMemberCount(): Promise<{ data: number | null; error: any }> {
  const result = await supabase.rpc('xelay_member_count')
  if (!isMissingDatabaseFunction(result.error)) {
    return { data: result.error ? null : Number(result.data) || 0, error: result.error }
  }
  const legacy = await supabase.from('profiles').select('id', { count: 'exact', head: true })
  return { data: legacy.count, error: legacy.error }
}
