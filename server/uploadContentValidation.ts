import { createHash } from 'node:crypto'
import { inflateRawSync, inflateSync } from 'node:zlib'
import { posix } from 'node:path'

/** Conservative structural allowlist. This is not an antivirus or a safety guarantee. */
export const UPLOAD_CONTENT_VALIDATION_VERSION = 1 as const
export const MAX_VALIDATED_UPLOAD_BYTES = 50 * 1024 * 1024
const MAX_EXPANDED = 64 * 1024 * 1024
const MAX_PART = 16 * 1024 * 1024
const MAX_XML = 4 * 1024 * 1024
const MAX_PIXELS = 32_000_000
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value,key)
const MIME: Record<string, string> = {
  pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', txt: 'text/plain', csv: 'text/csv',
}
export class UploadContentValidationError extends Error {
  readonly status = 422
  readonly statusCode = 422
  constructor(readonly code: string, message: string) { super(message); this.name = 'UploadContentValidationError' }
}
function reject(code = 'UPLOAD_CONTENT_INVALID', message = 'Не вдалося перевірити вміст файлу. Збережіть його заново або додайте звичайну PDF-версію.'): never {
  throw new UploadContentValidationError(code, message)
}
function limit(ok: unknown): asserts ok {
  if (!ok) reject('UPLOAD_CONTENT_LIMIT', 'Файл має надто складну або завелику внутрішню структуру. Зменште його або збережіть окремі сторінки у PDF.')
}
function utf8(data: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/^\uFEFF/, '') }
  catch { return reject('UPLOAD_TEXT_ENCODING', 'Текстовий файл має бути збережений у кодуванні UTF-8.') }
}
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
function pixels(width: number, height: number) { limit(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width * height <= MAX_PIXELS) }
function inflate(data: Buffer, raw: boolean, maximum: number): Buffer {
  limit(maximum > 0 && maximum <= MAX_EXPANDED)
  const boundedMaximum = Math.min(maximum,Math.max(1024 * 1024,data.length * 100))
  try {
    const options = { maxOutputLength: boundedMaximum, info: true as const }
    // Node returns the {buffer,engine} envelope when info:true. @types/node's
    // overload inference widens this conditional to Buffer, so state this exact
    // runtime contract locally rather than weakening project compiler settings.
    const result = (raw ? inflateRawSync(data, options) : inflateSync(data, options)) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
    if (result.engine.bytesWritten !== data.length) reject()
    return result.buffer
  } catch (error) { if (error instanceof UploadContentValidationError) throw error; return reject() }
}

