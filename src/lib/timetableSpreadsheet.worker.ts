import { read, utils, SSF, type WorkSheet } from 'xlsx'

const MAX_ROWS = 2000
const MAX_COLUMNS = 256
const MAX_CELLS = 20000
const MAX_TABLE_TEXT = 180000
const MAX_WORKBOOK_TEXT = 1200000
const error = (message: string): never => { throw new Error(message) }

// Reject oversized/encrypted archives before the spreadsheet library inflates
// them. The worker also has a hard lifetime and is terminated on cancellation.
async function prepareXlsxArchive(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) error('Це не файл XLSX. Збережіть таблицю у форматі XLSX або CSV.')
  let end = -1
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (view.getUint32(position, true) === 0x06054b50 && position + 22 + view.getUint16(position + 20, true) === bytes.length) { end = position; break }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) error('Файл XLSX пошкоджений або має непідтримуваний формат архіву.')
  const entries = view.getUint16(end + 10, true)
  const directorySize = view.getUint32(end + 12, true)
  const directoryStart = view.getUint32(end + 16, true)
  if (!entries || entries > 2048 || entries !== view.getUint16(end + 8, true) || directoryStart + directorySize !== end) error('Файл XLSX завеликий або має непідтримувану структуру. Збережіть потрібний аркуш окремо.')
  let position = directoryStart
  let total = 0
  const files: { name: Uint8Array; content: Uint8Array; crc: number; flags: number }[] = []
  const names = new Set<string>()
  const checkExtras = (start: number, length: number) => {
    const end = start + length
    while (start < end) {
      if (start + 4 > end) error('Файл XLSX пошкоджений.')
      const type = view.getUint16(start, true)
      const size = view.getUint16(start + 2, true)
      if (type === 1) error('Формат ZIP64 не підтримується. Збережіть потрібний аркуш як новий XLSX або CSV.')
      start += 4 + size
      if (start > end) error('Файл XLSX пошкоджений.')
    }
  }
  for (let index = 0; index < entries; index++) {
    if (position + 46 > end || view.getUint32(position, true) !== 0x02014b50) error('Не вдалося прочитати структуру XLSX.')
    const flags = view.getUint16(position + 8, true)
    const compression = view.getUint16(position + 10, true)
    const compressed = view.getUint32(position + 20, true)
    const expanded = view.getUint32(position + 24, true)
    const localOffset = view.getUint32(position + 42, true)
    const nameLength = view.getUint16(position + 28, true)
    const extraLength = view.getUint16(position + 30, true)
    const nextPosition = position + 46 + nameLength + extraLength + view.getUint16(position + 32, true)
    if (nextPosition > end || !nameLength || view.getUint16(position + 34, true)) error('Файл XLSX пошкоджений.')
    if ((flags & 0x2041) || ![0, 8].includes(compression) || expanded > 12 * 1024 * 1024 || localOffset + 30 > directoryStart || compressed > bytes.length) error('Таблиця зашифрована або завелика. Збережіть потрібний аркуш як новий XLSX чи CSV.')
    if (view.getUint32(localOffset, true) !== 0x04034b50 || view.getUint16(localOffset + 6, true) !== flags || view.getUint16(localOffset + 8, true) !== compression) error('Файл XLSX пошкоджений.')
    const localNameLength = view.getUint16(localOffset + 26, true)
    const localExtraLength = view.getUint16(localOffset + 28, true)
    const contentStart = localOffset + 30 + localNameLength + localExtraLength
    if (contentStart + compressed > directoryStart || nameLength !== localNameLength) error('Файл XLSX пошкоджений.')
    const name = bytes.slice(position + 46, position + 46 + nameLength)
    if (name.some((value, offset) => bytes[localOffset + 30 + offset] !== value)) error('Файл XLSX пошкоджений.')
    const nameKey = Array.from(name).join(',')
    if (names.has(nameKey)) error('Файл XLSX містить повторювані частини. Збережіть його як новий файл.')
    names.add(nameKey)
    checkExtras(position + 46 + nameLength, extraLength)
    checkExtras(localOffset + 30 + localNameLength, localExtraLength)
    const localCompressed = view.getUint32(localOffset + 18, true)
    const localExpanded = view.getUint32(localOffset + 22, true)
    if (flags & 8) {
      if ((localCompressed !== 0 && localCompressed !== compressed) || (localExpanded !== 0 && localExpanded !== expanded)) error('Файл XLSX пошкоджений.')
    } else if (localCompressed !== compressed || localExpanded !== expanded) error('Файл XLSX пошкоджений.')
    total += expanded
    if (total > 32 * 1024 * 1024) error('Таблиця завелика після розпакування. Збережіть потрібний аркуш окремо.')
    let content: Uint8Array
    if (compression === 0) {
      if (compressed !== expanded) error('Файл XLSX пошкоджений.')
      content = bytes.slice(contentStart, contentStart + compressed)
    } else {
      // Enforce the REAL inflated length before passing anything to SheetJS.
      // A false central/local size must never drive the library's allocator.
      const stream = new Blob([bytes.slice(contentStart, contentStart + compressed)]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      const reader = stream.getReader()
      content = new Uint8Array(expanded)
      let written = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (written + chunk.value.byteLength > expanded) error('Розпакований XLSX перевищує заявлений розмір. Збережіть таблицю як новий файл.')
          content.set(chunk.value, written)
          written += chunk.value.byteLength
        }
        if (written !== expanded) error('Файл XLSX пошкоджений.')
      } finally { await reader.cancel().catch(() => {}) }
    }
    files.push({ name, content, crc: view.getUint32(position + 16, true), flags: flags & 0x800 })
    position = nextPosition
  }
  if (position !== end) error('Не вдалося прочитати структуру XLSX.')
  // Rebuild a small, stored ZIP with no extra fields or data descriptors. The
  // library therefore receives only already bounded, uncompressed contents.
  const localSize = files.reduce((size, file) => size + 30 + file.name.length + file.content.length, 0)
  const centralSize = files.reduce((size, file) => size + 46 + file.name.length, 0)
  const output = new Uint8Array(localSize + centralSize + 22)
  const result = new DataView(output.buffer)
  let local = 0, central = localSize
  for (const file of files) {
    result.setUint32(local, 0x04034b50, true); result.setUint16(local + 4, 20, true)
    result.setUint16(local + 6, file.flags, true); result.setUint32(local + 14, file.crc, true)
    result.setUint32(local + 18, file.content.length, true); result.setUint32(local + 22, file.content.length, true)
    result.setUint16(local + 26, file.name.length, true)
    output.set(file.name, local + 30); output.set(file.content, local + 30 + file.name.length)
    result.setUint32(central, 0x02014b50, true); result.setUint16(central + 4, 20, true); result.setUint16(central + 6, 20, true)
    result.setUint16(central + 8, file.flags, true); result.setUint32(central + 16, file.crc, true)
    result.setUint32(central + 20, file.content.length, true); result.setUint32(central + 24, file.content.length, true)
    result.setUint16(central + 28, file.name.length, true); result.setUint32(central + 42, local, true)
    output.set(file.name, central + 46)
    local += 30 + file.name.length + file.content.length
    central += 46 + file.name.length
  }
  result.setUint32(central, 0x06054b50, true)
  result.setUint16(central + 8, files.length, true); result.setUint16(central + 10, files.length, true)
  result.setUint32(central + 12, centralSize, true); result.setUint32(central + 16, localSize, true)
  return output.buffer
}

