import test from 'node:test'
import assert from 'node:assert/strict'
import {createPlusBackendFixture,users,sessions,hash,plain,tutor} from './helpers/studentPlusBackend.mjs'

const request=(n,mode='chat')=>({requestId:'plus-db-'+n,mode,prompt:mode==='chat'?'Привіт':'Поясни попит і пропозицію',sources:[]})
const reserve=(f,r,amount=100000,cap=3000000,who='plus')=>f.service('xelay_max_ai_reserve',[users[who],hash(sessions[who]),r.requestId,hash(r.requestId),amount,cap,r],who)
const finish=(f,r,p,charge=3000,bundle=null,who='plus')=>f.service('xelay_max_ai_finish',[users[who],hash(sessions[who]),r.requestId,hash(r.requestId),p.reservationId,charge,bundle,r],who)
const status=(f,who='plus')=>f.own('xelay_student_workspace_status',[],who)

test('Plus migration preserves existing Max reservations, grades and lifetime gifts',{timeout:120000},async()=>{
 const f=await createPlusBackendFixture({applyPlus:false})
 try{
  const r=request('before'),p=await reserve(f,r,400000,10000000,'max')
  assert.equal(p.state,'reserved')
  const before=await status(f,'max'),legacy=await status(f,'legacy')
  await f.applyPlus()
  assert.deepEqual((await status(f,'max')).budget,before.budget)
  assert.equal((await status(f)).monthlyAiBudgetUsd,3)
  assert.equal((await status(f,'max')).monthlyAiBudgetUsd,10)
  assert.deepEqual(await status(f,'legacy'),legacy)
  assert.equal((await status(f,'legacy')).aiAllowance,'pending_legacy_policy')
  assert.equal((await status(f,'teacher')).planId,'free')
  assert.equal((await f.rows('select budget_limit_micros from xelay_student_private.requests where request_id=$1',[r.requestId]))[0].budget_limit_micros,10000000)
  assert.equal((await finish(f,r,p,123456,null,'max')).settled,true)
  assert.equal((await status(f,'max')).budget.spentMicros,123456)
  assert.deepEqual(await f.rows('select * from official_grades order by id'),[{id:1,score:85},{id:2,score:92}])
 }finally{await f.close()}
})

test('Plus is metered against one paid window, without calendar resets or access to an old Max wallet',{timeout:120000},async t=>{
 const f=await createPlusBackendFixture()
 try{
  await t.test('actual reservation caps at three dollars, duplicates do not spend twice, and old wallet stays untouched',async()=>{
   await f.db.query('insert into xelay_student_private.credit_wallets(user_id,granted_micros)values($1,5000000)',[users.plus])
   const r=request('cap'),p=await reserve(f,r,3000000,10000000)
   assert.equal(p.state,'reserved')
   assert.equal((await reserve(f,r,3000000,10000000)).state,'pending')
   assert.equal((await reserve(f,request('over-cap'),1,10000000)).state,'denied')
   assert.equal((await f.rows('select budget_limit_micros,wallet_reserve_micros from xelay_student_private.requests where request_id=$1',[r.requestId]))[0].budget_limit_micros,3000000)
   assert.equal((await finish(f,r,p,3000000)).settled,true)
   assert.equal((await finish(f,r,p,3000000)).replayed,true)
   assert.equal((await reserve(f,request('after-cap'),1,10000000)).state,'denied')
   assert.deepEqual((await status(f)).budget,{limitMicros:3000000,spentMicros:3000000,reservedMicros:0})
   assert.deepEqual(await f.rows('select granted_micros,spent_micros,reserved_micros from xelay_student_private.credit_wallets where user_id=$1',[users.plus]),[{granted_micros:5000000,spent_micros:0,reserved_micros:0}])
  })
  await t.test('one verified payment stays cycle zero across calendar month, short February and DST',async()=>{
   await f.db.query('update xelay_student_private.grants set revoked_at=clock_timestamp() where user_id=$1',[users.other])
   for(const [from,until,checks] of [
    ['2026-11-16T10:00:00+02:00','2026-12-16T10:00:00+02:00',['2026-11-30T23:59:59+02:00','2026-12-01T00:00:00+02:00']],
    ['2027-01-31T10:00:00+02:00','2027-03-03T10:00:00+02:00',['2027-02-01T10:00:00+02:00','2027-03-01T10:00:00+02:00']],
    ['2026-10-01T02:30:00+03:00','2026-11-01T02:30:00+02:00',['2026-10-01T00:00:00Z','2026-10-31T23:59:59Z']],
   ]){
    await f.grant('other','plus',from,until,'paid-window-'+from)
    const rows=await f.rows('select id from xelay_student_private.grants where user_id=$1 and reference=$2',[users.other,'paid-window-'+from])
    assert.equal(rows.length,1)
    await f.db.query("update xelay_student_private.grants set source='payment' where id=$1",[rows[0].id])
    for(const at of checks){const windows=await f.rows('select * from xelay_student_private.max_budget_window($1,$2)',[users.other,at]);assert.equal(windows.length,1);assert.equal(windows[0].cycle,0);assert.equal(windows[0].grant_id,rows[0].id);assert.equal(Date.parse(windows[0].ends_at),Date.parse(until))}
    await f.db.query('update xelay_student_private.grants set revoked_at=clock_timestamp() where id=$1',[rows[0].id])
   }
  })
 }finally{await f.close()}
})

