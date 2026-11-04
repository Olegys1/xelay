/** Bounded OOXML inspection. Imported office files stay on this device. */
function fail(message: string): never { throw new Error(message) }
const MAX_ENTRY = 8 * 1024 * 1024, MAX_TOTAL = 24 * 1024 * 1024
function crc32(data: Uint8Array) {
  let crc = 0xffffffff
  for (const value of data) { crc ^= value; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
export async function readQuestionOfficeArchive(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer)
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) fail('Вміст не відповідає DOCX або XLSX. Збережіть документ ще раз у потрібному форматі.')
  let end = -1
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if (view.getUint32(at, true) === 0x06054b50 && at + 22 + view.getUint16(at + 20, true) === bytes.length) { end = at; break }
  }
  if (end < 0 || view.getUint16(end + 4, true) || view.getUint16(end + 6, true)) fail('Пошкоджений або багатотомний документ не підтримується.')
  const count = view.getUint16(end + 10, true), start = view.getUint32(end + 16, true), size = view.getUint32(end + 12, true)
  if (!count || count > 512 || count !== view.getUint16(end + 8, true) || start + size !== end) fail('Документ має забагато частин або непідтримувану структуру. Збережіть потрібні запитання окремо.')
  const extras = (at: number, length: number) => {
    const stop = at + length
    if (stop > bytes.length) fail('Документ пошкоджений.')
    while (at < stop) {
      if (at + 4 > stop || view.getUint16(at, true) === 1) fail('ZIP64 і пошкоджені додаткові поля не підтримуються.')
      at += 4 + view.getUint16(at + 2, true)
      if (at > stop) fail('Документ пошкоджений.')
    }
  }
  const files = new Map<string, Uint8Array>(), ranges: { start: number; end: number }[] = []
  let at = start, total = 0
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) fail('Документ пошкоджений.')
    const flags = view.getUint16(at + 8, true), compression = view.getUint16(at + 10, true), crc = view.getUint32(at + 16, true)
    const compressed = view.getUint32(at + 20, true), expanded = view.getUint32(at + 24, true), offset = view.getUint32(at + 42, true)
    const nameLength = view.getUint16(at + 28, true), extraLength = view.getUint16(at + 30, true)
    const next = at + 46 + nameLength + extraLength + view.getUint16(at + 32, true)
    if (!nameLength || next > end || view.getUint16(at + 34, true) || (flags & 0x2041) || ![0, 8].includes(compression) || expanded > MAX_ENTRY || compressed > bytes.length || expanded > Math.max(1, compressed) * 250 || offset + 30 > start) fail('Документ зашифрований, завеликий або пошкоджений. Збережіть запитання окремим DOCX чи XLSX без пароля.')
    if (view.getUint32(offset, true) !== 0x04034b50 || view.getUint16(offset + 6, true) !== flags || view.getUint16(offset + 8, true) !== compression) fail('Частини документа не збігаються.')
    const localNameLength = view.getUint16(offset + 26, true), localExtraLength = view.getUint16(offset + 28, true)
    const contentStart = offset + 30 + localNameLength + localExtraLength
    if (contentStart + compressed > start || localNameLength !== nameLength) fail('Документ пошкоджений.')
    const nameBytes = bytes.slice(at + 46, at + 46 + nameLength)
    if (nameBytes.some((value, position) => bytes[offset + 30 + position] !== value)) fail('Назви частин документа не збігаються.')
    const name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes)
    if (files.has(name) || name.includes('\\') || name.startsWith('/') || name.split('/').some(part => part === '..') || /(?:vbaProject|macrosheets|activex|embeddings|oleObject|\.exe$|\.js$)/i.test(name)) fail('Документ містить непідтримувані активні або повторювані частини. Збережіть звичайний DOCX чи XLSX без макросів і вкладених об’єктів.')
    extras(at + 46 + nameLength, extraLength); extras(offset + 30 + localNameLength, localExtraLength)
    const localCompressed = view.getUint32(offset + 18, true), localExpanded = view.getUint32(offset + 22, true)
    if (flags & 8 ? localCompressed !== 0 && localCompressed !== compressed || localExpanded !== 0 && localExpanded !== expanded : localCompressed !== compressed || localExpanded !== expanded) fail('Розміри частин документа не збігаються.')
    if (!(flags & 8) && view.getUint32(offset + 14, true) !== crc) fail('Контрольні суми документа не збігаються.')
    if (ranges.some(range => offset < range.end && contentStart + compressed > range.start)) fail('Частини документа перетинаються.')
    ranges.push({ start: offset, end: contentStart + compressed })
    total += expanded
    if (total > MAX_TOTAL) fail('Після розпакування документ завеликий. За один раз імпортуйте до 100 запитань.')
    let content: Uint8Array
    if (compression === 0) {
      if (compressed !== expanded) fail('Розмір частини документа пошкоджений.')
      content = bytes.slice(contentStart, contentStart + compressed)
    } else {
      let decompressor: DecompressionStream
      try { decompressor = new DecompressionStream('deflate-raw') } catch { fail('Цей браузер не підтримує читання DOCX/XLSX. Оновіть браузер або вставте текст чи таблицю через буфер.') }
      const reader = new Blob([bytes.slice(contentStart, contentStart + compressed)]).stream().pipeThrough(decompressor).getReader()
      content = new Uint8Array(expanded)
      let written = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          if (written + chunk.value.byteLength > expanded) fail('Документ перевищує заявлений розмір після розпакування.')
          content.set(chunk.value, written); written += chunk.value.byteLength
        }
        if (written !== expanded) fail('Частину документа обірвано.')
      } finally { await reader.cancel().catch(() => {}) }
    }
    if (crc32(content) !== crc) fail('Контрольна сума документа неправильна. Збережіть файл ще раз.')
    if (/\.(?:xml|rels)$/i.test(name)) {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(content)
      if (/<!DOCTYPE|<!ENTITY/i.test(text) || /\bTargetMode\s*=\s*["']External["']/i.test(text)) fail('Документ містить зовнішні посилання або XML-сутності. Збережіть копію лише з текстом запитань.')
    }
    if (/\.rels$/i.test(name) && /vbaProject|macroEnabled|oleObject|activeX/i.test(new TextDecoder().decode(content))) fail('Документ містить макроси або активні об’єкти. Збережіть звичайну текстову копію DOCX чи XLSX.')
    files.set(name, content); at = next
  }
  if (at !== end || !files.has('[Content_Types].xml')) fail('Це не звичайний документ Office Open XML.')
  const types = new TextDecoder().decode(files.get('[Content_Types].xml'))
  for (const tag of types.split('>')) {
    if (!/vbaProject|macroEnabled|oleObject|activeX/i.test(tag)) continue
    const extension = tag.match(/\bExtension\s*=\s*["']([^"']+)["']/i)?.[1]
    if (/<Override\b/i.test(tag) || extension && [...files.keys()].some(name => name.toLocaleLowerCase().endsWith('.' + extension.toLocaleLowerCase()))) fail('Документ містить макроси або активні об’єкти. Збережіть звичайну текстову копію DOCX чи XLSX.')
  }
  return files
}

