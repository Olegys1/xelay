import test from 'node:test'
import assert from 'node:assert/strict'
import { CFB } from 'xlsx'
import { extractTeachingQuestionFile } from '../../src/lib/teachingQuestionImportFiles.ts'
import { previewTeachingQuestionsEasy, validateEasyImportedQuestion } from '../../src/lib/teachingQuestionImportText.ts'

// Synthetic fixtures only. No teacher files, questions or answer keys are stored.
function fixture({ text = '1. Оберіть колір\rа) Синій\rб) Білий\r\r2. Оберіть форму\rа) Коло\rб) Квадрат\r', header = '', compressed = false, flag = 0, property, styleProperty, modifiers = 0, data, extra, editWord, editTable } = {}) {
  const word = Buffer.alloc(4096), table = Buffer.alloc(4096), start = 1536, body = Buffer.from(text, compressed ? 'latin1' : 'utf16le'), tail = Buffer.from(header, compressed ? 'latin1' : 'utf16le')
  word.writeUInt16LE(0xa5ec,0);word.writeUInt16LE(0xc1,2);word.writeUInt16LE(0x422,6);word.writeUInt16LE(0x200|flag,10)
  word.writeUInt16LE(14,32);word.writeUInt16LE(22,62);word.writeUInt32LE(word.length,64);word.writeUInt32LE(text.length,76);word.writeUInt32LE(header.length,84);word.writeUInt16LE(93,152)
  word.writeUInt32LE(128,154+33*8);word.writeUInt32LE(21,154+33*8+4)
  table[128]=2;table.writeUInt32LE(16,129);table.writeUInt32LE(0,133);table.writeUInt32LE(text.length+header.length,137)
  table.writeUInt32LE(compressed?(start*2)|0x40000000:start,143);table.writeUInt16LE(modifiers,147)
  body.copy(word,start);tail.copy(word,start+body.length)
  if(property){
    word.writeUInt32LE(32,154+12*8);word.writeUInt32LE(12,154+12*8+4)
    table.writeUInt32LE(start,32);table.writeUInt32LE(start+body.length,36);table.writeUInt32LE(6,40)
    word.writeUInt32LE(start,3072);word.writeUInt32LE(start+body.length,3076);word[3080]=32;word[3136]=property.length;Buffer.from(property).copy(word,3137);word[3583]=1
  }
  if(styleProperty){
    const style=Buffer.alloc(16+2+styleProperty.length),styles=Buffer.alloc(8+style.length)
    styles.writeUInt16LE(4,0);styles.writeUInt16LE(1,2);styles.writeUInt16LE(10,4);styles.writeUInt16LE(style.length,6)
    style.writeUInt16LE(1,10);style.writeUInt16LE(78,12);style.writeUInt16LE(styleProperty.length,16);Buffer.from(styleProperty).copy(style,18);style.copy(styles,8)
    word.writeUInt32LE(512,154+8);word.writeUInt32LE(styles.length,154+12);styles.copy(table,512)
  }
  editWord?.(word);editTable?.(table)
  const cfb=CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb,'WordDocument',word);CFB.utils.cfb_add(cfb,'1Table',table)
  if(data)CFB.utils.cfb_add(cfb,'Data',data)
  if(extra)CFB.utils.cfb_add(cfb,extra,new Uint8Array([1]))
  CFB.utils.cfb_del(cfb,'\u0001Sh33tJ5')
  const output=Buffer.from(CFB.write(cfb,{type:'buffer'}))
  // SheetJS re-adds an internal sentinel during write. Remove only that
  // synthetic entry and rebuild a simple directory tree for these fixtures;
  // production deliberately does not whitelist arbitrary additional streams.
  const fat=(output.readUInt32LE(76)+1)*512,positions=[]
  for(let sector=output.readUInt32LE(48);sector!==0xfffffffe;sector=output.readUInt32LE(fat+sector*4))for(let at=0;at<512;at+=128)positions.push((sector+1)*512+at)
  const active=[]
  for(const [index,at] of positions.entries()){
    if(!output[at+66])continue
    const name=output.subarray(at,at+output.readUInt16LE(at+64)-2).toString('utf16le')
    if(name==='\u0001Sh33tJ5')output.fill(0,at,at+128)
    else if(index)active.push(index)
  }
  output.writeUInt32LE(active[0]??0xffffffff,positions[0]+76)
  active.forEach((id,index)=>{const at=positions[id];output.writeUInt32LE(0xffffffff,at+68);output.writeUInt32LE(active[index+1]??0xffffffff,at+72);output.writeUInt32LE(0xffffffff,at+76)})
  return output
}
function directoryPositions(bytes){
  const sectorSize=2**bytes.readUInt16LE(30),fat=(bytes.readUInt32LE(76)+1)*sectorSize,positions=[]
  for(let id=bytes.readUInt32LE(48);id!==0xfffffffe;id=bytes.readUInt32LE(fat+id*4))for(let at=0;at<sectorSize;at+=128)positions.push((id+1)*sectorSize+at)
  return positions
}
const extract = content => extractTeachingQuestionFile(new File([content],'synthetic.doc'))
const failure = /DOC|прихований|правки|формули|об’єкти|потоки|виноски/

