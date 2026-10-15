export type StudyGroupLoadIssue = { kind: 'network' | 'server' | 'session' | 'access' | 'unknown'; message: string; retryable: boolean }

export function studyGroupReadFailure(error: unknown, responseStatus?: number): StudyGroupLoadIssue {
  const value = error && typeof error === 'object' ? error as { name?: unknown; code?: unknown; message?: unknown; status?: unknown } : {}
  const name = typeof value.name === 'string' ? value.name : ''
  const code = typeof value.code === 'string' ? value.code : ''
  const message = typeof value.message === 'string' ? value.message.toLowerCase() : ''
  const status = typeof responseStatus === 'number' ? responseStatus : typeof value.status === 'number' ? value.status : null
  if (status === 0 || status === 408 || ['AbortError', 'TimeoutError'].includes(name)
    || name === 'AuthRetryableFetchError' && (status === null || status === 0)
    || /failed to fetch|fetch failed|load failed|networkerror|network request failed|request timed out|timeout/.test(message)) {
    return { kind: 'network', retryable: true, message: 'Не вдалося з’єднатися з Xelay для завантаження групи. Перевірте інтернет-з’єднання та спробуйте ще раз. Ця помилка не означає, що групу видалено або доступ втрачено.' }
  }
  if (status === 429 || status !== null && status >= 500) {
    return { kind: 'server', retryable: true, message: 'Сервіс навчальних груп тимчасово недоступний. Спробуйте ще раз трохи пізніше.' }
  }
  if (status === 401 || ['PGRST301', 'PGRST302', 'PGRST303'].includes(code)) {
    return { kind: 'session', retryable: true, message: 'Не вдалося підтвердити сесію для завантаження групи. Повторіть спробу. Якщо помилка залишається, увійдіть до Xelay ще раз.' }
  }
  if (status === 403 || code === '42501') {
    return { kind: 'access', retryable: false, message: 'Сервер не дозволив відкрити цю групу. Перевірте, чи ви увійшли до потрібного акаунта та прийняли запрошення.' }
  }
  return { kind: 'unknown', retryable: true, message: 'Не вдалося завантажити групу. Повторіть спробу. Якщо помилка залишається, зверніться до підтримки Xelay.' }
}
