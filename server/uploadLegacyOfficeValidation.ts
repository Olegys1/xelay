/** Bounded, non-executing structural filter for ordinary legacy Office files.
 * MS-CFB: https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb/05060311-bfce-4b12-874d-71fd4ce63aea
 * MS-DOC: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-doc/acb08ace-f268-4879-a998-de592103a70e
 * MS-XLS: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-xls/4d6a3d1e-d7c5-405f-bbae-d01e9cb79366
 * MS-PPT: https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/940d5700-e4d7-4fc0-ab48-fed5dbc48bc1
 * Unsupported dialects, active content and encrypted documents fail closed.
 * This does not render a document, run Office, or replace malware scanning.
 */
export class UploadLegacyOfficeValidationError extends Error {
  readonly status = 422
  readonly statusCode = 422
  constructor(readonly code: string, message: string) { super(message); this.name = 'UploadLegacyOfficeValidationError' }
}
const MAX_BYTES = 50 * 1024 * 1024
const END = 0xfffffffe, FREE = 0xffffffff, FAT = 0xfffffffd, DIFAT = 0xfffffffc
const MAGIC = Buffer.from('d0cf11e0a1b11ae1', 'hex')
function reject(kind = 'INVALID'): never {
  const message = kind === 'ACTIVE' ? 'Файл містить макроси, вкладені об’єкти або активні посилання. Приберіть їх чи збережіть документ як PDF.'
    : kind === 'ENCRYPTED' ? 'Файл захищено паролем. Зніміть шифрування або завантажте звичайну PDF-версію.'
      : 'Цей різновид старого документа Office не вдалося безпечно перевірити. Перезбережіть його у DOCX, XLSX, PPTX або PDF.'
  throw new UploadLegacyOfficeValidationError('UPLOAD_LEGACY_OFFICE_' + kind, message)
}
function check(ok: unknown, kind = 'INVALID'): asserts ok { if (!ok) reject(kind) }
function bounded(offset: number, length: number, total: number) {
  check(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= total && length <= total - offset)
}
function padding(bytes: Buffer) { return bytes.every(byte => byte === 0 || byte === 255) }
function text16(bytes: Buffer): string {
  check(bytes.length % 2 === 0)
  try { return new TextDecoder('utf-16le', { fatal: true }).decode(bytes) } catch { return reject() }
}
interface Entry { index: number; name: string; type: number; left: number; right: number; child: number; start: number; size: number }
interface Compound { streams: Map<string, Buffer>; storages: Entry[] }

