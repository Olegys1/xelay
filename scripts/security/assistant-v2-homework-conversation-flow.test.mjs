// Actual chat + HTTP handler + confirmed writes + fictional business transport.
// No provider, credentials, production client, network listener or external call.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFullSyntheticAssistantPorts } from '../assistant-full-preview-ports.mjs'
import { createAssistantCloudHandler } from '../../server/assistant-v2/cloudHandler.ts'

const uid=n=>`20000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const identities={student:{id:uid(1),name:'Студентка Приклад'},representative:{id:uid(2),name:'Староста Приклад'},teacher:{id:uid(3),name:'Викладач Приклад'}}
const NOW=Date.parse('2026-11-01T09:00:00Z'),TOMORROW='2026-11-02',FRIDAY='2026-11-06'
const token=id=>'synthetic-homework-flow-'+id
const bind=draft=>({id:draft.id,revision:draft.revision,confirmationToken:draft.confirmationToken})
async function fixture(t){
 const parent=path.join(fileURLToPath(new URL('../../',import.meta.url)),'.security-ci.local','homework-flow')
 await mkdir(parent,{recursive:true});const stateDirectory=await mkdtemp(path.join(parent,'case-'))
 assert.ok(path.resolve(stateDirectory).startsWith(path.resolve(parent)+path.sep))
 t.after(()=>rm(stateDirectory,{recursive:true,force:true}))
 const state={intent:{kind:'read',topic:'study',view:'homework',date:TOMORROW},modelCalls:0}
 const synthetic=await createFullSyntheticAssistantPorts({stateDirectory,identities,token,now:()=>NOW,planner:async()=>{state.modelCalls++;return structuredClone(state.intent)}})
 const handler=createAssistantCloudHandler({enabled:true,trustedOrigins:['https://www.xelay.ink'],ports:synthetic.ports,now:()=>NOW})
 async function request(actor,route,body){
  const res=new EventEmitter();res.writableEnded=false;res.destroyed=false
  res.writeHead=(status,headers)=>{res.status=status;res.headers=headers};res.end=raw=>{res.writableEnded=true;res.raw=raw;res.value=JSON.parse(raw)}
  await handler({method:body?'POST':'GET',url:'/api/assistant?route='+route,headers:{authorization:'Bearer '+token(identities[actor].id),origin:'https://www.xelay.ink','content-type':'application/json','sec-fetch-site':'same-origin'},...(body?{body}:{})},res)
  assert.equal(res.headers['cache-control'],'private, no-store, max-age=0')
  assert.ok(!res.raw.includes(token(identities[actor].id)),'response does not expose credentials')
  return res
 }
 const chat=(actor,message,continuation)=>request(actor,'chat',{message,requestId:randomUUID(),...(continuation?{continuation}:{})})
 return{...synthetic,state,request,chat}
}

test('the reported homework conversation keeps tomorrow and returns no lesson cards through the HTTP boundary',async t=>{
 const f=await fixture(t)
 let res=await f.chat('student','что на завтра задали мне?')
 assert.equal(res.status,200);assert.equal(res.value.kind,'read');assert.ok(res.value.read.records.length)
 assert.ok(res.value.read.records.every(row=>row.kind==='homework'&&row.date===TOMORROW))
 assert.doesNotMatch(res.value.text,/пар немає|записи, доступні/)
 let continuation=res.value.continuation
 for(const message of ['я попросил только дз дать','дз мне напиши только','на зщавтра дз напиши мне']){
  res=await f.chat('student',message,continuation)
  assert.equal(res.status,200,message);assert.equal(res.value.kind,'read',message)
  assert.ok(res.value.read.records.length,message)
  assert.ok(res.value.read.records.every(row=>row.kind==='homework'&&row.date===TOMORROW),message)
  continuation=res.value.continuation
 }
 const greeting=await f.chat('student','привет',continuation)
 assert.equal(greeting.value.kind,'reply');assert.ok(greeting.value.continuation)
 res=await f.chat('student','дз',greeting.value.continuation)
 assert.equal(res.status,200);assert.ok(res.value.read.records.every(row=>row.kind==='homework'&&row.date===TOMORROW))
 assert.equal(f.fixtures.get(identities.student.id).state.writes.length,0)
})

test('a representative drafts, edits, confirms exactly once, then reads the saved homework without lesson noise',async t=>{
 const f=await fixture(t),headman=f.fixtures.get(identities.representative.id),tables=headman.state.tables
 const prior=structuredClone(tables.study_group_homework)
 const body='Розв’язати вправи 1–4. Якщо немає світла, можна здати усно.\nОберіть лише одну форму.'
 f.state.intent={kind:'homework',subject:'Вища математика',date:TOMORROW}
 let res=await f.chat('representative','Додай ДЗ з вищої математики на завтра: '+body)
 assert.equal(res.status,200);assert.equal(res.value.kind,'draft')
 const first=res.value.draft
 assert.equal(first.payload.body,body);assert.equal(first.payload.date,TOMORROW)
 assert.deepEqual(tables.study_group_homework,prior,'preparation is not a group write')
 const reviewed=body+'\nВізьміть конспект.'
 res=await f.request('representative','drafts/edit',{...bind(first),payload:{...first.payload,body:reviewed}})
 assert.equal(res.status,200);const edited=res.value.draft
 assert.equal(edited.revision,first.revision+1);assert.deepEqual(tables.study_group_homework,prior)
 const stale=await f.request('representative','drafts/confirm',bind(first))
 assert.equal(stale.status,409);assert.deepEqual(tables.study_group_homework,prior)
 res=await f.request('representative','drafts/confirm',bind(edited))
 assert.equal(res.status,200);assert.equal(res.value.status,'confirmed')
 const writes=headman.state.writes.length,after=structuredClone(tables.study_group_homework)
 assert.equal(after.find(row=>row.schedule_item_id===edited.payload.lessonId&&row.lesson_date===TOMORROW)?.body,reviewed)
 const repeated=await f.request('representative','drafts/confirm',bind(edited))
 assert.equal(repeated.status,200);assert.equal(repeated.value.status,'confirmed')
 assert.equal(headman.state.writes.length,writes);assert.deepEqual(tables.study_group_homework,after)
 f.state.intent={kind:'read',topic:'study',view:'homework',date:TOMORROW}
 res=await f.chat('student','Що на завтра задали?')
 assert.equal(res.status,200);assert.ok(res.value.read.records.every(row=>row.kind==='homework'))
 assert.ok(res.value.read.records.some(row=>row.body===reviewed))
})

test('homework read refinements do not grant write rights or accept another account continuation',async t=>{
 const f=await fixture(t),headman=f.fixtures.get(identities.representative.id),before=structuredClone(headman.state.tables.study_group_homework)
 const first=await f.chat('representative','Яке ДЗ на завтра?')
 const stolen=await f.chat('student','тільки ДЗ',first.value.continuation)
 assert.equal(stolen.status,409)
 f.state.intent={kind:'homework',subject:'Вища математика',date:TOMORROW}
 const denied=await f.chat('student','Додай ДЗ з вищої математики на завтра: нове завдання')
 assert.equal(denied.status,200);assert.equal(denied.value.kind,'unsupported');assert.equal(denied.value.draft,undefined)
 assert.deepEqual(headman.state.tables.study_group_homework,before)
})

test('rights revoked after review prevent a representative confirmation from writing homework',async t=>{
 const f=await fixture(t),headman=f.fixtures.get(identities.representative.id),before=structuredClone(headman.state.tables.study_group_homework)
 f.state.intent={kind:'homework',subject:'Вища математика',date:TOMORROW}
 const prepared=await f.chat('representative','Додай ДЗ з вищої математики на завтра: перечитати приклад')
 assert.equal(prepared.status,200);assert.equal(prepared.value.kind,'draft')
 headman.state.rights=[]
 const denied=await f.request('representative','drafts/confirm',bind(prepared.value.draft))
 assert.notEqual(denied.status,200);assert.deepEqual(headman.state.tables.study_group_homework,before)
})
