import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
const root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map()
function load(file){
 const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute)
 const exports={};cache.set(absolute,exports)
 const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
 vm.runInNewContext(code,{exports,Buffer,TextEncoder,TextDecoder,Uint8Array,AbortSignal,Map,Set,Date,JSON,Number,require(name){if(!name.startsWith('.'))throw Error('Unexpected dependency '+name);return load(path.resolve(path.dirname(absolute),name.replace(/\.(js|ts)$/,''))+'.ts')}})
 return exports
}
const shared=load('src/lib/studentGroupMaterials.ts'),access=load('server/student-learning/studentGroupMaterialAccess.ts')
const USER='11111111-1111-4111-8111-111111111111',GROUP='22222222-2222-4222-8222-222222222222',MATERIAL='33333333-3333-4333-8333-333333333333',OTHER='44444444-4444-4444-8444-444444444444'
const ID=shared.groupMaterialSourceId({groupId:GROUP,materialId:MATERIAL,kind:'study'}),plain=v=>JSON.parse(JSON.stringify(v))
function fixture(){
 const state={member:true,allowAi:true,version:'a'.repeat(32),text:'Попит — кількість товару, яку покупці готові придбати.',userId:USER}
 const calls=[]
 const deny=()=>{throw Object.assign(Error('denied'),{code:'material_unavailable',status:403})}
 const api=access.createStudentGroupMaterialAccess({
  userId:USER,
  async groups(){calls.push('groups');return state.member?[{id:GROUP,name:'Навчальна група'}]:[]},
  async list(groupId){calls.push('list');assert.equal(groupId,GROUP);return {records:[{kind:'material',id:MATERIAL,groupId:GROUP,title:'Попит',subjectName:'Економіка',allowAi:state.allowAi},{kind:'test',id:OTHER,groupId:GROUP,title:'Закритий тест',allowAi:true}],truncated:false}},
  async content(groupId,materialId){calls.push('content');if(!state.member||!state.allowAi)deny();assert.equal(groupId,GROUP);assert.equal(materialId,MATERIAL);return {userId:state.userId,allowAi:true,text:state.text,title:'Попит',rightsVersion:state.version,truncated:false}},
  async assertRights(groupId,materialId,version){calls.push('assert');if(!state.member||!state.allowAi)deny();return {userId:state.userId,allowAi:true,rightsVersion:state.version}},
 })
 return {api,state,calls}
}
test('references fit the existing private source contract and cannot carry arbitrary paths',()=>{
 assert.ok(ID.length<=80);assert.deepEqual(plain(shared.groupMaterialReference(ID)),{kind:'study',groupId:GROUP,materialId:MATERIAL})
 for(const bad of ['https://private.example/file','gm_s_'+GROUP+'_../secret',ID+'x','gm_x_'+GROUP+'_'+MATERIAL])assert.equal(shared.groupMaterialReference(bad),null)
})
test('listing exposes only material metadata and rejects a foreign group before reading it',async()=>{
 const f=fixture(),list=await f.api.list(GROUP)
 assert.deepEqual(plain(list),{items:[{id:ID,title:'Попит',subject:'Економіка',allowAi:true}],truncated:false})
 assert.ok(!f.calls.includes('content'))
 f.calls.length=0;await assert.rejects(f.api.list(OTHER));assert.ok(!f.calls.includes('list'))
})
test('author opt-in is mandatory, including a forged preview request for a locked material',async()=>{
 const f=fixture();f.state.allowAi=false
 assert.equal((await f.api.list(GROUP)).items[0].allowAi,false)
 await assert.rejects(f.api.preview(ID),e=>e.code==='material_ai_not_allowed')
 assert.ok(!f.calls.includes('content'))
})
test('selected excerpt is bounded and validated; only authorized extraction is reused within a request',async()=>{
 const f=fixture();f.state.text='Навчальний матеріал '.repeat(2000)
 const preview=await f.api.preview(ID)
 assert.equal(preview.truncated,true);assert.ok(Buffer.byteLength(preview.source.text)<=23000)
 assert.deepEqual(plain(shared.parseStudentMaterialPreview(preview,ID)),plain(preview))
 await f.api.assertSources([preview.source]);await f.api.assertSources([preview.source])
 assert.equal(f.calls.filter(x=>x==='content').length,1)
 assert.equal(f.calls.filter(x=>x==='assert').length,2)
})
test('revocation, membership removal, content edits and owner changes block old sources',async()=>{
 for(const change of [{member:false},{allowAi:false},{version:'b'.repeat(32)},{userId:OTHER}]){
  const f=fixture(),preview=await f.api.preview(ID);Object.assign(f.state,change)
  await assert.rejects(f.api.assertSources([preview.source]))
 }
 const f=fixture(),preview=await f.api.preview(ID);f.state.text='Нова редакція'
 const fresh=fixture();fresh.state.text=f.state.text
 await assert.rejects(fresh.api.assertSources([preview.source]),e=>e.code==='context_changed')
})
test('browser text, source kind and alternate material-kind IDs are never trusted',async()=>{
 for(const change of [{text:'Підміна тексту'},{title:'Підміна назви'},{kind:'own_note'},{page:1}]){
  const f=fixture(),preview=await f.api.preview(ID)
  await assert.rejects(f.api.assertSources([{...preview.source,...change}]),e=>e.code==='context_changed')
 }
 const f=fixture();await assert.rejects(f.api.preview(ID.replace('gm_s_','gm_t_')));assert.ok(!f.calls.includes('content'))
})
test('plain own notes do not trigger any group reads; aborted reads cannot resolve',async()=>{
 const f=fixture();await f.api.assertSources([{id:'own-note',title:'Нотатка',text:'Текст',kind:'own_note',page:null}]);assert.equal(f.calls.length,0)
 const abort=new AbortController();abort.abort();await assert.rejects(f.api.groups(abort.signal))
})
test('browser parsers reject extra fields, another group and missing source provenance',()=>{
 assert.throws(()=>shared.parseStudentMaterialGroups([{id:GROUP,name:'Група',secret:'unexpected'}]))
 assert.throws(()=>shared.parseStudentGroupMaterials({items:[{id:ID,title:'Назва',subject:'',allowAi:true}],truncated:false},OTHER))
 assert.throws(()=>shared.parseStudentMaterialPreview({source:{id:'own-note',title:'Title',text:'Text',kind:'own_note',page:null},truncated:false},ID))
})

