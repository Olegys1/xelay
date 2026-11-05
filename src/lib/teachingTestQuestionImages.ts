import { supabase } from './supabase'
import type { TeachingTestQuestionImage } from './teachingTests'

export const MAX_TEST_QUESTION_IMAGES = 3
export const MAX_TEST_QUESTION_IMAGE_ALT = 160

const MAX_SOURCE_BYTES = 12 * 1024 * 1024
const MAX_JPEG_BYTES = 256 * 1024
const MAX_BASE64_LENGTH = Math.ceil(MAX_JPEG_BYTES / 3) * 4
const MIME = 'image/jpeg'
const IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function readableTeachingTestQuestionImages(images: TeachingTestQuestionImage[] | undefined) {
  if (!Array.isArray(images)) return []
  return images.filter(image => image?.mime_type === MIME && typeof image.alt === 'string' && IMAGE_ID.test(image.id))
    .slice(0, MAX_TEST_QUESTION_IMAGES)
}

function recognizedRaster(header: Uint8Array) {
  const begins = (bytes: number[], at = 0) => bytes.every((value, index) => header[at + index] === value)
  return begins([255, 216, 255]) || begins([137, 80, 78, 71, 13, 10, 26, 10])
    || (begins([82, 73, 70, 70]) && begins([87, 69, 66, 80], 8))
}

async function prepareImage(file: File): Promise<string> {
  if (!file.size || file.size > MAX_SOURCE_BYTES) throw new Error('Оберіть фото розміром до 12 МБ.')
  if (!recognizedRaster(new Uint8Array(await file.slice(0, 12).arrayBuffer()))) {
    throw new Error('Оберіть зображення у форматі JPG, PNG або WebP.')
  }
  const image = await createImageBitmap(file).catch(() => {
    throw new Error('Це фото пошкоджене або його не вдалося відкрити.')
  })
  try {
    if (!image.width || !image.height || image.width * image.height > 40_000_000) {
      throw new Error('Фото має завелику роздільну здатність.')
    }
    const canvas = document.createElement('canvas')
    const context = canvas.getContext('2d')
    if (!context) throw new Error('У цьому браузері не вдалося підготувати фото.')
    // Re-encode pixels to a fresh JPEG and discard source metadata and animation.
    for (const maximum of [1600, 1280, 960, 720]) {
      const scale = Math.min(1, maximum / Math.max(image.width, image.height))
      canvas.width = Math.max(1, Math.round(image.width * scale))
      canvas.height = Math.max(1, Math.round(image.height * scale))
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      const dataUrl = canvas.toDataURL(MIME, 0.88)
      const encoded = dataUrl.slice(`data:${MIME};base64,`.length)
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
      if (dataUrl.startsWith(`data:${MIME};base64,`) && encoded.length * 0.75 - padding <= MAX_JPEG_BYTES) return encoded
    }
    throw new Error('Фото завелике після підготовки. Обріжте його до потрібної області.')
  } finally {
    image.close()
  }
}

export async function uploadTeachingTestQuestionImage(courseId: string, userId: string, file: File, signal: AbortSignal): Promise<TeachingTestQuestionImage> {
  signal.throwIfAborted()
  const encoded = await prepareImage(file)
  signal.throwIfAborted()
  const { data, error } = await supabase.rpc('xelay_teaching_test_question_image_upload', {
    p_course_id: courseId,
    p_expected_user_id: userId,
    p_data: encoded,
  }).abortSignal(signal)
  if (error?.message.includes('TEST_IMAGE_LIMIT')) throw new Error('Для цього предмета вичерпано обсяг зображень.')
  if (error || typeof data?.id !== 'string' || !IMAGE_ID.test(data.id)) {
    throw new Error('Не вдалося додати зображення. Перевірте доступ до предмета та з’єднання.')
  }
  return { id: data.id, mime_type: MIME, alt: '' }
}

export async function loadTeachingTestQuestionImage(imageId: string, signal: AbortSignal): Promise<string> {
  const { data, error } = await supabase.rpc('xelay_teaching_test_question_image', { p_image_id: imageId }).abortSignal(signal)
  if (error || typeof data !== 'string' || data.length > MAX_BASE64_LENGTH
      || data.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new Error('Не вдалося завантажити зображення.')
  }
  return `data:${MIME};base64,${data}`
}
