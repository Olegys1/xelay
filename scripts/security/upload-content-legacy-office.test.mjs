import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import vm from 'node:vm'

const root = process.env.XELAY_AUDIT_SOURCE_ROOT || fileURLToPath(new URL('../../', import.meta.url))
const require = createRequire(join(process.env.XELAY_AUDIT_DEPENDENCY_ROOT || root, 'package.json'))
const ts = require('typescript'), XLSX = require('xlsx'), CFB = XLSX.CFB
const source = await readFile(join(root, 'server/uploadLegacyOfficeValidation.ts'), 'utf8')
const module = { exports: {} }
vm.runInNewContext(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }), { module, exports: module.exports, Buffer, TextDecoder }, { timeout: 2000 })
const { validateLegacyOffice: validate, UploadLegacyOfficeValidationError: ValidationError } = module.exports
const denied = (fn, kind) => assert.throws(fn, error => error instanceof ValidationError && error.status === 422 && (!kind || error.code.endsWith(kind)))
const compound = streams => {
  const cfb = CFB.utils.cfb_new({ root: 'Root Entry' })
  for (const [name, data] of Object.entries(streams)) CFB.utils.cfb_add(cfb, name, Buffer.from(data))
  return Buffer.from(CFB.write(cfb, { type: 'buffer' }))
}
const rec = (type, data = Buffer.alloc(0), version = 0, instance = 0) => {
  const header = Buffer.alloc(8); header.writeUInt16LE(version | instance << 4); header.writeUInt16LE(type, 2); header.writeUInt32LE(data.length, 4)
  return Buffer.concat([header, data])
}

// A complete bounded Word97 FIB, associated-string table, document properties
// and CLX piece table, with actual Unicode text and stream offsets. No app runs.
function wordStreams(text = 'Приклад матеріалу для групи.\r', compressed = false) {
  const doc = Buffer.alloc(4096), table = Buffer.alloc(4096)
  doc.writeUInt16LE(0xa5ec); doc.writeUInt16LE(0xc1, 2); doc.writeUInt16LE(0x1200, 10); doc.writeUInt16LE(0xbf, 12)
  doc.writeUInt16LE(14, 32); doc.writeUInt16LE(22, 62)
  const body = Buffer.from(text, compressed ? 'latin1' : 'utf16le'); body.copy(doc, 1024)
  doc.writeUInt32LE(1024 + body.length, 64); doc.writeUInt32LE(text.length, 76)
  doc.writeUInt16LE(93, 152); doc.writeUInt16LE(0, 898)
  const pair = (index, offset, length) => { doc.writeUInt32LE(offset, 154 + index * 8); doc.writeUInt32LE(length, 158 + index * 8) }
  pair(1, 0, 20); table.writeUInt16LE(18, 0)
  pair(31, 64, 500)
  pair(32, 600, 42); table.writeUInt16LE(0xffff, 600); table.writeUInt16LE(18, 602)
  pair(24, 650, 2); table[650] = 255; table[651] = 0x40
  pair(33, 700, 21); table[700] = 2; table.writeUInt32LE(16, 701); table.writeUInt32LE(text.length, 709)
  table.writeUInt32LE(compressed ? 0x40000000 | 2048 : 1024, 715)
  return { WordDocument: doc, '1Table': table }
}

function pptStreams({ extra = Buffer.alloc(0), macro = 0 } = {}) {
  const macroData = Buffer.alloc(12); macroData.writeUInt32LE(macro, 4); macroData.writeUInt32LE(2, 8)
  const document = rec(0x3e8, Buffer.concat([rec(0x3e9, Buffer.alloc(40), 1), rec(0x3ff, rec(0x400, macroData, 2), 15), extra]), 15)
  const slide = rec(0x3ee, rec(0x3ef, Buffer.alloc(24), 2), 15)
  const directoryData = Buffer.alloc(12); directoryData.writeUInt32LE(2 << 20 | 1); directoryData.writeUInt32LE(document.length, 8)
  const directoryAt = document.length + slide.length, directory = rec(0x1772, directoryData), editAt = directoryAt + directory.length
  const editData = Buffer.alloc(28); editData[7] = 3; editData.writeUInt32LE(directoryAt, 12); editData.writeUInt32LE(1, 16); editData.writeUInt32LE(3, 20)
  const main = Buffer.concat([document, slide, directory, rec(0xff5, editData)])
  const userData = Buffer.alloc(29); userData.writeUInt32LE(20); userData.writeUInt32LE(0xe391c05f, 4); userData.writeUInt32LE(editAt, 8)
  userData.writeUInt16LE(5, 12); userData.writeUInt16LE(0x3f4, 14); userData[16] = 3; Buffer.from('Xelay').copy(userData, 20); userData.writeUInt32LE(8, 25)
  return { 'PowerPoint Document': main, 'Current User': rec(0xff6, userData) }
}

