// Fictional format fixtures only. No malware, Office/PDF execution or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import vm from 'node:vm'
import * as zlib from 'node:zlib'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
const root=process.env.XELAY_AUDIT_SOURCE_ROOT||fileURLToPath(new URL('../../',import.meta.url))
const ts=createRequire(join(process.env.XELAY_AUDIT_DEPENDENCY_ROOT||root,'package.json'))('typescript')
const source=await readFile(join(root,'server/uploadContentValidation.ts'),'utf8'),module={exports:{}}
const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},reportDiagnostics:true})
assert.deepEqual(code.diagnostics?.filter(row=>row.category===ts.DiagnosticCategory.Error),[])
vm.runInNewContext(code.outputText,{module,exports:module.exports,Buffer,Uint8Array,TextDecoder,Error,require(name){if(name==='node:crypto')return crypto;if(name==='node:zlib')return zlib;if(name==='node:path')return path;throw Error('Unexpected dependency '+name)}})
const {validateUploadContent:validate,UploadContentValidationError:ValidationError}=module.exports
const denied=async(bytes,extension,mime)=>assert.rejects(validate(bytes,extension,mime),error=>error instanceof ValidationError&&error.status===422&&/[А-Яа-яІіЇїЄєҐґ]/u.test(error.message))
function crc(bytes){let value=0xffffffff;for(const byte of bytes){value^=byte;for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1}return(value^0xffffffff)>>>0}
function chunk(name,bytes){const out=Buffer.alloc(bytes.length+12);out.writeUInt32BE(bytes.length);out.write(name,4);bytes.copy(out,8);out.writeUInt32BE(crc(out.subarray(4,-4)),out.length-4);return out}
function png(){const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',zlib.deflateSync(Buffer.from([0,255,0,0]))),chunk('IEND',Buffer.alloc(0))])}
function jpeg(){
 const segment=(marker,data)=>{const out=Buffer.alloc(data.length+4);out[0]=255;out[1]=marker;out.writeUInt16BE(data.length+2,2);data.copy(out,4);return out}
 const huffman=kind=>Buffer.from([kind,1,...Array(15).fill(0),0])
 return Buffer.concat([Buffer.from([255,216]),segment(219,Buffer.from([0,...Array(64).fill(1)])),segment(192,Buffer.from([8,0,1,0,1,1,1,0x11,0])),segment(196,Buffer.concat([huffman(0),huffman(16)])),segment(218,Buffer.from([1,1,0,0,63,0])),Buffer.from([0x3f,255,217])])
}
function webp(){const payload=Buffer.from([0x30,0,0,0x9d,1,0x2a,1,0,1,0,0]),out=Buffer.alloc(12+8+payload.length+1);out.write('RIFF');out.writeUInt32LE(out.length-8,4);out.write('WEBP',8);out.write('VP8 ',12);out.writeUInt32LE(payload.length,16);payload.copy(out,20);return out}
function pdf(extra=[]){
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',...extra]
 let value='%PDF-1.7\n',offsets=[0]
 for(const[at,object]of objects.entries()){offsets.push(Buffer.byteLength(value,'latin1'));value+=`${at+1} 0 obj\n${object}\nendobj\n`}
 const start=Buffer.byteLength(value,'latin1');value+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
 return Buffer.from(value,'latin1')
}
function zip(files,{deflate=false}={}){
 const locals=[],central=[];let offset=0
 for(const[name,raw]of files){const data=Buffer.isBuffer(raw)?raw:Buffer.from(raw),filename=Buffer.from(name),packed=deflate?zlib.deflateRawSync(data):data,checksum=crc(data),local=Buffer.alloc(30+filename.length),entry=Buffer.alloc(46+filename.length)
  local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(deflate?8:0,8);local.writeUInt32LE(checksum,14);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(filename.length,26);filename.copy(local,30)
  entry.writeUInt32LE(0x02014b50);entry.writeUInt16LE(20,4);entry.writeUInt16LE(20,6);entry.writeUInt16LE(deflate?8:0,10);entry.writeUInt32LE(checksum,16);entry.writeUInt32LE(packed.length,20);entry.writeUInt32LE(data.length,24);entry.writeUInt16LE(filename.length,28);entry.writeUInt32LE(offset,42);filename.copy(entry,46)
  locals.push(local,packed);central.push(entry);offset+=local.length+packed.length
 }
 const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(files.length,8);end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);return Buffer.concat([...locals,directory,end])
}
const config={docx:['word/document.xml','application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p/></w:body></w:document>'],xlsx:['xl/workbook.xml','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets/></workbook>'],pptx:['ppt/presentation.xml','application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml','<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldIdLst/></p:presentation>']}
function office(extension,extras=[]){const[main,type,body]=config[extension];return[['[Content_Types].xml',`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="${type}"/></Types>`],['_rels/.rels',`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`],[main,body],...extras]}