test('binary DOC preserves main text and Ukrainian options without inventing missing keys',async()=>{
  const result=await extract(fixture()),parsed=previewTeachingQuestionsEasy(result.text)
  assert.equal(result.format,'plain');assert.deepEqual(parsed.issues,[])
  assert.deepEqual(parsed.questions.map(q=>q.options.map(o=>o.text)),[['Синій','Білий'],['Коло','Квадрат']])
  assert.ok(parsed.questions.every(q=>q.answer===undefined));assert.equal(parsed.inferredTypes.length,2)
  assert.ok(parsed.questions.every(q=>validateEasyImportedQuestion(q)))
  assert.ok(result.notes.some(note=>note.includes('правильні відповіді')))
})

test('main-story bounds exclude headers and stale sectors, while preserving explicit keys',async()=>{
  const text='1. Pick one\rA) One\rB) Two\rANSWER: B\r'
  const content=fixture({text,header:'SYNTHETIC HEADER',editWord(word){Buffer.from('STALE-ANSWER: A').copy(word,2800)}})
  const result=await extract(content),parsed=previewTeachingQuestionsEasy(result.text)
  assert.equal(result.text,text.replace(/\r/g,'\n'));assert.equal(parsed.questions[0].answer,'a2')
  assert.ok(result.notes.some(note=>note.includes('колонтитули')))
  const compressed=await extract(fixture({text:'1. Q\rA) One\rB) Two\r',compressed:true}))
  assert.equal(previewTeachingQuestionsEasy(compressed.text).questions.length,1)
})

test('legacy DOC rejects encryption, macro/object streams, nonempty Data and source control fields',async()=>{
  for(const options of [
    {flag:0x100},{flag:0x8000},{flag:8},{extra:'VBA/Module1'},{extra:'ObjectPool/Object1'},
    {data:new Uint8Array([1])},{extra:'data'},{text:'Q\u0001hidden image\r'},{text:'Q\u0013formula\u0014value\u0015\r'},
    {editWord:w=>w.writeUInt32LE(1,80)},{modifiers:1},
  ])await assert.rejects(extract(fixture(options)),failure)
  for(const source of [Buffer.from('{\\rtf1 fake doc}'),Buffer.from('<html>fake doc</html>')])await assert.rejects(extract(source),/DOC/)
})

test('hidden, web-hidden, SDT-hidden, deleted and symbolic/math character runs cannot leak into imports',async()=>{
  for(const opcode of [0x0800,0x0801,0x0802,0x0811,0x083c,0x2a90,0x0855,0x0856]){
    await assert.rejects(extract(fixture({property:[opcode&255,opcode>>8,1]})),failure)
  }
  for(const opcode of [0x6a03,0x6a09])await assert.rejects(extract(fixture({property:[opcode&255,opcode>>8,1,0,0,0]})),failure)
  await assert.rejects(extract(fixture({property:[0x1a,0xc8,1,1]})),failure)
  await assert.rejects(extract(fixture({styleProperty:[0x3c,0x08,1]})),failure)
  await assert.rejects(extract(fixture({styleProperty:[0x09,0x6a,0,0,65,0]})),failure)
  assert.ok((await extract(fixture({property:[0x3c,0x08,0]}))).text.includes('Оберіть'))
})

