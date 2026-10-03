import { supabase } from './supabase'

export const PUBLIC_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'] as const
const VIDEO_TYPES = ['video/mp4', 'video/webm', 'video/quicktime'] as const
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
}
export type PublicMediaBucket = 'avatars' | 'answer-media' | 'question-images'
export type PublicMediaUpload = { url: string; path: string; type: 'image' | 'video' }

export function publicMediaValidationError(files: readonly File[], bucket: PublicMediaBucket): string | undefined {
  if (files.length > (bucket === 'avatars' ? 1 : 5)) return 'Можна додати не більше ніж 5 файлів до публікації.'
  const allowed: readonly string[] = bucket === 'answer-media' ? [...PUBLIC_IMAGE_TYPES, ...VIDEO_TYPES] : PUBLIC_IMAGE_TYPES
  if (files.some((file) => !allowed.includes(file.type.toLowerCase()))) {
    return bucket === 'answer-media'
      ? 'Оберіть фото JPG, PNG, WebP, GIF, AVIF або відео MP4, WebM, MOV.'
      : 'Оберіть зображення JPG, PNG, WebP, GIF або AVIF.'
  }
  const limit = (bucket === 'avatars' ? 5 : 25) * 1024 * 1024
  if (files.some((file) => file.size <= 0 || file.size > limit)) {
    return `Розмір кожного файлу має бути від 1 байта до ${bucket === 'avatars' ? 5 : 25} МБ.`
  }
  if (files.reduce((total, file) => total + file.size, 0) > 50 * 1024 * 1024) {
    return 'Загальний розмір файлів публікації має бути не більше 50 МБ.'
  }
}

export function publicMediaPath(userId: string, kind: 'avatars' | 'questions' | 'answers', file: Pick<File, 'type'>): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error('Invalid upload owner')
  }
  const extension = EXTENSIONS[file.type.toLowerCase()]
  if (!extension) throw new Error('Unsupported media type')
  return `${userId}/${kind}/${crypto.randomUUID()}.${extension}`
}

export async function removePublicMedia(bucket: PublicMediaBucket, uploads: readonly PublicMediaUpload[]): Promise<void> {
  if (!uploads.length) return
  const { data, error } = await supabase.storage.from(bucket).remove(uploads.map((upload) => upload.path))
  if (error || (data?.length ?? 0) !== uploads.length) {
    // A failed cleanup must not erase the primary error or make a successfully
    // published question appear unsuccessful. Server cleanup can retry it.
    console.warn('[Xelay] Public media cleanup requires retry.')
  }
}

export async function uploadPublicMediaFiles(
  userId: string, kind: 'avatars' | 'questions' | 'answers', files: readonly File[], bucket: PublicMediaBucket = 'answer-media',
): Promise<PublicMediaUpload[]> {
  const validation = publicMediaValidationError(files, bucket)
  if (validation) throw new Error(validation)
  const uploaded: PublicMediaUpload[] = []
  try {
    for (const file of files) {
      const path = publicMediaPath(userId, kind, file)
      const { error: reservationError } = await supabase.rpc('xelay_reserve_public_media_upload', {
        p_bucket_id: bucket, p_storage_path: path, p_byte_size: file.size, p_mimetype: file.type.toLowerCase(),
      })
      if (reservationError) throw reservationError
      const { error } = await supabase.storage.from(bucket).upload(path, file, {
        contentType: file.type.toLowerCase(), upsert: false,
      })
      if (error) {
        await supabase.rpc('xelay_cancel_public_media_upload', { p_bucket_id: bucket, p_storage_path: path })
        throw error
      }
      uploaded.push({ path, url: supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl,
        type: file.type.startsWith('video/') ? 'video' : 'image' })
    }
    return uploaded
  } catch (error) {
    await removePublicMedia(bucket, uploaded)
    throw error
  }
}

export function publicMediaUploadError(error: unknown, fallback: string): string {
  const record = error && typeof error === 'object' ? error as { message?: unknown; code?: unknown } : null
  const message = typeof record?.message === 'string' ? record.message : ''
  if (record?.code === '54000' || /quota reached|upload rate exceeded/i.test(message)) {
    return 'Досягнуто ліміт завантажень. Спробуйте пізніше або зверніться до підтримки.'
  }
  return fallback
}

export function publicContentError(error: unknown, fallback: string): string {
  const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : ''
  if (message.includes('CONTENT_RATE_LIMIT')) return 'Забагато публікацій за короткий час. Спробуйте пізніше.'
  if (/CONTENT_(?:TITLE_|CATEGORY_)?TOO_LONG/.test(message)) return 'Текст публікації може містити до 50 000 символів.'
  if (message.includes('CONTENT_MEDIA_LINK_LIMIT')) return 'У публікації може бути не більше ніж 100 посилань на файли платформи.'
  return publicMediaUploadError(error, fallback)
}
