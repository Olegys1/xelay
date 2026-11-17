import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'
const native=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map()
function load(file){const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module);vm.runInNewContext(ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Buffer,URL,Date,Math,Number,JSON,Set,Map,TextEncoder,TextDecoder,Uint8Array,Response,AbortController,AbortSignal,setTimeout,clearTimeout,fetch(){throw Error('External network forbidden')},require(name){if(name.startsWith('node:'))return native(name);if(!name.startsWith('.'))throw Error('Unexpected '+name);return load(path.resolve(path.dirname(absolute),name.replace(/\.(?:js|ts)$/,''))+'.ts')}});return module.exports}
const cloud=load('src/lib/studentLearningLibrary.ts'),plain=v=>JSON.parse(JSON.stringify(v)),now=new Date().toISOString(),scope={userId:'owner-a',sessionId:'session-a'},empty=()=>({version:1,notes:[],reviews:[]}),note=(title='Попит')=>({id:'note-1',title,subject:'Економіка',text:'Попит залежить від ціни.',updatedAt:now}),doc=(title='Попит')=>({version:1,notes:[note(title)],reviews:[]})
const snap=(revision=0,document=empty(),extra={})=>({status:'ready',scope,revision,document,canEdit:true,updatedAt:revision?now:null,runs:[],nextCursor:null,...extra}),ack=(revision,document,extra={})=>({status:'ready',scope,revision,document,canEdit:true,updatedAt:now,acceptedRevision:revision,replayed:false,...extra})
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}}),defer=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return{promise,resolve,reject}},memory=()=>{const values=new Map();return{values,getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)}}
function fixture(){let current=snap(),online=true,saves=0;const mutations=new Map(),storage=memory(),client={async load(){if(!online)throw new cloud.StudentLearningLibraryError('unavailable');return plain(current)},async save(document,revision,id){if(!online)throw new cloud.StudentLearningLibraryError('unavailable');saves++;if(mutations.has(id))return{...ack(mutations.get(id),current.document),revision:current.revision,replayed:true};if(revision!==current.revision)throw new cloud.StudentLearningLibraryError('conflict',plain(current));current=snap(revision+1,plain(document));mutations.set(id,current.revision);return ack(current.revision,current.document)}};return{client,storage,get current(){return plain(current)},set current(v){current=plain(v)},set online(v){online=v},get saves(){return saves},create:(extra={})=>cloud.createStudentLearningLibraryController({client,ownerId:scope.userId,sessionId:scope.sessionId,storage,debounceMs:100000,...extra})}}

test('private library client bounds and validates content before transport',async()=>{
 let calls=0;const client=cloud.createStudentLearningLibraryClient({ownerId:scope.userId,credential:async()=>({...scope,accessToken:'synthetic-token'}),fetcher:async()=>{calls++;return json(ack(1,doc()))}})
 await assert.rejects(client.save({...doc(),userId:'owner-b'},0,'valid-id'),e=>e.code==='invalid_request')
 await assert.rejects(client.save(doc('<script>bad</script>'),0,'valid-id'),e=>e.code==='invalid_request')
 await assert.rejects(client.save({...doc(),notes:[{...note(),text:'x'.repeat(20001)}]},0,'valid-id'),e=>e.code==='invalid_request')
 await assert.rejects(client.save({...doc(),notes:[note(),note()]},0,'valid-id'),e=>e.code==='invalid_request')
 await assert.rejects(client.getRuns(Array.from({length:31},(_,i)=>'run-'+i)),e=>e.code==='invalid_request')
 await assert.rejects(client.getRuns(['run-1','run-1']),e=>e.code==='invalid_request')
 assert.equal(calls,0);await client.save(doc(),0,'valid-id');assert.equal(calls,1)
})

