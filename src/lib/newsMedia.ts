import { supabase } from './supabase'

const NEWS_MEDIA_BUCKET = 'xelay-news-media'
const MAX_NEWS_IMAGE_SIZE = 10 * 1024 * 1024
const NEWS_IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
  ['image/avif', 'avif'],
])

export const NEWS_IMAGE_ACCEPT = [...NEWS_IMAGE_EXTENSIONS.keys()].join(',')

export function validateNewsImage(file: File): void {
  if (!NEWS_IMAGE_EXTENSIONS.has(file.type)) {
    throw new Error('Оберіть фото у форматі JPEG, PNG, WebP, GIF або AVIF.')
  }
  if (file.size === 0) {
    throw new Error('Цей файл порожній. Оберіть інше фото.')
  }
  if (file.size > MAX_NEWS_IMAGE_SIZE) {
    throw new Error('Фото завелике. Максимальний розмір — 10 МБ.')
  }
}

export async function uploadNewsImage(userId: string, file: File): Promise<{ path: string }> {
  validateNewsImage(file)
  if (!userId) {
    throw new Error('Увійдіть в обліковий запис, щоб додати фото.')
  }

  const extension = NEWS_IMAGE_EXTENSIONS.get(file.type)
  const path = `${userId}/${crypto.randomUUID()}.${extension}`
  const storage = supabase.storage.from(NEWS_MEDIA_BUCKET)

  try {
    const { error } = await storage.upload(path, file, {
      contentType: file.type,
      upsert: false,
    })
    if (error) throw error

    return { path }
  } catch (error) {
    console.error('Could not upload news image:', error)
    throw new Error('Не вдалося завантажити фото. Спробуйте ще раз.')
  }
}

export async function removeNewsImage(path: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(NEWS_MEDIA_BUCKET).remove([path])
    if (error) console.error('Could not remove unused news image:', error)
  } catch (error) {
    console.error('Could not remove unused news image:', error)
  }
}
