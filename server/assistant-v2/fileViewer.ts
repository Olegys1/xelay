import { inflateRawSync } from 'node:zlib'
import { validateUploadContent } from '../uploadContentValidation.ts'

export const DOCX_VIEW_LIMITS = Object.freeze({ inputBytes: 8 * 1024 * 1024, expandedBytes: 4 * 1024 * 1024, entries: 512, textCharacters: 200_000, xmlNodes: 100_000, xmlDepth: 100 })
const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const WORD_NAMESPACES = new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])

export class AssistantDocxViewError extends Error {
  readonly status = 422
  readonly code: string
  constructor(code: string, message: string) { super(message); this.name = 'AssistantDocxViewError'; this.code = code }
}
function reject(code = 'DOCX_VIEW_INVALID', message = 'Не вдалося відкрити цей DOCX. Збережіть звичайний документ або додайте PDF-версію.'): never { throw new AssistantDocxViewError(code, message) }
const limit = (condition: unknown): void => { if (!condition) reject('DOCX_VIEW_LIMIT', 'Документ завеликий або має надто складну структуру. Залиште потрібні сторінки або додайте PDF.') }
const decode = (bytes: Buffer) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '') } catch { return reject('DOCX_VIEW_ENCODING', 'Для перегляду потрібен DOCX зі звичайним кодуванням UTF-8. Збережіть документ заново.') } }

const crcTable = Array.from({ length: 256 }, (_, number) => { let value = number; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0 })
function crc32(bytes: Buffer) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0 }
interface MainPart { bytes: Buffer; size: number; method: number; crc: number }

/** Read-only ZIP preflight. No archive entry is ever written to the filesystem. */
function mainPart(bytes: Buffer): MainPart {
  limit(bytes.length >= 22 && bytes.length <= DOCX_VIEW_LIMITS.inputBytes)
  if (bytes.readUInt32LE(0) !== 0x04034b50) reject()
  // The main content validator also rejects comments, ZIP64, multi-disk and
  // directory gaps. Apply the much smaller viewer budget before it inflates.
  const end = bytes.length - 22
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)) reject()
  const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16), size = bytes.readUInt32LE(end + 12)
  limit(count > 0 && count <= DOCX_VIEW_LIMITS.entries)
  if (offset + size !== end || offset >= end || [offset, size].includes(0xffffffff)) reject()
  const names = new Set<string>(), intervals: [number, number][] = []
  let cursor = offset, expanded = 0, result: MainPart | undefined
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) reject()
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), crc = bytes.readUInt32LE(cursor + 16), packed = bytes.readUInt32LE(cursor + 20), unpacked = bytes.readUInt32LE(cursor + 24)
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32), localOffset = bytes.readUInt32LE(cursor + 42)
    const centralEnd = cursor + 46 + nameLength + extraLength + commentLength
    if (centralEnd > end || !nameLength || nameLength > 240 || flags & ~0x0808 || ![0, 8].includes(method) || bytes.readUInt16LE(cursor + 34) || [packed, unpacked, localOffset].includes(0xffffffff)) reject()
    limit(unpacked <= DOCX_VIEW_LIMITS.expandedBytes && expanded + unpacked <= DOCX_VIEW_LIMITS.expandedBytes && unpacked <= Math.max(256 * 1024, packed * 100))
    if (method === 0 && packed !== unpacked) reject()
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength), name = decode(nameBytes), folded = name.toLowerCase()
    if (!name || names.has(folded) || name.startsWith('/') || name.includes('\\') || /[\x00-\x1f\x7f:%]/u.test(name) || name.split('/').some(segment => segment === '.' || segment === '..')) reject()
    names.add(folded)
    if (localOffset + 30 > offset || bytes.readUInt32LE(localOffset) !== 0x04034b50 || bytes.readUInt16LE(localOffset + 6) !== flags || bytes.readUInt16LE(localOffset + 8) !== method) reject()
    const localNameLength = bytes.readUInt16LE(localOffset + 26), localExtraLength = bytes.readUInt16LE(localOffset + 28), contentOffset = localOffset + 30 + localNameLength + localExtraLength, contentEnd = contentOffset + packed
    if (contentEnd > offset || localNameLength !== nameLength || !bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes)) reject()
    if (!(flags & 8) && (bytes.readUInt32LE(localOffset + 14) !== crc || bytes.readUInt32LE(localOffset + 18) !== packed || bytes.readUInt32LE(localOffset + 22) !== unpacked)) reject()
    let recordEnd = contentEnd
    if (flags & 8) {
      if (recordEnd + 12 > offset) reject()
      if (bytes.readUInt32LE(recordEnd) === 0x08074b50) recordEnd += 4
      if (recordEnd + 12 > offset || bytes.readUInt32LE(recordEnd) !== crc || bytes.readUInt32LE(recordEnd + 4) !== packed || bytes.readUInt32LE(recordEnd + 8) !== unpacked) reject()
      recordEnd += 12
    }
    intervals.push([localOffset, recordEnd]); expanded += unpacked
    if (name === 'word/document.xml') result = { bytes: bytes.subarray(contentOffset, contentEnd), size: unpacked, method, crc }
    cursor = centralEnd
  }
  if (cursor !== end || !result) reject()
  intervals.sort((a, b) => a[0] - b[0]); let previous = 0
  for (const [start, finish] of intervals) { if (start !== previous) reject(); previous = finish }
  if (previous !== offset) reject()
  return result
}