test('private library client binds both response and in-flight session to current account',async()=>{
 let credential={...scope,accessToken:'synthetic-token'},pending=defer(),seen
 const client=cloud.createStudentLearningLibraryClient({ownerId:scope.userId,credential:async()=>credential,fetcher:async(url,init)=>{seen={url,init};return pending.promise}})
 const request=client.load();await Promise.resolve();credential={userId:'owner-b',sessionId:'session-b',accessToken:'another-token'};pending.resolve(json(snap()));await assert.rejects(request,e=>e.code==='identity_changed');assert.equal(seen.url,'/api/student-library');assert.equal(seen.init.credentials,'omit');assert.equal(seen.init.redirect,'error');assert.equal(seen.init.cache,'no-store');assert.ok(!seen.url.includes('token'))
 credential={...scope,accessToken:'synthetic-token'};pending=defer();const forged=client.load();await Promise.resolve();pending.resolve(json(snap(0,empty(),{scope:{userId:'owner-b',sessionId:'session-b'}})));await assert.rejects(forged,e=>e.code==='identity_changed')
 pending=defer();const conflict=client.save(doc(),0,'mutation-a');await Promise.resolve();pending.resolve(json({status:'conflict',snapshot:snap(1,doc(),{scope:{...scope,sessionId:'old-session'}})},409));await assert.rejects(conflict,e=>e.code==='identity_changed')
})

test('private library client refuses malformed, redirected, oversized and mismatched batch responses',async()=>{
 let response=json(snap());const client=cloud.createStudentLearningLibraryClient({ownerId:scope.userId,credential:async()=>({...scope,accessToken:'synthetic-token'}),fetcher:async()=>response})
 response=new Response('<html>login</html>',{headers:{'Content-Type':'text/html'}});await assert.rejects(client.load(),e=>e.code==='invalid_response')
 response=json({...snap(),unexpected:true});await assert.rejects(client.load(),e=>e.code==='invalid_response')
 response=new Response('x'.repeat(cloud.STUDENT_LIBRARY_LIMITS.responseBytes+1),{headers:{'Content-Type':'application/json'}});await assert.rejects(client.load(),e=>e.code==='invalid_response')
 response=json({status:'ready',scope,runs:[],nextRunIds:['different']});await assert.rejects(client.getRuns(['run-1']),e=>e.code==='invalid_response')
 response=json(snap());Object.defineProperty(response,'redirected',{value:true});await assert.rejects(client.load(),e=>e.code==='invalid_response')
})

test('offline notes persist per owner, recover after refresh, converge once and contain no credentials',async()=>{
 const f=fixture();let controller=f.create();try{await controller.load();f.online=false;controller.edit(()=>doc());await controller.sync();assert.equal(controller.state().phase,'offline');assert.equal(controller.state().hasLocalChanges,true);const cached=[...f.storage.values.values()][0];assert.ok(cached.includes('Попит'));assert.ok(!cached.includes('accessToken'));assert.ok(!cached.includes('Bearer'));controller.dispose();controller=f.create();f.online=true;await controller.load();assert.equal(controller.state().document.notes[0].title,'Попит');await controller.sync();assert.equal(controller.state().phase,'saved');assert.equal(f.current.revision,1);assert.equal(f.saves,1);assert.equal(f.storage.values.size,0)}finally{controller.dispose()}
})

test('cross-device conflicts preserve both versions until an explicit selection',async()=>{
 const f=fixture(),a=f.create(),b=f.create({storage:memory()});try{await a.load();await b.load();a.edit(()=>doc('Пристрій А'));b.edit(()=>doc('Пристрій Б'));await a.sync();await b.sync();assert.equal(b.state().phase,'conflict');assert.equal(b.state().document.notes[0].title,'Пристрій Б');assert.equal(b.state().conflictSnapshot.document.notes[0].title,'Пристрій А');await b.sync();assert.equal(f.saves,2);b.keepLocalVersion();await b.sync();assert.equal(f.current.revision,2);assert.equal(f.current.document.notes[0].title,'Пристрій Б');await a.load();assert.equal(a.state().document.notes[0].title,'Пристрій Б');assert.equal(a.state().revision,undefined)}finally{a.dispose();b.dispose()}
})