const biff = (type, data = Buffer.alloc(0)) => { const h = Buffer.alloc(4); h.writeUInt16LE(type); h.writeUInt16LE(data.length, 2); return Buffer.concat([h, data]) }
const bof = kind => { const b = Buffer.alloc(16); b.writeUInt16LE(0x600); b.writeUInt16LE(kind, 2); return biff(0x809, b) }
function workbookStream({ functionId, macroSheet = false } = {}) {
  const bound = Buffer.alloc(9); bound[5] = macroSheet ? 1 : 0; bound[6] = 1; bound[8] = 83
  const globals = Buffer.concat([bof(5), biff(0x85, bound), biff(0xa)])
  globals.writeUInt32LE(globals.length, 24)
  const dimensions = Buffer.alloc(14); dimensions.writeUInt32LE(2, 4); dimensions.writeUInt16LE(2, 10)
  const number = Buffer.alloc(14); number.writeDoubleLE(2, 6)
  const formula = Buffer.alloc(29); formula.writeUInt16LE(1); formula.writeUInt16LE(7, 20); formula[22] = 0x1e; formula.writeUInt16LE(2, 23); formula[25] = 0x22; formula[26] = 1; formula.writeUInt16LE(functionId ?? 4, 27)
  return Buffer.concat([globals, bof(macroSheet ? 0x40 : 0x10), biff(0x81, Buffer.alloc(2)), biff(0x200, dimensions), biff(0x203, number), ...(functionId == null ? [] : [biff(6, formula)]), biff(0xa)])
}
function sheetJsBook() {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['Предмет', 'Бали'], ['Математика', 10], ['Літерал DDEAUTO, не код', 5]]), 'Журнал')
  return Buffer.from(XLSX.write(book, { type: 'buffer', bookType: 'biff8' }))
}

function versionFourWord() {
  const streams = wordStreams(), out = Buffer.alloc(5 * 4096), header = out.subarray(0, 4096), fat = out.subarray(4096, 8192)
  Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(header); header.writeUInt16LE(0x3e, 24); header.writeUInt16LE(4, 26); header.writeUInt16LE(0xfffe, 28)
  header.writeUInt16LE(12, 30); header.writeUInt16LE(6, 32); header.writeUInt32LE(1, 40); header.writeUInt32LE(1, 44); header.writeUInt32LE(1, 48)
  header.writeUInt32LE(4096, 56); header.writeUInt32LE(0xfffffffe, 60); header.writeUInt32LE(0xfffffffe, 68)
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : 0xffffffff, 76 + i * 4)
  fat.fill(255); fat.writeUInt32LE(0xfffffffd); for (const i of [1, 2, 3]) fat.writeUInt32LE(0xfffffffe, i * 4)
  const directory = out.subarray(8192, 12288)
  function entry(index, name, type, start, size, left = 0xffffffff, child = 0xffffffff) {
    const at = index * 128, n = Buffer.from(name + '\0', 'utf16le'); n.copy(directory, at); directory.writeUInt16LE(n.length, at + 64); directory[at + 66] = type; directory[at + 67] = 1
    directory.writeUInt32LE(left, at + 68); directory.writeUInt32LE(0xffffffff, at + 72); directory.writeUInt32LE(child, at + 76); directory.writeUInt32LE(start, at + 116); directory.writeUInt32LE(size, at + 120)
  }
  entry(0, 'Root Entry', 5, 0xfffffffe, 0, 0xffffffff, 1); entry(1, 'WordDocument', 2, 2, 4096, 2); entry(2, '1Table', 2, 3, 4096)
  streams.WordDocument.copy(out, 12288); streams['1Table'].copy(out, 16384); return out
}