/** Validate allocation before copying any user stream. No permissive CFB repair. */
function compound(bytes: Buffer, extension: string): Compound {
  check(bytes.length >= 1536 && bytes.length <= MAX_BYTES && bytes.subarray(0, 8).equals(MAGIC))
  check(bytes.subarray(8, 24).every(byte => byte === 0) && bytes.readUInt16LE(28) === 0xfffe)
  const major = bytes.readUInt16LE(26), shift = bytes.readUInt16LE(30)
  check((major === 3 && shift === 9 || major === 4 && shift === 12) && bytes.readUInt16LE(32) === 6)
  check(bytes.subarray(34, 40).every(byte => byte === 0) && bytes.readUInt32LE(56) === 4096)
  const sectorSize = 2 ** shift, sectorCount = bytes.length / sectorSize - 1
  check(Number.isInteger(sectorCount) && sectorCount >= 2 && sectorCount <= 102400)
  if (major === 4) check(bytes.subarray(512, sectorSize).every(byte => byte === 0))
  const nDirectory = bytes.readUInt32LE(40), nFat = bytes.readUInt32LE(44), firstDirectory = bytes.readUInt32LE(48)
  const firstMiniFat = bytes.readUInt32LE(60), nMiniFat = bytes.readUInt32LE(64), firstDifat = bytes.readUInt32LE(68), nDifat = bytes.readUInt32LE(72)
  check((major !== 3 || nDirectory === 0) && nFat > 0 && nFat <= Math.ceil(sectorCount / (sectorSize / 4)) + 1 && nMiniFat <= sectorCount && nDifat <= sectorCount)
  const claimed = new Set<number>(), fatSectors: number[] = [], difatSectors: number[] = []
  function sector(id: number): Buffer { check(id < sectorCount); return bytes.subarray((id + 1) * sectorSize, (id + 2) * sectorSize) }
  function claim(id: number) { check(id < sectorCount && !claimed.has(id)); claimed.add(id) }
  function fatPointer(id: number) { if (fatSectors.length < nFat) { check(id < sectorCount && !fatSectors.includes(id)); fatSectors.push(id) } else check(id === FREE) }
  for (let i = 0; i < 109; i++) fatPointer(bytes.readUInt32LE(76 + i * 4))
  let next = firstDifat
  for (let i = 0; i < nDifat; i++) {
    claim(next); difatSectors.push(next)
    const b = sector(next)
    for (let at = 0; at < sectorSize - 4; at += 4) fatPointer(b.readUInt32LE(at))
    next = b.readUInt32LE(sectorSize - 4)
  }
  check(next === END && fatSectors.length === nFat)
  const fat = new Uint32Array(nFat * (sectorSize / 4))
  fatSectors.forEach((id, i) => { claim(id); const b = sector(id); for (let j = 0; j < sectorSize / 4; j++) fat[i * sectorSize / 4 + j] = b.readUInt32LE(j * 4) })
  check(fat.length >= sectorCount)
  fatSectors.forEach(id => check(fat[id] === FAT)); difatSectors.forEach(id => check(fat[id] === DIFAT))
  // SheetJS and some legacy writers fill out-of-file FAT slots with EOC.
  // Such slots are never followed: every actual sector is bounded above.
  for (let i = sectorCount; i < fat.length; i++) check(fat[i] === FREE || fat[i] === END)
  function chain(start: number, expected: number | null, maximum = sectorCount): Buffer {
    const pieces: Buffer[] = []
    let at = start
    while (at !== END) {
      check(pieces.length < maximum && (expected === null || pieces.length < expected))
      claim(at); pieces.push(sector(at)); at = fat[at]
    }
    check(expected === null || pieces.length === expected)
    return Buffer.concat(pieces, pieces.length * sectorSize)
  }
  const directory = chain(firstDirectory, major === 4 ? nDirectory : null, 1024)
  check(directory.length > 0 && directory.length / 128 <= 4096, 'LIMIT')
  const entries: Entry[] = []
  for (let at = 0; at < directory.length; at += 128) {
    const type = directory[at + 66], nameLength = directory.readUInt16LE(at + 64)
    if (type === 0) {
      const unused = Buffer.from(directory.subarray(at, at + 128)); unused.fill(0, 68, 80)
      check(unused.every(byte => byte === 0)); entries.push({ index: at / 128, name: '', type, left: FREE, right: FREE, child: FREE, start: END, size: 0 }); continue
    }
    check([1, 2, 5].includes(type) && directory[at + 67] <= 1 && nameLength >= 2 && nameLength <= 64 && nameLength % 2 === 0 && directory.readUInt16LE(at + nameLength - 2) === 0)
    const name = text16(directory.subarray(at, at + nameLength - 2))
    check(name.length > 0 && !/[\\/:!\u0000]/.test(name) && !/[\u0002-\u0004\u0006-\u001f]/.test(name))
    const hi = directory.readUInt32LE(at + 124), low = directory.readUInt32LE(at + 120)
    check(hi === 0 && low <= MAX_BYTES, 'LIMIT')
    entries.push({ index: at / 128, name, type, left: directory.readUInt32LE(at + 68), right: directory.readUInt32LE(at + 72), child: directory.readUInt32LE(at + 76), start: directory.readUInt32LE(at + 116), size: low })
  }
  const root = entries[0]
  check(root?.type === 5 && root.left === FREE && root.right === FREE && root.size % 64 === 0)
  const rootClass = directory.subarray(80, 96).toString('hex')
  const documentClass = ({ doc: '0609020000000000c000000000000046', xls: '2008020000000000c000000000000046', ppt: '108d81649b4fcf1186ea00aa00b929e8' } as Record<string, string>)[extension]
  check(rootClass === '00000000000000000000000000000000' || rootClass === documentClass, 'UNSUPPORTED')
  const visited = new Set<number>([0]), names = new Set<string>(), storages: Entry[] = []
  const compare = (a: string, b: string) => a.length - b.length || (a.toUpperCase() < b.toUpperCase() ? -1 : a.toUpperCase() > b.toUpperCase() ? 1 : 0)
  function visit(index: number, depth: number, minimum?: string, maximum?: string) {
    if (index === FREE) return
    check(depth <= 128 && index > 0 && index < entries.length && !visited.has(index), 'LIMIT')
    visited.add(index); const e = entries[index]
    check(e.type === 1 || e.type === 2)
    check((minimum === undefined || compare(e.name, minimum) > 0) && (maximum === undefined || compare(e.name, maximum) < 0))
    const folded = e.name.toUpperCase(); check(!names.has(folded)); names.add(folded)
    if (e.type === 1) { check(e.name === 'ObjectPool' && e.child === FREE && e.size === 0 && directory.subarray(e.index * 128 + 80, e.index * 128 + 96).every(byte => byte === 0), 'ACTIVE'); storages.push(e) }
    else check(e.child === FREE)
    visit(e.left, depth + 1, minimum, e.name); visit(e.right, depth + 1, e.name, maximum)
  }
  visit(root.child, 0)
  for (const e of entries) check(e.type === 0 || visited.has(e.index))
  const miniFatBytes = nMiniFat ? chain(firstMiniFat, nMiniFat) : Buffer.alloc(0)
  if (!nMiniFat) check(firstMiniFat === END)
  const miniFat = Array.from({ length: miniFatBytes.length / 4 }, (_, i) => miniFatBytes.readUInt32LE(i * 4))
  const miniDataFull = root.size ? chain(root.start, Math.ceil(root.size / sectorSize)) : Buffer.alloc(0)
  if (!root.size) check(root.start === END || root.start === FREE)
  check(padding(miniDataFull.subarray(root.size)))
  const miniData = miniDataFull.subarray(0, root.size), usedMini = new Set<number>(), streams = new Map<string, Buffer>()
  for (const e of entries.filter(value => value.type === 2)) {
    if (/(?:VBA|MACROS|PROJECT|ENCRYPT|OLE10NATIVE|PACKAGE|ACTIVEX|CONTENTS)/i.test(e.name)) reject('ACTIVE')
    if (e.size === 0) { check(e.start === END || e.start === FREE); streams.set(e.name, Buffer.alloc(0)); continue }
    let full: Buffer
    if (e.size >= 4096) full = chain(e.start, Math.ceil(e.size / sectorSize))
    else {
      const pieces: Buffer[] = []; let at = e.start
      for (let i = 0; i < Math.ceil(e.size / 64); i++) {
        check(at < miniFat.length && (at + 1) * 64 <= miniData.length && !usedMini.has(at))
        usedMini.add(at); pieces.push(miniData.subarray(at * 64, (at + 1) * 64)); at = miniFat[at]
      }
      check(at === END); full = Buffer.concat(pieces)
    }
    check(padding(full.subarray(e.size)), 'UNSUPPORTED'); streams.set(e.name, full.subarray(0, e.size))
  }
  for (let i = 0; i < sectorCount; i++) if (!claimed.has(i)) check(fat[i] === FREE && padding(sector(i)), 'UNSUPPORTED')
  for (let i = 0; i < miniData.length / 64; i++) if (!usedMini.has(i)) check((miniFat[i] === FREE || miniFat[i] === undefined) && padding(miniData.subarray(i * 64, (i + 1) * 64)), 'UNSUPPORTED')
  return { streams, storages }
}