test('unknown acknowledgement replays same durable mutation without a duplicate revision',async()=>{
 const f=fixture(),original=f.client.save;let drop=true;f.client.save=async(...args)=>{const result=await original(...args);if(drop){drop=false;throw new cloud.StudentLearningLibraryError('unavailable')}return result};const c=f.create();try{await c.load();c.edit(()=>doc());const mutation=JSON.parse(c.exportPending()).pending.mutationId;await c.sync();assert.equal(c.state().phase,'offline');assert.equal(f.current.revision,1);assert.equal(JSON.parse(c.exportPending()).pending.mutationId,mutation);await c.sync();assert.equal(c.state().phase,'saved');assert.equal(f.current.revision,1);assert.equal(f.saves,2)}finally{c.dispose()}
})

test('edits made during an in-flight save remain pending and rebase only on accepted revision',async()=>{
 const f=fixture(),gate=defer(),original=f.client.save;f.client.save=async(...args)=>{await gate.promise;return original(...args)};const c=f.create();try{await c.load();c.edit(()=>doc('Перший'));const saving=c.sync();await Promise.resolve();c.edit(()=>doc('Другий'));gate.resolve();await saving;assert.equal(c.state().phase,'pending');assert.equal(c.state().document.notes[0].title,'Другий');assert.equal(JSON.parse(c.exportPending()).pending.baseRevision,1);await c.sync();assert.equal(c.state().phase,'saved');assert.equal(f.current.revision,2);assert.equal(f.current.document.notes[0].title,'Другий')}finally{c.dispose()}
})

test('late GET cannot roll back an acknowledged cloud revision',async()=>{
 const f=fixture(),c=f.create();try{await c.load();const gate=defer();f.client.load=async()=>gate.promise;const reading=c.load();await Promise.resolve();c.edit(()=>doc());await c.sync();assert.equal(c.state().snapshot.revision,1);gate.resolve(snap());await reading;assert.equal(c.state().phase,'saved');assert.equal(c.state().snapshot.revision,1);assert.equal(c.state().document.notes[0].title,'Попит')}finally{c.dispose()}
})

test('a load observing our committed first edit does not conflict with a newer local edit',async()=>{
 const f=fixture(),c=f.create(),gate=defer(),original=f.client.save;try{await c.load();f.client.save=async(...args)=>{const result=await original(...args);await gate.promise;return result};c.edit(()=>doc('Перший'));const saving=c.sync();await Promise.resolve();c.edit(()=>doc('Другий'));await c.load();assert.equal(c.state().phase,'pending');gate.resolve();await saving;assert.equal(c.state().phase,'pending');await c.sync();assert.equal(f.current.revision,2);assert.equal(f.current.document.notes[0].title,'Другий')}finally{c.dispose()}
})

test('editing automatically syncs after a bounded debounce without another model call',async()=>{
 const f=fixture(),c=f.create({debounceMs:5});try{await c.load();c.edit(()=>doc());await new Promise(resolve=>setTimeout(resolve,35));assert.equal(c.state().phase,'saved');assert.equal(f.saves,1);assert.equal(f.current.revision,1)}finally{c.dispose()}
})

test('explicit server selection fences a late save response and restores the current server copy',async()=>{
 const f=fixture(),c=f.create(),gate=defer();try{await c.load();f.client.save=async()=>gate.promise;c.edit(()=>doc('Локальний'));const saving=c.sync();await Promise.resolve();f.current=snap(2,doc('Серверний'));await c.useServerVersion();gate.resolve(ack(1,doc('Локальний')));await saving;assert.equal(c.state().snapshot.revision,2);assert.equal(c.state().document.notes[0].title,'Серверний');assert.equal(c.state().hasLocalChanges,false)}finally{c.dispose()}
})

