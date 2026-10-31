import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { extractValidatedDocxText, DOCX_VIEW_LIMITS } from '../../server/assistant-v2/fileViewer.ts'

const crcTable = Array.from({ length: 256 }, (_, n) => { let v = n; for (let bit = 0; bit < 8; bit++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; return v >>> 0 })
const crc32 = bytes => { let v = 0xffffffff; for (const b of bytes) v = crcTable[(v ^ b) & 255] ^ (v >>> 8); return (v ^ 0xffffffff) >>> 0 }
const utf8 = value => Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')

/** Disposable in-memory ordinary OOXML fixtures; never fetch or extract a file. */
function zip(entries, { compress = true } = {}) {
  const localParts = [], centralParts = []
  let offset = 0
  for (const [name, value] of entries) {
    const data = utf8(value), filename = utf8(name), packed = compress ? deflateRawSync(data) : data, method = compress ? 8 : 0, checksum = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(packed.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42)
    localParts.push(local, filename, packed); centralParts.push(central, filename); offset += local.length + filename.length + packed.length
  }
  const central = Buffer.concat(centralParts), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...localParts, central, end])
}
const wordNamespace = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const types = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
const relationships = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
const document = body => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="${wordNamespace}"><w:body>${body}</w:body></w:document>`
const docx = (body, options) => zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', document(body)]], options)
const paragraph = value => `<w:p><w:r><w:t>${value}</w:t></w:r></w:p>`
const rejects = bytes => assert.rejects(() => extractValidatedDocxText(bytes), error => /^DOCX_VIEW_/.test(error.code) && error.status === 422)

test('ordinary compressed DOCX renders Ukrainian paragraphs, inline runs, tabs, breaks and safe entities', async () => {
  const bytes = docx(`<w:p><w:r><w:t>Привіт, </w:t></w:r><w:r><w:t>Марта &amp; Тарас &#x2728;</w:t><w:tab/><w:t>Далі</w:t><w:br/><w:t>Новий рядок</w:t></w:r></w:p>${paragraph('Наступний абзац')}`)
  assert.equal(await extractValidatedDocxText(bytes), 'Привіт, Марта & Тарас ✨\tДалі\nНовий рядок\nНаступний абзац')
})

test('stored ZIP and custom Word namespace prefixes render without interpreting markup as HTML', async () => {
  const xml = `<?xml version="1.0"?><doc:document xmlns:doc="${wordNamespace}"><doc:body><doc:p><doc:r><doc:t>&lt;script&gt; &quot;текст&quot; &apos; &#128578;</doc:t></doc:r></doc:p></doc:body></doc:document>`
  const bytes = zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', xml]], { compress: false })
  assert.equal(await extractValidatedDocxText(bytes), '<script> "текст" \' 🙂')
})

test('tables retain rows and cells, while tracked deletion text is omitted', async () => {
  const table = '<w:tbl><w:tr><w:tc>' + paragraph('Предмет') + '</w:tc><w:tc>' + paragraph('Бал') + '</w:tc></w:tr><w:tr><w:tc>' + paragraph('Математика') + '</w:tc><w:tc>' + paragraph('5') + '</w:tc></w:tr></w:tbl>'
  assert.equal(await extractValidatedDocxText(docx(table + `<w:del>${paragraph('ВИДАЛЕНИЙ ТЕКСТ')}</w:del>` + paragraph('Завершено'))), 'Предмет\tБал\nМатематика\t5\nЗавершено')
})

test('only main document body is extracted; unrelated headers and properties are not included', async () => {
  const header = `<w:hdr xmlns:w="${wordNamespace}">${paragraph('HEADER_NOT_IN_BODY')}</w:hdr>`
  const bytes = zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', document(paragraph('Текст заняття'))], ['word/header1.xml', header]])
  assert.equal(await extractValidatedDocxText(bytes), 'Текст заняття')
})

test('DTD, external entities and entity expansion declarations are rejected', async () => {
  for (const injection of ['<!DOCTYPE w:document SYSTEM "https://example.com/secret">', '<!DOCTYPE w:document [<!ENTITY x SYSTEM "file:///secret">]>', '<!DOCTYPE w:document [<!ENTITY a "A"><!ENTITY b "&a;&a;&a;">]>']) {
    const xml = injection + document(paragraph('&x;'))
    await rejects(zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', xml]]))
  }
})

test('external relationships, active fields, malformed XML and invalid entity characters are rejected', async () => {
  const external = relationships.replace('Target="word/document.xml"', 'Target="https://example.com/file" TargetMode="External"')
  await rejects(zip([['[Content_Types].xml', types], ['_rels/.rels', external], ['word/document.xml', document(paragraph('Ні'))]]))
  for (const body of ['<w:p><w:r><w:instrText>DOCPROPERTY SECRET</w:instrText></w:r></w:p>', '<w:p><w:r><w:t>Текст</w:r></w:t></w:p>', paragraph('&unknown;'), paragraph('&#0;'), paragraph('&#xD800;'), paragraph('&#xFFFF;')]) await rejects(docx(body))
})

test('ZIP corruption, duplicate filenames, path traversal and CRC mismatch are rejected', async () => {
  const basic = docx(paragraph('Текст'))
  await rejects(basic.subarray(0, basic.length - 1))
  const crc = Buffer.from(basic); crc[14] ^= 1; await rejects(crc)
  await rejects(zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', document(paragraph('A'))], ['word/document.xml', document(paragraph('B'))]]))
  await rejects(zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', document(paragraph('A'))], ['../outside.xml', '<x/>']]))
})

test('preflight rejects declared zip bombs before decompression and bounds whole-package expansion', async () => {
  const bytes = docx(paragraph('Текст'))
  const corrupted = Buffer.from(bytes), end = corrupted.length - 22, central = corrupted.readUInt32LE(end + 16)
  corrupted.writeUInt32LE(DOCX_VIEW_LIMITS.expandedBytes + 1, central + 24)
  await assert.rejects(() => extractValidatedDocxText(corrupted), error => error.code === 'DOCX_VIEW_LIMIT')
  const largePart = '<x>' + 'Z'.repeat(1_100_000) + '</x>'
  const packageBytes = zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', document(paragraph('A'))], ['word/extra.xml', largePart]])
  await assert.rejects(() => extractValidatedDocxText(packageBytes), error => error.code === 'DOCX_VIEW_LIMIT')
})

test('text larger than200000characters fails without returning a silently truncated document', async () => {
  const bytes = docx(paragraph('М'.repeat(DOCX_VIEW_LIMITS.textCharacters + 1)), { compress: false })
  await assert.rejects(() => extractValidatedDocxText(bytes), error => error.code === 'DOCX_VIEW_LIMIT')
})

test('wrong Word namespace, missing body and invalid UTF8 are rejected', async () => {
  const wrong = document(paragraph('A')).replace(wordNamespace, 'https://example.com/not-word')
  await rejects(zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', wrong]]))
  await rejects(zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', `<w:document xmlns:w="${wordNamespace}"/>`]]))
  await rejects(zip([['[Content_Types].xml', types], ['_rels/.rels', relationships], ['word/document.xml', Buffer.from([0xff, 0xfe, 0xff])]]))
})