function textInput(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes)
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes)
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return new TextDecoder('windows-1251').decode(bytes) }
}

function delimitedSheet(input: string, extension: 'csv' | 'tsv'): WorkSheet {
  let text = input.replace(/^\ufeff/, '')
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) error('CSV або TSV містить двійкові дані. Експортуйте таблицю заново у текстовий формат.')
  const directive = /^sep=([,;\t])\r?\n/i.exec(text)
  if (directive) text = text.slice(directive[0].length)
  const counts = { ',': 0, ';': 0, '\t': 0 }
  let quoted = false
  for (let index = 0; index < Math.min(text.length, 20000); index++) {
    const char = text[index]
    if (char === '"') {
      if (quoted && text[index + 1] === '"') index++
      else quoted = !quoted
    } else if (!quoted) {
      if (char === '\r' || char === '\n') break
      if (char in counts) counts[char as keyof typeof counts]++
    }
  }
  const delimiter = extension === 'tsv' ? '\t' : directive?.[1] || (Object.keys(counts) as (keyof typeof counts)[]).sort((a, b) => counts[b] - counts[a])[0]
  const rows: string[][] = []
  let row: string[] = [], cell = '', inQuotes = false, afterQuote = false
  const pushCell = () => {
    row.push(cell)
    if (row.length > MAX_COLUMNS) error('У таблиці понад 256 стовпців. Збережіть потрібний розділ окремо.')
    cell = ''; afterQuote = false
  }
  const pushRow = () => {
    pushCell(); rows.push(row); row = []
    if (rows.length > MAX_ROWS) error('У таблиці понад 2000 рядків. Збережіть потрібний розділ окремо.')
  }
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++ }
        else { inQuotes = false; afterQuote = true }
      } else cell += char
    } else if (char === delimiter) pushCell()
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index++
      pushRow()
    } else if (char === '"' && !cell && !afterQuote) inQuotes = true
    else {
      if (afterQuote) error('У CSV некоректні лапки. Експортуйте його заново або завантажте XLSX.')
      cell += char
    }
    if (cell.length > 4000) error('Одна клітинка таблиці містить забагато тексту. Залиште лише потрібний розклад.')
  }
  if (inQuotes) error('У CSV не закриті лапки. Експортуйте його заново або завантажте XLSX.')
  if (cell || row.length || afterQuote) pushRow()
  // No format sniffing: a file renamed to CSV never reaches a ZIP/OLE parser.
  return utils.aoa_to_sheet(rows)
}

