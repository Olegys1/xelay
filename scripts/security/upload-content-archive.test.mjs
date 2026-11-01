// Only fictional inert ZIP bytes; no file extraction, document execution or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as zlib from 'node:zlib'

const module = { exports: {} }, source = readFileSync(new URL('../../server/uploadArchiveValidation.ts', import.meta.url), 'utf8')
const media = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../server/uploadMediaValidation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module:media, exports:media.exports, Buffer })
const additionalImages = { exports: {} }
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../../server/uploadAdditionalImageValidation.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { module:additionalImages, exports:additionalImages.exports, Buffer })
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
  module, exports: module.exports, Buffer, TextDecoder, require(name) { if (name === './uploadMediaValidation.ts') return media.exports; if (name === './uploadAdditionalImageValidation.ts') return additionalImages.exports; assert.equal(name, 'node:zlib'); return zlib }, fetch() { throw Error('Network forbidden') },
})
const { validateArchive, UploadArchiveValidationError } = module.exports
function crc(data) { let v = 0xffffffff; for (const b of data) { v ^= b; for (let i = 0; i < 8; i++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1 } return (v ^ 0xffffffff) >>> 0 }
function zip(files, options = {}) {
  const local = [], central = []; let offset = 0
  for (const entry of files) {
    const name = Buffer.from(entry.name), data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? 'Synthetic notes\n'), method = entry.method ?? (options.deflate && !entry.name.endsWith('/') ? 8 : 0), packed = method === 8 ? zlib.deflateRawSync(data) : data
    const flags = entry.flags ?? 0x800, checksum = crc(data), extra = entry.extra || Buffer.alloc(0), lh = Buffer.alloc(30), ch = Buffer.alloc(46)
    lh.writeUInt32LE(0x04034b50); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8); lh.writeUInt32LE(flags & 8 ? 0 : checksum, 14); lh.writeUInt32LE(flags & 8 ? 0 : packed.length, 18); lh.writeUInt32LE(flags & 8 ? 0 : data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(extra.length, 28)
    const descriptor = flags & 8 ? Buffer.alloc(16) : Buffer.alloc(0)
    if (descriptor.length) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(packed.length, 8); descriptor.writeUInt32LE(data.length, 12) }
    ch.writeUInt32LE(0x02014b50); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(flags, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(checksum, 16); ch.writeUInt32LE(packed.length, 20); ch.writeUInt32LE(entry.claimedSize ?? data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt16LE(extra.length, 30); ch.writeUInt32LE(entry.attributes ?? (entry.name.endsWith('/') ? 0x41ed0010 : 0x81a40000), 38); ch.writeUInt32LE(offset, 42)
    local.push(lh, name, extra, packed, descriptor); central.push(ch, name, extra); offset += lh.length + name.length + extra.length + packed.length + descriptor.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
const denied = (data, callback = async () => {}) => assert.rejects(validateArchive(data, callback), error => error instanceof UploadArchiveValidationError && error.status === 422)
const directoryAt = data => data.readUInt32LE(data.length - 6)
test('enclosing processing budget reserves expansion before decompressing an entry',async()=>{
 const bytes=zip([{name:'note.txt',data:'Ordinary text'}],{deflate:true}),seen=[]
 const stop=new Error('Synthetic exhausted processing budget')
 // The compressed bytes are deliberately damaged. A pre-allocation budget
 // denial must win, without inflating or calling the content validator.
 bytes[30+bytes.readUInt16LE(26)+bytes.readUInt16LE(28)]=0xff
 await assert.rejects(validateArchive(bytes,async()=>seen.push('validate'),size=>{seen.push(size);throw stop}),error=>error===stop)
 assert.deepEqual(seen,[Buffer.byteLength('Ordinary text')])
})

test('ordinary stored/deflated files and Unicode folders are validated individually with exact bytes and normalized extension', async () => {
  for (const deflate of [false, true]) {
    const bytes = zip([{ name: 'Нотатки/', data: '' }, { name: 'Нотатки/Пара.TXT', data: 'Звичайний конспект\n' }, { name: 'table.csv', data: 'Предмет,Бал\nМатематика,5' }], { deflate }), before = Buffer.from(bytes), seen = []
    await validateArchive(bytes, async (data, extension) => { seen.push([data.toString('utf8'), extension]) })
    assert.deepEqual(seen, [['Звичайний конспект\n', 'txt'], ['Предмет,Бал\nМатематика,5', 'csv']]); assert.deepEqual(bytes, before)
  }
})
test('data descriptors and harmless timestamps are accepted with local/central agreement', async () => {
  const extra = Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0]), seen = []
  await validateArchive(zip([{ name: 'notes.txt', flags: 0x808, extra }], { deflate: true }), async (_, extension) => seen.push(extension)); assert.deepEqual(seen, ['txt'])
})
test('legacy Office and media are delegated to their content validators, never accepted on extension alone', async () => {
  for (const extension of ['doc', 'xls', 'ppt', 'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'webm', 'mov', 'docx']) {
    let calls = 0
    const data = extension === 'docx' ? zip([{name:'word/document.xml',data:'Synthetic content; child validator must still reject'}]) : Buffer.from('Synthetic notes\n')
    await denied(zip([{ name: 'fixture.' + extension, data }]), async (bytes, actual) => { calls++; assert.equal(actual, extension); assert.deepEqual(bytes,data); throw Error('Fictional content mismatch') })
    assert.equal(calls, 1)
  }
})
test('unknown, active and nested archive formats fail before delegation', async () => {
  for (const name of ['run.exe', 'script.js', 'page.html', 'image.svg', 'setup.msi', 'nested.zip', 'nested.rar', 'data.7z', 'without-extension']) {
    let calls = 0; await denied(zip([{ name }]), async () => { calls++ }); assert.equal(calls, 0, name)
  }
})
test('traversal, absolute/Windows paths, special names, control marks and noncanonical paths fail closed', async () => {
  for (const name of ['../notes.txt', '/notes.txt', 'C:/notes.txt', 'a\\notes.txt', 'a/../notes.txt', 'a//notes.txt', 'CON.txt', 'notes.txt ', 'a./notes.txt', 'a\0.txt', 'a\u202e.txt', 'e\u0301.txt']) await denied(zip([{ name }]))
})
test('duplicate case-insensitive names, file/directory collisions and symbolic/device entries are rejected', async () => {
  await denied(zip([{ name: 'Notes.txt' }, { name: 'notes.TXT' }]))
  await denied(zip([{ name: 'parent.txt' }, { name: 'parent.txt/child.txt' }]))
  for (const attributes of [0xa1ff0000, 0x61a40000, 0x21a40000, 0x41ed0000]) await denied(zip([{ name: 'notes.txt', attributes }]))
})
test('encryption, unsupported compression, split disks, ZIP64 and alternative-path extra fields are refused', async () => {
  await denied(zip([{ name: 'notes.txt', flags: 0x801 }])); await denied(zip([{ name: 'notes.txt', method: 99 }]))
  for (const extra of [Buffer.from([1, 0, 0, 0]), Buffer.from([0x75, 0x70, 0, 0]), Buffer.from([0x55, 0x54, 5, 0, 7, 0, 0, 0, 0])]) await denied(zip([{ name: 'notes.txt', extra }]))
  const split = zip([{ name: 'notes.txt' }]); split.writeUInt16LE(1, split.length - 18); await denied(split)
})
test('CRC, packed size, local header/name and directory-offset mismatches are rejected', async () => {
  const original = zip([{ name: 'notes.txt', data: 'An ordinary string' }]), cd = directoryAt(original)
  for (const mutate of [b => b[30 + 'notes.txt'.length] ^= 1, b => b.writeUInt32LE(1, cd + 16), b => b.writeUInt32LE(1, cd + 20), b => b[30] ^= 1, b => b.writeUInt32LE(1, cd + 42), b => b.writeUInt16LE(8, 8)]) { const copy = Buffer.from(original); mutate(copy); await denied(copy) }
})
test('prefixes, trailing polyglots, comments, truncation and unreferenced gaps are rejected', async () => {
  const data = zip([{ name: 'notes.txt' }]); for (const changed of [Buffer.concat([Buffer.from('MZ'), data]), Buffer.concat([data, Buffer.from('tail')]), data.subarray(0, -1), data.subarray(1)]) await denied(changed)
  const comment = Buffer.concat([data, Buffer.from('note')]); comment.writeUInt16LE(4, data.length - 2); await denied(comment)
  const gap = Buffer.concat([data.subarray(0, directoryAt(data)), Buffer.from([0]), data.subarray(directoryAt(data))]); gap.writeUInt32LE(directoryAt(data) + 1, gap.length - 6); await denied(gap)
})
test('per-file, total-size and entry-count claims are bounded before decompression or callbacks', async () => {
  for (const data of [zip([{ name: 'large.txt', claimedSize: 16 * 1024 * 1024 + 1 }]), zip(Array.from({ length: 5 }, (_, i) => ({ name: i + '.txt', claimedSize: 16 * 1024 * 1024 }))), zip(Array.from({ length: 51 }, (_, i) => ({ name: i + '.txt' }))), zip(Array.from({ length: 2049 }, (_, i) => ({ name: i + '/', data: '' })))]) { let calls = 0; await denied(data, async () => { calls++ }); assert.equal(calls, 0) }
})
test('the enclosing 64MB work budget includes inner OOXML expansion before the child validator runs', async () => {
  const office = zip(Array.from({length:3},(_,i)=>({name:'part'+i+'.xml',claimedSize:10*1024*1024}))), archive = zip(Array.from({length:3},(_,i)=>({name:i+'.docx',data:office})))
  let calls=0; await denied(archive,async()=>{calls++}); assert.equal(calls,2,'A third package cannot add another30MB of work')
})
test('the enclosing work budget also includes declared decoded image dimensions', async () => {
  const png=Buffer.alloc(33);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);png.writeUInt32BE(2048,16);png.writeUInt32BE(2048,20);png[24]=8;png[25]=6
  let calls=0;await denied(zip(Array.from({length:4},(_,i)=>({name:i+'.png',data:png}))),async()=>{calls++});assert.equal(calls,3)
})
test('AVIF processing uses the real bounded ispe preflight before its full content validator', async () => {
  const box=(kind,data)=>{const header=Buffer.alloc(8);header.writeUInt32BE(8+data.length);header.write(kind,4);return Buffer.concat([header,data])}
  const dimensions=Buffer.alloc(12);dimensions.writeUInt32BE(2048,4);dimensions.writeUInt32BE(2048,8)
  const properties=box('iprp',box('ipco',box('ispe',dimensions))),avif=Buffer.concat([box('ftyp',Buffer.concat([Buffer.from('avif'),Buffer.alloc(4),Buffer.from('avif')])),box('meta',Buffer.concat([Buffer.alloc(4),properties]))])
  let calls=0;await denied(zip(Array.from({length:4},(_,i)=>({name:i+'.avif',data:avif}))),async()=>{calls++});assert.equal(calls,3)
})
test('GIF processing charges cumulative frame pixels through the real cheap frame inspector', async () => {
  const header=Buffer.alloc(13);header.write('GIF89a');header.writeUInt16LE(2048,6);header.writeUInt16LE(2048,8);header[10]=0x80
  const image=Buffer.alloc(10);image[0]=0x2c;image.writeUInt16LE(2048,5);image.writeUInt16LE(2048,7)
  const gif=Buffer.concat([header,Buffer.from([0,0,0,255,255,255]),image,Buffer.from([2,2,0x44,0x01,0,0x3b])]);let calls=0
  await denied(zip(Array.from({length:4},(_,i)=>({name:i+'.gif',data:gif}))),async()=>{calls++});assert.equal(calls,3)
})
test('actual deflate bombs and corrupted streams cannot expand beyond bounded declared output', async () => {
  await denied(zip([{ name: 'notes.txt', data: Buffer.alloc(2 * 1024 * 1024, 65) }], { deflate: true }))
  const data = zip([{ name: 'notes.txt' }], { deflate: true }); data[30 + 'notes.txt'.length] ^= 0xff; await denied(data)
})
test('one invalid file stops validation without accepting remaining entries or extracting any path', async () => {
  const seen = []; await denied(zip([{ name: 'one.txt' }, { name: 'two.txt' }]), async (_, extension) => { seen.push(extension); throw Error('Fictional rejection') }); assert.deepEqual(seen, ['txt'])
  await denied(zip([{ name: 'folder/', data: '' }])); await denied(Buffer.alloc(0))
})