function png(bytes: Buffer) {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) reject()
  let at = 8, width = 0, height = 0, bits = 0, color = -1, palette = false, ended = false, dataEnded = false, compressed = 0
  const pieces: Buffer[] = []
  const safe = new Set(['IHDR','PLTE','IDAT','IEND','tRNS','sRGB','gAMA','cHRM','pHYs','sBIT','bKGD','tIME'])
  for (let count = 0; at < bytes.length; count++) {
    limit(count < 4096 && at + 12 <= bytes.length)
    const size = bytes.readUInt32BE(at), type = bytes.toString('ascii', at + 4, at + 8), end = at + 12 + size
    if (end > bytes.length || !/^[A-Za-z]{4}$/.test(type) || !safe.has(type) || crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) reject()
    const part = bytes.subarray(at + 8, end - 4)
    if (count === 0 && type !== 'IHDR' || count > 0 && type === 'IHDR' || ended) reject()
    if (type === 'IHDR') {
      if (size !== 13) reject()
      width = part.readUInt32BE(0); height = part.readUInt32BE(4); pixels(width, height)
      bits = part[8]; color = part[9]
      if (!({0:[1,2,4,8,16],2:[8,16],3:[1,2,4,8],4:[8,16],6:[8,16]} as Record<number, number[]>)[color]?.includes(bits)
        || part[10] !== 0 || part[11] !== 0 || part[12] !== 0) reject('UPLOAD_IMAGE_UNSUPPORTED', 'Збережіть PNG без черезрядкового або анімованого кодування, або експортуйте у JPG.')
    } else if (type === 'PLTE') {
      if (palette || pieces.length || !size || size % 3 || size > 768 || color === 0 || color === 4) reject()
      palette = true
    } else if (type === 'IDAT') {
      if (dataEnded || !size || color === 3 && !palette) reject()
      pieces.push(part); compressed += size
    } else {
      if (pieces.length) dataEnded = true
      if (type === 'IEND') { if (size || !pieces.length) reject(); ended = true }
    }
    at = end
  }
  if (!ended || at !== bytes.length) reject()
  const channels = ({0:1,2:3,3:1,4:2,6:4} as Record<number,number>)[color]
  const row = Math.ceil(width * channels * bits / 8), expected = (row + 1) * height
  limit(expected <= MAX_EXPANDED && compressed <= MAX_VALIDATED_UPLOAD_BYTES)
  const decoded = inflate(Buffer.concat(pieces, compressed), false, expected)
  if (decoded.length !== expected) reject()
  for (let offset = 0; offset < decoded.length; offset += row + 1) if (decoded[offset] > 4) reject()
}
function jpeg(bytes: Buffer) {
  if (bytes.length < 16 || bytes[0] !== 255 || bytes[1] !== 216) reject()
  let at = 2, frame = false, scan = false, ended = false, segments = 0
  let progressive = false
  let progressiveEobRuns = false
  const quantizers = new Set<number>(), huffman = new Set<number>(), componentIds = new Set<number>(), requiredQuantizers = new Set<number>(), requiredHuffman = new Set<number>()
  while (at < bytes.length) {
    limit(++segments < 16384)
    if (bytes[at++] !== 255) reject()
    while (bytes[at] === 255) at++
    const marker = bytes[at++]
    if (marker === 217) { if (!frame || !scan || at !== bytes.length) reject(); ended = true; break }
    if ([0,216,1].includes(marker) || marker >= 208 && marker <= 215 || at + 2 > bytes.length) reject()
    const length = bytes.readUInt16BE(at), end = at + length
    if (length < 2 || end > bytes.length) reject()
    if ([192,193,194].includes(marker)) {
      if (frame || length < 8) reject()
      const components = bytes[at + 7]
      if (bytes[at + 2] !== 8 || ![1,3,4].includes(components) || length !== 8 + components * 3) reject()
      pixels(bytes.readUInt16BE(at + 5), bytes.readUInt16BE(at + 3)); frame = true; progressive = marker === 194
      let blocks = 0
      for (let offset = at + 8; offset < end; offset += 3) {
        const id = bytes[offset], sampling = bytes[offset + 1], horizontal = sampling >>> 4, vertical = sampling & 15, table = bytes[offset + 2]
        if (!horizontal || horizontal > 4 || !vertical || vertical > 4 || table > 3) reject()
        blocks += horizontal * vertical; requiredQuantizers.add(table)
        // Component ids must not be repeated, regardless of scan order.
        if (componentIds.has(id)) reject(); componentIds.add(id)
      }
      limit(blocks <= 10)
    } else if (marker >= 195 && marker <= 207 && ![196,200,204].includes(marker)) reject('UPLOAD_IMAGE_UNSUPPORTED', 'Це кодування JPG не підтримується. Збережіть зображення як звичайний JPG або PNG.')
    if (marker === 219) {
      for (let offset = at + 2; offset < end;) {
        const spec = bytes[offset++], precision = spec >>> 4, id = spec & 15, size = precision ? 128 : 64
        if (precision > 1 || id > 3 || offset + size > end) reject()
        for (let value = offset; value < offset + size; value += precision ? 2 : 1) if (!(precision ? bytes.readUInt16BE(value) : bytes[value])) reject()
        quantizers.add(id); offset += size
      }
    }
    if (marker === 196) {
      for (let offset = at + 2; offset < end;) {
        if (offset + 17 > end) reject()
        const spec = bytes[offset++], kind = spec >>> 4, id = spec & 15
        if (kind > 1 || id > 3) reject()
        let symbols = 0, available = 1
        for (let bit = 0; bit < 16; bit++) { const count = bytes[offset++]; symbols += count; available = available * 2 - count; if (available < 0) reject() }
        if (!symbols || symbols > 256 || offset + symbols > end) reject()
        for (const symbol of bytes.subarray(offset,offset + symbols)) {
          if (kind === 0 ? symbol > 11 : (symbol & 15) > 10) reject()
          // Progressive AC coding uses R/0 symbols for EOB runs (R=1..14).
          // They are invalid for sequential coding. DHT may precede SOF, so
          // defer that distinction until the actual frame type is known.
          if (kind === 1 && !(symbol & 15) && symbol !== 0 && symbol !== 240) progressiveEobRuns = true
        }
        huffman.add(kind * 16 + id); offset += symbols
      }
    }
    if (marker === 218) {
      if (!frame || length < 6 || length !== 6 + 2 * bytes[at + 2]) reject()
      const count = bytes[at + 2], spectral = bytes[at + 3 + count * 2], spectralEnd = bytes[at + 4 + count * 2], approximation = bytes[at + 5 + count * 2]
      if (!count || count > componentIds.size || spectral > spectralEnd || spectralEnd > 63 || approximation >>> 4 > 13 || (approximation & 15) > 13 || !progressive && (spectral || spectralEnd !== 63 || approximation)) reject()
      const seen = new Set<number>()
      for (let offset = at + 3; offset < at + 3 + count * 2; offset += 2) {
        const id = bytes[offset], tables = bytes[offset + 1]
        if (!componentIds.has(id) || seen.has(id) || tables >>> 4 > 3 || (tables & 15) > 3) reject()
        seen.add(id)
        if (!progressive || spectral === 0) requiredHuffman.add(tables >>> 4)
        if (!progressive || spectral > 0) requiredHuffman.add(16 + (tables & 15))
      }
      scan = true; at = end
      while (at < bytes.length) {
        if (bytes[at++] !== 255) continue
        const start = at - 1
        while (bytes[at] === 255) at++
        if (bytes[at] === 0 || bytes[at] >= 208 && bytes[at] <= 215) { at++; continue }
        at = start; break
      }
    } else at = end
  }
  if (!ended || progressiveEobRuns && !progressive || [...requiredQuantizers].some(id=>!quantizers.has(id)) || [...requiredHuffman].some(id=>!huffman.has(id))) reject()
}
function rgbIccProfile(bytes: Buffer) {
  // A small RGB matrix/TRC subset covers ordinary browser sRGB/P3 output.
  // Profiles with opaque extensions or LUTs are not accepted merely
  // because the enclosing WebP calls them ICCP.
  const unsupported = () => reject('UPLOAD_IMAGE_PROFILE_UNSUPPORTED', 'Колірний профіль зображення не підтримується. Збережіть зображення у звичайному sRGB або PNG.')
  if (bytes.length < 132 || bytes.length > 1024 * 1024 || bytes.length % 4 || bytes.readUInt32BE(0) !== bytes.length
    || ![2,4].includes(bytes[8]) || bytes[10] || bytes[11] || !['mntr','scnr'].includes(bytes.toString('ascii',12,16))
    || bytes.toString('ascii',16,20) !== 'RGB ' || bytes.toString('ascii',20,24) !== 'XYZ '
    || bytes.toString('ascii',36,40) !== 'acsp' || bytes.subarray(100,128).some(value=>value !== 0)) unsupported()
  const count = bytes.readUInt32BE(128), tableEnd = 132 + count * 12
  if (!count || count > 64 || tableEnd > bytes.length) unsupported()
  const tags = new Set<string>(), ranges: Array<[number,number]> = []
  const xyzTags = new Set(['rXYZ','gXYZ','bXYZ','wtpt','bkpt','lumi'])
  const fixed = (part: Buffer, start: number, end: number) => { for (let at = start; at < end; at += 4) if (Math.abs(part.readInt32BE(at)) > 32 * 65536) unsupported() }
  for (let n = 0; n < count; n++) {
    const row = 132 + n * 12, name = bytes.toString('ascii',row,row + 4), offset = bytes.readUInt32BE(row + 4), size = bytes.readUInt32BE(row + 8)
    if (tags.has(name) || offset % 4 || offset < tableEnd || size < 8 || offset + size > bytes.length) unsupported()
    tags.add(name)
    if (ranges.some(([start,end])=>offset < end && offset + size > start && (start !== offset || end !== offset + size))) unsupported()
    ranges.push([offset,offset + size])
    const part = bytes.subarray(offset,offset + size), type = part.toString('ascii',0,4)
    if (part.readUInt32BE(4) !== 0) unsupported()
    if (xyzTags.has(name)) { if (type !== 'XYZ ' || size !== 20) unsupported(); fixed(part,8,20) }
    else if (name === 'chad') { if (type !== 'sf32' || size !== 44) unsupported(); fixed(part,8,44) }
    else if (['rTRC','gTRC','bTRC'].includes(name)) {
      if (type === 'para') {
        if (size < 12 || part.readUInt16BE(10) !== 0) unsupported()
        const fn = part.readUInt16BE(8), parameters = [1,3,4,5,7][fn]
        if (!parameters || size !== 12 + parameters * 4 || part.readInt32BE(12) <= 0) unsupported()
        fixed(part,12,size)
        if (fn > 0 && part.readInt32BE(16) <= 0) unsupported()
        if (fn >= 3) {
          const a = part.readInt32BE(16) / 65536, b = part.readInt32BE(20) / 65536, c = part.readInt32BE(24), d = part.readInt32BE(28) / 65536
          if (c < 0 || d < 0 || d > 1 || d < -b / a) unsupported()
        }
      } else if (type === 'curv') {
        if (size < 12) unsupported()
        const entries = part.readUInt32BE(8)
        if (entries > 4096 || size !== 12 + entries * 2) unsupported()
        let previous = 0
        for (let at = 12; at < size; at += 2) { const value = part.readUInt16BE(at); if (value < previous) unsupported(); previous = value }
        if (entries === 1 && previous === 0) unsupported()
      } else unsupported()
    } else if (['desc','cprt','dmnd','dmdd'].includes(name)) {
      if (type === 'mluc') {
        if (size < 16) unsupported()
        const entries = part.readUInt32BE(8), recordSize = part.readUInt32BE(12), textStart = 16 + entries * 12
        if (!entries || entries > 32 || recordSize !== 12 || textStart > size) unsupported()
        for (let at = 16; at < textStart; at += 12) {
          const length = part.readUInt32BE(at + 4), start = part.readUInt32BE(at + 8)
          if (length % 2 || length > 65536 || start % 2 || start < textStart || start + length > size) unsupported()
          try { new TextDecoder('utf-16be',{fatal:true}).decode(part.subarray(start,start + length)) } catch { unsupported() }
        }
      } else if (name === 'cprt' && type === 'text') {
        if (size > 65536 || part[size - 1] !== 0 || /[^\x09\x0a\x0d\x20-\x7e]/.test(part.toString('latin1',8,size - 1))) unsupported()
      } else unsupported()
    } else unsupported()
  }
  if (['rXYZ','gXYZ','bXYZ','wtpt','rTRC','gTRC','bTRC'].some(name=>!tags.has(name))) unsupported()
  let end = tableEnd
  const unique = [...new Map(ranges.map(range=>[range.join(':'),range])).values()].sort((a,b)=>a[0] - b[0])
  for (const [start,finish] of unique) {
    if (start !== end) unsupported()
    end = Math.ceil(finish / 4) * 4
    if (end > bytes.length || bytes.subarray(finish,end).some(value=>value !== 0)) unsupported()
  }
  if (end !== bytes.length) unsupported()
}
function webp(bytes: Buffer) {
  if (bytes.length < 26 || bytes.toString('ascii',0,4) !== 'RIFF' || bytes.toString('ascii',8,12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) reject()
  let at = 12, frame = false, canvas: [number,number] | null = null, extendedFlags = 0, profile = false
  for (let count = 0; at < bytes.length; count++) {
    limit(count < 32 && at + 8 <= bytes.length)
    const type = bytes.toString('ascii',at,at + 4), size = bytes.readUInt32LE(at + 4), end = at + 8 + size
    if (end + (size & 1) > bytes.length || size & 1 && bytes[end] !== 0) reject()
    const part = bytes.subarray(at + 8,end)
    if (type === 'VP8X') {
      if (count || size !== 10 || part[0] & 0xcf || part[1] || part[2] || part[3]) reject()
      extendedFlags = part[0]
      canvas = [part.readUIntLE(4,3) + 1,part.readUIntLE(7,3) + 1]; pixels(...canvas)
    } else if (type === 'ICCP') {
      if (!canvas || frame || profile || !(extendedFlags & 32)) reject()
      rgbIccProfile(part); profile = true
    } else if (type === 'VP8 ' || type === 'VP8L') {
      if (frame) reject()
      let width: number, height: number
      if (type === 'VP8 ') {
        if (size < 11 || part[0] & 1 || !(part[0] & 16) || part.toString('hex',3,6) !== '9d012a') reject()
        const firstPartition = part.readUIntLE(0,3) >>> 5
        if (!firstPartition || firstPartition > size - 10) reject()
        width = part.readUInt16LE(6) & 16383; height = part.readUInt16LE(8) & 16383
      } else {
        if (size < 6 || part[0] !== 47) reject()
        const packed = part.readUInt32LE(1)
        if (packed >>> 29) reject()
        width = (packed & 16383) + 1; height = ((packed >>> 14) & 16383) + 1
      }
      pixels(width,height); if (canvas && (canvas[0] !== width || canvas[1] !== height)) reject(); frame = true
    } else if (type === 'ALPH') { if (!canvas || frame || !size || part[0] & 0xc0) reject() }
    else reject('UPLOAD_IMAGE_UNSUPPORTED', 'Збережіть WebP без анімації та додаткових вкладень або експортуйте зображення у PNG.')
    at = end + (size & 1)
  }
  if (!frame || at !== bytes.length || Boolean(extendedFlags & 32) !== profile) reject()
}

type PdfValue = number | string | boolean | null | PdfValue[] | { [key: string]: PdfValue }
type PdfRef = { ref: number; generation: number }
const blockedPdf = new Set(['JS','JavaScript','Launch','EmbeddedFile','EmbeddedFiles','OpenAction','AA','RichMedia','XFA','GoToR','GoToE','SubmitForm','ImportData','URI','AcroForm','Filespec','Rendition','Movie','Sound','3D','Encrypt','ObjStm','XRef','Prev','XRefStm','Annots','F','FFilter','FDecodeParms','OPI','Ref','Alternates'])
class PdfReader {
  at: number
  tokens = 0
  constructor(readonly text: string, start: number, readonly end: number) { this.at = start }
  space() { while (this.at < this.end) { if (/[\x00\x09\x0a\x0c\x0d\x20]/.test(this.text[this.at])) this.at++; else if (this.text[this.at] === '%') { while (this.at < this.end && !/[\r\n]/.test(this.text[this.at])) this.at++ } else break } }
  word() { this.space(); const found = /^[^\x00\x09\x0a\x0c\x0d\x20()[\]<>{}/%]+/.exec(this.text.slice(this.at,this.end)); if (!found) reject(); this.at += found[0].length; return found[0] }
  value(depth = 0): PdfValue {
    limit(depth < 40 && ++this.tokens <= 100000); this.space()
    const c = this.text[this.at]
    if (this.text.slice(this.at,this.at + 2) === '<<') {
      this.at += 2; const dict: { [key:string]: PdfValue } = Object.create(null)
      for (;;) { this.space(); if (this.text.slice(this.at,this.at + 2) === '>>') { this.at += 2; return dict }
        if (this.text[this.at] !== '/') reject()
        const key = this.value(depth + 1) as string
        if (hasOwn(dict,key)) reject()
        dict[key] = this.value(depth + 1)
      }
    }
    if (c === '[') { this.at++; const array: PdfValue[] = []; for (;;) { this.space(); if (this.text[this.at] === ']') { this.at++; return array }; limit(array.length < 20000); array.push(this.value(depth + 1)) } }
    if (c === '/') {
      this.at++; const start = this.at
      while (this.at < this.end && !/[\x00\x09\x0a\x0c\x0d\x20()[\]<>{}/%]/.test(this.text[this.at])) this.at++
      const rawName = this.text.slice(start,this.at)
      if (/#(?![a-f0-9]{2})/i.test(rawName)) reject()
      const name = rawName.replace(/#([a-f0-9]{2})/gi,(_all,hex)=>String.fromCharCode(parseInt(hex,16)))
      if (!name || /[\x00-\x20\x7f]/.test(name) || blockedPdf.has(name)) reject('UPLOAD_PDF_ACTIVE', 'PDF містить активні дії, вкладення або непідтримуване кодування. Експортуйте звичайний PDF без форм, сценаріїв і вкладених файлів.')
      return name
    }
    if (c === '(') {
      this.at++; let nesting = 1
      while (this.at < this.end && nesting) { const ch = this.text[this.at++]; if (ch === '\\') { if (this.text[this.at] === '\r' && this.text[this.at + 1] === '\n') this.at++; this.at++ } else if (ch === '(') nesting++; else if (ch === ')') nesting--; limit(nesting < 40) }
      if (nesting) reject(); return 'literal-string'
    }
    if (c === '<') { this.at++; const start = this.at; while (this.at < this.end && this.text[this.at] !== '>') this.at++; if (this.at >= this.end || /[^a-f0-9\s]/i.test(this.text.slice(start,this.at))) reject(); this.at++; return 'hex-string' }
    const word = this.word()
    if (word === 'null') return null
    if (word === 'true' || word === 'false') return word === 'true'
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(word)) reject()
    const value = Number(word); if (!Number.isFinite(value)) reject()
    const after = this.at
    if (Number.isSafeInteger(value) && value >= 0) {
      this.space(); const ref = /^(\d+)\s+R(?=[\s()[\]<>{}/%]|$)/.exec(this.text.slice(this.at,this.end))
      if (ref) { this.at += ref[0].length; return { ref:value,generation:Number(ref[1]) } }
      this.at = after
    }
    return value
  }
}
function dict(value: PdfValue): Record<string,PdfValue> { if (!value || typeof value !== 'object' || Array.isArray(value)) reject(); return value }
function ref(value: PdfValue): PdfRef { const row = dict(value); if (!Number.isSafeInteger(row.ref) || !Number.isSafeInteger(row.generation)) reject(); return row as PdfRef }
function pdf(bytes: Buffer) {
  const text = bytes.toString('latin1')
  if (!/^%PDF-1\.[0-7](?:\r\n|\r|\n)/.test(text)) reject()
  const tail = /startxref\s+(\d+)\s+%%EOF[\r\n\x20\t]*$/.exec(text)
  if (!tail) reject()
  const xrefOffset = Number(tail[1]); if (!Number.isSafeInteger(xrefOffset) || text.slice(xrefOffset,xrefOffset + 4) !== 'xref') reject('UPLOAD_PDF_UNSUPPORTED', 'Для перевірки цього PDF потрібен інший формат збереження. Експортуйте PDF без шифрування та стиснених таблиць об’єктів.')
  const reader = new PdfReader(text,xrefOffset + 4,tail.index), locations = new Map<number,{offset:number;generation:number}>()
  for (;;) {
    reader.space(); if (text.slice(reader.at,reader.at + 7) === 'trailer') { reader.at += 7; break }
    const first = Number(reader.word()), count = Number(reader.word()); limit(Number.isSafeInteger(first) && first >= 0 && Number.isSafeInteger(count) && count > 0 && count <= 20000 && locations.size + count <= 20000)
    for (let n = 0; n < count; n++) {
      const offset = reader.word(), generation = reader.word(), status = reader.word()
      if (!/^\d{10}$/.test(offset) || !/^\d{5}$/.test(generation) || !['f','n'].includes(status)) reject()
      if (status === 'n') { if (locations.has(first + n) || Number(offset) >= xrefOffset) reject(); locations.set(first + n,{offset:Number(offset),generation:Number(generation)}) }
    }
  }
  const trailer = dict(reader.value()); reader.space(); if (reader.at !== tail.index || !Number.isSafeInteger(trailer.Size)) reject()
  const root = ref(trailer.Root), objects = new Map<number,PdfValue>(); let previous = /^%PDF-1\.[0-7][^\r\n]*(?:\r\n|\r|\n)/.exec(text)![0].length, expanded = 0
  for (const [id,entry] of [...locations].sort((a,b)=>a[1].offset - b[1].offset)) {
    const gap = new PdfReader(text,previous,entry.offset); gap.space(); if (gap.at !== entry.offset || entry.offset < previous) reject()
    const object = new PdfReader(text,entry.offset,xrefOffset)
    if (object.word() !== String(id) || object.word() !== String(entry.generation) || object.word() !== 'obj') reject()
    const value = object.value(); objects.set(id,value); object.space()
    if (text.slice(object.at,object.at + 6) === 'stream') {
      const details = dict(value), size = details.Length
      if (!Number.isSafeInteger(size) || Number(size) < 0) reject('UPLOAD_PDF_UNSUPPORTED', 'Збережіть PDF заново зі звичайною таблицею об’єктів і без вкладень.')
      object.at += 6
      if (text.slice(object.at,object.at + 2) === '\r\n') object.at += 2
      else if (['\r','\n'].includes(text[object.at])) object.at++
      else reject()
      const end = object.at + Number(size); if (end >= xrefOffset) reject()
      const stream = bytes.subarray(object.at,end)
      if (details.Filter === 'FlateDecode') { const part = inflate(stream,false,Math.min(MAX_PART,MAX_EXPANDED - expanded)); expanded += part.length }
      else if (details.Filter === 'DCTDecode' && details.Subtype === 'Image') jpeg(stream)
      else if (details.Filter !== undefined) reject('UPLOAD_PDF_UNSUPPORTED', 'Це кодування PDF не підтримується для перевірки. Експортуйте звичайний PDF або додайте зображення сторінок.')
      else { expanded += stream.length; limit(stream.length <= MAX_PART && expanded <= MAX_EXPANDED) }
      object.at = end; object.space(); if (object.word() !== 'endstream') reject(); object.space()
    }
    if (object.word() !== 'endobj') reject(); previous = object.at
  }
  const gap = new PdfReader(text,previous,xrefOffset); gap.space(); if (gap.at !== xrefOffset || !objects.size || root.generation !== locations.get(root.ref)?.generation || dict(objects.get(root.ref)!).Type !== 'Catalog') reject()
  const pages = ref(dict(objects.get(root.ref)!).Pages), pageTree = dict(objects.get(pages.ref)!)
  if (pageTree.Type !== 'Pages' || !Number.isInteger(pageTree.Count) || Number(pageTree.Count) < 1 || Number(pageTree.Count) > 10000 || !Array.isArray(pageTree.Kids)) reject()
  if (Number(trailer.Size) <= Math.max(...locations.keys())) reject()
  let references = 0
  const checkReferences = (value: PdfValue, depth = 0): void => {
    limit(depth < 40 && ++references < 200000)
    if (!value || typeof value !== 'object') return
    if (!Array.isArray(value) && Object.keys(value).length === 2 && hasOwn(value,'ref') && hasOwn(value,'generation')) {
      const target = ref(value)
      if (!objects.has(target.ref) || locations.get(target.ref)?.generation !== target.generation) reject()
    } else for (const child of Object.values(value)) checkReferences(child,depth + 1)
  }
  for (const value of objects.values()) checkReferences(value)
  checkReferences(trailer)
  const visited = new Set<number>()
  const countPages = (id: number, depth = 0): number => {
    limit(depth < 40 && visited.size <= 10000); if (visited.has(id)) reject(); visited.add(id)
    const node = dict(objects.get(id)!)
    if (node.Type === 'Page') return 1
    if (node.Type !== 'Pages' || !Array.isArray(node.Kids) || !node.Kids.length) reject()
    const count = node.Kids.reduce<number>((sum,child)=>sum + countPages(ref(child).ref,depth + 1),0)
    if (node.Count !== count) reject(); return count
  }
  countPages(pages.ref)
}

function xmlText(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);)/.test(value)) reject()
  return value.replace(/&([^;\s]{1,20});/g,(_whole,entity)=>{
    const predefined: Record<string,string> = {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}
    if (hasOwn(predefined,entity)) return predefined[entity]
    const match = /^#(?:x([a-f0-9]+)|(\d+))$/i.exec(entity)
    const code = match ? parseInt(match[1] || match[2],match[1] ? 16 : 10) : 0
    if (!code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff || code < 32 && ![9,10,13].includes(code)) reject()
    return String.fromCodePoint(code)
  })
}
type XmlTag = {name:string; attributes:Record<string,string>; closing:boolean; text:string}
function xml(bytes: Buffer): XmlTag[] {
  limit(bytes.length <= MAX_XML)
  const source = utf8(bytes); if (/<!|[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(source)) reject('UPLOAD_OFFICE_ACTIVE', 'Документ містить непідтримувані XML-розширення або вкладення. Експортуйте його у звичайний PDF.')
  const stack: string[] = [], tags: XmlTag[] = []; let at = 0, roots = 0
  while (at < source.length) {
    const opening = source.indexOf('<',at), text = source.slice(at,opening < 0 ? source.length : opening)
    if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);)/i.test(text)) reject()
    if (!stack.length && text.trim()) reject()
    if (opening < 0) { at = source.length; break }
    if (source.startsWith('<?xml ',opening) && !tags.length && !roots) { const end = source.indexOf('?>',opening + 6); if (end < 0) reject(); at = end + 2; continue }
    if (source.startsWith('<?',opening)) reject()
    const found = /^<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)/.exec(source.slice(opening)); if (!found) reject()
    let cursor = opening + found[0].length; const attributes: Record<string,string> = Object.create(null)
    let selfClosing = false
    for (;;) {
      const whitespace = /^\s*/.exec(source.slice(cursor))![0].length; cursor += whitespace
      if (source.startsWith('/>',cursor)) { selfClosing = true; cursor += 2; break }
      if (source[cursor] === '>') { cursor++; break }
      const attribute = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(["'])/.exec(source.slice(cursor)); if (!attribute || !whitespace || found[1]) reject()
      cursor += attribute[0].length; const end = source.indexOf(attribute[2],cursor)
      if (end < 0 || source.slice(cursor,end).includes('<') || hasOwn(attributes,attribute[1])) reject()
      attributes[attribute[1]] = xmlText(source.slice(cursor,end)); cursor = end + 1
    }
    const name = found[2], local = name.split(':').pop()!
    if (!found[1] && stack.some(parent=>/^(?:f|definedName)$/.test(parent.split(':').pop()!))) reject()
    if (/^(?:object|OLEObject|oleObj|altChunk|control|script|externalLink|externalReference|connection|queryTable|instrText|fldSimple|fldChar|hlinkClick|hlinkHover)$/i.test(local)) reject('UPLOAD_OFFICE_ACTIVE', 'Документ містить зовнішні дані, активні поля, об’єкти або вкладення. Приберіть їх чи експортуйте у PDF.')
    if (found[1]) { if (selfClosing || Object.keys(attributes).length || stack.pop() !== name) reject() }
    else { if (!stack.length && ++roots !== 1) reject(); if (!selfClosing) stack.push(name) }
    tags.push({name,attributes,closing:Boolean(found[1]),text:xmlText(text)}); limit(tags.length <= 100000 && stack.length <= 100)
    at = cursor
  }
  if (stack.length || roots !== 1) reject()
  return tags
}
function ooxml(bytes: Buffer, extension: string) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) reject()
  let eocd = -1
  for (let at = bytes.length - 22; at >= Math.max(0,bytes.length - 65557); at--) if (bytes.readUInt32LE(at) === 0x06054b50 && at + 22 + bytes.readUInt16LE(at + 20) === bytes.length) { eocd = at; break }
  if (eocd < 0 || bytes.readUInt16LE(eocd + 4) || bytes.readUInt16LE(eocd + 6) || bytes.readUInt16LE(eocd + 8) !== bytes.readUInt16LE(eocd + 10) || bytes.readUInt16LE(eocd + 20)) reject()
  const count = bytes.readUInt16LE(eocd + 10), cdSize = bytes.readUInt32LE(eocd + 12), cdOffset = bytes.readUInt32LE(eocd + 16)
  limit(count > 0 && count <= 2048 && cdOffset + cdSize === eocd)
  const entries = new Map<string,Buffer>(), folded = new Set<string>(), intervals: Array<[number,number]> = []; let cursor = cdOffset, total = 0
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x02014b50) reject()
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), packed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), start = bytes.readUInt32LE(cursor + 42)
    const end = cursor + 46 + nameLength + extraLength + commentLength
    if (end > eocd || flags & ~0x0808 || ![0,8].includes(method) || bytes.readUInt16LE(cursor + 34) || [packed,size,start].includes(0xffffffff)) reject()
    limit(size <= MAX_PART && total + size <= MAX_EXPANDED && size <= Math.max(1024 * 1024,packed * 100))
    const nameBytes = bytes.subarray(cursor + 46,cursor + 46 + nameLength), name = utf8(nameBytes)
    if (!name || name.includes('\\') || /[\x00-\x1f\x7f:%]/.test(name) || name.startsWith('/') || name.split('/').some(segment=>segment === '.' || segment === '..') || folded.has(name.toLowerCase())) reject()
    folded.add(name.toLowerCase())
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16
    if (mode & 0xf000 && ![0x4000,0x8000].includes(mode & 0xf000)) reject()
    const checkExtra = (from: number, to: number) => { for (let offset = from; offset < to;) { if (offset + 4 > to) reject(); const tag = bytes.readUInt16LE(offset), length = bytes.readUInt16LE(offset + 2); if (![0x5455,0x000a,0x7875].includes(tag) || offset + 4 + length > to) reject(); offset += 4 + length } }
    checkExtra(cursor + 46 + nameLength,end - commentLength)
    if (start + 30 > cdOffset || bytes.readUInt32LE(start) !== 0x04034b50 || bytes.readUInt16LE(start + 6) !== flags || bytes.readUInt16LE(start + 8) !== method) reject()
    const localName = bytes.readUInt16LE(start + 26), localExtra = bytes.readUInt16LE(start + 28), contentStart = start + 30 + localName + localExtra, contentEnd = contentStart + packed
    if (contentEnd > cdOffset || localName !== nameLength || !bytes.subarray(start + 30,start + 30 + localName).equals(nameBytes)) reject()
    checkExtra(start + 30 + localName,contentStart)
    if (!(flags & 8) && (bytes.readUInt32LE(start + 14) !== crc || bytes.readUInt32LE(start + 18) !== packed || bytes.readUInt32LE(start + 22) !== size)) reject()
    let recordEnd = contentEnd
    if (flags & 8) { if (recordEnd + 12 > cdOffset) reject(); if (bytes.readUInt32LE(recordEnd) === 0x08074b50) recordEnd += 4; if (recordEnd + 12 > cdOffset || bytes.readUInt32LE(recordEnd) !== crc || bytes.readUInt32LE(recordEnd + 4) !== packed || bytes.readUInt32LE(recordEnd + 8) !== size) reject(); recordEnd += 12 }
    intervals.push([start,recordEnd]); const packedBytes = bytes.subarray(contentStart,contentEnd)
    const contents = method === 0 ? packedBytes : inflate(packedBytes,true,Math.max(1,size))
    if (contents.length !== size || crc32(contents) !== crc) reject()
    total += size; entries.set(name,contents); cursor = end
  }
  if (cursor !== eocd) reject()
  intervals.sort((a,b)=>a[0] - b[0]); let previous = 0
  for (const [start,end] of intervals) { if (start !== previous) reject(); previous = end }
  if (previous !== cdOffset) reject()
  const main = ({docx:'word/document.xml',xlsx:'xl/workbook.xml',pptx:'ppt/presentation.xml'} as Record<string,string>)[extension]
  const content = entries.get('[Content_Types].xml'), relationships = entries.get('_rels/.rels')
  if (!content || !relationships || !entries.has(main)) reject()
  const types = xml(content)
  if (types[0]?.name !== 'Types' || types[0].attributes.xmlns !== 'http://schemas.openxmlformats.org/package/2006/content-types') reject()
  const expected = ({docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',pptx:'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'} as Record<string,string>)[extension]
  if (!types.some(tag=>tag.name.split(':').pop() === 'Override' && tag.attributes.PartName === '/' + main && tag.attributes.ContentType === expected)) reject()
  const usedExtensions = new Set([...entries.keys()].filter(name=>!name.endsWith('/')).map(name=>name.split('.').pop()!.toLowerCase()))
  let rootRelationship = false
  for (const [name,data] of entries) {
    const lower = name.toLowerCase()
    if (/(?:^|\/)(?:embeddings|activex|externallinks|customui|macrosheets|dialogsheets)(?:\/|$)|vba|\.bin$|\.vml$|\.exe$|\.js$/i.test(name)) reject('UPLOAD_OFFICE_ACTIVE', 'Документ містить макроси, вкладені файли або активні об’єкти. Приберіть їх або експортуйте у PDF.')
    if (name.endsWith('/')) { if (data.length) reject(); continue }
    if (/\.xml$|\.rels$/.test(lower)) {
      const tags = xml(data)
      if (name === main && (tags[0]?.name.split(':').pop() !== ({docx:'document',xlsx:'workbook',pptx:'presentation'} as Record<string,string>)[extension])) reject()
      if (/\.rels$/.test(lower) && (tags[0]?.name !== 'Relationships' || tags[0].attributes.xmlns !== 'http://schemas.openxmlformats.org/package/2006/relationships')) reject()
      if (tags.some(tag=>{
        // SheetJS includes an unused macro-capable Default for .bin even in an
        // ordinary XLSX. A declaration without a matching package part is not
        // active content. Used dangerous MIME types and ALL actual .bin/macro
        // parts still fail; no binary payload is exempted from inspection.
        const defaultExtension = tag.attributes.Extension || ''
        const unusedDefault = name === '[Content_Types].xml' && tag.name.split(':').pop() === 'Default'
          && /^[a-z0-9]{1,12}$/i.test(defaultExtension)
          && !usedExtensions.has(defaultExtension.toLowerCase())
        return Object.entries(tag.attributes).some(([attribute,value])=>/macroenabled|vbaproject|oleobject|activex|ppaction:|javascript:|vbscript:|file:/i.test(value)
          && !(unusedDefault && attribute === 'ContentType' && /macroenabled|vbaproject|oleobject|activex/i.test(value)
            && !/ppaction:|javascript:|vbscript:|file:/i.test(value)))
      })) reject()
      if (/\.rels$/.test(lower)) for (const tag of tags.filter(tag=>!tag.closing && tag.name.split(':').pop() === 'Relationship')) {
        const target = tag.attributes.Target || '', mode = tag.attributes.TargetMode || ''
        if (mode || !target || /[:\\?#\x00-\x20]/.test(target) || /^\/\//.test(target) || /%/.test(target) || /oleObject|attachedTemplate|externalLink|package$/i.test(tag.attributes.Type || '')) reject('UPLOAD_OFFICE_EXTERNAL', 'Документ містить зовнішні зв’язки або вкладені об’єкти. Приберіть їх або збережіть PDF-версію.')
        const base = name === '_rels/.rels' ? '' : posix.dirname(name).replace(/\/_rels$/,'')
        const resolved = posix.normalize(target.startsWith('/') ? target.slice(1) : posix.join(base,target))
        if (resolved.startsWith('../') || !entries.has(resolved)) reject()
        if (name === '_rels/.rels' && /\/officeDocument$/.test(tag.attributes.Type || '') && resolved === main) rootRelationship = true
      }
      if (extension === 'xlsx') {
        const localFunctions = new Set(['SUM','AVERAGE','MIN','MAX','COUNT','COUNTA','COUNTBLANK','IF','IFS','IFERROR','AND','OR','NOT','ROUND','ROUNDUP','ROUNDDOWN','ABS','INT','MOD','SQRT','POWER','PRODUCT','SUMIF','SUMIFS','COUNTIF','COUNTIFS','AVERAGEIF','AVERAGEIFS','MEDIAN','STDEV.P','STDEV.S','VAR.P','VAR.S','VLOOKUP','HLOOKUP','XLOOKUP','INDEX','MATCH','XMATCH','CHOOSE','CONCAT','CONCATENATE','TEXTJOIN','LEFT','RIGHT','MID','LEN','LOWER','UPPER','TRIM','SUBSTITUTE','REPLACE','FIND','SEARCH','TEXT','VALUE','DATE','YEAR','MONTH','DAY','TODAY','NOW','WEEKDAY','WEEKNUM','EDATE','EOMONTH'])
        for (const tag of tags.filter(tag=>tag.closing && /^(?:f|definedName)$/.test(tag.name.split(':').pop()!))) {
          if (/\||\[|https?:|file:/i.test(tag.text) || [...tag.text.matchAll(/([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].some(match=>!localFunctions.has(match[1].toUpperCase().replace(/^_XLFN\./,'')))) reject('UPLOAD_OFFICE_EXTERNAL', 'Таблиця містить зовнішні або непідтримувані формули. Експортуйте значення без формул чи додайте PDF.')
        }
      }
    } else if (/\.png$/.test(lower)) png(data)
    else if (/\.jpe?g$/.test(lower)) jpeg(data)
    else if (/\.webp$/.test(lower)) webp(data)
    else reject('UPLOAD_OFFICE_UNSUPPORTED', 'Документ містить непідтримуваний тип вкладення. Збережіть його як звичайний DOCX, XLSX, PPTX або PDF.')
  }
  if (!rootRelationship) reject()
}
function text(bytes: Buffer, csv: boolean) {
  const value = utf8(bytes)
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) reject('UPLOAD_TEXT_BINARY', 'Цей файл містить двійкові дані. Додайте звичайний текст UTF-8 або PDF.')
  if (/<\s*!DOCTYPE|<\s*\/?\s*(?:html|script|iframe|object|embed|svg|math|link|meta|body|style)(?:\s|\/?>)/i.test(value)) reject('UPLOAD_TEXT_ACTIVE', 'HTML і активний вміст не підтримуються. Збережіть звичайний текст або PDF.')
  if (csv) {
    if (/^\s*sep\s*=/i.test(value)) reject('UPLOAD_CSV_SEPARATOR', 'CSV із директивою sep= не підтримується. Експортуйте звичайний CSV з комою або крапкою з комою, без формул.')
    let cell = '', quoted = false, afterQuote = false, cells = 0
    const finish = () => { limit(++cells <= 500000); if (/^[\s\uFEFF]*[=+@]|^[\s\uFEFF]*-(?!\d+(?:[.,]\d+)?\s*$)/.test(cell)) reject('UPLOAD_CSV_FORMULA', 'CSV містить формули, які можуть виконувати дії у табличному редакторі. Експортуйте значення без формул або додайте PDF.'); cell = ''; afterQuote = false }
    for (let at = 0; at < value.length; at++) {
      const char = value[at]
      if (quoted) { if (char === '"') { if (value[at + 1] === '"') { cell += '"'; at++ } else { quoted = false; afterQuote = true } } else cell += char }
      else if ([',',';','\t','\r','\n'].includes(char)) { finish(); if (char === '\r' && value[at + 1] === '\n') at++ }
      else if (char === '"' && !cell && !afterQuote) quoted = true
      else { if (afterQuote || char === '"') reject(); cell += char }
      limit(cell.length <= 1024 * 1024)
    }
    if (quoted) reject(); finish()
  }
}
export type ValidatedUploadContent = { mime: string; extension: string; validationVersion: 1; size: number; sha256: string }
export async function validateUploadContent(input: Uint8Array, extension: string, declaredMime: string): Promise<ValidatedUploadContent> {
  if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > MAX_VALIDATED_UPLOAD_BYTES) reject('UPLOAD_CONTENT_SIZE', 'Додайте непорожній файл розміром до 50 МБ.')
  const bytes = Buffer.from(input.buffer,input.byteOffset,input.byteLength), ext = typeof extension === 'string' ? extension.replace(/^\./,'').toLowerCase() : ''
  const expected = MIME[ext]
  if (!expected) reject('UPLOAD_FORMAT_UNSUPPORTED', 'Цей формат поки не підтримує перевірку. Для DOC, XLS і PPT збережіть DOCX, XLSX чи PPTX; архіви, аудіо та відео додайте посиланням або підготуйте PDF.')
  const declared = typeof declaredMime === 'string' ? declaredMime.trim().toLowerCase().split(';',1)[0] : ''
  if (declared && declared !== 'application/octet-stream' && declared !== expected && !(ext === 'csv' && ['text/plain','application/vnd.ms-excel','application/csv','text/x-csv'].includes(declared))) reject('UPLOAD_MIME_MISMATCH', 'Тип файлу не відповідає формату. Збережіть його заново у вибраному форматі.')
  try {
    if (ext === 'pdf') pdf(bytes)
    else if (['docx','xlsx','pptx'].includes(ext)) ooxml(bytes,ext)
    else if (ext === 'png') png(bytes)
    else if (ext === 'jpg' || ext === 'jpeg') jpeg(bytes)
    else if (ext === 'webp') webp(bytes)
    else text(bytes,ext === 'csv')
  } catch (error) { if (error instanceof UploadContentValidationError) throw error; reject() }
  return { mime:expected,extension:ext,validationVersion:UPLOAD_CONTENT_VALIDATION_VERSION,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex') }
}