/** Rebuild an already bounded stored ZIP, so SheetJS never inflates untrusted bytes. */
export function storedQuestionOfficeArchive(files: Map<string, Uint8Array>): ArrayBuffer {
  const parts = [...files].map(([name, content]) => ({ name: new TextEncoder().encode(name), content, crc: crc32(content) }))
  const localSize = parts.reduce((sum, part) => sum + 30 + part.name.length + part.content.length, 0)
  const centralSize = parts.reduce((sum, part) => sum + 46 + part.name.length, 0)
  const output = new Uint8Array(localSize + centralSize + 22), view = new DataView(output.buffer)
  let local = 0, central = localSize
  for (const part of parts) {
    view.setUint32(local, 0x04034b50, true); view.setUint16(local + 4, 20, true); view.setUint16(local + 6, 0x800, true)
    view.setUint32(local + 14, part.crc, true); view.setUint32(local + 18, part.content.length, true); view.setUint32(local + 22, part.content.length, true); view.setUint16(local + 26, part.name.length, true)
    output.set(part.name, local + 30); output.set(part.content, local + 30 + part.name.length)
    view.setUint32(central, 0x02014b50, true); view.setUint16(central + 4, 20, true); view.setUint16(central + 6, 20, true); view.setUint16(central + 8, 0x800, true)
    view.setUint32(central + 16, part.crc, true); view.setUint32(central + 20, part.content.length, true); view.setUint32(central + 24, part.content.length, true); view.setUint16(central + 28, part.name.length, true); view.setUint32(central + 42, local, true)
    output.set(part.name, central + 46); local += 30 + part.name.length + part.content.length; central += 46 + part.name.length
  }
  view.setUint32(central, 0x06054b50, true); view.setUint16(central + 8, parts.length, true); view.setUint16(central + 10, parts.length, true); view.setUint32(central + 12, centralSize, true); view.setUint32(central + 16, localSize, true)
  return output.buffer
}