test('ordinary bounded TXT/CSV return canonical identity and content hash',async()=>{
 for(const[ext,data,mime]of[['txt','Звичайний конспект\nБез активних вкладень','text/plain'],['csv','Предмет,Бал\nМатематика,5','text/csv']]){
  const bytes=Buffer.from(data),result=await validate(bytes,ext,mime)
  assert.equal(result.mime,mime);assert.equal(result.extension,ext);assert.equal(result.validationVersion,1);assert.equal(result.size,bytes.length);assert.equal(result.sha256,crypto.createHash('sha256').update(bytes).digest('hex'))
 }
})
test('empty, oversized, unsupported legacy/archive/media and MIME-mismatch fail closed',async()=>{
 await denied(Buffer.alloc(0),'txt','text/plain');await denied(Buffer.alloc(50*1024*1024+1),'txt','text/plain')
 for(const ext of['doc','xls','ppt','zip','mp3','mp4','svg','html','exe'])await denied(Buffer.from('BENIGN'),ext,'application/octet-stream')
 await denied(png(),'png','application/pdf')
})
test('binary/invalid UTF8/active markup and formula CSV are rejected without execution',async()=>{
 for(const bytes of[Buffer.from([0xff,0x80]),Buffer.from('plain\0binary'),Buffer.from('<html>BENIGN MARKUP</html>')])await denied(bytes,'txt','text/plain')
 for(const cell of['=1+1','+SUM(1,2)','@SUM(1)','-example',' \t=1+1','\n=1+1','-1+1'])await denied(Buffer.from(`"${cell.replaceAll('"','""')}"`),'csv','text/csv')
 for(const separator of[',',';','\t'])await denied(Buffer.from(`name${separator}"=1+1"`),'csv','text/csv')
 await denied(Buffer.from('sep=|\nname|=1+1'),'csv','text/csv')
 await denied(Buffer.from('name,unquoted"field'),'csv','text/csv')
 await validate(Buffer.from('Name,Value\nExample,-10'),'csv','text/csv')
 await validate(Buffer.from('"Name","Text"\n"Example","Line one\nLine two, with ""quotes"""'),'csv','text/csv')
})
test('PNG validates CRC, full deflate rows, dimensions and trailer instead of only signature',async()=>{
 const valid=png();assert.equal((await validate(valid,'png','image/png')).mime,'image/png')
 const changed=Buffer.from(valid);changed[changed.length-5]^=1
 for(const bytes of[changed,valid.subarray(0,-1),Buffer.concat([valid,Buffer.from('BENIGN TRAILER')]),Buffer.from([137,80,78,71,13,10,26,10])])await denied(bytes,'png','image/png')
})
test('JPEG validates markers/tables/scan boundaries and rejects missing tables/truncation/trailing polyglot',async()=>{
 const valid=jpeg();assert.equal((await validate(valid,'jpg','image/jpeg')).mime,'image/jpeg')
 for(const bytes of[Buffer.from([255,216,255,217]),valid.subarray(0,-1),Buffer.concat([valid,Buffer.from('BENIGN TRAILER')])])await denied(bytes,'jpg','image/jpeg')
})
test('progressive JPEG EOB-run symbols are accepted only with a progressive frame',async()=>{
 const baseline=jpeg(),table=baseline.indexOf(Buffer.from([255,196]))
 assert.ok(table>0);baseline[table+39]=0x10
 await denied(baseline,'jpg','image/jpeg')
 const start=baseline.indexOf(Buffer.from([255,218])),frame=baseline.indexOf(Buffer.from([255,192]))
 assert.ok(start>0&&frame>0)
 const header=Buffer.from(baseline.subarray(0,start));header[frame+1]=194;header.writeUInt16BE(8,frame+5);header.writeUInt16BE(16,frame+7)
 // Two 8x8 blocks: DC first, then one AC EOB run covering both blocks.
 const scan=(first,last)=>Buffer.from([255,218,0,8,1,1,0,first,last,0,0x3f])
 const progressive=Buffer.concat([header,scan(0,0),scan(1,63),Buffer.from([255,217])])
 assert.equal((await validate(progressive,'jpg','image/jpeg')).mime,'image/jpeg')
})
test('WebP checks RIFF length, key-frame header and dimensions; unsupported animation/metadata fail closed',async()=>{
 const valid=webp();assert.equal((await validate(valid,'webp','image/webp')).mime,'image/webp')
 const wrong=Buffer.from(valid);wrong.writeUInt32LE(999,4)
 for(const bytes of[wrong,valid.subarray(0,20),Buffer.concat([valid,Buffer.from('BENIGN')])])await denied(bytes,'webp','image/webp')
})
test('WebP accepts only bounded declared RGB ICC metadata; malformed profile or unknown tags fail closed',async()=>{
 const names=['rXYZ','gXYZ','bXYZ','wtpt','rTRC','gTRC','bTRC'],tableEnd=132+names.length*12,profile=Buffer.alloc(tableEnd+4*20+12)
 profile.writeUInt32BE(profile.length);profile[8]=4;profile.write('mntr',12);profile.write('RGB ',16);profile.write('XYZ ',20);profile.write('acsp',36);profile.writeUInt32BE(names.length,128)
 for(let n=0;n<names.length;n++){
  const offset=n<4?tableEnd+n*20:tableEnd+80,size=n<4?20:12,row=132+n*12
  profile.write(names[n],row);profile.writeUInt32BE(offset,row+4);profile.writeUInt32BE(size,row+8)
  profile.write(n<4?'XYZ ':'curv',offset)
  if(n<4)for(let coordinate=0;coordinate<3;coordinate++)profile.writeInt32BE(65536,offset+8+coordinate*4)
 }
 const wrap=icc=>{const extended=Buffer.alloc(10);extended[0]=32;const block=(name,data)=>{const out=Buffer.alloc(8+data.length+(data.length&1));out.write(name);out.writeUInt32LE(data.length,4);data.copy(out,8);return out};const payload=Buffer.concat([block('VP8X',extended),block('ICCP',icc),webp().subarray(12)]),header=Buffer.alloc(12);header.write('RIFF');header.writeUInt32LE(payload.length+4,4);header.write('WEBP',8);return Buffer.concat([header,payload])}
 assert.equal((await validate(wrap(profile),'webp','image/webp')).mime,'image/webp')
 const malformed=Buffer.from(profile);malformed.writeUInt32BE(profile.length+4);await denied(wrap(malformed),'webp','image/webp')
 const unknown=Buffer.from(profile);unknown.write('A2B0',132);await denied(wrap(unknown),'webp','image/webp')
 const badOffset=Buffer.from(profile);badOffset.writeUInt32BE(profile.length-4,136);await denied(wrap(badOffset),'webp','image/webp')
})
test('classic-xref PDF with real catalog/page tree is supported; fake/truncated PDF is rejected',async()=>{
 const valid=pdf();assert.equal((await validate(valid,'pdf','application/pdf')).mime,'application/pdf')
 for(const bytes of[Buffer.from('%PDF-1.7\nBENIGN NOT A PDF'),valid.subarray(0,-12),Buffer.concat([valid,Buffer.from('BENIGN TRAILER')])])await denied(bytes,'pdf','application/pdf')
})
test('PDF active action names including escaped names are refused even in unused objects',async()=>{
 for(const extra of['<< /Type /Action /S /JavaScript /JS (inert text) >>','<< /Type /Action /S /Java#53cript /JS () >>','<< /Type /EmbeddedFile /Length 0 >>','<< /OpenAction [3 0 R /Fit] >>','<< /Encrypt null >>'])await denied(pdf([extra]),'pdf','application/pdf')
})
test('PDF unsupported compressed-object/encrypted/external structures fail closed with safe message',async()=>{
 for(const extra of['<< /Type /ObjStm /N 0 /First 0 /Length 0 >>','<< /Type /XRef /Length 0 >>','<< /F (fictional-only.txt) >>','<< /Annots [] >>'])await denied(pdf([extra]),'pdf','application/pdf')
})
test('PDF stream bytes are bounded and actual Flate data must decode with exact stream envelope',async()=>{
 const compressed=zlib.deflateSync(Buffer.from('0 0 m 1 1 l S'))
 const stream=`<< /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n${compressed.toString('latin1')}\nendstream`
 await validate(pdf([stream]),'pdf','application/pdf')
 await denied(pdf([stream.replace(`/Length ${compressed.length}`,`/Length ${compressed.length+1}`)]),'pdf','application/pdf')
})
test('DOCX/XLSX/PPTX require matching package relationships, content type and main XML',async()=>{
 for(const ext of['docx','xlsx','pptx']){
  assert.equal((await validate(zip(office(ext),{deflate:true}),ext,'application/octet-stream')).extension,ext)
  await denied(zip(office(ext).filter(([name])=>name!=='_rels/.rels')),ext,'application/octet-stream')
 }
 await denied(zip(office('docx')),'xlsx','application/octet-stream')
})
test('unused default MIME declaration is harmless but never permits an actual macro/binary part',async()=>{
 const files=office('xlsx');files[0][1]=String(files[0][1]).replace('</Types>','<Default Extension="bin" ContentType="application/vnd.ms-excel.sheet.binary.macroEnabled.main"/></Types>')
 await validate(zip(files),'xlsx','application/octet-stream')
 await denied(zip([...files,['xl/fictional.bin','BENIGN PLACEHOLDER']]),'xlsx','application/octet-stream')
})
test('OOXML inert macro/embedded-object path markers, DTD and external relationship are rejected',async()=>{
 for(const extra of[['word/vbaProject.bin','BENIGN PLACEHOLDER'],['word/embeddings/placeholder.xml','<root/>'],['word/activeX/placeholder.xml','<root/>'],['word/extra.xml','<!DOCTYPE root><root/>']])await denied(zip(office('docx',[extra])),'docx','application/octet-stream')
 const files=office('docx');files[1][1]=String(files[1][1]).replace('</Relationships>','<Relationship Id="r2" Type="http://example.test/hyperlink" Target="https://example.test/" TargetMode="External"/></Relationships>')
 await denied(zip(files),'docx','application/octet-stream')
})
test('OOXML duplicate/traversal/CRC/local-directory mismatch and claimed archive bomb are rejected',async()=>{
 await denied(zip(office('docx',[['../outside.xml','<root/>']])),'docx','application/octet-stream')
 await denied(zip(office('docx',[['WORD/DOCUMENT.XML','<root/>']])),'docx','application/octet-stream')
 const badName=zip(office('docx'));badName[30]^=1;await denied(badName,'docx','application/octet-stream')
 const badCrc=zip(office('docx'));badCrc[14]^=1;await denied(badCrc,'docx','application/octet-stream')
 const bomb=zip(office('docx')),directory=bomb.readUInt32LE(bomb.length-6);bomb.writeUInt32LE(64*1024*1024,directory+24);await denied(bomb,'docx','application/octet-stream')
})
test('OOXML formulas with external behavior and inert OLE tags are refused',async()=>{
 await denied(zip(office('xlsx',[['xl/worksheets/sheet1.xml','<worksheet><c><f>WEBSERVICE(&quot;https://example.test/&quot;)</f></c></worksheet>']])),'xlsx','application/octet-stream')
 await denied(zip(office('docx',[['word/extra.xml','<root><object/></root>']])),'docx','application/octet-stream')
 await denied(zip(office('xlsx',[['xl/worksheets/sheet1.xml','<worksheet><c><f>IMAGE(A1)</f></c></worksheet>']])),'xlsx','application/octet-stream')
 await denied(zip(office('docx',[['word/extra.xml','<root><instrText>INCLUDETEXT inert-placeholder</instrText></root>']])),'docx','application/octet-stream')
 await validate(zip(office('xlsx',[['xl/worksheets/sheet1.xml','<worksheet><c><f>SUM(A1:A3)*0.5</f></c></worksheet>']])),'xlsx','application/octet-stream')
})