function streamsFor(cfb: Compound, required: string[], optional: string[]) {
  const allowed = new Set([...required, ...optional, '\u0005SummaryInformation', '\u0005DocumentSummaryInformation', '\u0001CompObj', '\u0001Sh33tJ5'])
  for (const name of required) check(cfb.streams.has(name) && cfb.streams.get(name)!.length > 0)
  for (const [name, bytes] of cfb.streams) {
    check(allowed.has(name), 'UNSUPPORTED')
    if (name === '\u0001Sh33tJ5') check(bytes.equals(Buffer.from('7262')), 'UNSUPPORTED')
    if (bytes.indexOf(MAGIC) >= 0 || bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70]))) reject('ACTIVE')
    // A genuine PE header is different from ordinary document text saying MZ.
    for (let at = bytes.indexOf('MZ'); at >= 0; at = bytes.indexOf('MZ', at + 2)) {
      if (at + 64 <= bytes.length) {
        const pe = bytes.readUInt32LE(at + 60)
        if (pe >= 64 && pe <= bytes.length - at - 4 && bytes.toString('hex', at + pe, at + pe + 4) === '50450000') reject('ACTIVE')
      }
    }
  }
}

function wordFields(text: string) {
  const stack: string[] = []
  for (const char of text) {
    if (char === '\u0013') { check(stack.length < 32, 'LIMIT'); stack.push('') }
    else if (char === '\u0014' || char === '\u0015') {
      check(stack.length > 0)
      const field = stack[stack.length - 1]
      if (field !== '\u0000') {
        const keyword = field.trim().match(/^[A-Z]+/i)?.[0]?.toUpperCase()
        check(keyword && ['PAGE', 'NUMPAGES', 'DATE', 'TIME', 'REF', 'PAGEREF', 'TOC', 'SEQ', 'SYMBOL', 'HYPERLINK'].includes(keyword), 'ACTIVE')
        if (keyword === 'HYPERLINK') check(/^\s*HYPERLINK\s+(?:"https?:\/\/[^"\s]+"|https?:\/\/[^\s]+|\\l\s+"?[A-Za-z0-9_]+"?)(?:\s|$)/i.test(field), 'ACTIVE')
      }
      if (char === '\u0015') stack.pop(); else stack[stack.length - 1] = '\u0000'
    } else if (stack.length && stack[stack.length - 1] !== '\u0000') {
      stack[stack.length - 1] += char; check(stack[stack.length - 1].length <= 4096, 'LIMIT')
    }
  }
  check(stack.length === 0)
}
function word(cfb: Compound) {
  check(cfb.streams.has('WordDocument'))
  const doc = cfb.streams.get('WordDocument')!
  check(doc.length >= 900 && doc.readUInt16LE(0) === 0xa5ec)
  const flags = doc.readUInt16LE(10), nFib = doc.readUInt16LE(2)
  check([0xc1, 0xd9, 0x101, 0x10c, 0x112].includes(nFib), 'UNSUPPORTED')
  if (flags & 0x8100 || doc.readUInt32LE(14) !== 0) reject('ENCRYPTED')
  check(!(flags & 3) && doc.readUInt16LE(8) === 0, 'UNSUPPORTED')
  const tableName = flags & 0x200 ? '1Table' : '0Table'
  streamsFor(cfb, ['WordDocument', tableName], ['Data'])
  const table = cfb.streams.get(tableName)!
  let at = 32
  const csw = doc.readUInt16LE(at); at += 2; check(csw >= 14 && csw <= 64); bounded(at, csw * 2 + 2, doc.length); at += csw * 2
  const cslw = doc.readUInt16LE(at); at += 2; check(cslw >= 22 && cslw <= 64); bounded(at, cslw * 4 + 2, doc.length)
  const cbMac = doc.readUInt32LE(at), ccpText = doc.readUInt32LE(at + 12)
  const counts = [3, 4, 5, 7, 8, 9, 10].map(i => doc.readUInt32LE(at + i * 4)), total = counts.reduce((sum, value) => sum + value, 0)
  check(ccpText >= 1 && total <= 5_000_000, 'LIMIT'); at += cslw * 4
  const pairs = doc.readUInt16LE(at); at += 2; check(pairs >= 93 && pairs <= 183); bounded(at, pairs * 8 + 2, doc.length)
  const pairsAt = at; at += pairs * 8
  const cswNew = doc.readUInt16LE(at); at += 2; check(cswNew <= 5); bounded(at, cswNew * 2, doc.length); at += cswNew * 2
  check(cbMac >= at && cbMac <= doc.length)
  const pair = (index: number) => { const offset = doc.readUInt32LE(pairsAt + index * 8), length = doc.readUInt32LE(pairsAt + index * 8 + 4); bounded(offset, length, table.length); return table.subarray(offset, offset + length) }
  for (const index of [20, 26, 85]) check(doc.readUInt32LE(pairsAt + index * 8 + 4) === 0, 'ACTIVE')
  const commands = pair(24)
  // Empty Tcg255 is FF followed by the 40 terminator; nonempty commands can
  // carry macro/key/toolbar customizations and are outside this passive subset.
  check(commands.length === 0 || commands.length === 2 && commands[0] === 255 && commands[1] === 0x40, 'ACTIVE')
  check(pair(1).length >= 18 && pair(31).length >= 84)
  const assoc = pair(32); check(assoc.length >= 42 && assoc.readUInt16LE(0) === 0xffff && assoc.readUInt16LE(2) === 18 && assoc.readUInt16LE(4) === 0)
  let pos = 6
  for (let i = 0; i < 18; i++) {
    bounded(pos, 2, assoc.length); const length = assoc.readUInt16LE(pos); pos += 2
    const chars = length === 0xffff ? 0 : length; check(chars <= 255); bounded(pos, chars * 2, assoc.length)
    const text = text16(assoc.subarray(pos, pos + chars * 2)); pos += chars * 2
    if ([1, 8, 9].includes(i)) check(!text || i === 1 && /^normal\.dotm?$/i.test(text), 'ACTIVE')
  }
  check(pos === assoc.length)
  const clx = pair(33); let offset = 0
  while (clx[offset] === 1) { bounded(offset, 3, clx.length); const length = clx.readUInt16LE(offset + 1); bounded(offset + 3, length, clx.length); offset += 3 + length }
  check(clx[offset] === 2); bounded(offset, 5, clx.length)
  const lcb = clx.readUInt32LE(offset + 1); offset += 5
  check(lcb >= 16 && (lcb - 4) % 12 === 0 && offset + lcb === clx.length)
  const count = (lcb - 4) / 12; check(count <= 20000, 'LIMIT')
  const finalCp = clx.readUInt32LE(offset + count * 4)
  check(clx.readUInt32LE(offset) === 0 && finalCp === total + (counts.slice(1).some(Boolean) ? 1 : 0))
  const chunks: string[] = []
  for (let i = 0; i < count; i++) {
    const cp = clx.readUInt32LE(offset + i * 4), end = clx.readUInt32LE(offset + (i + 1) * 4)
    check(cp < end && end <= finalCp)
    const pcd = offset + (count + 1) * 4 + i * 8, fc = clx.readUInt32LE(pcd + 2)
    check(!(fc & 0x80000000)); const compressed = Boolean(fc & 0x40000000), physical = (fc & 0x3fffffff) / (compressed ? 2 : 1)
    check(Number.isInteger(physical) && physical >= at); bounded(physical, (end - cp) * (compressed ? 1 : 2), cbMac)
    const text = doc.subarray(physical, physical + (end - cp) * (compressed ? 1 : 2))
    chunks.push(compressed ? text.toString('latin1') : text16(text))
  }
  const content = chunks.join(''); check(content[ccpText - 1] === '\r'); wordFields(content)
}

interface BiffRecord { type: number; at: number; data: Buffer }
function excel(cfb: Compound) {
  streamsFor(cfb, ['Workbook'], [])
  check(cfb.storages.length === 0, 'ACTIVE')
  const book = cfb.streams.get('Workbook')!, records: BiffRecord[] = [], atRecord = new Map<number, BiffRecord>()
  let at = 0, open = false, substreams = 0, globalsEnded = false, dimensions = false
  const sheets: number[] = []
  while (at < book.length) {
    if (!open && book.subarray(at).every(byte => byte === 0)) break
    check(records.length < 200000, 'LIMIT'); bounded(at, 4, book.length)
    const type = book.readUInt16LE(at), length = book.readUInt16LE(at + 2); check(length <= 8224); bounded(at + 4, length, book.length)
    const data = book.subarray(at + 4, at + 4 + length), record = { type, at, data }; records.push(record); atRecord.set(at, record)
    if (type === 0x809) {
      check(!open && length === 16 && data.readUInt16LE(0) === 0x600)
      const kind = data.readUInt16LE(2)
      if (kind === 0x40 || kind === 6) reject('ACTIVE')
      check(kind === (substreams ? 0x10 : 5), 'UNSUPPORTED'); open = true; substreams++; dimensions = false
    } else { check(open); if (type === 0x0a) { check(length === 0 && (substreams === 1 || dimensions)); open = false; globalsEnded = true } }
    if (type === 0x2f) reject('ENCRYPTED')
    if ([0xd3, 0x5d, 0x1b5, 0x1b8, 0x1be, 0x1b6, 0x1c6, 0x23, 0x223, 0x59, 0xdc, 0x1ad, 0x803, 0x806, 0x807, 0x876, 0x1027].includes(type)) reject('ACTIVE')
    if (type === 0x1ae) check(length === 4 && data.readUInt16LE(2) === 0x0401, 'ACTIVE') // Internal SupBook only.
    if (type === 0x81) check(substreams > 1 && length === 2)
    if (type === 0x200) {
      check(substreams > 1 && length === 14 && data.readUInt32LE(0) <= data.readUInt32LE(4) && data.readUInt32LE(4) <= 65536 && data.readUInt16LE(8) <= data.readUInt16LE(10) && data.readUInt16LE(10) <= 256)
      dimensions = true
    }
    if (type === 0x85) {
      check(!globalsEnded && length >= 8 && data[5] === 0 && data[4] <= 2, 'ACTIVE')
      check(data[6] > 0 && data[6] <= 31 && (data[7] & 0xfe) === 0 && length === 8 + data[6] * (data[7] ? 2 : 1))
      sheets.push(data.readUInt32LE(0)); check(sheets.length <= 256, 'LIMIT')
    }
    if (type === 0x18) {
      check(length >= 14); const flags = data.readUInt16LE(0)
      // Defined names can dispatch XLM or external calls; ordinary numeric
      // worksheets remain supported without attempting to execute a formula.
      check((flags & 0x002e) === 0 && data.readUInt16LE(4) === 0, 'ACTIVE')
    }
    if (type === 6) {
      check(length >= 22); const tokens = data.readUInt16LE(20); bounded(22, tokens, length)
      formula(data.subarray(22, 22 + tokens))
    }
    if (type === 0x4bc || type === 0x221) reject('UNSUPPORTED') // Shared/array formulas need their own token context.
    at += 4 + length
  }
  check(!open && substreams >= 2 && sheets.length === substreams - 1 && new Set(sheets).size === sheets.length)
  sheets.forEach(offset => { const row = atRecord.get(offset); check(row?.type === 0x809 && row.data.readUInt16LE(2) === 0x10) })
}
function formula(tokens: Buffer) {
  let at = 0, depth = 0
  const safeFunctions = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 56, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 82, 97, 98, 99, 100, 101, 102, 109, 111, 112, 115, 117, 118, 119, 120, 124, 125, 126, 127, 128, 129, 130, 140, 141, 142, 143, 144, 148, 149, 162, 163, 164, 169, 183, 184, 189, 190, 197, 212, 213, 214, 215, 216, 219, 220, 221, 222, 227, 228, 229, 244, 269, 279, 285, 286, 287, 288, 298, 299, 300, 303, 304, 305, 318, 319, 320, 321, 325, 326, 327, 328, 329, 330, 336, 337, 342, 344, 345, 346, 347, 350, 351, 352, 353, 354, 358, 359, 360, 361, 362, 363, 364, 365, 366, 367])
  // REGISTER is a native-code macro function. INDIRECT and HYPERLINK require
  // argument-level external-target proof, so they are outside this subset.
  for (const id of [148, 149, 359]) safeFunctions.delete(id)
  // Fixed arities of the allowlisted BIFF functions, matching SheetJS FtabArgc.
  const fixed: Record<number, number> = {2:1,3:1,10:0,15:1,16:1,17:1,18:1,19:0,20:1,21:1,22:1,23:1,24:1,25:1,26:1,27:2,30:2,31:3,32:1,33:1,34:0,35:0,38:1,39:2,63:0,65:3,66:3,67:1,68:1,69:1,70:1,71:1,72:1,73:1,74:0,75:1,76:1,77:1,97:2,98:1,99:1,101:3,102:3,111:1,112:1,117:2,118:1,119:4,126:1,127:1,128:1,129:1,130:1,140:1,141:1,142:3,143:4,144:4,162:1,163:1,164:1,184:1,189:3,190:1,197:1,212:2,213:2,214:1,215:1,229:1,244:1,279:1,285:2,286:4,287:3,288:2,298:1,299:2,300:3,303:2,304:2,305:2,325:2,326:2,327:2,328:2,337:2,342:1,346:2,347:1,350:4,351:3,352:1,353:2,360:1}
  while (at < tokens.length) {
    const raw = tokens[at], type = raw >= 0x20 ? (raw & 0x1f) | 0x20 : raw
    let size = 0
    if (type >= 3 && type <= 0x11) { size = 1; check(depth >= 2); depth-- }
    else if (type >= 0x12 && type <= 0x15) { size = 1; check(depth >= 1) }
    else if (type === 0x16) { size = 1; depth++ }
    else if ([0x1c, 0x1d].includes(type)) { size = 2; depth++ }
    else if (type === 0x1e) { size = 3; depth++ }
    else if (type === 0x1f) { size = 9; depth++ }
    else if (type === 0x24 || type === 0x2c) { size = 5; depth++ }
    else if (type === 0x25 || type === 0x2d) { size = 9; depth++ }
    else if (type === 0x17) { bounded(at, 3, tokens.length); check((tokens[at + 2] & 0xfe) === 0); size = 3 + tokens[at + 1] * (tokens[at + 2] ? 2 : 1); depth++ }
    else if (type === 0x19) { bounded(at, 4, tokens.length); check([0, 1, 0x10, 0x40, 0x41].includes(tokens[at + 1]), 'UNSUPPORTED'); if (tokens[at + 1] === 0x10) check(depth >= 1); size = 4 }
    else if (type === 0x21 || type === 0x22) {
      size = type === 0x21 ? 3 : 4; bounded(at, size, tokens.length)
      const fn = tokens.readUInt16LE(at + (type === 0x21 ? 1 : 2))
      check(safeFunctions.has(fn), 'ACTIVE')
      const args = type === 0x21 ? fixed[fn] : tokens[at + 1]
      check(Number.isInteger(args) && args >= 0 && args <= 127, 'UNSUPPORTED')
      check(depth >= args); depth += 1 - args
    } else reject('UNSUPPORTED')
    bounded(at, size, tokens.length); check(depth <= 256, 'LIMIT'); at += size
  }
  check(depth === 1)
}