function serializeSheet(sheet: WorkSheet, name: string, date1904 = false): string | null {
  const rangeText = sheet['!fullref'] || sheet['!ref']
  if (!rangeText) return null
  const range = utils.decode_range(rangeText)
  if (range.e.r >= MAX_ROWS || range.e.c >= MAX_COLUMNS) error('Аркуш містить понад 2000 рядків або 256 стовпців. Збережіть потрібний розділ в окремий файл.')
  const rows = sheet['!rows'] || []
  const columns = sheet['!cols'] || []
  const cells: [string, string][] = []
  const formattedValues: { cell: string; excel_serial: number; number_format: string }[] = []
  let formulaCells = 0
  for (const address of Object.keys(sheet)) {
    if (address.startsWith('!') || !/^[A-Z]+[1-9]\d*$/.test(address)) continue
    const point = utils.decode_cell(address)
    if (point.r >= MAX_ROWS || point.c >= MAX_COLUMNS) error('Аркуш містить дані за межами 2000 рядків або 256 стовпців. Збережіть потрібний розділ окремо.')
    if (rows[point.r]?.hidden || columns[point.c]?.hidden) continue
    const cell = sheet[address]
    const formulaCell = Boolean(cell.f || cell.F)
    // SheetJS can synthesize zero for a formula without a cached value. Do not
    // present that synthetic value as a subject, group number or midnight.
    let text = typeof cell.w === 'string' ? cell.w : cell.v === undefined || cell.v === null ? '' : String(cell.v)
    if (formulaCell) { formulaCells++; text = '[клітинка з формулою — звірте видиме значення з оригіналом або завантажте скриншот]' }
    text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim()
    if (!text) continue
    if (text.length > 4000) error('Одна з клітинок містить забагато тексту. Завантажте лише розділ із розкладом.')
    cells.push([address, text])
    if (!formulaCell && typeof cell.v === 'number' && Number.isFinite(cell.v) && typeof cell.z === 'string' && SSF.is_date(cell.z)) {
      if (cell.z.length > 200) error('Формат однієї з дат у таблиці надто складний. Збережіть аркуш як CSV або завантажте скриншот.')
      formattedValues.push({ cell: address, excel_serial: cell.v, number_format: cell.z })
    }
    if (cells.length > MAX_CELLS) error('Аркуш завеликий. Збережіть потрібний курс або групу окремо.')
  }
  if (!cells.length) return null
  cells.sort((left, right) => {
    const a = utils.decode_cell(left[0]), b = utils.decode_cell(right[0])
    return a.r - b.r || a.c - b.c
  })
  const merges = sheet['!merges'] || []
  if (merges.length > 10000 || merges.some(merge => merge.e.r >= MAX_ROWS || merge.e.c >= MAX_COLUMNS || merge.s.r < 0 || merge.s.c < 0 || merge.s.r > merge.e.r || merge.s.c > merge.e.c)) error('Аркуш має надто складні об’єднані клітинки. Збережіть потрібний розділ окремо.')
  const result = JSON.stringify({
    format: 'xelay_spreadsheet_v1', sheet: name, range: rangeText,
    merged_ranges: merges.map(merge => utils.encode_range(merge)),
    cells,
    ...(formattedValues.length ? { date_system: date1904 ? '1904' : '1900', date_time_values: formattedValues } : {}),
    notes: [
      'Координати клітинок та об’єднані діапазони збережено з оригіналу. Порожні клітинки не перелічені; об’єднана клітинка має значення у верхньому лівому куті.',
      ...(formattedValues.length ? ['date_time_values зберігає початкові значення Excel і формат дат/часу. Вони не задають автоматично період імпорту; приховані форматом компоненти дати треба звірити з оригіналом.'] : []),
      ...(rows.some(row => row?.hidden) || columns.some(column => column?.hidden) ? ['Приховані рядки та стовпці не включено.'] : []),
      ...(formulaCells ? ['Значення клітинок із формулами не включено, формули не обчислюються. Використайте скриншот або збережіть потрібний аркуш як CSV зі значеннями.'] : []),
    ],
  })
  if (result.length > MAX_TABLE_TEXT) error('Аркуш містить забагато даних для одного імпорту. Збережіть потрібний курс або групу в окрему таблицю.')
  return result
}

