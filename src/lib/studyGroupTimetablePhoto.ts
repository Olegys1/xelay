import { supabase } from './supabase'
import { isMissingDatabaseFunction, isMissingDatabaseTable } from './databaseCompatibility'

export const TIMETABLE_PHOTO_BUCKET = 'xelay-timetable-images'
export const MAX_TIMETABLE_PHOTO_BYTES = 8 * 1024 * 1024
export type TimetablePhoto = {
  group_id: string; storage_path: string; file_name: string; mime_type: string
  file_size: number; updated_at: string; updated_by: string
}
type PhotoUpload = Pick<TimetablePhoto, 'storage_path' | 'file_name' | 'mime_type' | 'file_size'>
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PATH = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(?:jpg|jpeg|png|webp)$/i
const MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export function timetablePhotoError(error: unknown): string {
  const value = error as { code?: string; message?: string } | null
  if (isMissingDatabaseFunction(value) || isMissingDatabaseTable(value)) return 'Фото розкладу поки недоступне. Попросіть адміністратора оновити платформу.'
  const message = error instanceof Error ? error.message : value?.message || ''
  if (/GROUP_LICENSE_REQUIRED/.test(message)) return 'Для оновлення фото потрібен активний доступ групи.'
  if (/STUDY_GROUP_PERMISSION_REQUIRED|TIMETABLE_PHOTO_(?:PERMISSION|FORBIDDEN)|42501/.test(message) || value?.code === '42501') return 'Оновлювати фото може староста або заступник із правом редагувати розклад.'
  if (/TIMETABLE_PHOTO_(?:INVALID|NOT_FOUND)/.test(message)) return 'Не вдалося зберегти це зображення. Оберіть файл JPG, PNG або WebP до 8 МБ.'
  if (message.startsWith('Оберіть ') || message.startsWith('Зображення ') || message.startsWith('Доступ ')) return message
  return 'Не вдалося оновити фото розкладу. Перевірте з’єднання та спробуйте ще раз.'
}

function photoFromRow(value: unknown, groupId: string): TimetablePhoto | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('TIMETABLE_PHOTO_INVALID')
  const row = value as TimetablePhoto
  if (row.group_id !== groupId || !PATH.test(row.storage_path || '') || row.storage_path.split('/')[0] !== groupId
    || typeof row.file_name !== 'string' || !MIME_TYPES.includes(row.mime_type)
    || !Number.isSafeInteger(row.file_size) || row.file_size <= 0 || row.file_size > MAX_TIMETABLE_PHOTO_BYTES
    || typeof row.updated_at !== 'string' || !UUID.test(row.updated_by || '')) throw new Error('TIMETABLE_PHOTO_INVALID')
  return row
}

export async function loadTimetablePhoto(groupId: string): Promise<TimetablePhoto | null> {
  const { data, error } = await supabase.from('study_group_timetable_photos')
    .select('group_id,storage_path,file_name,mime_type,file_size,updated_at,updated_by').eq('group_id', groupId).maybeSingle()
  if (error) throw error
  return photoFromRow(data, groupId)
}

export async function timetablePhotoUrl(path: string): Promise<string> {
  if (!PATH.test(path)) throw new Error('TIMETABLE_PHOTO_INVALID')
  const { data, error } = await supabase.storage.from(TIMETABLE_PHOTO_BUCKET).createSignedUrl(path, 60)
  if (error || !data?.signedUrl) throw error || new Error('TIMETABLE_PHOTO_NOT_FOUND')
  return data.signedUrl
}

export async function uploadTimetablePhoto(groupId: string, userId: string, file: File): Promise<PhotoUpload> {
  if (!UUID.test(groupId) || !UUID.test(userId)) throw new Error('TIMETABLE_PHOTO_INVALID')
  if (!file.size || file.size > MAX_TIMETABLE_PHOTO_BYTES) throw new Error('Оберіть фото розкладу до 8 МБ.')
  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const mime = header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff ? 'image/jpeg'
    : [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => header[index] === byte) ? 'image/png'
      : String.fromCharCode(...header.slice(0, 4)) === 'RIFF' && String.fromCharCode(...header.slice(8, 12)) === 'WEBP' ? 'image/webp' : null
  if (!mime) throw new Error('Оберіть зображення у форматі JPG, PNG або WebP.')
  const extension = mime === 'image/jpeg' ? 'jpg' : mime === 'image/png' ? 'png' : 'webp'
  const stem = file.name.replace(/\.[^.]*$/, '').replace(/[\x00-\x1f\x7f/\\]/g, '').trim().slice(0, 150) || 'rozklad'
  const upload: PhotoUpload = { storage_path: `${groupId}/${userId}/${crypto.randomUUID()}.${extension}`, file_name: `${stem}.${extension}`, mime_type: mime, file_size: file.size }
  const { error } = await supabase.storage.from(TIMETABLE_PHOTO_BUCKET).upload(upload.storage_path, file, { contentType: mime, upsert: false })
  if (error) { await removeDetachedTimetablePhoto(upload.storage_path); throw error }
  return upload
}

export async function setTimetablePhoto(groupId: string, upload: PhotoUpload | null): Promise<{ photo: TimetablePhoto | null; previousPath: string | null }> {
  const { data, error } = await supabase.rpc('xelay_set_study_group_timetable_photo', {
    p_group_id: groupId, p_storage_path: upload?.storage_path || null, p_file_name: upload?.file_name || null,
    p_mime_type: upload?.mime_type || null, p_file_size: upload?.file_size ?? null,
  })
  if (error) throw error
  if (!data || typeof data !== 'object' || !('photo' in data)) throw new Error('TIMETABLE_PHOTO_INVALID')
  return { photo: photoFromRow(data.photo, groupId), previousPath: typeof data.previous_storage_path === 'string' && PATH.test(data.previous_storage_path) ? data.previous_storage_path : null }
}

export async function removeDetachedTimetablePhoto(path: string): Promise<boolean> {
  if (!PATH.test(path)) return false
  try {
    const { data, error } = await supabase.storage.from(TIMETABLE_PHOTO_BUCKET).remove([path])
    return !error && (data || []).some((row) => row.name === path)
  } catch { return false }
}
