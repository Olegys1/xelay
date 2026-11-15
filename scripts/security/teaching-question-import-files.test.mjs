import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateRawSync } from 'node:zlib'
import { readQuestionOfficeArchive, storedQuestionOfficeArchive } from '../../src/lib/teachingQuestionImportArchive.ts'
import { extractTeachingQuestionFile } from '../../src/lib/teachingQuestionImportFiles.ts'
import { importTeachingQuestionsEasy, questionTableToText } from '../../src/lib/teachingQuestionImportText.ts'
import { utils, write } from 'xlsx'

const xml = text => new TextEncoder().encode(text)
const contentTypes = '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>'
const map = document => new Map([['[Content_Types].xml',xml(contentTypes)],['word/document.xml',xml(document)]])
const textQuestion = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>1. Яка столиця?</w:t></w:r></w:p><w:p><w:r><w:t>A) Київ</w:t></w:r></w:p><w:p><w:r><w:t>B) Львів</w:t></w:r></w:p><w:p><w:r><w:t>Відповідь: A</w:t></w:r></w:p></w:body></w:document>'
const file = (name, content) => new File([content],name)

test('DOCX text is extracted locally with its key and points in separate Word paragraphs', async () => {
  const document = textQuestion.replace('</w:body>', '<w:p><w:r><w:t>Бали: 2</w:t></w:r></w:p></w:body>')
  const result = await extractTeachingQuestionFile(file('test.docx', storedQuestionOfficeArchive(map(document))))
  assert.equal(result.format,'plain')
  const parsed = importTeachingQuestionsEasy(result.text,result.format)
  assert.deepEqual(parsed.issues,[])
  assert.equal(parsed.questions[0].answer,'a1')
  assert.equal(parsed.questions[0].text,'Яка столиця?')
  assert.equal(parsed.questions[0].points,2)
  assert.match(result.notes[0],/нумерацію/)
})
test('DOCX preserves literal inequalities and XML entities without rendering HTML', async () => {
  const document = textQuestion.replace('Яка столиця?', 'x &lt; 5 і y &gt; 3, &amp;')
  const result = await extractTeachingQuestionFile(file('math.docx',storedQuestionOfficeArchive(map(document))))
  assert.match(result.text,/x < 5 і y > 3, &/)
  assert.match(importTeachingQuestionsEasy(result.text).questions[0].text,/x < 5 і y > 3, &/)
})
test('scans, embedded math/images, active objects and unresolved changes are not silently lost', async () => {
  for (const tag of ['w:drawing','w:pict','m:oMath','w:object','w:altChunk','w:ins','w:del']) {
    await assert.rejects(extractTeachingQuestionFile(file('test.docx',storedQuestionOfficeArchive(map(textQuestion.replace('<w:body>',`<w:body><${tag}/>`))))),/зображення|формули|правки/)
  }
})
test('XLSX reads all compatible sheets, rejects formulas and excessive ranges', async () => {
  const workbook = utils.book_new(), rows = [['Запитання','A','B','Відповідь','Бали'],['Що?','One','Two','B',2]]
  utils.book_append_sheet(workbook,utils.aoa_to_sheet(rows),'One')
  utils.book_append_sheet(workbook,utils.aoa_to_sheet(rows),'Two')
  const result = await extractTeachingQuestionFile(file('test.xlsx',write(workbook,{type:'array',bookType:'xlsx',compression:true})))
  assert.equal(result.format,'table')
  const parsed = importTeachingQuestionsEasy(result.text,result.format)
  assert.deepEqual(parsed.issues,[])
  assert.equal(parsed.questions.length,2)
  assert.equal(parsed.questions[0].answer,'a2')
  workbook.Sheets.One.B2 = {t:'n',f:'1+1',v:2}
  await assert.rejects(extractTeachingQuestionFile(file('formula.xlsx',write(workbook,{type:'array',bookType:'xlsx'}))),/формули/)
  delete workbook.Sheets.One.B2.f
  const bounded = await readQuestionOfficeArchive(write(workbook,{type:'array',bookType:'xlsx'}))
  const worksheet = new TextDecoder().decode(bounded.get('xl/worksheets/sheet1.xml')).replace(/<dimension ref="[^"]+"\/>/, '<dimension ref="A1:Z999999"/>')
  bounded.set('xl/worksheets/sheet1.xml', xml(worksheet))
  await assert.rejects(extractTeachingQuestionFile(file('range.xlsx',storedQuestionOfficeArchive(bounded))),/завеликий|завелика|розмір/)
})
test('XLSX cannot masquerade as DOCX, macros and external relationships are rejected before library parsing', async () => {
  const archive = map(textQuestion)
  archive.set('word/vbaProject.bin',new Uint8Array([1]))
  await assert.rejects(readQuestionOfficeArchive(storedQuestionOfficeArchive(archive)),/активні/)
  archive.delete('word/vbaProject.bin')
  archive.set('word/_rels/document.xml.rels',xml('<Relationships><Relationship TargetMode="External" Target="https://example.invalid/private" /></Relationships>'))
  await assert.rejects(extractTeachingQuestionFile(file('external.docx',storedQuestionOfficeArchive(archive))),/зовнішні/)
  archive.delete('word/_rels/document.xml.rels')
  archive.set('xl/workbook.xml',xml('<workbook/>'))
  await assert.rejects(extractTeachingQuestionFile(file('spoof.docx',storedQuestionOfficeArchive(archive))),/відповідає/)
})
test('plain UTF8/UTF16 files and pasted tables do not need an external parser service', async () => {
  const text='Question,A,B,Answer\nWhich?,One,Two,B'
  const result=await extractTeachingQuestionFile(file('test.csv',text))
  assert.equal(importTeachingQuestionsEasy(result.text,result.format).questions[0].answer,'a2')
  const utf16 = new Uint8Array(2+text.length*2);utf16.set([255,254]);for(let index=0;index<text.length;index++){utf16[index*2+2]=text.charCodeAt(index)&255;utf16[index*2+3]=text.charCodeAt(index)>>8}
  const unicode=await extractTeachingQuestionFile(file('test.txt',utf16))
  assert.equal(unicode.text,text)
  assert.deepEqual(importTeachingQuestionsEasy(questionTableToText([['Question','A','B','Answer'],['x < 5, y > 3','One','Two','B']])).issues,[])
})
test('spoofed, empty, unsupported and oversized files fail before heavy parsing', async () => {
  for (const [name,content,pattern] of [['test.pdf','<html>fake</html>',/PDF/],['test.docx','plain text',/DOCX/],['test.xlsx','text',/XLSX/],['test.doc','binary',/DOCX/],['scan.png','picture',/фото/],['empty.txt','',/непорожнім/],['binary.txt',new Uint8Array([0,1,2,3]),/текст/],['huge.txt',new Uint8Array(10*1024*1024+1),/10 МБ/]]) await assert.rejects(extractTeachingQuestionFile(file(name,content)),pattern)
})
test('ZIP CRC, traversal, duplicate and mismatched headers are rejected', async () => {
  const archive = map(textQuestion), bytes = new Uint8Array(storedQuestionOfficeArchive(archive)), view = new DataView(bytes.buffer)
  bytes[30 + view.getUint16(26,true)] ^= 1
  await assert.rejects(readQuestionOfficeArchive(bytes.buffer),/сума/)
  const traversal = map(textQuestion);traversal.set('../bad.xml',xml('<bad/>'))
  await assert.rejects(readQuestionOfficeArchive(storedQuestionOfficeArchive(traversal)),/активні/)
  const bad = new Uint8Array(storedQuestionOfficeArchive(archive));new DataView(bad.buffer).setUint16(6,1,true)
  await assert.rejects(readQuestionOfficeArchive(bad.buffer),/не збігаються|пошкоджений/)
})
function compressedArchive(content, claimedLength=content.length) {
  const name=Buffer.from('[Content_Types].xml'), compressed=deflateRawSync(content), local=Buffer.alloc(30), central=Buffer.alloc(46), end=Buffer.alloc(22)
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(8,8);local.writeUInt32LE(compressed.length,18);local.writeUInt32LE(claimedLength,22);local.writeUInt16LE(name.length,26)
  central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(8,10);central.writeUInt32LE(compressed.length,20);central.writeUInt32LE(claimedLength,24);central.writeUInt16LE(name.length,28)
  const offset=local.length+name.length+compressed.length
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(offset,16)
  return Uint8Array.from(Buffer.concat([local,name,compressed,central,name,end])).buffer
}
test('inflater enforces the real expanded size, not just the attacker-declared central size', async () => {
  const bytes=Buffer.alloc(128*1024,120)
  await assert.rejects(readQuestionOfficeArchive(compressedArchive(bytes,128)),/перевищує заявлений|сума/)
  await assert.rejects(readQuestionOfficeArchive(compressedArchive(bytes,9*1024*1024)),/завеликий|пошкоджений/)
})

test('malformed DOCX XML is rejected in bounded time and unused macro defaults do not reject ordinary XLSX', async () => {
  const start=performance.now()
  await assert.rejects(extractTeachingQuestionFile(file('broken.docx',storedQuestionOfficeArchive(map('<'.repeat(256*1024))))),/XML/)
  assert.ok(performance.now()-start<1500)
  const active = map(textQuestion)
  active.set('[Content_Types].xml', xml('<Types><Override PartName="/word/a.bin" ContentType="application/vnd.ms-office.vbaProject"/></Types>'))
  active.set('word/a.bin',new Uint8Array([1,2]))
  await assert.rejects(readQuestionOfficeArchive(storedQuestionOfficeArchive(active)),/макроси/)
})