test('FIB, CLX piece and accumulated text bounds reject truncation, overlapping amplification and invalid formatting tables',async()=>{
  for(const options of [
    {editWord:w=>w.writeUInt32LE(0x7fffffff,76)},
    {editWord:w=>w.writeUInt32LE(1,64)},
    {editWord:w=>w.writeUInt32LE(1538,64)},
    {editWord:w=>w.writeUInt32LE(0x7fffffff,64)},
    {editWord:w=>w.writeUInt32LE(0xffffff00,154+33*8)},
    {editTable:t=>t.writeUInt32LE(0x7fffffff,137)},
    {editTable:t=>t.writeUInt32LE(0xffff,143)},
    {editTable:t=>{t[128]=1}},
    {property:[0x3c],editTable:t=>t.writeUInt32LE(0xffffff,40)},
  ])await assert.rejects(extract(fixture(options)),failure)
})

test('CFB directory, FAT and mini-stream corruption is rejected before unsafe library traversal',async()=>{
  const valid=fixture(),directory=()=>{const copy=Buffer.from(valid);return{copy,offset:(copy.readUInt32LE(48)+1)*512}}
  for(const mutate of [
    b=>b.writeUInt32LE(0x7fffffff,44),
    b=>b.writeUInt32LE(1,72),
    b=>b.writeUInt16LE(15,30),
    b=>{const fat=(b.readUInt32LE(76)+1)*512,dir=b.readUInt32LE(48);b.writeUInt32LE(dir,fat+dir*4)},
  ]){const copy=Buffer.from(valid);mutate(copy);await assert.rejects(extract(copy),failure)}
  for(const mutate of [
    (b,p)=>b.writeUInt32LE(0,p+128+68),
    (b,p)=>b.writeUInt32LE(0x7fffffff,p+128+120),
  ]){const{copy,offset}=directory();mutate(copy,offset);await assert.rejects(extract(copy),failure)}
  const mini=fixture({extra:'\u0001CompObj'}),compound=CFB.read(mini,{type:'buffer'}),miniIndex=compound.FileIndex.find(entry=>entry.name==='\u0001CompObj').start
  mini.writeUInt32LE(miniIndex,(mini.readUInt32LE(60)+1)*512+miniIndex*4)
  await assert.rejects(extract(mini),failure)
  const corrupt=Buffer.from(valid);corrupt.writeUInt32LE(0x7fffffff,44)
  const originalRead=CFB.read
  let calls=0
  try{CFB.read=(...args)=>{calls++;return originalRead(...args)};await assert.rejects(extract(corrupt),failure);assert.equal(calls,0)}finally{CFB.read=originalRead}
  await assert.rejects(extract(valid.subarray(0,valid.length-1)),failure)
})

