// Restricted MS-CFB/MS-DOC text reader. Never starts Office or evaluates OLE,
// fields, macros or embedded objects. SheetJS sees only a bounded, checked CFB.
const MAX_FILE = 10 * 1024 * 1024, MAX_TEXT = 2 * 1024 * 1024
const FREE = 0xffffffff, END = 0xfffffffe, FAT = 0xfffffffd, DIF = 0xfffffffc
const conversion = ' Збережіть текстову копію як DOCX або вставте текст запитань.'
const bad = (): never => { throw new Error('Структура старого DOC пошкоджена або не підтримується.' + conversion) }
const unsupported = (detail: string): never => { throw new Error(`Старий DOC містить ${detail}, які не можна переносити мовчки.` + conversion) }
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const range = (bytes: Uint8Array, at: number, length: number) => {
  if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at > bytes.length - length) bad()
  return bytes.subarray(at, at + length)
}
const u16 = (bytes: Uint8Array, at: number) => view(range(bytes, at, 2)).getUint16(0, true)
const u32 = (bytes: Uint8Array, at: number) => view(range(bytes, at, 4)).getUint32(0, true)
const decode = (bytes: Uint8Array, encoding = 'utf-16le') => {
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes) } catch { return bad() }
}
// MS-DOC FcCompressed is 8-bit Unicode with this exact exception table;
// unlike Windows-1252, 0x80/0x8E/0x9E are not Euro/Ž/ž substitutions.
const compressedUnicode: Record<number, number> = { 0x82:0x201a,0x83:0x0192,0x84:0x201e,0x85:0x2026,0x86:0x2020,0x87:0x2021,0x88:0x02c6,0x89:0x2030,0x8a:0x0160,0x8b:0x2039,0x8c:0x0152,0x91:0x2018,0x92:0x2019,0x93:0x201c,0x94:0x201d,0x95:0x2022,0x96:0x2013,0x97:0x2014,0x98:0x02dc,0x99:0x2122,0x9a:0x0161,0x9b:0x203a,0x9c:0x0153,0x9f:0x0178 }
const decodeCompressed = (bytes: Uint8Array) => Array.from(bytes, value => String.fromCharCode(compressedUnicode[value] ?? value)).join('')
type Entry = { name: string; type: number; left: number; right: number; child: number; start: number; size: number }

/** Reject cycles, shared chains, huge declared allocations and directory cycles
 * before the library's recursive DIFAT/path and mini-stream traversals. */
