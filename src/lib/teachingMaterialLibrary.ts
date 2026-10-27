import type { TeachingCourse, TeachingGroup, TeachingOwnedMaterial, TeachingTeacher } from './teaching'

export const TEACHING_MATERIAL_TITLE_LIMIT = 240
export const TEACHING_MATERIAL_BODY_LIMIT = 50_000

/** Per-material delegation never replaces a colleague's current course/group scope. */
export type TeachingMaterialGrant = {
  user_id: string
  full_name?: string
  can_edit: boolean
  can_delete: boolean
  can_manage_groups: boolean
}

export type TeachingLibraryMaterial = TeachingOwnedMaterial & {
  is_owner: boolean
  can_edit: boolean
  can_delete: boolean
  can_manage_groups: boolean
  can_manage_collaborators: boolean
  access_until?: string | null
  updated_at?: string
  collaborators: TeachingMaterialGrant[]
  target_group_names: { group_id: string; group_name: string }[]
  /** No names or identifiers for groups outside the viewer's teaching scope. */
  hidden_target_count: number
}

export type TeachingMaterialLibraryCourse = {
  course: TeachingCourse
  groups: TeachingGroup[]
  colleagues: TeachingTeacher[]
}

export type TeachingMaterialLibraryData = {
  materials: TeachingLibraryMaterial[]
  courses: TeachingMaterialLibraryCourse[]
}

export function teachingMaterialExpired(material: { access_until?: string | null }, timestamp = Date.now()): boolean {
  return Boolean(material.access_until && Date.parse(material.access_until) <= timestamp)
}

export function teachingMaterialLibraryStatus(material: Pick<TeachingLibraryMaterial, 'withdrawn_at' | 'status' | 'access_until'>): 'withdrawn' | 'expired' | 'draft' | 'scheduled' | 'published' {
  if (material.withdrawn_at) return 'withdrawn'
  if (teachingMaterialExpired(material)) return 'expired'
  return material.status
}