function unpack(part: MainPart): Buffer {
  try {
    if (part.method === 0) { if (part.bytes.length !== part.size || crc32(part.bytes) !== part.crc) reject(); return part.bytes }
    const result = inflateRawSync(part.bytes, { maxOutputLength: Math.max(1, part.size), info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
    if (result.engine.bytesWritten !== part.bytes.length || result.buffer.length !== part.size || crc32(result.buffer) !== part.crc) reject()
    return result.buffer
  } catch (error) { if (error instanceof AssistantDocxViewError) throw error; return reject() }
}

function entityText(value: string): string {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/iu.test(value)) reject()
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  return value.replace(/&([^;\s]{1,20});/gu, (_match, entity: string) => {
    if (Object.prototype.hasOwnProperty.call(named, entity)) return named[entity]
    const match = /^#(?:x([0-9a-f]+)|(\d+))$/iu.exec(entity)
    const code = match ? Number.parseInt(match[1] || match[2], match[1] ? 16 : 10) : 0
    if (!code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff || code < 32 && ![9, 10, 13].includes(code) || code === 0xfffe || code === 0xffff) reject()
    return String.fromCodePoint(code)
  })
}
interface Frame { name: string; local: string; word: boolean; namespaces: Record<string, string>; deleted: boolean; inBody: boolean }

/** Plain text only. XML tags and relationships never become HTML or links. */
function documentText(bytes: Buffer): string {
  const xml = decode(bytes).replace(/\r\n?/gu, '\n')
  if (/<!|[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(xml)) reject('DOCX_VIEW_ACTIVE', 'Документ містить непідтримувані XML-вставки. Додайте звичайний DOCX або PDF.')
  const stack: Frame[] = [], pieces: string[] = []
  let cursor = 0, count = 0, characters = 0, roots = 0, bodies = 0
  const append = (value: string) => { if (value) { limit(characters + value.length <= DOCX_VIEW_LIMITS.textCharacters); pieces.push(value); characters += value.length } }
  const trimGeneratedBreaks = (tabs = false) => { while (pieces.length && (pieces[pieces.length - 1] === '\n' || tabs && pieces[pieces.length - 1] === '\t')) characters -= pieces.pop()!.length }
  while (cursor < xml.length) {
    const opening = xml.indexOf('<', cursor), text = xml.slice(cursor, opening < 0 ? xml.length : opening)
    const current = stack[stack.length - 1]
    if (current?.word && current.local === 't' && current.inBody && !current.deleted) append(entityText(text))
    else if (!stack.length && text.trim()) reject()
    if (opening < 0) { cursor = xml.length; break }
    if (xml.startsWith('<?xml ', opening) && !count && !roots) {
      const end = xml.indexOf('?>', opening + 6)
      if (end < 0 || end - opening > 200 || !/^<\?xml\s+version\s*=\s*(['"])1\.0\1(?:\s+encoding\s*=\s*(['"])utf-8\2)?(?:\s+standalone\s*=\s*(['"])(?:yes|no)\3)?\s*\?>$/iu.test(xml.slice(opening, end + 2))) reject('DOCX_VIEW_ENCODING', 'Збережіть DOCX зі звичайним кодуванням UTF-8.')
      cursor = end + 2; count++; continue
    }
    if (xml.startsWith('<?', opening)) reject()
    const tag = /^<(\/?)([A-Za-z_][A-Za-z0-9_.:-]*)/u.exec(xml.slice(opening))
    if (!tag) reject()
    let at = opening + tag[0].length, selfClosing = false
    const attributes: Record<string, string> = Object.create(null)
    for (;;) {
      const whitespace = /^\s*/u.exec(xml.slice(at))![0].length; at += whitespace
      if (xml.startsWith('/>', at)) { selfClosing = true; at += 2; break }
      if (xml[at] === '>') { at++; break }
      const attribute = /^([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(['"])/u.exec(xml.slice(at))
      if (!attribute || !whitespace || tag[1]) reject()
      if (attribute[1].split(':').length > 2 || attribute[1].endsWith(':')) reject()
      at += attribute[0].length; const end = xml.indexOf(attribute[2], at)
      if (end < 0 || end - at > 64 * 1024 || xml.slice(at, end).includes('<') || Object.prototype.hasOwnProperty.call(attributes, attribute[1])) reject()
      attributes[attribute[1]] = entityText(xml.slice(at, end)); at = end + 1
      limit(Object.keys(attributes).length <= 256)
    }
    limit(++count <= DOCX_VIEW_LIMITS.xmlNodes && at - opening <= 128 * 1024)
    const name = tag[2]
    if (name.split(':').length > 2 || name.endsWith(':')) reject()
    if (tag[1]) {
      const frame = stack.pop()
      if (!frame || frame.name !== name || selfClosing || Object.keys(attributes).length) reject()
      if (frame.word && frame.inBody && !frame.deleted) {
        if (frame.local === 'p') append('\n')
        if (frame.local === 'tc') { trimGeneratedBreaks(); append('\t') }
        if (frame.local === 'tr') { trimGeneratedBreaks(true); append('\n') }
      }
    } else {
      const namespaces: Record<string, string> = { ...(current?.namespaces || {}) }
      for (const [key, value] of Object.entries(attributes)) { if (key === 'xmlns') namespaces[''] = value; else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = value }
      const split = name.split(':'), local = split[split.length - 1]!, namespace = namespaces[split.length > 1 ? split[0] : '']
      const word = WORD_NAMESPACES.has(namespace)
      if (!stack.length) { if (++roots !== 1 || !word || local !== 'document') reject() }
      const inBody = current?.inBody || word && local === 'body' && current?.word && current.local === 'document'
      if (word && local === 'body') { if (!inBody || ++bodies !== 1) reject() }
      const deleted = current?.deleted || word && local === 'del'
      const frame: Frame = { name, local, word, namespaces, deleted: !!deleted, inBody: !!inBody }
      if (word && inBody && !deleted && ['tab', 'br', 'cr'].includes(local)) append(local === 'tab' ? '\t' : '\n')
      if (!selfClosing) stack.push(frame)
      limit(stack.length <= DOCX_VIEW_LIMITS.xmlDepth)
    }
    cursor = at
  }
  if (stack.length || roots !== 1 || bodies !== 1) reject()
  return pieces.join('').replace(/[ \t]+\n/gu, '\n').replace(/\n{4,}/gu, '\n\n\n').trim()
}

/** Validate, then render only the main Word document as bounded plain text. */
export async function extractValidatedDocxText(input: Uint8Array): Promise<string> {
  if (!(input instanceof Uint8Array)) reject()
  limit(input.byteLength <= DOCX_VIEW_LIMITS.inputBytes)
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const part = mainPart(bytes)
  try { await validateUploadContent(bytes, 'docx', MIME) }
  catch { return reject('DOCX_VIEW_CONTENT_INVALID', 'Документ не пройшов перевірку вмісту. Приберіть активні об’єкти та зовнішні зв’язки або додайте PDF.') }
  return documentText(unpack(part))
}
