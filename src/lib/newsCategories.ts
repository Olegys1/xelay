import type { PostgrestError } from '@supabase/supabase-js'
import { supabase } from './supabase'
import { NEWS_TYPE_LABELS, type NewsPostType } from './news'

export interface NewsCategory {
  id: string
  name: string
  university_id: string | null
  academic_unit_id: string | null
  archived_at?: string | null
  version?: number
}

export type NewsCategorySettings = { categories: NewsCategory[]; hidden_types: NewsPostType[]; version: number }
export type NewsCategoryTarget = { categoryId: string; postType?: never } | { categoryId?: never; postType: NewsPostType }

const CATEGORY_FIELDS = 'id,name,university_id,academic_unit_id,archived_at,version'
const CATEGORY_NAME_INVALID = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i

export class NewsCategoryMutationError extends Error {
  constructor(message: string, public readonly code: string) { super(message); this.name = 'NewsCategoryMutationError' }
}

function categoryError(error: { message?: string }): NewsCategoryMutationError {
  const message = String(error.message || '')
  if (message.includes('NEWS_CATEGORY_CONFLICT')) return new NewsCategoryMutationError('Список категорій уже змінив інший редактор. Оновіть його й повторіть дію.', 'NEWS_CATEGORY_CONFLICT')
  if (message.includes('NEWS_CATEGORY_EDITOR_REQUIRED')) return new NewsCategoryMutationError('Потрібен редакторський доступ саме до цього розділу новин.', 'NEWS_CATEGORY_EDITOR_REQUIRED')
  if (message.includes('NEWS_CATEGORY_ARCHIVED')) return new NewsCategoryMutationError('Категорію з такою назвою вже прибрано. Відновіть її в керуванні категоріями.', 'NEWS_CATEGORY_ARCHIVED')
  return new NewsCategoryMutationError('Не вдалося змінити категорії. Оновіть список і спробуйте ще раз.', 'NEWS_CATEGORY_UNAVAILABLE')
}

function parseSettings(value: unknown, universityId: string | null, academicUnitId: string | null): NewsCategorySettings {
  const settings = value as Partial<NewsCategorySettings> | null
  if (!settings || !Number.isSafeInteger(settings.version) || Number(settings.version) < 0
    || !Array.isArray(settings.hidden_types) || settings.hidden_types.some(type => !Object.prototype.hasOwnProperty.call(NEWS_TYPE_LABELS, type))
    || !Array.isArray(settings.categories) || settings.categories.some(category => !category || !UUID.test(category.id)
      || typeof category.name !== 'string' || category.name.length < 2 || category.name.length > 50
      || category.university_id !== universityId || category.academic_unit_id !== academicUnitId
      || category.archived_at !== null && (typeof category.archived_at !== 'string' || !Number.isFinite(Date.parse(category.archived_at)))
      || !Number.isSafeInteger(category.version) || Number(category.version) < 1)) {
    throw new Error('Не вдалося підтвердити список категорій. Оновіть сторінку.')
  }
  return settings as NewsCategorySettings
}

export async function listNewsCategorySettings(universityId: string | null, academicUnitId: string | null): Promise<NewsCategorySettings> {
  const { data, error } = await supabase.rpc('xelay_news_category_settings', {
    p_university_id: universityId, p_academic_unit_id: academicUnitId,
  })
  if (error) throw categoryError(error)
  return parseSettings(data, universityId, academicUnitId)
}

export async function setNewsCategoryVisibility(
  target: NewsCategoryTarget, hidden: boolean, expectedVersion: number,
  universityId: string | null, academicUnitId: string | null,
): Promise<NewsCategorySettings> {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0
    || ('categoryId' in target ? !target.categoryId || !UUID.test(target.categoryId) : !Object.prototype.hasOwnProperty.call(NEWS_TYPE_LABELS, target.postType))) throw new Error('Оновіть список категорій перед зміною.')
  const { data, error } = await supabase.rpc('xelay_set_news_category_visibility', {
    p_university_id: universityId, p_academic_unit_id: academicUnitId,
    p_category_id: target.categoryId || null, p_post_type: target.postType || null,
    p_hidden: hidden, p_expected_version: expectedVersion,
  })
  if (error) throw categoryError(error)
  return parseSettings(data, universityId, academicUnitId)
}

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
    if (code.includes('NEWS_CATEGORY_ARCHIVED')) throw categoryError(error)
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