test('late ACK cannot overwrite a newer remote revision or hide its conflict',async()=>{
 const f=fixture(),c=f.create();try{await c.load();const gate=defer();f.client.save=async()=>gate.promise;c.edit(()=>doc('Локальний'));const saving=c.sync();await Promise.resolve();f.current=snap(2,doc('Інший пристрій'));await c.load();assert.equal(c.state().phase,'conflict');gate.resolve(ack(1,doc('Локальний')));await saving;assert.equal(c.state().phase,'conflict');assert.equal(c.state().snapshot.revision,2);assert.equal(c.state().document.notes[0].title,'Локальний');assert.equal(c.state().conflictSnapshot.document.notes[0].title,'Інший пристрій')}finally{c.dispose()}
})

test('expiry retains reading and export while client edit remains denied',async()=>{
 const f=fixture();f.current=snap(1,doc(),{canEdit:false});const c=f.create();try{await c.load();assert.equal(c.state().canEdit,false);assert.equal(c.state().document.notes[0].title,'Попит');assert.ok(c.exportPending().includes('Попит'));assert.throws(()=>c.edit(()=>doc('Зміна')),e=>e.code==='forbidden');assert.equal(f.saves,0)}finally{c.dispose()}
})

test('foreign-owner cache is never restored or exported and disposed requests do not paint data',async()=>{
 const f=fixture(),key='xelay:student-library:'+scope.userId+':v1';f.storage.setItem(key,JSON.stringify({version:1,ownerId:'owner-b',sessionId:'session-b',pending:{document:doc('Чужий запис'),baseRevision:0,mutationId:'mutation-b'}}));const c=f.create();assert.ok(!c.exportPending().includes('Чужий запис'));const gate=defer();f.client.load=()=>gate.promise;const loading=c.load();await Promise.resolve();c.dispose();gate.resolve(snap(1,doc('Пізня відповідь')));await loading;assert.equal(c.state().snapshot,null);assert.ok(!c.exportPending().includes('Пізня відповідь'))
})

test('broken same-owner cache is preserved for explicit recovery instead of silent replacement',async()=>{
 const f=fixture(),key='xelay:student-library:'+scope.userId+':v1',raw=JSON.stringify({version:1,ownerId:scope.userId,sessionId:scope.sessionId,pending:{document:{version:1,notes:[{...note(),text:'x'.repeat(20001)}],reviews:[]},baseRevision:0,mutationId:'mutation-a'}});f.storage.setItem(key,raw);const c=f.create();try{await c.load();assert.equal(c.state().phase,'error');assert.equal(c.state().hasLocalChanges,true);assert.equal(c.exportPending(),raw);await c.sync();assert.equal(f.saves,0);await c.useServerVersion();assert.equal(c.state().phase,'saved');assert.equal(c.state().hasLocalChanges,false)}finally{c.dispose()}
})

test('blocked local storage warns visibly and still permits exporting pending notes',async()=>{
 const f=fixture(),c=f.create({storage:{getItem:()=>null,setItem(){throw Error('Storage blocked')},removeItem(){}}});try{await c.load();f.online=false;c.edit(()=>doc());assert.equal(c.state().phase,'error');assert.match(c.state().error,/Завантаж копію/);await c.sync();assert.match(c.state().error,/не збережено на пристрої/);assert.ok(c.exportPending().includes('Попит'));assert.equal(c.state().hasLocalChanges,true)}finally{c.dispose()}
})

test('a revoked session stops further editing without dropping the pending export',async()=>{
 const f=fixture(),c=f.create();try{await c.load();c.edit(()=>doc());f.client.save=async()=>{throw new cloud.StudentLearningLibraryError('forbidden')};await c.sync();assert.equal(c.state().phase,'error');assert.equal(c.state().canEdit,false);assert.throws(()=>c.edit(()=>doc('Зміна')),e=>e.code==='forbidden');assert.ok(c.exportPending().includes('Попит'))}finally{c.dispose()}
})