test('unused directory entries cannot redirect paths or declare hidden allocations, and sanitization preserves the original',async()=>{
  const valid=fixture({extra:'\u0001CompObj'}),positions=directoryPositions(valid)
  const empty=positions.map((offset,id)=>({offset,id})).filter(({offset})=>valid[offset+66]===0)
  const active=positions.map((offset,id)=>({offset,id})).find(({offset})=>valid[offset+66]===2)
  assert.ok(empty.length>=2);assert.ok(active)
  const mutations=[
    b=>b.writeUInt32LE(empty[0].id,empty[0].offset+76),
    b=>{b.writeUInt32LE(empty[1].id,empty[0].offset+76);b.writeUInt32LE(empty[0].id,empty[1].offset+76)},
    b=>{b.writeUInt32LE(empty[1].id,empty[0].offset+76);b.writeUInt32LE(empty[0].id,empty[1].offset+76);b.writeUInt32LE(active.id,empty[1].offset+68)},
    b=>b.writeUInt32LE(0x7fffffff,empty[0].offset+120),
    b=>b.writeUInt32LE(1,empty[0].offset+116),
    b=>b.writeUInt16LE(64,empty[0].offset+64),
    b=>b.writeUInt32LE(active.id,active.offset+72),
  ]
  const originalRead=CFB.read
  let calls=0
  try{
    CFB.read=(...args)=>{calls++;return originalRead(...args)}
    for(const mutate of mutations){const bytes=Buffer.from(valid);mutate(bytes);await assert.rejects(extract(bytes),failure)}
    assert.equal(calls,0,'malformed paths and allocations fail before entering the library')
  }finally{CFB.read=originalRead}
  const original=Buffer.from(valid)
  assert.ok((await extract(valid)).text.includes('Оберіть'))
  assert.deepEqual(valid,original,'unused-link sanitization changes a private copy only')
})

test('character formatting rejects duplicate pages, nonmonotonic ranges, unsupported property groups and truncated operands',async()=>{
  const baseProperty=[0x35,0x08,1]
  assert.ok((await extract(fixture({property:baseProperty}))).text.includes('Оберіть'))
  for(const property of [[0x03,0x24,1],[0x35,0x08],[0x09,0xca,255]])await assert.rejects(extract(fixture({property})),failure)
  const duplicate={property:baseProperty,editWord(word){
    word.writeUInt32LE(20,154+12*8+4);word.writeUInt32LE(1540,3076)
  },editTable(table){
    const end=table.readUInt32LE(36)
    table.writeUInt32LE(1536,32);table.writeUInt32LE(1540,36);table.writeUInt32LE(end,40);table.writeUInt32LE(6,44);table.writeUInt32LE(6,48)
  }}
  await assert.rejects(extract(fixture(duplicate)),failure)
  await assert.rejects(extract(fixture({property:baseProperty,editTable:t=>t.writeUInt32LE(1535,36)})),failure)
  await assert.rejects(extract(fixture({property:baseProperty,editWord:w=>w.writeUInt32LE(1537,3072)})),failure)
  await assert.rejects(extract(fixture({property:baseProperty,editWord:w=>{w[3583]=255}})),failure)
})

test('acyclic reverse FAT chains cannot amplify third-party copying beyond the preflight budget',async()=>{
  const ordinary=fixture({data:Buffer.alloc(64*1024)})
  assert.ok((await extract(ordinary)).text.includes('Оберіть'))
  const reversed=Buffer.from(ordinary),sectorSize=2**reversed.readUInt16LE(30)
  const fatIds=Array.from({length:reversed.readUInt32LE(44)},(_,index)=>reversed.readUInt32LE(76+index*4))
  const fatOffset=id=>(fatIds[Math.floor(id/(sectorSize/4))]+1)*sectorSize+id%(sectorSize/4)*4
  const dataEntry=directoryPositions(reversed).find(at=>reversed[at+66]===2&&reversed.subarray(at,at+reversed.readUInt16LE(at+64)-2).toString('utf16le')==='Data')
  assert.notEqual(dataEntry,undefined)
  const chain=[]
  for(let id=reversed.readUInt32LE(dataEntry+116);id!==0xfffffffe;id=reversed.readUInt32LE(fatOffset(id)))chain.push(id)
  assert.equal(chain.length,128)
  chain.reverse()
  reversed.writeUInt32LE(chain[0],dataEntry+116)
  chain.forEach((id,index)=>reversed.writeUInt32LE(chain[index+1]??0xfffffffe,fatOffset(id)))
  const originalRead=CFB.read
  let calls=0
  try{
    CFB.read=(...args)=>{calls++;return originalRead(...args)}
    await assert.rejects(extract(reversed),failure)
    assert.equal(calls,0,'the disjoint, acyclic chain is rejected before repeated library allocations')
  }finally{CFB.read=originalRead}
})
