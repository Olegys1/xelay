import { supabase } from './supabase'
import { getMaterialAttachments, getMaterialLinks, type MaterialAttachment, type MaterialLink } from './studyGroupMaterialFiles'

export type MaterialSubject = {
  id: string
  group_id: string
  name: string
  created_by: string
  created_at: string
  updated_at: string
}

export type StudyGroupMaterial = {
  id: string
  group_id: string
  subject_id: string
  title: string
  material_date: string
  body: string
  links: MaterialLink[]
  attachments: MaterialAttachment[]
  created_by: string
  created_at: string
  updated_at: string
}

export type MaterialDraft = Pick<StudyGroupMaterial, 'subject_id' | 'title' | 'material_date' | 'body' | 'links' | 'attachments'>

export function materialToday(): string {
  const date = new Date()
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function isMaterialDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2200-12-31') return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export function formatMaterialDate(value: string): string {
  return isMaterialDate(value) ? new Intl.DateTimeFormat('uk-UA', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : 'Дата не вказана'
}

export function validateMaterialDraft(draft: MaterialDraft): void {
  if (!draft.subject_id) throw new Error('Оберіть предмет для цієї теми.')
  const length = draft.title.trim().length
  if (length < 3 || length > 240) throw new Error('Назва теми має містити від 3 до 240 символів.')
  if (!isMaterialDate(draft.material_date)) throw new Error('Вкажіть правильну дату теми.')
  if (draft.body.length > 50_000) throw new Error('Текст матеріалу має містити не більше 50 000 символів.')
}

export function normalizeStudyGroupMaterial(value: unknown, groupId: string): StudyGroupMaterial | null {
  if (!value || typeof value !== 'object') return null
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || item.group_id !== groupId || typeof item.subject_id !== 'string' || typeof item.title !== 'string') return null
  return {
    id: item.id, group_id: groupId, subject_id: item.subject_id, title: item.title,
    material_date: typeof item.material_date === 'string' ? item.material_date : '',
    body: typeof item.body === 'string' ? item.body : '', links: getMaterialLinks(item.links), attachments: getMaterialAttachments(item.attachments),
    created_by: typeof item.created_by === 'string' ? item.created_by : '', created_at: typeof item.created_at === 'string' ? item.created_at : '', updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
  }
}

export async function loadStudyGroupMaterials(groupId: string, isCurrent: () => boolean = () => true): Promise<{ subjects: MaterialSubject[]; materials: StudyGroupMaterial[] }> {
  const read = async (table: 'study_group_material_subjects' | 'study_group_materials'): Promise<Record<string, unknown>[]> => {
    const rows: Record<string, unknown>[] = []
    let after: string | null = null
    // Keyset pages avoid the API's default row cap. Continue until an empty
    // page, including when this project's configured maximum is below 500.
    while (isCurrent()) {
      let request = supabase.from(table).select('*').eq('group_id', groupId).order('id', { ascending: true }).limit(500)
      if (after) request = request.gt('id', after)
      const result = await request
      if (result.error) throw result.error
      if (!result.data?.length) break
      rows.push(...result.data)
      const lastId = result.data[result.data.length - 1]?.id
      if (typeof lastId !== 'string' || lastId === after) break
      after = lastId
    }
    return rows
  }
  const [subjects, materials] = await Promise.all([read('study_group_material_subjects'), read('study_group_materials')])
  return {
    subjects: subjects.filter((item) => item.group_id === groupId && typeof item.id === 'string' && typeof item.name === 'string').map((item): MaterialSubject => ({
      id: String(item.id), group_id: groupId, name: String(item.name),
      created_by: typeof item.created_by === 'string' ? item.created_by : '',
      created_at: typeof item.created_at === 'string' ? item.created_at : '',
      updated_at: typeof item.updated_at === 'string' ? item.updated_at : '',
    })).sort((a, b) => a.name.localeCompare(b.name, 'uk-UA')),
    materials: materials.map((item) => normalizeStudyGroupMaterial(item, groupId)).filter((item): item is StudyGroupMaterial => item !== null),
  }
}

export function materialError(reason: unknown): string {
  const value = reason && typeof reason === 'object' ? reason as { message?: string; code?: string; details?: string } : {}
  const message = value.message || (typeof reason === 'string' ? reason : '')
  const combined = `${message} ${value.code || ''} ${value.details || ''}`
  const errors: [string, string][] = [
    ['GROUP_LICENSE_REQUIRED', 'Не вдалося підтвердити безкоштовний доступ групи. Дані збережено; оновіть сторінку або зверніться до підтримки.'],
    ['STUDY_GROUP_PERMISSION_REQUIRED', 'Додавати й редагувати матеріали можуть староста та заступники з відповідним дозволом.'],
    ['MATERIAL_AUTH_REQUIRED', 'Увійдіть у свій обліковий запис і повторіть спробу.'],
    ['MATERIAL_SUBJECT_NAME_EXISTS', 'Предмет із такою назвою вже є в групі.'],
    ['MATERIAL_SUBJECT_NOT_EMPTY', 'Спочатку перенесіть або видаліть усі теми цього предмета.'],
    ['MATERIAL_SUBJECT_NOT_FOUND', 'Предмет уже видалено. Оновіть список і оберіть інший.'],
    ['MATERIAL_NOT_FOUND', 'Матеріал уже видалено. Оновіть список.'],
    ['MATERIAL_SUBJECT_INVALID', 'Назва предмета має містити від 2 до 180 символів.'],
    ['MATERIAL_ENTRY_INVALID', 'Перевірте назву теми, предмет, дату й довжину тексту.'],
    ['MATERIAL_FILE_STORAGE_QUOTA', 'Досягнуто ліміту матеріалів для одного автора: 1 ГБ або 500 файлів. Приберіть непотрібні вкладення або зверніться до підтримки.'],
    ['MATERIAL_FILES_OR_LINKS_INVALID', 'Перевірте формати, розміри файлів і адреси посилань.'],
    ['MATERIAL_FILE_', 'Не вдалося підтвердити вкладення. Спробуйте додати цей файл знову.'],
  ]
  const known = errors.find(([code]) => combined.includes(code))
  if (known) return known[1]
  if (value.code === '42501' || /permission denied|row.level security/i.test(combined)) return 'У вас немає дозволу на цю дію. Оновіть сторінку або зверніться до старости.'
  if (value.code === '42P01' || value.code === 'PGRST202' || /schema cache|does not exist/i.test(combined)) return 'Матеріали ще не підключені до бази групи. Зверніться до адміністратора платформи.'
  // Local validation and file helpers already return a Ukrainian explanation.
  if (reason instanceof Error && /[А-Яа-яІіЇїЄєҐґ]/u.test(message)) return message
  return 'Не вдалося виконати дію. Перевірте з’єднання й повторіть спробу.'
}
