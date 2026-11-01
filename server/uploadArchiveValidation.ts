import { inflateRawSync } from 'node:zlib'
import { avifDecodedPixelBudget } from './uploadMediaValidation.ts'
import { gifDecodedPixelBudget } from './uploadAdditionalImageValidation.ts'

// Inspect an ordinary ZIP in memory; never extract paths or execute entries.
// Every supported file still needs its own structural content validator.
const MAX_ARCHIVE = 50 * 1024 * 1024, MAX_ENTRY = 16 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024
const MAX_ENTRIES = 2048, MAX_FILES = 50
const FILES = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'webm', 'mov'])
export class UploadArchiveValidationError extends Error {
  readonly status = 422
  readonly statusCode = 422
  constructor(readonly code = 'UPLOAD_ARCHIVE_INVALID', message = 'Архів не пройшов перевірку. Створіть звичайний ZIP лише з підтримуваними документами, зображеннями, аудіо або відео без пароля.') { super(message); this.name = 'UploadArchiveValidationError' }
}
const reject = (): never => { throw new UploadArchiveValidationError() }
function limit(ok: unknown): asserts ok { if (!ok) throw new UploadArchiveValidationError('UPLOAD_ARCHIVE_LIMIT', 'Архів має містити до 50 файлів, до 16 МБ кожен і до 64 МБ сумарного обсягу обробки разом із внутрішнім вмістом документів та зображень, без вкладених архівів.') }
const table = Array.from({ length: 256 }, (_, n) => { let v = n; for (let bit = 0; bit < 8; bit++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; return v >>> 0 })
function crc32(bytes: Buffer) { let v = 0xffffffff; for (const b of bytes) v = table[(v ^ b) & 255] ^ (v >>> 8); return (v ^ 0xffffffff) >>> 0 }
function safeExtra(bytes: Buffer) {
  let at = 0
  while (at < bytes.length) {
    if (at + 4 > bytes.length) reject()
    const kind = bytes.readUInt16LE(at), size = bytes.readUInt16LE(at + 2); at += 4
    if (at + size > bytes.length) reject()
    const value = bytes.subarray(at, at + size)
    // Only timestamp and Unix identity metadata. Alternative Unicode paths,
    // ZIP64, AES and opaque extension records are not accepted implicitly.
    if (kind === 0x5455) { if (!size || value[0] & ~7 || size !== 1 + 4 * [1, 2, 4].filter(bit => value[0] & bit).length) reject() }
    else if (kind === 0x7875) {
      if (size < 5 || value[0] !== 1 || !value[1] || value[1] > 8 || value[1] + 3 > size) reject()
      const groupSize = value[2 + value[1]]; if (!groupSize || groupSize > 8 || size !== 3 + value[1] + groupSize) reject()
    } else reject()
    at += size
  }
}
function filename(bytes: Buffer, flags: number) {
  if (!bytes.length || bytes.length > 512 || !(flags & 0x800) && bytes.some(b => b > 127)) reject()
  let name: string
  try { name = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return reject() }
  if (!Buffer.from(name, 'utf8').equals(bytes)) reject()
  if (/[\\:\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name) || name.startsWith('/') || name.normalize('NFC') !== name) reject()
  const directory = name.endsWith('/'), parts = (directory ? name.slice(0, -1) : name).split('/')
  if (parts.some(p => !p || p.length > 240 || p === '.' || p === '..' || /[. ]$/.test(p) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) reject()
  const extension = directory ? '' : parts[parts.length - 1].match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase() || ''
  if (!directory && !FILES.has(extension)) throw new UploadArchiveValidationError('UPLOAD_ARCHIVE_UNSUPPORTED', 'ZIP містить непідтримуваний або активний формат. Приберіть програми, скрипти, HTML/SVG та вкладені архіви; кожен інший файл також має пройти перевірку вмісту.')
  return { directory, key: parts.join('/').toLowerCase(), extension }
}
type Entry = { name: Buffer; key: string; directory: boolean; extension: string; version: number; flags: number; method: number; checksum: number; packed: number; size: number; start: number; time: number; date: number }
function imageCost(bytes: Buffer, extension: string): number {
  let width = 0, height = 0, channels = 4, bits = 8
  if (extension === 'png') {
    if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) reject()
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); bits = bytes[24]; channels = ({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[bytes[25]]
    if (!channels || ![1,2,4,8,16].includes(bits)) reject()
  } else if (extension === 'jpg' || extension === 'jpeg') {
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) reject()
    let at = 2
    while (at + 4 <= bytes.length) {
      if (bytes[at++] !== 255) reject()
      while (bytes[at] === 255) at++
      const marker = bytes[at++]; if (marker === 218 || marker === 217 || at + 2 > bytes.length) break
      const size = bytes.readUInt16BE(at); if (size < 2 || at + size > bytes.length) reject()
      if (marker >= 192 && marker <= 207 && ![196,200,204].includes(marker)) { if (size < 8) reject(); height = bytes.readUInt16BE(at + 3); width = bytes.readUInt16BE(at + 5); break }
      at += size
    }
  } else if (extension === 'webp') {
    if (bytes.length < 20 || bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) reject()
    for (let at = 12; at + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(at + 4), end = at + 8 + size; if (end > bytes.length) reject()
      const kind = bytes.toString('ascii',at,at+4), part = bytes.subarray(at+8,end)
      if (kind === 'VP8X' && size === 10) { width = part.readUIntLE(4,3)+1; height = part.readUIntLE(7,3)+1; break }
      if (kind === 'VP8 ' && size >= 10) { width = part.readUInt16LE(6)&0x3fff; height = part.readUInt16LE(8)&0x3fff; break }
      at = end + (size & 1)
    }
  } else if (extension === 'avif') {
    let pixels: number; try { pixels = avifDecodedPixelBudget(bytes) } catch { return reject() }
    limit(Number.isSafeInteger(pixels) && pixels > 0 && pixels <= 32_000_000); return pixels * 4
  } else if (extension === 'gif') {
    let pixels: number; try { pixels = gifDecodedPixelBudget(bytes) } catch { return reject() }
    limit(Number.isSafeInteger(pixels) && pixels > 0 && pixels <= MAX_TOTAL); return pixels * 4
  } else return 0
  limit(width > 0 && height > 0 && width * height <= 32_000_000)
  return Math.max((Math.ceil(width * channels * bits / 8) + 1) * height, width * height * 4)
}
function officeCost(bytes: Buffer) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) reject()
  const end = bytes.length - 22
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end+20) || bytes.readUInt16LE(end+4) || bytes.readUInt16LE(end+6)) reject()
  const count = bytes.readUInt16LE(end+10), start = bytes.readUInt32LE(end+16)
  limit(count > 0 && count <= MAX_ENTRIES)
  if (bytes.readUInt16LE(end+8) !== count || start + bytes.readUInt32LE(end+12) !== end) reject()
  let at = start, total = 0
  for (let i = 0; i < count; i++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) reject()
    const size = bytes.readUInt32LE(at+24); limit(size <= MAX_ENTRY); total += size; limit(total <= MAX_TOTAL)
    at += 46 + bytes.readUInt16LE(at+28) + bytes.readUInt16LE(at+30) + bytes.readUInt16LE(at+32)
    if (at > end) reject()
  }
  if (at !== end) reject()
  // The real OOXML validator still checks CRC, paths, structures and exact
  // expansion. This pre-count prevents many individually bounded packages
  // from silently multiplying the enclosing archive's processing budget.
  return total
}
export async function validateArchive(bytes: Buffer, validateEntry: (data: Buffer, extension: string) => Promise<unknown>, reserveEntry?: (size: number) => void): Promise<void> {
  limit(Buffer.isBuffer(bytes) && bytes.length >= 22 && bytes.length <= MAX_ARCHIVE)
  if (typeof validateEntry !== 'function' || reserveEntry !== undefined && typeof reserveEntry !== 'function') reject()
  const end = bytes.length - 22
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) reject()
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryStart = bytes.readUInt32LE(end + 16)
  limit(count > 0 && count <= MAX_ENTRIES)
  if (bytes.readUInt16LE(end + 8) !== count || directoryStart + directorySize !== end) reject()
  const entries: Entry[] = [], keys = new Set<string>(); let cursor = directoryStart, total = 0, files = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) reject()
    const version = bytes.readUInt16LE(cursor + 6), flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), checksum = bytes.readUInt32LE(cursor + 16), packed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24)
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32), disk = bytes.readUInt16LE(cursor + 34), attributes = bytes.readUInt32LE(cursor + 38), start = bytes.readUInt32LE(cursor + 42)
    const next = cursor + 46 + nameSize + extraSize + commentSize
    if (next > end || ![10,20].includes(version) || (method === 8 || flags & 8) && version !== 20 || flags & ~(0x800 | 8 | 6) || ![0, 8].includes(method) || method === 0 && flags & 6 || disk || commentSize) reject()
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameSize), parsed = filename(name, flags), type = (attributes >>> 16) & 0xf000
    if (type && type !== (parsed.directory ? 0x4000 : 0x8000) || !!(attributes & 0x10) && !parsed.directory || keys.has(parsed.key)) reject()
    keys.add(parsed.key); safeExtra(bytes.subarray(cursor + 46 + nameSize, cursor + 46 + nameSize + extraSize))
    if (parsed.directory) { if (size || packed || checksum || method !== 0 || flags & 8) reject() }
    else { limit(++files <= MAX_FILES && size > 0 && size <= MAX_ENTRY && packed > 0); total += size; limit(total <= MAX_TOTAL); if (method === 0 && packed !== size) reject() }
    entries.push({ name, ...parsed, version, flags, method, checksum, packed, size, start, time: bytes.readUInt16LE(cursor + 12), date: bytes.readUInt16LE(cursor + 14) }); cursor = next
  }
  if (cursor !== end || !files) reject()
  for (const entry of entries) {
    const pieces = entry.key.split('/'); pieces.pop()
    while (pieces.length) { const parent = pieces.join('/'); if (entries.some(other => other.key === parent && !other.directory)) reject(); pieces.pop() }
  }
  let localEnd = 0, processing = total, officeFiles = 0
  for (const entry of entries.sort((a, b) => a.start - b.start)) {
    const start = entry.start
    if (start !== localEnd || start + 30 > directoryStart || bytes.readUInt32LE(start) !== 0x04034b50 || bytes.readUInt16LE(start + 4) !== entry.version || bytes.readUInt16LE(start + 6) !== entry.flags || bytes.readUInt16LE(start + 8) !== entry.method || bytes.readUInt16LE(start + 10) !== entry.time || bytes.readUInt16LE(start + 12) !== entry.date) reject()
    const nameSize = bytes.readUInt16LE(start + 26), extraSize = bytes.readUInt16LE(start + 28), dataStart = start + 30 + nameSize + extraSize, dataEnd = dataStart + entry.packed
    if (dataEnd > directoryStart || nameSize !== entry.name.length || !bytes.subarray(start + 30, start + 30 + nameSize).equals(entry.name)) reject()
    safeExtra(bytes.subarray(start + 30 + nameSize, dataStart))
    const localChecksum = bytes.readUInt32LE(start + 14), localPacked = bytes.readUInt32LE(start + 18), localSize = bytes.readUInt32LE(start + 22)
    if (entry.flags & 8) { if (localChecksum && localChecksum !== entry.checksum || localPacked && localPacked !== entry.packed || localSize && localSize !== entry.size) reject() }
    else if (localChecksum !== entry.checksum || localPacked !== entry.packed || localSize !== entry.size) reject()
    localEnd = dataEnd
    if (entry.flags & 8) {
      if (localEnd + 12 > directoryStart) reject()
      if (bytes.readUInt32LE(localEnd) === 0x08074b50) localEnd += 4
      if (localEnd + 12 > directoryStart || bytes.readUInt32LE(localEnd) !== entry.checksum || bytes.readUInt32LE(localEnd + 4) !== entry.packed || bytes.readUInt32LE(localEnd + 8) !== entry.size) reject()
      localEnd += 12
    }
    if (entry.directory) continue
    // The enclosing validator reserves the declared expansion before any
    // allocation, sharing the remaining budget with nested Office/image checks.
    reserveEntry?.(entry.size)
    let contents: Buffer
    if (entry.method === 0) contents = bytes.subarray(dataStart, dataEnd)
    else {
      const maximum = Math.min(MAX_ENTRY, entry.size, Math.max(1024 * 1024, entry.packed * 100))
      try {
        const inflated = inflateRawSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: maximum, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
        if (inflated.engine.bytesWritten !== entry.packed) reject()
        contents = inflated.buffer
      } catch { return reject() }
    }
    if (contents.length !== entry.size || crc32(contents) !== entry.checksum) reject()
    if (['docx','xlsx','pptx'].includes(entry.extension)) { limit(++officeFiles <= 50); processing += officeCost(contents) }
    else processing += imageCost(contents, entry.extension)
    limit(processing <= MAX_TOTAL)
    try { await validateEntry(contents, entry.extension) } catch { throw new UploadArchiveValidationError('UPLOAD_ARCHIVE_ENTRY_INVALID', 'Один із файлів усередині ZIP не пройшов перевірку вмісту. Приберіть його або збережіть заново.') }
  }
  if (localEnd !== directoryStart) reject()
}
