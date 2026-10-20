export type TimetableSpreadsheet = {
  name: string
  sheets: { name: string; table_text: string }[]
}

const MAX_FILE_BYTES = 8 * 1024 * 1024
const PARSE_TIMEOUT_MS = 30000

// Parsing stays on this device in a disposable worker. Only the worksheets
// selected in the import form are subsequently sent for recognition.
export async function loadTimetableSpreadsheet(file: File, signal?: AbortSignal): Promise<TimetableSpreadsheet> {
  if (!/\.(xlsx|csv|tsv)$/i.test(file.name) || !file.size || file.size > MAX_FILE_BYTES) {
    throw new Error('Оберіть таблицю XLSX, CSV або TSV розміром до 8 МБ. Файл XLS спочатку збережіть як XLSX.')
  }
  if (signal?.aborted) throw new DOMException('Скасовано', 'AbortError')
  if (typeof Worker === 'undefined') throw new Error('Цей браузер не підтримує читання таблиць. Оновіть браузер або завантажте скриншоти розкладу.')
  const name = file.name.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)
  const worker = new Worker(new URL('./timetableSpreadsheet.worker.ts', import.meta.url), { type: 'module' })
  return new Promise<TimetableSpreadsheet>((resolve, reject) => {
    let finished = false
    const finish = (problem?: Error, result?: TimetableSpreadsheet) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      if (problem) reject(problem)
      else resolve(result!)
    }
    const abort = () => finish(new DOMException('Скасовано', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('Таблиця читається надто довго. Збережіть потрібні аркуші в окремий файл або завантажте скриншоти.')), PARSE_TIMEOUT_MS)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onerror = () => finish(new Error('Не вдалося прочитати таблицю. Спробуйте зберегти її як новий XLSX або CSV.'))
    worker.onmessage = ({ data }) => {
      if (data?.ok !== true) {
        finish(new Error(typeof data?.error === 'string' && data.error.length <= 400 ? data.error : 'Не вдалося прочитати таблицю.'))
        return
      }
      const sheets: unknown = data.sheets
      if (!Array.isArray(sheets) || !sheets.length || sheets.length > 32 || sheets.some(sheet => !sheet || typeof sheet.name !== 'string' || sheet.name.length > 160 || typeof sheet.table_text !== 'string' || !sheet.table_text || sheet.table_text.length > 180000)) {
        finish(new Error('Таблиця завелика або має непідтримувану структуру. Збережіть потрібний аркуш окремо.'))
        return
      }
      finish(undefined, { name, sheets })
    }
    if (signal?.aborted) { abort(); return }
    void file.arrayBuffer().then(buffer => {
      if (!finished) worker.postMessage({ name, extension: file.name.split('.').pop()?.toLowerCase(), buffer }, [buffer])
    }).catch(() => finish(new Error('Не вдалося відкрити файл таблиці. Оберіть його ще раз.')))
  })
}
