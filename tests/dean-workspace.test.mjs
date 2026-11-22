import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createTeachingScopedFixture } from '../scripts/security/teaching-scoped-fixture.mjs'
import { parseDeanSource, deanPublicationRows } from '../src/lib/deanWorkspace.ts'

test('dean import rejects ambiguity and preserves individual recipients',()=>{
 const source={students:[{id:'a',name:'Synthetic A',group:'A'},{id:'b',name:'Synthetic B',group:'B'}],events:[{id:'e',course:'Math',activity:'lecture',teacher:'Teacher',teacherIds:['t'],studentIds:['a','b'],day:1,period:1,weeks:[1,2]}]}
 const parsed=parseDeanSource(source)
 assert.equal(deanPublicationRows(parsed,{a:{userId:'1',groupId:'a'},b:{userId:'2',groupId:'b'}},'2027-02-01').length,4)
 assert.throws(()=>deanPublicationRows(parsed,{},'2027-02-01'))
 assert.throws(()=>deanPublicationRows(parsed,{a:{userId:'1',groupId:'a'},b:{userId:'1',groupId:'b'}},'2027-02-01'))
 assert.throws(()=>deanPublicationRows(parsed,{},'2027-02-02'))
 assert.throws(()=>parseDeanSource({...source,events:[...source.events,{...source.events[0],id:'e2'}]}))
 assert.throws(()=>parseDeanSource({...source,events:[{...source.events[0],activity:'unknown'}]}))
})

