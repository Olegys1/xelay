import { QUESTION_IMPORT_MAX_TEXT, detectTeachingQuestionFormat, questionTableToText, type TeachingEasyImportFormat } from './teachingQuestionImportText.ts'
import { readQuestionOfficeArchive, storedQuestionOfficeArchive } from './teachingQuestionImportArchive.ts'

export const QUESTION_IMPORT_ACCEPT = '.gift,.txt,.md,.xml,.csv,.tsv,.xlsx,.doc,.docx,.pdf,text/plain,text/csv,application/msword,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const QUESTION_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024
export const QUESTION_IMPORT_MAX_BATCH_BYTES = 20 * 1024 * 1024
export const QUESTION_IMPORT_MAX_FILES = 10
export type ExtractedQuestionImport = { name: string; text: string; format: TeachingEasyImportFormat; notes: string[] }
function fail(message: string): never { throw new Error(message) }
function limitText(text: string) {
  if (!text.trim()) fail('У файлі не знайдено тексту. Якщо це скан або фото, скопіюйте розпізнаний текст чи використайте текстовий DOCX/PDF.')
  if (text.length > QUESTION_IMPORT_MAX_TEXT || new TextEncoder().encode(text).length > QUESTION_IMPORT_MAX_TEXT) fail('Текст файлу перевищує 2 МБ. Імпортуйте до 100 запитань за раз.')
  return text
}
function decodeText(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2))
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2))
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '') }
  catch { return fail('Текст має невідоме кодування. Збережіть файл як UTF-8 або вставте його текст у поле.') }
}
/** Linear text extraction; malformed brackets cannot trigger regex backtracking. */
function xmlText(xml: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) fail('XML-сутності та DTD у документах не підтримуються.')
  const parts: string[] = []
  const stack: string[] = []
  let position = 0
  while (position < xml.length) {
    const opening = xml.indexOf('<', position)
    if (opening < 0) { parts.push(xml.slice(position)); break }
    parts.push(xml.slice(position, opening))
    if (xml.startsWith('<!--', opening)) {
      const end = xml.indexOf('-->', opening + 4)
      if (end < 0) fail('Коментар XML обірваний. Збережіть документ ще раз.')
      position = end + 3; continue
    }
    if (xml.startsWith('<![CDATA[', opening)) {
      const end = xml.indexOf(']]>', opening + 9)
      if (end < 0) fail('Текстовий блок XML обірваний.')
      // Escape ampersands so CDATA is not entity-decoded a second time.
      parts.push(xml.slice(opening + 9, end).replace(/&/g, '&amp;'))
      position = end + 3; continue
    }
    let quote = '', end = opening + 1
    for (; end < xml.length; end++) {
      const char = xml[end]
      if (quote) { if (char === quote) quote = '' }
      else if (char === '"' || char === "'") quote = char
      else if (char === '>') break
      else if (char === '<') fail('Структура XML пошкоджена. Збережіть документ ще раз.')
      if (end - opening > 65536) fail('Тег XML завеликий.')
    }
    if (end === xml.length) fail('Тег XML обірваний. Збережіть документ ще раз.')
    const tag = xml.slice(opening + 1, end).trim()
    if (!tag.startsWith('?')) {
      const match = tag.match(/^(\/?)([A-Za-z_][\w:.-]*)(?:\s|\/|$)/)
      if (!match) fail('Некоректний тег XML.')
      const closing = Boolean(match[1]), name = match[2]
      if (closing) { if (stack.pop() !== name) fail('Теги XML не збігаються.') }
      else if (!tag.endsWith('/')) { stack.push(name); if (stack.length > 64) fail('XML має надмірну вкладеність.') }
      if (closing && name === 'w:p') parts.push('\n\n')
      else if (closing && name === 'w:tc' || name === 'w:tab') parts.push('\t')
      else if (closing && name === 'w:tr' || name === 'w:br') parts.push('\n')
    }
    position = end + 1
  }
  if (stack.length) fail('XML обірваний: не всі теги закрито.')
  return parts.join('').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const named: Record<string,string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (entity[0] !== '#') return named[entity.toLowerCase()] || ''
    const value = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : ''
  }).trim()
}

