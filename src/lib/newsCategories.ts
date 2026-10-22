import type { PostgrestError } from '@supabase/supabase-js'
import { supabase } from './supabase'

export interface NewsCategory {
  id: string
  name: string
  university_id: string | null
  academic_unit_id: string | null
}

const CATEGORY_FIELDS = 'id,name,university_id,academic_unit_id'
const CATEGORY_NAME_INVALID = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/

export async function listNewsCategories(
  universityId: string | null,
  academicUnitId: string | null,
): Promise<{ data: NewsCategory[]; error: PostgrestError | null }> {
  let query = supabase.from('news_categories').select(CATEGORY_FIELDS).order('name')
  query = universityId === null ? query.is('university_id', null) : query.eq('university_id', universityId)
  query = academicUnitId === null ? query.is('academic_unit_id', null) : query.eq('academic_unit_id', academicUnitId)
  const { data, error } = await query
  return { data: (data || []) as NewsCategory[], error }
}

export async function createNewsCategory(
  name: string,
  universityId: string | null,
  academicUnitId: string | null,
): Promise<NewsCategory> {
  const normalizedName = name.trim()
  if (normalizedName.length < 2 || normalizedName.length > 50 || CATEGORY_NAME_INVALID.test(normalizedName)) {
    throw new Error('Назва категорії має містити від 2 до 50 символів без службових знаків.')
  }
  if (universityId === null && academicUnitId !== null) throw new Error('Для категорії факультету спочатку оберіть університет.')
  const { data, error } = await supabase.rpc('xelay_create_news_category', {
    p_name: normalizedName,
    p_university_id: universityId,
    p_academic_unit_id: academicUnitId,
  })
  if (error) {
    const code = String(error.message || '')
    if (code.includes('NEWS_CATEGORY_NAME_INVALID')) throw new Error('Назва категорії має містити від 2 до 50 символів без службових знаків.')
    if (code.includes('NEWS_CATEGORY_EDITOR_REQUIRED')) throw new Error('Для створення категорії потрібен редакторський доступ саме до цього розділу новин.')
    throw new Error('Не вдалося створити категорію. Спробуйте ще раз.')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || typeof data.id !== 'string' || typeof data.name !== 'string'
    || data.university_id !== universityId || data.academic_unit_id !== academicUnitId) {
    throw new Error('Не вдалося підтвердити створення категорії. Оновіть список категорій.')
  }
  return data as NewsCategory
}