test('Plus request, output, owner and session boundaries are enforced by SQL',{timeout:120000},async t=>{
 const f=await createPlusBackendFixture()
 try{
  await t.test('premium modes and formats cannot be reserved through the service RPC',async()=>{
   for(const mode of ['plan','math'])assert.equal((await reserve(f,request(mode,mode))).state,'denied')
   const format={...request('format','quiz'),studyFormat:'true_false'}
   assert.equal((await reserve(f,format)).state,'denied')
   const source={id:'source-one',title:'Конспект',kind:'own_excerpt',page:null,text:'Попит — залежність кількості від ціни.'}
   await assert.rejects(f.own('xelay_max_sources_put',['plus-two-sources',[source,{...source,id:'source-two'}]]),e=>e.code==='42501')
   assert.deepEqual(await f.own('xelay_max_sources_put',['plus-no-sources',[]]),[])
  })
  await t.test('authenticated clients cannot reserve or settle, and foreign sessions cannot impersonate the owner',async()=>{
   const r=request('owner')
   await assert.rejects(f.own('xelay_max_ai_reserve',[users.plus,hash(sessions.plus),r.requestId,hash(r.requestId),100,3000000,r]),e=>e.code==='42501')
   await assert.rejects(f.service('xelay_max_ai_reserve',[users.plus,hash(sessions.other),r.requestId,hash(r.requestId),100,3000000,r]),e=>e.code==='42501')
   for(const fn of ['student_ai_request_allowed(text,jsonb)','student_ai_bundle_allowed(text,jsonb,jsonb)'])for(const role of ['anon','authenticated','service_role'])assert.equal((await f.rows('select has_function_privilege($1,$2,$3)v',[role,'xelay_student_private.'+fn,'execute']))[0].v,false)
  })
  await t.test('a valid but premium bundle is charged and refused, while a permitted bundle is saved privately',async()=>{
   const r=request('premium-output','quiz'),p=await reserve(f,r)
   const bundle=plain(tutor.createTutorDemo('plus-demo','quiz').bundle)
   for(const q of bundle.questions)q.sourceId=''
   for(const c of bundle.cards)c.sourceId=''
   bundle.citations=[]
   assert.equal((await finish(f,r,p,3000,bundle)).stored,false)
   const next=request('allowed-output','quiz'),np=await reserve(f,next)
   bundle.plan=[];bundle.math=null
   assert.equal((await finish(f,next,np,3000,bundle)).stored,true)
   assert.equal((await f.own('xelay_max_runs_list',[12])).length,1)
   assert.equal((await f.own('xelay_max_runs_list',[12],'other')).length,0)
   await f.db.query('update xelay_student_private.grants set revoked_at=clock_timestamp() where user_id=$1',[users.plus])
   assert.equal((await status(f)).planId,'free')
   assert.equal((await f.own('xelay_max_runs_list',[12]))[0].id,next.requestId)
  })
 }finally{await f.close()}
})

test('settlement stays in its original Plus window after upgrade and Max purchased credits still work',{timeout:120000},async()=>{
 const f=await createPlusBackendFixture()
 try{
  const r=request('upgrade'),p=await reserve(f,r)
  const original=(await f.rows('select budget_grant_id,budget_limit_micros from xelay_student_private.requests where request_id=$1',[r.requestId]))[0]
  await f.grant('plus','max',undefined,undefined,'upgrade-to-max')
  assert.equal((await status(f)).planId,'max')
  await finish(f,r,p,25000)
  assert.equal((await status(f)).budget.spentMicros,0)
  assert.equal((await f.rows('select spent_micros,reserved_micros from xelay_student_private.period_usage where grant_id=$1',[original.budget_grant_id]))[0].spent_micros,25000)
  assert.equal(original.budget_limit_micros,3000000)
  await f.db.query('insert into xelay_student_private.credit_wallets(user_id,granted_micros)values($1,5000000)',[users.max])
  const maxRequest=request('max-credits'),mp=await reserve(f,maxRequest,10000000,10000000,'max')
  await finish(f,maxRequest,mp,10000000,null,'max')
  const topup=request('max-topup'),tp=await reserve(f,topup,1000000,10000000,'max')
  assert.equal(tp.state,'reserved')
  await finish(f,topup,tp,500000,null,'max')
  assert.deepEqual(await f.rows('select granted_micros,spent_micros,reserved_micros from xelay_student_private.credit_wallets where user_id=$1',[users.max]),[{granted_micros:5000000,spent_micros:500000,reserved_micros:0}])
 }finally{await f.close()}
})