function inspectContainer(bytes: Uint8Array) {
  let libraryBytes = bytes
  if (bytes.length < 512 || bytes.length > MAX_FILE || ![0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1].every((v, i) => bytes[i] === v)) bad()
  const major = u16(bytes, 26), shift = u16(bytes, 30)
  if (u16(bytes, 28) !== 0xfffe || !((major === 3 && shift === 9) || (major === 4 && shift === 12)) || u16(bytes, 32) !== 6 || u32(bytes, 56) !== 4096) bad()
  const sectorSize = 2 ** shift, sectors = bytes.length / sectorSize - 1
  if (!Number.isInteger(sectors) || sectors < 1 || sectors > MAX_FILE / 512 || (major === 3 && u32(bytes, 40) !== 0)) bad()
  const sector = (id: number) => { if (id >= sectors) bad(); return range(bytes, (id + 1) * sectorSize, sectorSize) }
  const fatCount = u32(bytes, 44), difCount = u32(bytes, 72)
  if (!fatCount || fatCount > Math.ceil(sectors / (sectorSize / 4)) + 1 || difCount > Math.ceil(Math.max(0, fatCount - 109) / (sectorSize / 4 - 1))) bad()
  const fatIds: number[] = [], difIds = new Set<number>()
  const addFat = (id: number) => { if (id !== FREE) { if (id >= sectors || fatIds.includes(id)) bad(); fatIds.push(id) } }
  for (let at = 76; at < 512; at += 4) addFat(u32(bytes, at))
  let difId = u32(bytes, 68)
  for (let index = 0; index < difCount; index++) {
    if (difIds.has(difId) || difId >= sectors || fatIds.includes(difId)) bad()
    difIds.add(difId)
    const data = sector(difId)
    for (let at = 0; at < sectorSize - 4; at += 4) addFat(u32(data, at))
    difId = u32(data, sectorSize - 4)
  }
  if (difId !== END || fatIds.length !== fatCount || fatIds.some(id => difIds.has(id)) || fatCount * sectorSize / 4 < sectors) bad()
  const fat = new Uint32Array(sectors)
  for (let index = 0; index < sectors; index++) fat[index] = u32(sector(fatIds[Math.floor(index * 4 / sectorSize)]), index * 4 % sectorSize)
  if (fat.some(id => id >= sectors && ![FREE, END, FAT, DIF].includes(id)) || fatIds.some(id => fat[id] !== FAT) || [...difIds].some(id => fat[id] !== DIF)) bad()
  const claimed = new Set<number>([...fatIds, ...difIds])
  const walk = (start: number, expected: number | undefined, table = fat, maximum = sectors, owners = claimed): number[] => {
    const chain: number[] = [], seen = new Set<number>()
    let id = start
    while (id !== END) {
      if (id >= maximum || id >= table.length || seen.has(id) || owners.has(id)) bad()
      seen.add(id); owners.add(id); chain.push(id)
      if (chain.length > maximum || expected !== undefined && chain.length > expected) bad()
      id = table[id]
    }
    if (expected !== undefined && chain.length !== expected) bad()
    return chain
  }
  const join = (chain: number[]) => {
    const output = new Uint8Array(chain.length * sectorSize)
    chain.forEach((id, index) => output.set(sector(id), index * sectorSize))
    return output
  }
  const dirChain = walk(u32(bytes, 48), undefined)
  if (!dirChain.length || dirChain.length * sectorSize > 256 * 128 || major === 4 && dirChain.length !== u32(bytes, 40)) bad()
  const directory = join(dirChain), entries: Entry[] = []
  for (let at = 0; at < directory.length; at += 128) {
    const type = directory[at + 66], nameBytes = u16(directory, at + 64)
    if (type === 0) {
      // The library visits even unused directory entries while building paths.
      // Reject disguised payloads and normalize only the allowed unused links.
      const unused = range(directory, at, 128)
      if (unused.some((value, index) => (index < 68 || index >= 80) && value !== 0)
        || [68,72,76].some(offset => ![0,FREE].includes(u32(unused, offset)))) bad()
      if (libraryBytes === bytes) libraryBytes = bytes.slice()
      const physical = (dirChain[Math.floor(at / sectorSize)] + 1) * sectorSize + at % sectorSize
      for (const offset of [68,72,76]) view(libraryBytes).setUint32(physical + offset, FREE, true)
      entries.push({ name: '', type, left: FREE, right: FREE, child: FREE, start: END, size: 0 }); continue
    }
    if (![2,5].includes(type)) unsupported('вкладені об’єкти або макроси')
    if (nameBytes < 2 || nameBytes > 64 || nameBytes % 2 || u16(directory, at + nameBytes - 2) !== 0 || u32(directory, at + 124)) bad()
    const name = decode(range(directory, at, nameBytes - 2))
    if (!name || /[\\/\u0000]/.test(name)) bad()
    entries.push({ name, type, left: u32(directory, at + 68), right: u32(directory, at + 72), child: u32(directory, at + 76), start: u32(directory, at + 116), size: u32(directory, at + 120) })
  }
  if (entries[0]?.type !== 5 || entries[0].left !== FREE || entries[0].right !== FREE || entries.slice(1).some(entry => entry.type === 5)) bad()
  const reached = new Set<number>(), names = new Set<string>(), pending = [entries[0].child]
  while (pending.length) {
    const id = pending.pop()!
    if (id === FREE) continue
    const entry = entries[id]
    if (!id || !entry || entry.type !== 2 || reached.has(id) || entry.child !== FREE) bad()
    reached.add(id)
    const name = entry.name.toLowerCase()
    if (names.has(name)) bad()
    names.add(name)
    if (!['worddocument','0table','1table','data','\u0001compobj','\u0005summaryinformation','\u0005documentsummaryinformation'].includes(name)) unsupported('непідтримувані потоки, об’єкти або макроси')
    pending.push(entry.left, entry.right)
  }
  if (entries.slice(1).some((entry, index) => entry.type && !reached.has(index + 1))) bad()
  const miniCount = u32(bytes, 64)
  if (miniCount > Math.ceil(sectors / (sectorSize / 64)) || entries[0].size > bytes.length) bad()
  const miniFat = miniCount ? join(walk(u32(bytes, 60), miniCount)) : new Uint8Array()
  if (!miniCount && u32(bytes, 60) !== END) bad()
  const miniRoot = entries[0].size ? join(walk(entries[0].start, Math.ceil(entries[0].size / sectorSize))).subarray(0, entries[0].size) : new Uint8Array()
  const miniTable = new Uint32Array(miniFat.length / 4)
  for (let index = 0; index < miniTable.length; index++) miniTable[index] = u32(miniFat, index * 4)
  const usedMini = new Set<number>()
  let totalBytes = 0
  for (const entry of entries.slice(1).filter(entry => entry.type === 2)) {
    totalBytes += entry.size
    if (entry.size > bytes.length || totalBytes > bytes.length) bad()
    if (!entry.size) { if (entry.start !== END && entry.start !== FREE) bad(); continue }
    if (entry.size < 4096) walk(entry.start, Math.ceil(entry.size / 64), miniTable, Math.floor(miniRoot.length / 64), usedMini)
    else walk(entry.start, Math.ceil(entry.size / sectorSize))
  }
  // Unreferenced chains could otherwise make the library repeatedly traverse
  // an attacker-controlled shared tail even though every named stream is safe.
  if (fat.some((next, id) => next < sectors && !claimed.has(id))) bad()
  // SheetJS builds sector lists in directory-relative physical order. Even a
  // valid acyclic chain in reverse physical order can repeatedly copy its tail.
  // Simulate that exact traversal with a work bound before any library copies.
  const visited = new Uint8Array(sectors), dirStart = u32(bytes, 48)
  let librarySteps = 0
  for (let index = 0; index < sectors; index++) {
    let id = (index + dirStart) % sectors
    if (visited[id]) continue
    while (id < sectors) {
      if (++librarySteps > sectors * 4) bad()
      visited[id] = 1
      id = fat[id]
    }
  }
  return { entries: entries.filter(entry => entry.type === 2), libraryBytes }
}

