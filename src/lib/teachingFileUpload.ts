type TeachingStorageUpload = {
  bucket: string
  storagePath: string
  file: File
  mimeType: string
  accessToken: string
  onProgress?: (percent: number) => void
  signal?: AbortSignal
}

class TeachingStorageUploadError extends Error {
  readonly statusCode: number
  readonly status: number
  constructor(message: string, statusCode = 0) {
    super(message)
    this.name = 'TeachingStorageUploadError'
    this.statusCode = statusCode
    this.status = statusCode
  }
}

export function uploadTeachingStorageFile({ bucket, storagePath, file, mimeType, accessToken, onProgress, signal }: TeachingStorageUpload): Promise<void> {
  const configuredUrl = import.meta.env.VITE_SUPABASE_URL as string
  const publicKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string
  let endpoint: URL
  try {
    const project = new URL(configuredUrl)
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    if (project.username || project.password || project.search || project.hash || project.pathname !== '/'
      || !['https:', 'http:'].includes(project.protocol) || !publicKey || !accessToken
      || !['xelay-teaching-files', 'xelay-submission-files'].includes(bucket)
      || !new RegExp(`^${uuid}/${uuid}/${uuid}\\.[a-z0-9]{1,5}$`).test(storagePath)) throw new Error()
    endpoint = new URL(`/storage/v1/object/${encodeURIComponent(bucket)}/${storagePath.split('/').map(encodeURIComponent).join('/')}`, project)
  } catch {
    return Promise.reject(new TeachingStorageUploadError('Не вдалося визначити сховище файлів. Оновіть сторінку або зверніться до підтримки.'))
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Завантаження скасовано.', 'AbortError')); return }
    const request = new XMLHttpRequest()
    let settled = false
    let lastPercent = -1
    function report(percent: number) {
      if (percent !== lastPercent) { lastPercent = percent; onProgress?.(percent) }
    }
    function finish(error?: Error) {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      request.onload = request.onerror = request.ontimeout = request.onabort = null
      request.upload.onprogress = null
      if (error) reject(error)
      else { report(100); resolve() }
    }
    function abort() { request.abort(); finish(new DOMException('Завантаження скасовано.', 'AbortError')) }
    request.open('POST', endpoint.href)
    request.withCredentials = false
    request.timeout = 15 * 60 * 1000
    request.setRequestHeader('Authorization', `Bearer ${accessToken}`)
    request.setRequestHeader('apikey', publicKey)
    request.setRequestHeader('x-upsert', 'false')
    request.upload.onprogress = event => {
      if (event.lengthComputable && event.total > 0) report(Math.min(99, Math.max(0, lastPercent, Math.floor(event.loaded / event.total * 100))))
    }
    request.onload = () => {
      let result: { message?: unknown; error?: unknown; statusCode?: unknown; Key?: unknown } | null = null
      try { result = JSON.parse(request.responseText) } catch { /* A failed/non-JSON response must not become a successful upload. */ }
      if (request.status >= 200 && request.status < 300 && result?.Key === `${bucket}/${storagePath}`) { finish(); return }
      const message = String(result?.message ?? result?.error ?? '')
      const status = Number(result?.statusCode) || request.status
      if (status === 403 || /row[- ]level security|violates.*security policy/i.test(message)) {
        finish(new TeachingStorageUploadError('Не вдалося завантажити файл через налаштування доступу. Спробуйте ще раз або зверніться до підтримки.', 403))
      } else if (status === 413) {
        finish(new TeachingStorageUploadError('Файл завеликий для завантаження. Завантажте його в Google Drive та додайте посилання з доступом для викладача або вибраної групи.', status))
      } else if (status === 401) {
        finish(new TeachingStorageUploadError('Не вдалося підтвердити вхід. Збережіть текст роботи перед повторним входом.', status))
      } else {
        finish(new TeachingStorageUploadError('Не вдалося підтвердити завантаження файлу. Текст і вибрані файли залишаються у формі. Спробуйте ще раз.', status))
      }
    }
    request.onerror = () => finish(new TeachingStorageUploadError('Не вдалося завантажити файл через з’єднання. Текст і вибрані файли залишаються у формі. Спробуйте ще раз.'))
    request.ontimeout = () => finish(new TeachingStorageUploadError('Завантаження тривало надто довго. Текст і вибрані файли залишаються у формі. Перевірте з’єднання та спробуйте ще раз.'))
    request.onabort = () => finish(new DOMException('Завантаження скасовано.', 'AbortError'))
    signal?.addEventListener('abort', abort, { once: true })
    const body = new FormData()
    body.append('cacheControl', '3600')
    body.append('', new Blob([file], { type: mimeType }), file.name)
    report(0)
    try { request.send(body) }
    catch { finish(new TeachingStorageUploadError('Не вдалося почати завантаження. Текст і вибрані файли залишаються у формі. Спробуйте ще раз.')) }
  })
}