function directoryEntry(bytes, name) {
  const sectorSize = 2 ** bytes.readUInt16LE(30), start = (bytes.readUInt32LE(48) + 1) * sectorSize
  for (let at = start; at < start + sectorSize; at += 128) {
    const length = bytes.readUInt16LE(at + 64)
    if (length >= 2 && bytes.toString('utf16le', at, at + length - 2) === name) return at
  }
  throw Error('Test fixture directory entry missing: ' + name)
}

test('fresh real SheetJS BIFF8 with Unicode text and numeric cells is accepted without executing formulas', () => {
  const bytes = sheetJsBook(); validate(bytes, 'xls')
  const book = XLSX.read(bytes, { type: 'buffer' }); assert.equal(book.Sheets['Журнал'].B2.v, 10)
})
test('Word97 Unicode and compressed text use real bounded FIB/CLX references', () => {
  validate(compound(wordStreams()), 'doc'); validate(compound(wordStreams('Ordinary Word text.\r', true)), 'doc')
})
test('CFB version4 sectors and larger version3 DIFAT chains are bounded and accepted', () => {
  validate(versionFourWord(), 'doc')
  const large = compound({ ...wordStreams(), Data: Buffer.alloc(8 * 1024 * 1024) })
  assert.ok(large.readUInt32LE(72) > 0); validate(large, 'doc')
  const ss = 2 ** large.readUInt16LE(30), difatAt = (large.readUInt32LE(68) + 1) * ss
  large.writeUInt32LE(large.readUInt32LE(68), difatAt + ss - 4); denied(() => validate(large, 'doc'))
})
test('Word page fields and HTTPS hyperlinks are allowed; ordinary security lesson text is not a macro', () => {
  validate(compound(wordStreams('DDEAUTO is a literal. \u0013PAGE\u00141\u0015\r')), 'doc')
  validate(compound(wordStreams('\u0013HYPERLINK "https://example.com/notes"\u0014Матеріал\u0015\r')), 'doc')
})
test('PowerPoint record tree, current user edit and persist directory are validated together', () => validate(compound(pptStreams()), 'ppt'))
test('numeric BIFF worksheet and basic SUM formula pass the passive token allowlist', () => {
  validate(compound({ Workbook: workbookStream() }), 'xls')
  validate(compound({ Workbook: workbookStream({ functionId: 4 }) }), 'xls')
})
test('a matching CFB header alone, renamed formats and truncation never count as a document', () => {
  const fake = Buffer.alloc(1536); Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(fake)
  denied(() => validate(fake, 'doc')); denied(() => validate(sheetJsBook(), 'doc'))
  for (const size of [0, 8, 511, 512, 1024]) denied(() => validate(compound(wordStreams()).subarray(0, size), 'doc'))
})
test('FAT directory cycles, out of range DIFAT and overlapping full streams fail closed', () => {
  const cycle = compound(wordStreams()), ss = 2 ** cycle.readUInt16LE(30), fatAt = (cycle.readUInt32LE(76) + 1) * ss
  const directory = cycle.readUInt32LE(48); cycle.writeUInt32LE(directory, fatAt + directory * 4); denied(() => validate(cycle, 'doc'))
  const difat = compound(wordStreams()); difat.writeUInt32LE(1, 72); difat.writeUInt32LE(0x7fffffff, 68); denied(() => validate(difat, 'doc'))
  const alias = compound(wordStreams()), a = directoryEntry(alias, '1Table'), b = directoryEntry(alias, 'WordDocument')
  alias.writeUInt32LE(alias.readUInt32LE(a + 116), b + 116); denied(() => validate(alias, 'doc'))
})
test('orphan directory streams, non-document root CLSID and oversized stream declarations are refused', () => {
  const orphan = compound(wordStreams()), ss = 2 ** orphan.readUInt16LE(30), root = (orphan.readUInt32LE(48) + 1) * ss
  orphan.writeUInt32LE(0xffffffff, root + 76); denied(() => validate(orphan, 'doc'))
  const clsid = compound(wordStreams()); clsid[root + 80] = 1; denied(() => validate(clsid, 'doc'))
  const huge = compound(wordStreams()); huge.writeUInt32LE(0x7fffffff, directoryEntry(huge, 'WordDocument') + 120); denied(() => validate(huge, 'doc'), 'LIMIT')
})
test('trailing executable polyglots and cross-linked mini streams cannot hide behind valid headers', () => {
  const bytes = compound(wordStreams()), extra = Buffer.alloc(512); extra.write('MZ'); extra.writeUInt32LE(64, 60); extra.write('PE\0\0', 64)
  const polyglot = Buffer.concat([bytes, extra]), ss = 2 ** bytes.readUInt16LE(30), fatAt = (bytes.readUInt32LE(76) + 1) * ss
  polyglot.writeUInt32LE(0xffffffff, fatAt + (bytes.length / ss - 1) * 4); denied(() => validate(polyglot, 'doc'))
  const minis = compound(pptStreams()), user = directoryEntry(minis, 'Current User'), root = (minis.readUInt32LE(48) + 1) * 512
  minis.writeUInt32LE(minis.readUInt32LE(root + 116), user + 116); denied(() => validate(minis, 'ppt'))
  const cycle = compound(pptStreams()), miniStart = cycle.readUInt32LE(directoryEntry(cycle, 'Current User') + 116), miniFatAt = (cycle.readUInt32LE(60) + 1) * 512
  cycle.writeUInt32LE(miniStart, miniFatAt + miniStart * 4); denied(() => validate(cycle, 'ppt'))
})
test('VBA storage, native packages, unknown streams and actual embedded PE files are refused', () => {
  denied(() => validate(compound({ ...wordStreams(), 'VBA/dir': Buffer.from('macro') }), 'doc'), 'ACTIVE')
  denied(() => validate(compound({ ...wordStreams(), '\u0001Ole10Native': Buffer.alloc(80) }), 'doc'), 'ACTIVE')
  denied(() => validate(compound({ ...wordStreams(), Unexpected: Buffer.from('unknown') }), 'doc'), 'UNSUPPORTED')
  const exe = Buffer.alloc(128); exe.write('MZ'); exe.writeUInt32LE(64, 60); exe.write('PE\0\0', 64)
  denied(() => validate(compound({ ...wordStreams(), Data: exe }), 'doc'), 'ACTIVE')
})
test('encrypted Word, wrong table selection and inconsistent piece offsets or counts are rejected', () => {
  let s = wordStreams(); s.WordDocument.writeUInt16LE(0x1300, 10); denied(() => validate(compound(s), 'doc'), 'ENCRYPTED')
  s = wordStreams(); s.WordDocument.writeUInt16LE(0x1000, 10); denied(() => validate(compound(s), 'doc'))
  s = wordStreams(); s['1Table'].writeUInt32LE(2, 715); denied(() => validate(compound(s), 'doc'))
  s = wordStreams(); s['1Table'].writeUInt32LE(0xffffff, 709); denied(() => validate(compound(s), 'doc'))
  s = wordStreams(); s.WordDocument.writeUInt32LE(0xfffffff0, 154 + 33 * 8); denied(() => validate(compound(s), 'doc'))
})
test('Word DDE, include-text and local-file hyperlink fields cannot be disguised as passive text', () => {
  for (const instruction of ['DDEAUTO cmd /c calc', 'INCLUDETEXT "https://example.com/file"', 'HYPERLINK "file:///C:/a.exe"'])
    denied(() => validate(compound(wordStreams('\u0013' + instruction + '\u0014result\u0015\r')), 'doc'), 'ACTIVE')
})
test('Word template and command-table links or inline controls require a safe re-save', () => {
  let s = wordStreams(); s['1Table'][650] = 1; denied(() => validate(compound(s), 'doc'), 'ACTIVE')
  s = wordStreams(); s.WordDocument.writeUInt32LE(8, 158 + 85 * 8); denied(() => validate(compound(s), 'doc'), 'ACTIVE')
  s = wordStreams(); const assoc = Buffer.alloc(44); assoc.writeUInt16LE(0xffff); assoc.writeUInt16LE(18, 2); assoc.writeUInt16LE(1, 8); assoc.write('X', 10, 'utf16le'); assoc.copy(s['1Table'], 600); s.WordDocument.writeUInt32LE(44, 158 + 32 * 8)
  denied(() => validate(compound(s), 'doc'), 'ACTIVE')
})
test('BIFF FilePass encryption, XLM macro sheet and EXEC formula are rejected before any evaluation', () => {
  const wb = workbookStream(); wb.writeUInt16LE(0x2f, 20); denied(() => validate(compound({ Workbook: wb }), 'xls'), 'ENCRYPTED')
  denied(() => validate(compound({ Workbook: workbookStream({ macroSheet: true }) }), 'xls'), 'ACTIVE')
  for (const functionId of [110, 148, 149, 150, 267, 359, 379]) denied(() => validate(compound({ Workbook: workbookStream({ functionId }) }), 'xls'), 'ACTIVE')
})
test('BIFF fake BOF-only book, wrong sheet pointer and truncated records are rejected', () => {
  denied(() => validate(compound({ Workbook: Buffer.concat([bof(5), biff(0xa)]) }), 'xls'))
  const wb = workbookStream(); wb.writeUInt32LE(3, 24); denied(() => validate(compound({ Workbook: wb }), 'xls'))
  denied(() => validate(compound({ Workbook: workbookStream().subarray(0, 45) }), 'xls'))
  const badStack = workbookStream({ functionId: 4 })
  for (let at = 0; at + 4 < badStack.length;) { const type = badStack.readUInt16LE(at), length = badStack.readUInt16LE(at + 2); if (type === 6) badStack[at + 4 + 26] = 2; at += 4 + length }
  denied(() => validate(compound({ Workbook: badStack }), 'xls'))
})
test('PowerPoint encryption, VBA records, OLE records and hidden command records are blocked', () => {
  let s = pptStreams(); s['Current User'].writeUInt32LE(0xf3d1c4df, 12); denied(() => validate(compound(s), 'ppt'), 'ENCRYPTED')
  denied(() => validate(compound(pptStreams({ macro: 1 })), 'ppt'), 'ACTIVE')
  denied(() => validate(compound(pptStreams({ extra: rec(0x1011, Buffer.alloc(4)) })), 'ppt'), 'ACTIVE')
  denied(() => validate(compound(pptStreams({ extra: rec(0x138b, rec(0xf132, Buffer.alloc(0), 15)) })), 'ppt'), 'ACTIVE')
})
test('PowerPoint edit cycles, offset substitution and malformed container lengths are rejected', () => {
  let s = pptStreams(); const at = s['Current User'].readUInt32LE(16); s['PowerPoint Document'].writeUInt32LE(at, at + 16); denied(() => validate(compound(s), 'ppt'))
  s = pptStreams(); s['Current User'].writeUInt32LE(1, 16); denied(() => validate(compound(s), 'ppt'))
  s = pptStreams(); s['PowerPoint Document'].writeUInt32LE(0x7fffffff, 4); denied(() => validate(compound(s), 'ppt'))
})
test('known PowerPoint containers cannot hide active children by claiming atom recVer', () => {
  let s = pptStreams({ macro: 1 }); s['PowerPoint Document'].writeUInt16LE(0, 0); denied(() => validate(compound(s), 'ppt'))
  s = pptStreams({ macro: 1 }); s['PowerPoint Document'].writeUInt16LE(0, 56); denied(() => validate(compound(s), 'ppt'))
  const nested = rec(0x138a, rec(0x138b, rec(0x1011, Buffer.alloc(4))), 0)
  denied(() => validate(compound(pptStreams({ extra: nested })), 'ppt'))
})