const hiddenSprms = [0x0800,0x0801,0x0802,0x0811,0x083c,0x2a90] // revisions, field/character/web/SDT vanish
const mediaSprms = [0x0806,0x080a,0x0855,0x0856,0x6a03,0x6a09,0xc81a]
function checkStyleFlags(styles: Uint8Array) {
  // Conservative: inherited hidden/revision properties may originate in a
  // style rather than CHPX. Reject ambiguous flagged style bytes, never expose
  // text that a Word renderer might hide.
  if (!styles.length) return
  const headerSize = u16(styles, 0), count = u16(styles, 2), baseSize = u16(styles, 4)
  if (headerSize < 4 || count > 1024 || baseSize < 10 || baseSize > 18) bad()
  range(styles, 2, headerSize)
  let position = headerSize + 2
  for (let index = 0; index < count; index++) {
    const size = u16(styles, position); position += 2
    const style = range(styles, position, size); position += size
    if (!size) continue
    const nameSize = u16(style, baseSize)
    const properties = range(style, baseSize + 2 + nameSize * 2 + 2, style.length - (baseSize + 2 + nameSize * 2 + 2))
    for (let at = 0; at + 2 < properties.length; at++) {
      const sprm = u16(properties, at)
      if (hiddenSprms.includes(sprm) && properties[at + 2] !== 0) unsupported('прихований текст або невирішені правки')
      // Styles can also supply inherited symbol/picture/math properties.
      if (mediaSprms.includes(sprm)) unsupported('символьні формули або вкладені об’єкти в стилях')
    }
  }
  if (position !== styles.length) bad()
}
type Piece = { start: number; end: number; compressed: boolean }
function checkCharacterFormatting(word: Uint8Array, table: Uint8Array, fc: number, length: number, pieces: Piece[]) {
  if (!length) return
  const bte = range(table, fc, length), count = (length - 4) / 8
  if (!Number.isInteger(count) || count < 1 || count > 4096) bad()
  const sorted = [...pieces].sort((a, b) => a.start - b.start), merged: Piece[] = []
  for (const piece of sorted) {
    const previous = merged[merged.length - 1]
    if (previous && previous.end >= piece.start) previous.end = Math.max(previous.end, piece.end)
    else merged.push({ ...piece })
  }
  const intersects = (from: number, to: number) => {
    let left = 0, right = merged.length
    while (left < right) { const middle = (left + right) >>> 1; if (merged[middle].start < to) left = middle + 1; else right = middle }
    return left > 0 && merged[left - 1].end > from
  }
  if (u32(bte, 0) > merged[0].start || u32(bte, count * 4) < merged[merged.length - 1].end) bad()
  const pages = new Set<number>()
  let totalRuns = 0
  for (let index = 0; index < count; index++) {
    const pageId = u32(bte, (count + 1) * 4 + index * 4)
    if (pages.has(pageId) || u32(bte, index * 4) >= u32(bte, (index + 1) * 4)) bad()
    pages.add(pageId)
    const page = range(word, pageId * 512, 512), runs = page[511]
    totalRuns += runs
    if (!runs || totalRuns > 100000 || (runs + 1) * 4 + runs > 511 || u32(page, 0) !== u32(bte, index * 4) || u32(page, runs * 4) !== u32(bte, (index + 1) * 4)) bad()
    for (let run = 0; run < runs; run++) {
      const from = u32(page, run * 4), to = u32(page, (run + 1) * 4)
      if (from >= to) bad()
      if (!intersects(from, to)) continue
      const at = page[(runs + 1) * 4 + run] * 2
      if (!at) continue
      if (at <= (runs + 1) * 4 + runs || at + 1 + page[at] > 511) bad()
      const properties = range(page, at + 1, page[at])
      for (let p = 0; p < properties.length;) {
        const sprm = u16(properties, p), spra = sprm >>> 13
        if ((sprm >>> 10 & 7) !== 2) unsupported('непідтримуване форматування символів')
        p += 2
        const size = spra === 6 ? (properties[p] ?? bad()) + 1 : [1,1,2,4,2,2,0,3][spra]
        range(properties, p, size)
        if (hiddenSprms.includes(sprm) && properties[p] !== 0) unsupported('прихований текст або невирішені правки')
        if (mediaSprms.includes(sprm) && properties.slice(p, p + size).some(value => value !== 0)) unsupported('формули, поля або вкладені об’єкти')
        p += size
      }
    }
  }
}

