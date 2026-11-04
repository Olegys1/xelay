import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { QUESTION_IMPORT_MAX_TEXT } from './teachingQuestionImportText.ts'
function fail(message: string): never { throw new Error(message) }
function limitText(text: string) {
  if (!text.trim()) fail('У PDF не знайдено тексту. Якщо це скан, спочатку потрібен розпізнаний текст.')
  if (text.length > QUESTION_IMPORT_MAX_TEXT || new TextEncoder().encode(text).length > QUESTION_IMPORT_MAX_TEXT) fail('PDF містить забагато тексту. Збережіть потрібні запитання окремо.')
  return text
}

export async function extractQuestionPdfText(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer)
  if (!new TextDecoder().decode(bytes.subarray(0, 8)).startsWith('%PDF-')) fail('Вміст не відповідає PDF.')
  const pdfjs = await import('pdfjs-dist')
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  const task = pdfjs.getDocument({ data: bytes, useWorkerFetch: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { void task.destroy(); reject(new Error('PDF обробляється надто довго. Збережіть потрібні сторінки окремо або вставте текст.')) }, 20000) })
  try {
    return await Promise.race([(async () => {
      const document = await task.promise
      if (document.numPages > 100) fail('У PDF більше 100 сторінок. Збережіть потрібні запитання окремо.')
      const pages: string[] = []
      let length = 0
      for (let number = 1; number <= document.numPages; number++) {
        const page = await document.getPage(number), content = await page.getTextContent({ includeMarkedContent: false })
        let pageText = '', y: number | null = null
        for (const item of content.items) {
          if (!('str' in item)) continue
          const nextY = item.transform[5]
          if (y !== null && Math.abs(nextY - y) > 3 && !pageText.endsWith('\n')) pageText += '\n'
          pageText += item.str + (item.hasEOL ? '\n' : ' '); y = nextY
          if (pageText.length > QUESTION_IMPORT_MAX_TEXT) fail('На сторінці забагато тексту. Збережіть потрібні запитання окремо.')
        }
        pages.push(pageText.trim()); length += pageText.length
        if (length > QUESTION_IMPORT_MAX_TEXT) fail('PDF містить забагато тексту. Збережіть потрібні запитання окремо.')
        page.cleanup()
      }
      return limitText(pages.join('\n\n'))
    })(), deadline])
  } catch (failure) {
    if ((failure as { name?: string }).name === 'PasswordException') fail('PDF захищений паролем. Збережіть текстову копію без пароля.')
    throw failure
  } finally { if (timer) clearTimeout(timer); await task.destroy().catch(() => {}) }
}