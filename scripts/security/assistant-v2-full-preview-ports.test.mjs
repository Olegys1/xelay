import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { createFullSyntheticAssistantPorts } from '../assistant-full-preview-ports.mjs'
const uid=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const identities={student:{id:uid(1),name:'Олександра Тестова'},representative:{id:uid(2),name:'Марко Приклад'},teacher:{id:uid(3),name:'Ірина Прикладова'}}
const token=id=>'synthetic-preview-only-'+id,now=()=>Date.parse('2026-11-01T12:00:00Z'),binding=d=>({id:d.id,revision:d.revision,confirmationToken:d.confirmationToken})
async function setup(t,extra={}){const dir=await mkdtemp(path.join(os.tmpdir(),'xelay-full-preview-'));t.after(async()=>{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'xelay-full-preview-'));await rm(dir,{recursive:true,force:true})});const result=await createFullSyntheticAssistantPorts({stateDirectory:dir,identities,token,now,...extra});return {...result,dir,student:token(uid(1)),headman:token(uid(2)),teacher:token(uid(3))}}

test('full local preview uses real cloud confirmation and shared fictional rows across authorized roles',async t=>{
 const f=await setup(t),{GROUP,LESSON}=f.ids,day='2026-11-02',scope={groupId:GROUP,date:day}
 const prepared=await f.ports.writes.prepare(f.headman,{action:'homework.upsert',scope,payload:{lessonId:LESSON,date:day,topic:'Змінена тема',body:'Якщо буде пара, прочитайте. Інакше не здавайте.',dueAt:null}})
 assert.equal((await f.ports.read(f.student,{topic:'study',scope:{groupId:GROUP,from:day,to:day}})).records.find(r=>r.kind==='homework').title,'Практична робота № 3')
 assert.equal((await f.ports.writes.confirm(f.headman,binding(prepared.draft))).status,'confirmed')
 const current=await f.ports.read(f.student,{topic:'study',scope:{groupId:GROUP,from:day,to:day}});assert.equal(current.records.find(r=>r.kind==='homework').body,prepared.draft.payload.body)
 const restarted=await createFullSyntheticAssistantPorts({stateDirectory:f.dir,identities,token,now});assert.equal((await restarted.ports.writes.confirm(f.headman,binding(prepared.draft))).status,'confirmed');assert.equal((await restarted.ports.read(f.student,{topic:'study',scope:{groupId:GROUP,from:day,to:day}})).records.filter(r=>r.kind==='homework').length,1)
 await assert.rejects(f.ports.writes.get(f.student,prepared.draft.id),e=>e.code==='draft_not_found')
})
test('full preview keeps teacher distribution hidden and offers all eleven read-topic families by role',async t=>{
 const f=await setup(t),{GROUP,COURSE}=f.ids
 await assert.rejects(f.ports.read(f.teacher,{topic:'seminars',scope:{groupId:GROUP}}),e=>e.code==='access_denied')
 await assert.rejects(f.ports.read(f.student,{topic:'gradebook',scope:{groupId:GROUP,courseId:COURSE}}),e=>e.code==='access_denied')
 for(const topic of ['study','materials','results','seminars','organizer','community','news','opportunities','help'])assert.ok(Array.isArray((await f.ports.read(f.student,{topic,scope:{groupId:GROUP}})).records))
 for(const topic of ['teaching','materials','gradebook'])assert.ok(Array.isArray((await f.ports.read(f.teacher,{topic,scope:{groupId:GROUP,courseId:COURSE}})).records))
 assert.equal((await f.ports.catalog(await f.ports.verifySession(f.headman))).groups[0].permissions.includes('seminars'),true)
})
test('no paid call happens at preview startup; material explanation waits for explicit current author consent',async t=>{
 let calls=0;const f=await setup(t,{taskModel:async(_credential,_requestId,task)=>{calls++;assert.equal(task.task,'explain');return{safe:true,answer:'Похідна показує швидкість зміни функції.',quotes:['Похідна показує швидкість зміни функції.']}}}),{MATERIAL,GROUP,COURSE}=f.ids,scope={groupId:GROUP,courseId:COURSE}
 assert.equal(calls,0);await assert.rejects(f.ports.tools.explainMaterial(f.student,{requestId:uid(999),scope:{groupId:GROUP},materialId:MATERIAL}),e=>e.code==='material_ai_not_allowed');assert.equal(calls,0)
 const form=await f.ports.writes.form(f.teacher,{action:'teaching.material.ai',scope,payload:{id:MATERIAL}}),prepared=await f.ports.writes.prepare(f.teacher,{action:'teaching.material.ai',scope,payload:{...form.form.payload,allow:true}})
 assert.equal((await f.ports.writes.confirm(f.teacher,binding(prepared.draft))).status,'confirmed')
 const result=await f.ports.tools.explainMaterial(f.student,{requestId:uid(999),scope:{groupId:GROUP},materialId:MATERIAL});assert.equal(calls,1);assert.match(result.text,/Похідна/)
 const change=await f.ports.writes.prepare(f.teacher,{action:'teaching.material.upsert',scope,payload:{id:MATERIAL,version:2,title:'Оновлена версія'}});await f.ports.writes.confirm(f.teacher,{...binding(change.draft),acceptMaterialRights:true})
 await assert.rejects(f.ports.tools.explainMaterial(f.student,{requestId:uid(998),scope:{groupId:GROUP},materialId:MATERIAL}),e=>e.code==='material_ai_not_allowed');assert.equal(calls,1)
})
test('fictional file receipt is issued only after actual local content checks; working storage is never called',async t=>{
 const f=await setup(t),origin='http://127.0.0.1:3079',url=new URL(`/__assistant-fixture/upload?courseId=${f.ids.COURSE}&name=notes.txt`,origin)
 async function upload(content,name='notes.txt'){const req=Readable.from([Buffer.from(content)]);req.method='POST';req.headers={origin,authorization:'Bearer '+f.teacher,'content-type':'text/plain','content-length':String(Buffer.byteLength(content))};const res={writeHead(s){this.status=s},end(body){this.body=JSON.parse(body)}};const target=new URL(url);target.searchParams.set('name',name);await f.uploadFixture(req,res,target,origin);return res}
 const good=await upload('Це вигаданий навчальний текст.');assert.equal(good.status,200);assert.equal(good.body.syntheticOnly,true);assert.equal(good.body.contentChecked,true);assert.ok(f.fixtures.get(uid(3)).state.verifiedFiles.has(good.body.file.storage_path))
 const bad=await upload('<script>alert(1)</script>');assert.equal(bad.status,422);assert.equal(bad.body.file,undefined)
})