export async function extractLegacyQuestionDoc(buffer: ArrayBuffer): Promise<{ text: string; notes: string[] }> {
  const bytes = new Uint8Array(buffer), { entries, libraryBytes } = inspectContainer(bytes)
  const { CFB } = await import('xlsx')
  let parsed: { FileIndex: { name: string; type: number; size: number; content?: Uint8Array }[] }
  try { parsed = CFB.read(libraryBytes, { type: 'array' }) } catch { return bad() }
  const stream = (name: string) => {
    const expected = entries.find(entry => entry.name.toLowerCase() === name.toLowerCase()), found = parsed.FileIndex.find(entry => entry.name.toLowerCase() === name.toLowerCase() && entry.type === 2)
    if (!expected || !found?.content || found.size !== expected.size || found.content.length !== expected.size) return bad()
    return new Uint8Array(found.content)
  }
  const dataEntry = entries.find(entry => entry.name.toLowerCase() === 'data')
  if (dataEntry && stream('Data').some(value => value !== 0)) unsupported('дані вкладених об’єктів або зображень')
  const word = stream('WordDocument')
  if (u16(word, 0) !== 0xa5ec || u16(word, 2) < 0xc1 || u16(word, 2) > 0x112) bad()
  const flags = u16(word, 10)
  if (flags & 0x8100) unsupported('зашифровані або захищені дані')
  if (flags & 0x0008) unsupported('зображення або формули')
  const table = stream(flags & 0x0200 ? '1Table' : '0Table')
  let at = 32
  const csw = u16(word, at); at += 2 + csw * 2
  const cslw = u16(word, at); at += 2
  if (csw !== 14 || cslw !== 22) bad()
  const stories = range(word, at, cslw * 4), documentBytes = u32(stories, 0), characters = u32(stories, 12), headerCharacters = u32(stories, 20)
  if (!characters || characters > MAX_TEXT / 2 || [16,28,32,36,40].some(offset => u32(stories, offset) !== 0)) unsupported('виноски, коментарі, текстові поля або надмірний обсяг тексту')
  at += cslw * 4
  const pairCount = u16(word, at); at += 2
  if (pairCount < 93 || pairCount > 183) bad()
  range(word, at, pairCount * 8)
  if (documentBytes < at + pairCount * 8 || documentBytes > word.length) bad()
  const activeWord = word.subarray(0, documentBytes)
  const pair = (index: number) => ({ fc: u32(word, at + index * 8), length: u32(word, at + index * 8 + 4) })
  const styles = pair(1)
  checkStyleFlags(range(table, styles.fc, styles.length))
  const clx = pair(33), data = range(table, clx.fc, clx.length)
  // Nontrivial piece modifiers/PRCs need a complete Word property resolver.
  if (data[0] !== 2 || u32(data, 1) !== data.length - 5) unsupported('непідтримувані зміни форматування тексту')
  const payload = data.subarray(5), count = (payload.length - 4) / 12
  if (!Number.isInteger(count) || count < 1 || count > 4096 || u32(payload, 0) !== 0) bad()
  const parts: string[] = [], pieces: Piece[] = []
  let decodedCharacters = 0
  for (let index = 0; index < count; index++) {
    const cp = u32(payload, index * 4), next = u32(payload, (index + 1) * 4), pcd = (count + 1) * 4 + index * 8
    if (next <= cp || next > characters + headerCharacters + 1 || u16(payload, pcd + 6) !== 0) unsupported('непідтримувані зміни форматування тексту')
    const rawFc = u32(payload, pcd + 2), compressed = Boolean(rawFc & 0x40000000), start = (rawFc & 0x3fffffff) / (compressed ? 2 : 1)
    if (rawFc & 0x80000000 || !Number.isInteger(start) || !compressed && start % 2) bad()
    range(activeWord, start, (next - cp) * (compressed ? 1 : 2))
    const take = Math.max(0, Math.min(next, characters) - cp)
    if (!take) continue
    decodedCharacters += take
    if (decodedCharacters > characters || decodedCharacters > MAX_TEXT / 2) bad()
    const end = start + take * (compressed ? 1 : 2)
    pieces.push({ start, end, compressed })
    const pieceBytes = range(activeWord, start, end - start)
    parts.push(compressed ? decodeCompressed(pieceBytes) : decode(pieceBytes))
  }
  if (decodedCharacters !== characters) bad()
  const chpx = pair(12)
  checkCharacterFormatting(activeWord, table, chpx.fc, chpx.length, pieces)
  const raw = parts.join('')
  if (/[\u0000-\u0008\u000e-\u001f\u007f]/.test(raw)) unsupported('формули, поля, зображення або спеціальні об’єкти')
  const text = raw.replace(/\r\n?/g, '\n').replace(/[\v\f]/g, '\n')
  if (new TextEncoder().encode(text).length > MAX_TEXT) bad()
  const notes = ['Зі старого DOC прочитано основний текст. Перевірте запитання й усі варіанти: форматування Word не визначає правильні відповіді.']
  if (headerCharacters) notes.push('Службові колонтитули DOC не імпортовано; основний текст запитань збережено повністю.')
  return { text, notes }
}