test('dean full PostgreSQL flow: scoped MFA, immutable drafts, review and explicit approval, private projection', {timeout:120000}, async t=>{
 const fx=await createTeachingScopedFixture();t.after(()=>fx.close());const {db,ids,groups}=fx
 await db.exec('create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz)')
 const sessions={};for(const user of [ids.admin,ids.owner,ids.studentA,ids.studentB,ids.outsider]){sessions[user]=randomUUID();await db.query('insert into auth.sessions values($1,$2,null)',[sessions[user],user])}
 await db.query("insert into auth.mfa_factors(user_id,status,factor_type)values($1,'verified','totp')",[ids.owner])
 await db.exec(await readFile(new URL('../supabase/migrations/20261122184146_dean_workspace.sql',import.meta.url),'utf8'))
 async function invoke(user,name,args,aal='aal2'){
  await db.exec('set role authenticated');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:sessions[user],aal,role:'authenticated'})])
  try{return(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result}finally{await db.exec('reset role')}
 }
 const call=(action,payload={},user=ids.admin,aal='aal2')=>invoke(user,'xelay_dean_workspace',[action,JSON.stringify(payload)],aal)
 const personal=(user,group)=>invoke(user,'xelay_dean_personal_lessons',[group,null],'aal1')
 const original=JSON.stringify((await db.query('select * from study_group_schedule order by id')).rows)
 let draft
 const row=(period,user=ids.studentA,group=groups[0])=>({sourceId:'e'+period,groupId:group,userIds:[user],subject:'Synthetic math',teacher:'Synthetic teacher',teacherIds:['synthetic-t'],activity:'lecture',date:'2027-02-01',period})
 const doc={rows:['2027-02-01','2027-02-02','2027-02-03'].flatMap(date=>[1,2].map(p=>({...row(p),date}))),source:{events:[],students:[]},mapping:{},monday:'2027-02-01'}
 await t.test('anonymous, nonstaff, aal1, expired sessions and direct table reads are denied',async()=>{
  await assert.rejects(call('catalog',{},ids.outsider),/DEAN_MFA_REQUIRED/)
  await assert.rejects(call('catalog',{},ids.admin,'aal1'),/DEAN_MFA_REQUIRED/)
  await db.query("update auth.sessions set not_after=now()-interval '1 minute' where user_id=$1",[ids.owner])
  await assert.rejects(call('catalog',{},ids.owner),/DEAN_MFA_REQUIRED/)
  await db.query('update auth.sessions set not_after=null where user_id=$1',[ids.owner])
  await db.exec('set role anon');try{await assert.rejects(db.query("select public.xelay_dean_workspace('catalog','{}')"),/permission denied/)}finally{await db.exec('reset role')}
  await db.exec('set role authenticated');try{await assert.rejects(db.query('select * from dean_private.drafts'),/permission denied/)}finally{await db.exec('reset role')}
 })
 await t.test('staff grants are limited to one group; only admin may manage them',async()=>{
  await call('grant',{userId:ids.owner,groupId:groups[0],enabled:true})
  assert.deepEqual((await call('catalog',{},ids.owner)).groups.map(g=>g.id),[groups[0]])
  await assert.rejects(call('grant',{userId:ids.outsider,groupId:groups[1],enabled:true},ids.owner),/DEAN_ADMIN_REQUIRED/)
 })
 await t.test('save, reload, stale revision, cross-owner access and confirmation boundary',async()=>{
  draft=await call('create',{title:'Synthetic draft',document:doc},ids.owner)
  assert.deepEqual((await call('load',{id:draft.id},ids.owner)).document,doc)
  await assert.rejects(call('publish',{id:draft.id,revision:1},ids.owner),/DEAN_APPROVAL_REQUIRED/)
  assert.deepEqual(await personal(ids.studentA,groups[0]),[])
  await assert.rejects(call('save',{id:draft.id,revision:9,document:doc},ids.owner),/DEAN_STALE_VERSION/)
  await assert.rejects(call('approve',{id:draft.id,revision:1,confirmation:'ПІДТВЕРДЖУЮ 1'},ids.owner),/DEAN_CONFIRMATION_REQUIRED/)
 })
 await t.test('server rejects scope tampering, removed membership, gaps and conflicts',async()=>{
  for(const [rows,expected] of [[[row(1,ids.studentB,groups[1]),row(2,ids.studentB,groups[1])],/DEAN_SCOPE_DENIED/],[[row(1,ids.outsider),row(2,ids.outsider)],/DEAN_ROSTER_CHANGED/],[[row(1),row(3)],/DEAN_DAY_GAPS_OR_LOAD/],[[row(1),row(1)],/DEAN_STUDENT_CONFLICT/]]){
   const bad=await call('create',{title:'Invalid candidate',document:{...doc,rows}},ids.owner)
   await assert.rejects(call('review',{id:bad.id,revision:1},ids.owner),expected)
  }
 })
 await t.test('approval is bound to exact revision; save revokes it',async()=>{
  assert.equal((await call('review',{id:draft.id,revision:1},ids.owner)).passed,true)
  await call('approve',{id:draft.id,revision:1,confirmation:'ПІДТВЕРДЖУЮ 1'})
  draft=await call('save',{id:draft.id,revision:1,document:doc},ids.owner)
  assert.equal(draft.approved_revision,null)
  await assert.rejects(call('publish',{id:draft.id,revision:2},ids.owner),/DEAN_APPROVAL_REQUIRED/)
 })
 await t.test('published projection survives reload, is idempotent and only visible to its student',async()=>{
  await call('approve',{id:draft.id,revision:2,confirmation:'ПІДТВЕРДЖУЮ 2'})
  await call('publish',{id:draft.id,revision:2},ids.owner)
  await call('publish',{id:draft.id,revision:2},ids.owner)
  const lessons=await personal(ids.studentA,groups[0]);assert.equal(lessons.length,6);assert.equal(lessons[0].dean_managed,true);assert.equal('user_ids' in lessons[0],false)
  assert.deepEqual(await personal(ids.studentB,groups[1]),[])
  assert.deepEqual(await personal(ids.outsider,groups[0]),[])
  await assert.rejects(call('save',{id:draft.id,revision:2,document:doc},ids.owner),/DEAN_PUBLISHED_IMMUTABLE/)
  assert.equal(JSON.stringify((await db.query('select * from study_group_schedule order by id')).rows),original)
  await call('grant',{userId:ids.owner,groupId:groups[0],enabled:false})
  await assert.rejects(call('load',{id:draft.id},ids.owner),/DEAN_ACCESS_DENIED/)
 })
})
