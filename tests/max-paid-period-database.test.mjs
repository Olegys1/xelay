import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'

const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')
const old=await read('202611160100_student_max_workspace.sql'),migration=await read('20261116155610_student_max_paid_period.sql')
const owner='71000000-0000-4000-8000-000000000001',other='71000000-0000-4000-8000-000000000002',session='71000000-0000-4000-8000-000000000101'
const hash=v=>createHash('sha256').update(v).digest('hex'),source={id:'own-note',title:'Мій конспект',text:'Підготовка, виконання, перевірка.',page:null,kind:'own_note'}
const request=n=>({requestId:'paid-period-'+n,mode:'quiz',prompt:'Створи тест за моїм конспектом.',sources:[source]})

test('Max allowance follows the paid window and migration preserves existing spending, pending work and grades',{timeout:120000},async t=>{
 const db=new PGlite()
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.uid()returns uuid language sql stable as $$select(auth.jwt()->>'sub')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt()to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
 create table public.profiles(id uuid primary key,account_type text default 'student');
 create function public.xelay_has_participant_access(u uuid)returns boolean language sql stable security definer as $$select false$$;
 create table public.official_grades(id integer primary key,score integer);insert into public.official_grades values(1,85),(2,92);
 insert into auth.users(id,email_confirmed_at)values('${owner}',now()),('${other}',now());insert into profiles(id)select id from auth.users;
 insert into auth.sessions(id,user_id)values('${session}','${owner}');`)
 await db.exec(old)
 const q=async(sql,args=[])=>(await db.query(sql,args)).rows
 const rpc=async(name,args=[])=>(await q(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args))[0].v
 const as=async(role,fn)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:owner,session_id:session,role})]);try{return await fn()}finally{await db.exec('reset role')}}
 const service=(name,args=[])=>as('service_role',()=>rpc(name,args)),call=(name,args=[])=>as('authenticated',()=>rpc(name,args))
 const reserve=(n,amount,cap=10000000)=>service('xelay_max_ai_reserve',[owner,hash(session),request(n).requestId,hash('content-'+n),amount,cap,request(n)])
 const finish=(n,row,charge)=>service('xelay_max_ai_finish',[owner,hash(session),request(n).requestId,hash('content-'+n),row.reservationId,charge,null,request(n)])
 try{
  await service('xelay_student_audience_assign',[owner,'student','Synthetic paid-period migration check'])
  const now=Date.now(),starts=new Date(now-86400000).toISOString(),ends=new Date(now+29*86400000).toISOString()
  await service('xelay_student_plan_grant',[owner,'max',starts,ends,'synthetic-paid-window'])
  await call('xelay_max_sources_put',[request(1).requestId,[source]])
  const first=await reserve(1,500000,6000000);await finish(1,first,123456)
  await call('xelay_max_sources_put',[request(2).requestId,[source]])
  const inFlight=await reserve(2,250000,6000000)
  const oldStart=old.indexOf('create function public.xelay_max_ai_reserve('),oldEnd=old.indexOf('end$$;',oldStart)+7
  await db.exec(old.slice(oldStart,oldEnd).replace('public.xelay_max_ai_reserve(', 'public.xelay_max_ai_reserve_before_migration('))
  await db.exec('revoke all on function public.xelay_max_ai_reserve_before_migration(uuid,text,text,text,bigint,bigint,jsonb) from public,anon,authenticated;grant execute on function public.xelay_max_ai_reserve_before_migration(uuid,text,text,text,bigint,bigint,jsonb)to service_role;')
  const finishStart=old.indexOf('create function public.xelay_max_ai_finish('),finishEnd=old.indexOf('end$$;',finishStart)+7
  await db.exec(old.slice(finishStart,finishEnd).replace('public.xelay_max_ai_finish(', 'public.xelay_max_ai_finish_before_migration('))
  await db.exec('revoke all on function public.xelay_max_ai_finish_before_migration(uuid,text,text,text,uuid,bigint,jsonb,jsonb) from public,anon,authenticated;grant execute on function public.xelay_max_ai_finish_before_migration(uuid,text,text,text,uuid,bigint,jsonb,jsonb)to service_role;')
  const before=(await q('select count(*)::int n,coalesce(sum(charge_micros),0)::text charges from xelay_student_private.requests'))[0]
  await db.exec(migration)
  await t.test('existing charges and pending reservations are carried into the same paid period',async()=>{
   const status=await call('xelay_student_workspace_status')
   assert.equal(status.planId,'max');assert.equal(status.budget.limitMicros,10000000)
   assert.equal(status.budget.spentMicros,123456);assert.equal(status.budget.reservedMicros,250000)
   assert.equal(status.budgetPeriod,'subscription_month');assert.equal(Date.parse(status.budgetResetsAt),Date.parse(ends))
   assert.deepEqual((await q('select count(*)::int n,coalesce(sum(charge_micros),0)::text charges from xelay_student_private.requests'))[0],before)
   await service('xelay_max_ai_finish_before_migration',[owner,hash(session),request(2).requestId,hash('content-2'),inFlight.reservationId,87654,null,request(2)])
   await finish(2,inFlight,87654)
   const usage=(await call('xelay_student_workspace_status')).budget
   assert.equal(usage.spentMicros,211110);assert.equal(usage.reservedMicros,0)
  })
  await t.test('old in-flight function body cannot insert an unmetered legacy reservation after migration',async()=>{
   await call('xelay_max_sources_put',[request(6).requestId,[source]])
   const before=await call('xelay_student_workspace_status')
   await assert.rejects(service('xelay_max_ai_reserve_before_migration',[owner,hash(session),request(6).requestId,hash('content-6'),500000,6000000,request(6)]),e=>e.code==='PT409')
   assert.equal((await q('select count(*)::int n from xelay_student_private.requests where request_id=$1',[request(6).requestId]))[0].n,0)
   assert.deepEqual((await call('xelay_student_workspace_status')).budget,before.budget)
  })
  await t.test('actual reserve path caps total at ten, rejects duplicate work and is owner/session restricted',async()=>{
   await call('xelay_max_sources_put',[request(3).requestId,[source]])
   await call('xelay_max_sources_put',[request(4).requestId,[source]])
   const row=await reserve(3,9788890);assert.equal(row.state,'reserved')
   assert.equal((await reserve(3,9788890)).state,'pending');assert.equal((await reserve(4,1)).state,'denied')
   await assert.rejects(reserve(4,10000001),e=>e.code==='22023')
   await assert.rejects(call('xelay_max_ai_reserve',[owner,hash(session),request(4).requestId,hash('content-4'),1,10000000,request(4)]),e=>e.code==='42501')
   await assert.rejects(service('xelay_max_ai_reserve',[owner,hash('foreign-session'),request(4).requestId,hash('content-4'),1,10000000,request(4)]),e=>e.code==='42501')
   await finish(3,row,9788890);assert.equal((await reserve(4,1)).state,'denied')
  })
  await t.test('late settlement charges its original grant even after the next period becomes active',async()=>{
   await db.exec(`update xelay_student_private.grants set revoked_at=now()where user_id='${owner}'`)
   await service('xelay_student_plan_grant',[owner,'max',new Date(Date.now()-10000).toISOString(),new Date(Date.now()+86400000).toISOString(),'late-settlement-origin'])
   await call('xelay_max_sources_put',[request(5).requestId,[source]])
   const pending=await reserve(5,500000)
   const originalGrant=(await q('select budget_grant_id from xelay_student_private.requests where request_id=$1',[request(5).requestId]))[0].budget_grant_id
   await db.query('update xelay_student_private.grants set revoked_at=now()where id=$1',[originalGrant])
   await service('xelay_student_plan_grant',[owner,'max',new Date(Date.now()-1000).toISOString(),new Date(Date.now()+2*86400000).toISOString(),'late-settlement-next'])
   await finish(5,pending,125000)
   assert.equal((await call('xelay_student_workspace_status')).budget.spentMicros,0)
   assert.equal((await q('select spent_micros,reserved_micros from xelay_student_private.period_usage where grant_id=$1',[originalGrant]))[0].spent_micros,125000)
   assert.equal((await q('select reserved_micros from xelay_student_private.period_usage where grant_id=$1',[originalGrant]))[0].reserved_micros,0)
  })
  await t.test('private ledger and helper are inaccessible through public API roles',async()=>{
   for(const role of ['anon','authenticated','service_role']){
    for(const privilege of ['select','insert','update','delete'])assert.equal((await q('select has_table_privilege($1,$2,$3) v',[role,'xelay_student_private.period_usage',privilege]))[0].v,false)
    assert.equal((await q('select has_function_privilege($1,$2,$3) v',[role,'xelay_student_private.max_budget_window(uuid,timestamptz)','execute']))[0].v,false)
   }
   assert.equal((await q("select relrowsecurity from pg_class where oid='xelay_student_private.period_usage'::regclass"))[0].relrowsecurity,true)
   assert.deepEqual(await q('select * from official_grades order by id'),[{id:1,score:85},{id:2,score:92}])
  })
  await t.test('calendar rollover, month-end and DST never create two allowances for one paid month',async()=>{
   await db.exec(`update xelay_student_private.grants set revoked_at=now()where user_id='${owner}';`)
   for(const [from,until,checks]of[
    ['2026-11-16T10:00:00+02:00','2026-12-16T10:00:00+02:00',['2026-11-30T23:59:59+02:00','2026-12-01T00:00:00+02:00','2026-12-16T09:59:59+02:00']],
    ['2027-01-31T10:00:00+02:00','2027-02-28T10:00:00+02:00',['2027-01-31T10:00:00+02:00','2027-02-01T10:00:00+02:00','2027-02-28T09:59:59+02:00']],
    ['2026-10-01T02:30:00+03:00','2026-11-01T02:30:00+02:00',['2026-09-30T23:30:01Z','2026-10-01T00:00:00Z','2026-10-31T23:59:59Z']],
   ]){
    const ref='window-'+from
    await service('xelay_student_plan_grant',[owner,'max',from,until,ref])
    const rows=[];for(const at of checks)rows.push((await q('select * from xelay_student_private.max_budget_window($1,$2)',[owner,at]))[0])
    assert.ok(rows.every(r=>r&&r.cycle===0));assert.equal(new Set(rows.map(r=>r.grant_id)).size,1)
    assert.ok(rows.every(r=>Date.parse(r.ends_at)===Date.parse(until)))
    assert.equal((await q('select * from xelay_student_private.max_budget_window($1,$2)',[owner,until])).length,0)
    await db.query('update xelay_student_private.grants set revoked_at=now()where reference=$1',[ref])
   }
  })
  await t.test('one paid grant remains one allowance when refund reflow shifts 31 days into a 30-day month or across DST',async()=>{
   await db.exec(`update xelay_student_private.grants set revoked_at=now()where user_id='${owner}'`)
   for(const [start,end,checks]of[
    ['2026-09-01T10:00:00+03:00','2026-10-02T10:00:00+03:00',['2026-09-30T12:00:00+03:00','2026-10-01T12:00:00+03:00']],
    ['2026-10-01T02:30:00+03:00','2026-11-01T02:30:00+02:00',['2026-09-30T23:30:00Z','2026-11-01T00:29:59Z']],
   ]){
    const ref='reflowed-paid-'+start
    await service('xelay_student_plan_grant',[owner,'max',start,end,ref])
    // The canonical paid activation is covered by full payment integration;
    // mark this isolated fixture's preserved window as a verified paid grant.
    await db.query("update xelay_student_private.grants set source='payment'where reference=$1",[ref])
    for(const at of checks){const row=(await q('select * from xelay_student_private.max_budget_window($1,$2)',[owner,at]))[0];assert.equal(row.cycle,0);assert.equal(Date.parse(row.ends_at),Date.parse(end))}
    await db.query('update xelay_student_private.grants set revoked_at=now()where reference=$1',[ref])
   }
  })
  await t.test('long gift windows renew from original Kyiv anniversary, short trial expires without a calendar refill',async()=>{
   await service('xelay_student_plan_grant',[owner,'max','2027-01-31T10:00:00+02:00','2027-04-30T10:00:00+03:00','long-synthetic-gift'])
   for(const [at,cycle]of[['2027-02-27T10:00:00+02:00',0],['2027-02-28T10:00:00+02:00',1],['2027-03-30T10:00:00+03:00',1],['2027-03-31T10:00:00+03:00',2]])assert.equal((await q('select * from xelay_student_private.max_budget_window($1,$2)',[owner,at]))[0].cycle,cycle)
   await db.exec(`update xelay_student_private.grants set revoked_at=now()where user_id='${owner}';`)
   await service('xelay_student_plan_grant',[owner,'max','2026-11-28T10:00:00+02:00','2026-12-05T10:00:00+02:00','short-synthetic-trial'])
   for(const at of ['2026-11-30T20:00:00Z','2026-12-01T00:00:00Z'])assert.equal((await q('select * from xelay_student_private.max_budget_window($1,$2)',[owner,at]))[0].cycle,0)
   assert.equal((await q('select * from xelay_student_private.max_budget_window($1,$2)',[other,'2026-12-01T00:00:00Z'])).length,0)
  })
 }finally{await db.close()}
})