async function extractDocx(buffer: ArrayBuffer) {
  const archive = await readQuestionOfficeArchive(buffer)
  const content = archive.get('word/document.xml')
  if (!content || archive.has('xl/workbook.xml')) fail('Вміст не відповідає DOCX.')
  const xml = decodeText(content)
  if (/<(?:w:drawing|w:pict|m:oMath|w:object|w:altChunk|w:ins|w:del)\b/.test(xml)) fail('Документ містить зображення, формули, вкладені об’єкти або невирішені правки. Для точного імпорту збережіть текстову копію з явними відповідями; такі частини не можна переносити мовчки.')
  return limitText(xmlText(xml))
}
async function extractSpreadsheet(buffer: ArrayBuffer) {
  const archive = await readQuestionOfficeArchive(buffer)
  if (!archive.has('xl/workbook.xml') || archive.has('word/document.xml')) fail('Вміст не відповідає XLSX.')
  const { read, utils } = await import('xlsx')
  const workbook = read(storedQuestionOfficeArchive(archive), { type: 'array', dense: true, sheetRows: 102, cellFormula: true, cellHTML: false, cellStyles: false, cellNF: false, bookVBA: false, WTF: true })
  if (workbook.SheetNames.length > 20) fail('У книзі забагато аркушів. Збережіть аркуш із запитаннями окремо.')
  const rows: string[][] = []
  let header: string[] | null = null
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name]
    if (!sheet?.['!ref']) continue
    const range = utils.decode_range(sheet['!fullref'] || sheet['!ref'])
    if (range.e.r > 101 || range.e.c > 35) fail(`Аркуш «${name}» завеликий. Залиште заголовок і до 100 запитань у 36 колонках.`)
    for (let row = range.s.r; row <= range.e.r; row++) for (let column = range.s.c; column <= range.e.c; column++) {
      const cell = sheet['!data']?.[row]?.[column] || sheet[utils.encode_cell({ r: row, c: column })]
      if (cell?.f || cell?.F) fail(`Аркуш «${name}» містить формули. Вставте значення, щоб імпортувати саме видимий текст і ключі.`)
    }
    const table = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false }).map(row => row.map(value => String(value ?? '')))
    if (table.length < 2) fail(`Аркуш «${name}» не містить заголовка і запитань. Приберіть зайві аркуші або скористайтеся шаблоном.`)
    if (header && JSON.stringify(header) !== JSON.stringify(table[0])) fail('Заголовки аркушів різні. Імпортуйте кожен аркуш окремо або вирівняйте колонки за шаблоном.')
    header ||= table[0]
    if (!rows.length) rows.push(header)
    rows.push(...table.slice(1))
    if (rows.length > 101) fail('У всіх аркушах разом більше 100 запитань. Розділіть книгу на частини.')
  }
  return limitText(questionTableToText(rows))
}
async function extractPdf(buffer: ArrayBuffer) {
  if (!new TextDecoder().decode(new Uint8Array(buffer).subarray(0, 8)).startsWith('%PDF-')) fail('Вміст не відповідає PDF.')
  const { extractQuestionPdfText } = await import('./teachingQuestionImportPdf.ts')
  return extractQuestionPdfText(buffer)
}

/** Local content inspection only: no files are uploaded to a model or server. */
export async function extractTeachingQuestionFile(file: File): Promise<ExtractedQuestionImport> {
  if (!file.size || file.size > QUESTION_IMPORT_MAX_FILE_BYTES) fail('Один файл має бути непорожнім і не більшим за 10 МБ.')
  const extension = file.name.toLocaleLowerCase().split('.').pop() || ''
  if (!['gift','txt','md','xml','csv','tsv','xlsx','doc','docx','pdf'].includes(extension)) fail('Оберіть TXT, GIFT, Moodle XML, CSV, TSV, XLSX, DOC, DOCX або текстовий PDF. Старі XLS збережіть як XLSX; для фото і сканів спочатку потрібен розпізнаний текст.')
  const buffer = await file.arrayBuffer()
  let text: string, format: TeachingEasyImportFormat = 'auto'
  const notes: string[] = []
  if (extension === 'doc') {
    const { extractLegacyQuestionDoc } = await import('./teachingQuestionImportDoc.ts')
    const extracted = await extractLegacyQuestionDoc(buffer)
    text = extracted.text; notes.push(...extracted.notes)
  }
  else if (extension === 'docx') { text = await extractDocx(buffer); notes.push('Перевірте нумерацію, абзаци й ключі: форматування Word не визначає правильну відповідь.') }
  else if (extension === 'xlsx') { text = await extractSpreadsheet(buffer); format = 'table' }
  else if (extension === 'pdf') { text = await extractPdf(buffer); notes.push('З PDF витягнуто лише текст. Перевірте порядок рядків; зображення й позначки кольором не визначають відповіді.') }
  else {
    const bytes = new Uint8Array(buffer)
    if (bytes.subarray(0, 8).some(value => value === 0) && !(bytes[0] === 0xff && bytes[1] === 0xfe) && !(bytes[0] === 0xfe && bytes[1] === 0xff)) fail('Файл не схожий на текст. Оберіть оригінальний DOCX, XLSX або PDF.')
    text = decodeText(bytes)
    if (extension === 'xml') format = 'moodle_xml'
    else if (extension === 'gift') format = 'gift'
    else if (['csv','tsv'].includes(extension)) format = 'table'
  }
  limitText(text)
  if (text.includes('\u0000')) fail('Текст містить двійкові дані. Збережіть файл як UTF-8.')
  return { name: file.name, text, format: format === 'auto' ? detectTeachingQuestionFormat(text) : format, notes }
}