interface PptRecord { type: number; at: number; length: number; version: number; instance: number }
function powerpoint(cfb: Compound) {
  streamsFor(cfb, ['PowerPoint Document', 'Current User'], ['Pictures'])
  check(cfb.storages.length === 0, 'ACTIVE')
  const doc = cfb.streams.get('PowerPoint Document')!, user = cfb.streams.get('Current User')!
  check(user.length >= 32 && user.readUInt16LE(0) === 0 && user.readUInt16LE(2) === 0xff6 && user.readUInt32LE(8) === 20)
  check(user.readUInt32LE(12) === 0xe391c05f, 'ENCRYPTED')
  const nameLength = user.readUInt16LE(20), userLength = user.readUInt32LE(4) + 8
  check(nameLength <= 255 && user.readUInt16LE(22) === 0x3f4 && user[24] === 3 && user[25] === 0 && userLength === 32 + nameLength)
  check(user.length === userLength || user.length === userLength + nameLength * 2)
  check([8, 9].includes(user.readUInt32LE(28 + nameLength)))
  const records = new Map<number, PptRecord>(), top = new Set<number>()
  // Known MS-PPT/OfficeArt containers must not masquerade as opaque atoms.
  const containers = new Set([0x3e8,0x3ee,0x3f0,0x3f2,0x3f8,0x3fa,0x3ff,0x402,0x407,0x408,0x409,0x40b,0x40c,0x410,0x411,0x413,0x414,0x7d0,0x7d5,0x7d6,0x7e3,0x7e4,0x7e6,0x7f8,0xfae,0xfb3,0xfb5,0xfc8,0xfc9,0xfcc,0xfce,0xfd7,0xfd9,0xfe4,0xfee,0xff0,0xff2,0x1005,0x1006,0x1007,0x100d,0x100e,0x100f,0x1010,0x1014,0x1388,0x1389,0x138a,0x177d,0x177e,0x2b02,0x2b04,0x2b06,0x2b08,0x2ee0,0x2ee4,0x2eec,0x2eed,0x2ef1,0x2f14,0x36b3,0x3714,0xf000,0xf001,0xf002,0xf003,0xf004,0xf005,0xf125,0xf12a,0xf12b,0xf12c,0xf12d,0xf12e,0xf12f,0xf130,0xf131,0xf132])
  const risky = new Set([0xbc1, 0xfc3, 0xfcc, 0xfcd, 0xfce, 0xfd1, 0xfd3, 0xfd7, 0xfe4, 0xfee, 0xff2, 0xff3, 0xffb, 0x1004, 0x1005, 0x1006, 0x1007, 0x100d, 0x100e, 0x100f, 0x1010, 0x1011, 0x1012, 0x1013, 0x1018, 0x2f14, 0xf132, 0xf13b])
  function walk(start: number, end: number, depth = 0) {
    check(depth <= 64, 'LIMIT')
    for (let at = start; at < end;) {
      check(records.size < 100000, 'LIMIT'); bounded(at, 8, end)
      const packed = doc.readUInt16LE(at), type = doc.readUInt16LE(at + 2), length = doc.readUInt32LE(at + 4)
      bounded(at + 8, length, end)
      const record = { type, at, length, version: packed & 15, instance: packed >>> 4 }; records.set(at, record)
      if (containers.has(type)) check(record.version === 15)
      if (depth === 0) { check([0x3e8, 0x3ee, 0x3f0, 0x3f8, 0xfc9, 0xff5, 0x1772].includes(type), 'UNSUPPORTED'); top.add(at) }
      check(!risky.has(type), 'ACTIVE')
      if (type === 0x400) { check(record.version === 2 && record.instance === 0 && length === 12); check(doc.readUInt32LE(at + 12) === 0, 'ACTIVE') }
      // Binary program tags contain another record sequence despite recVer=0.
      // Traverse it too, so animation command/macro records cannot hide there.
      if (record.version === 15 || type === 0x138b && length) walk(at + 8, at + 8 + length, depth + 1)
      at += 8 + length
    }
  }
  walk(0, doc.length)
  const persist = new Map<number, number>(), seen = new Set<number>()
  let current = user.readUInt32LE(16)
  while (current) {
    check(seen.size < 4096 && !seen.has(current), 'LIMIT'); seen.add(current)
    const edit = records.get(current); check(top.has(current) && edit?.type === 0xff5 && edit.version === 0 && edit.instance === 0 && [28, 32].includes(edit.length))
    check(doc[current + 14] === 0 && doc[current + 15] === 3)
    if (edit.length === 32) check(doc.readUInt32LE(current + 36) === 0, 'ENCRYPTED')
    const previous = doc.readUInt32LE(current + 16), directoryAt = doc.readUInt32LE(current + 20)
    check(previous < current && directoryAt > previous && directoryAt < current && doc.readUInt32LE(current + 24) === 1)
    const directory = records.get(directoryAt); check(top.has(directoryAt) && directory?.type === 0x1772 && directory.version === 0 && directory.instance === 0)
    let at = directoryAt + 8, end = at + directory.length
    while (at < end) {
      bounded(at, 4, end); const packed = doc.readUInt32LE(at), id = packed & 0xfffff, count = packed >>> 20; at += 4
      check(id > 0 && count > 0 && id + count <= 0x100000 && persist.size + count <= 100000, 'LIMIT'); bounded(at, count * 4, end)
      for (let i = 0; i < count; i++) { const offset = doc.readUInt32LE(at + i * 4); check(top.has(offset)); if (!persist.has(id + i)) persist.set(id + i, offset) }
      at += count * 4
    }
    current = previous
  }
  check(seen.size > 0 && records.get(persist.get(1) ?? -1)?.type === 0x3e8)
}

export function validateLegacyOffice(bytes: Buffer, extension: string): void {
  try {
    check(Buffer.isBuffer(bytes) && ['doc', 'xls', 'ppt'].includes(extension))
    const cfb = compound(bytes, extension)
    if (extension === 'doc') word(cfb)
    else if (extension === 'xls') excel(cfb)
    else powerpoint(cfb)
  } catch (error) { if (error instanceof UploadLegacyOfficeValidationError) throw error; reject() }
}