self.onmessage = async ({ data }) => {
  try {
    if (!(data?.buffer instanceof ArrayBuffer) || !data.buffer.byteLength || data.buffer.byteLength > 8 * 1024 * 1024 || !['xlsx', 'csv', 'tsv'].includes(data.extension)) error('Оберіть таблицю XLSX, CSV або TSV до 8 МБ.')
    const xlsx = data.extension === 'xlsx'
    const workbook = xlsx ? read(await prepareXlsxArchive(data.buffer), {
      type: 'array', cellHTML: false,
      cellFormula: true, cellStyles: true, cellText: true, cellNF: true,
      // Read every row of the bounded archive. sheetRows could silently hide a
      // sparse lower-week section when the XLSX omits its optional dimension.
      bookVBA: false, bookFiles: false,
    }) : { SheetNames: ['Розклад'], Sheets: { 'Розклад': delimitedSheet(textInput(data.buffer), data.extension) }, Workbook: undefined }
    if (workbook.SheetNames.length > 32) error('У файлі понад 32 аркуші. Збережіть потрібні аркуші окремо.')
    const sheets: { name: string; table_text: string }[] = []
    let total = 0
    for (const name of workbook.SheetNames) {
      if (workbook.Workbook?.Sheets?.find(sheet => sheet.name === name)?.Hidden) continue
      const table_text = serializeSheet(workbook.Sheets[name], name, Boolean(workbook.Workbook?.WBProps?.date1904))
      if (!table_text) continue
      total += table_text.length
      if (total > MAX_WORKBOOK_TEXT) error('У файлі забагато даних. Збережіть потрібні аркуші окремо.')
      sheets.push({ name, table_text })
    }
    if (!sheets.length) error('У таблиці немає видимих клітинок із розкладом. Оберіть інший файл.')
    self.postMessage({ ok: true, sheets })
  } catch (problem) {
    self.postMessage({ ok: false, error: problem instanceof Error ? problem.message.slice(0, 400) : 'Не вдалося прочитати файл таблиці.' })
  }
}