test('private material file reader rejects paths, other projects, redirects and oversized/changed streams',async()=>{
 const {createAuthorizedMaterialFileReader}=load('server/assistant-v2/cloudMaterialStorage.ts'),url='https://baohfpadxvhqhhjjqtil.supabase.co'
 const descriptor={bucket:'xelay-study-materials',path:GROUP+'/'+USER+'/'+MATERIAL+'.txt',size:4},calls=[]
 const reader=createAuthorizedMaterialFileReader({url,privateKey:'synthetic-private-key',fetcher:async(target,init)=>{calls.push({target,init});return new Response('text',{headers:{'content-length':'4'}})}})
 const result=await reader(descriptor);assert.equal(Buffer.from(result).toString(),'text');assert.equal(calls[0].init.redirect,'error')
 assert.throws(()=>createAuthorizedMaterialFileReader({url:'https://foreign.example',privateKey:'synthetic',fetcher:fetch}))
 for(const changed of[{bucket:'other-bucket'},{path:'../secret'},{size:8*1024*1024+1}])await assert.rejects(reader({...descriptor,...changed}))
 assert.equal(calls.length,1)
 for(const response of [new Response('bigger',{headers:{'content-length':'6'}}),new Response('bigger'),new Response('x')]){
  const bounded=createAuthorizedMaterialFileReader({url,privateKey:'synthetic',fetcher:async()=>response})
  await assert.rejects(bounded(descriptor))
 }
 const redirected=createAuthorizedMaterialFileReader({url,privateKey:'synthetic',fetcher:async()=>({ok:true,redirected:true,url:'https://foreign.example',headers:new Headers(),body:new Response('text').body})})
 await assert.rejects(redirected(descriptor))
})
