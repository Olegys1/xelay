import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),cache=new Map()
function load(file){
 const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute)
 const api={};cache.set(absolute,api)
 vm.runInNewContext(ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:api,TextEncoder,TextDecoder,ArrayBuffer,Uint8Array,DataView,Buffer,DecompressionStream,Set,Map,DOMException,crypto,fetch(){throw Error('Network forbidden')},require(name){if(!name.startsWith('.'))throw Error('Unexpected import '+name);const p=path.resolve(path.dirname(absolute),name.endsWith('.ts')?name:name+'.ts');if(!p.startsWith(root+path.sep))throw Error('Outside fixture');return load(p)}})
 return api
}
const api=load('src/lib/maxTutorAttachments.ts')
test('attachment excerpts respect complete UTF8 boundaries and explicitly report truncated content',()=>{
 assert.deepEqual(JSON.parse(JSON.stringify(api.maxTutorAttachmentExcerpt('Привіт',100))),{text:'Привіт',truncated:false})
 const clipped=api.maxTutorAttachmentExcerpt('А😀Б',5);assert.equal(clipped.text,'А');assert.equal(clipped.truncated,true)
 assert.equal(api.maxTutorAttachmentExcerpt('А😀Б',6).text,'А😀')
 assert.equal(api.maxTutorAttachmentExcerpt('x'.repeat(20001),24000).text.length,20000)
 for(const value of ['', 'text\u0000data','<script>alert(1)</script>'])assert.throws(()=>api.maxTutorAttachmentExcerpt(value,100))
})
test('unsupported, empty, huge and oversized batches fail before file reading or module loading',async()=>{
 let reads=0;const file=(name,size)=>({name,size,async arrayBuffer(){reads++;throw Error('Must not read')}})
 for(const files of [[],[file('photo.png',10)],[file('bad.exe',100)],[file('empty.txt',0)],[file('big.pdf',10*1024*1024+1)],[file('one.txt',1),file('two.txt',1),file('three.txt',1),file('four.txt',1)],[file('a.pdf',8*1024*1024),file('b.pdf',8*1024*1024),file('c.pdf',8*1024*1024)]])await assert.rejects(()=>api.readMaxTutorAttachments(files))
 assert.equal(reads,0)
})
test('cancelled selection stops before extraction or any file content is read',async()=>{
 const controller=new AbortController();controller.abort()
 await assert.rejects(()=>api.readMaxTutorAttachments([{name:'notes.txt',size:4,arrayBuffer(){throw Error('Should not read')}}],{signal:controller.signal}),e=>e.name==='AbortError')
})

test('actual text-file extraction produces an explicit own source without any network call',async()=>{
 const text='Навчальний проєкт має етапи: підготовка, виконання й перевірка.'
 const result=await api.readMaxTutorAttachments([new File([text],'мій конспект.txt',{type:'text/plain'})])
 assert.equal(result.sources.length,1);assert.equal(result.sources[0].text,text);assert.equal(result.sources[0].kind,'own_excerpt');assert.equal(result.sources[0].title,'мій конспект.txt')
 assert.match(result.sources[0].id,/^file-[a-f0-9-]{36}$/);assert.equal(result.warnings.length,0)
 const long=await api.readMaxTutorAttachments([new File(['я'.repeat(20000)],'великий.md')])
 assert.ok(new TextEncoder().encode(long.sources[0].text).length<=24000);assert.equal(long.warnings.length,1);assert.match(long.warnings[0],/лише початковий уривок/)
})
