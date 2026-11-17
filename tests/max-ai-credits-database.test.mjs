import test from'node:test'
import assert from'node:assert/strict'
import{readFile}from'node:fs/promises'
import{createHash}from'node:crypto'
import{PGlite}from'@electric-sql/pglite'
const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')
const foundation=await read('202611160100_student_max_workspace.sql'),period=await read('20261116155610_student_max_paid_period.sql'),credits=await read('20261117105257_student_max_ai_credits.sql')
const owner='76000000-0000-4000-8000-000000000001',other='76000000-0000-4000-8000-000000000002',session='76000000-0000-4000-8000-000000000101'
const hash=v=>createHash('sha256').update(v).digest('hex'),ref=n=>'xtop_76000000-0000-4000-8000-'+String(n).padStart(12,'0')
const source={id:'own-note',title:'Конспект',text:'Підготовка визначає мету. Виконання створює результат.',page:null,kind:'own_note'},request=n=>({requestId:'credits-request-'+n,mode:'quiz',prompt:'Створи тест за конспектом.',sources:[source]})
test('real PostgreSQL credit ledger preserves subscription allowance and enforces paid wallet boundaries',{timeout:120000},async t=>{
 const db=new PGlite()
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.uid()returns uuid language sql stable as $$select(auth.jwt()->>'sub')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt()to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create table public.profiles(id uuid primary key,account_type text default'student');
 create function public.xelay_has_participant_access(uuid)returns boolean language sql stable security definer as $$select false$$;
 create table public.official_grades(id integer primary key,score integer);insert into public.official_grades values(1,85),(2,92);
 insert into auth.users(id,email_confirmed_at)values('${owner}',now()),('${other}',now());insert into profiles(id)select id from auth.users;
 insert into auth.sessions(id,user_id)values('${session}','${owner}');`)
 await db.exec(foundation);await db.exec(period)
 const rows=async(s,a=[])=>(await db.query(s,a)).rows
 const as=async(role,fn,user=owner)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:session,role})]);try{return await fn()}finally{await db.exec('reset role')}}
 const rpc=(name,a=[])=>as('service_role',async()=>(await rows(`select public.${name}(${a.map((_,i)=>'$'+(i+1)).join(',')})v`,a))[0].v)
 const own=(name,a=[])=>as('authenticated',async()=>(await rows(`select public.${name}(${a.map((_,i)=>'$'+(i+1)).join(',')})v`,a))[0].v)
 const reserve=async(n,amount)=>{await own('xelay_max_sources_put',[request(n).requestId,[source]]);return rpc('xelay_max_ai_reserve',[owner,hash(session),request(n).requestId,hash('credits-'+n),amount,10000000,request(n)])}
 const finish=(n,row,charge)=>rpc('xelay_max_ai_finish',[owner,hash(session),request(n).requestId,hash('credits-'+n),row.reservationId,charge,null,request(n)])
 const create=(n,pack='credits_1000',mode='live',user=owner)=>rpc('xelay_create_max_credit_order',[user,mode,ref(n),pack,'2026-11-17.1'])
 let event=0
 const apply=(order,status='Approved',amount=order.amount,mode=order.mode,currency='UAH',fingerprint=hash('event-'+(++event)))=>rpc('xelay_apply_max_credit_event',[order.order_reference,mode,fingerprint,status,amount,currency])
 const wallet=async()=> (await rpc('xelay_max_credit_status',[owner])).wallet
 const usage=()=>own('xelay_student_workspace_status')
 await rpc('xelay_student_audience_assign',[owner,'student','Synthetic credit ledger check'])
 await rpc('xelay_student_plan_grant',[owner,'max',new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+29*86400000).toISOString(),'synthetic-credits-grant'])
 const pre=await reserve(1,100000)
 await db.exec(credits)
 let order,nextOrder
 try{
  await t.test('migration preserves old pending work, gifts and official grades',async()=>{
   const before=await usage();assert.equal(before.budget.limitMicros,10000000);assert.equal(before.budget.reservedMicros,100000)
   assert.deepEqual(await wallet(),{balanceCredits:0,reservedCredits:0,debtCredits:0})
   await finish(1,pre,50000);assert.equal((await usage()).budget.spentMicros,50000)
   assert.deepEqual(await rows('select*from public.official_grades order by id'),[{id:1,score:85},{id:2,score:92}])
  })
  await t.test('only the service boundary can create immutable server-priced orders for active Max',async()=>{
   await assert.rejects(own('xelay_create_max_credit_order',[owner,'live',ref(1),'credits_1000','2026-11-17.1']),e=>e.code==='42501')
   await assert.rejects(as('authenticated',()=>db.query('select*from xelay_student_private.credit_wallets')),e=>e.code==='42501')
   await assert.rejects(create(2,'credits_1000','live',other),e=>e.code==='42501')
   await assert.rejects(create(3,'forged_package'),e=>e.code==='22023')
   order=await create(4);assert.equal(Number(order.amount),99);assert.equal(order.credit_micros,1000000);assert.equal(order.product,'ai_credits')
   assert.equal((await create(5)).id,order.id)
   await assert.rejects(db.query('update xelay_student_private.credit_orders set amount=1 where id=$1',[order.id]),e=>e.code==='42501')
   await assert.rejects(db.query('update xelay_student_private.credit_orders set user_id=$1 where id=$2',[other,order.id]),e=>e.code==='42501')
   assert.equal(await rpc('xelay_max_credit_order_owned',[other,order.order_reference,'live']),false)
   assert.equal(await rpc('xelay_claim_max_credit_reconciliation',[owner,order.order_reference,'live']),true)
   assert.equal(await rpc('xelay_claim_max_credit_reconciliation',[owner,order.order_reference,'live']),false)
  })
  await t.test('approval checks amount, mode and currency and credits each paid order once',async()=>{
   await assert.rejects(apply(order,'Approved',1),e=>e.code==='42501')
   await assert.rejects(apply(order,'Approved',99,'test'),e=>e.code==='42501')
   await assert.rejects(apply(order,'Approved',99,'live','USD'),e=>e.code==='42501')
   const fingerprint=hash('approved-first');await apply(order,'Approved',99,'live','UAH',fingerprint)
   assert.equal((await wallet()).balanceCredits,1000)
   assert.equal((await apply(order,'Approved',99,'live','UAH',fingerprint)).replayed,true)
   await apply(order);assert.equal((await wallet()).balanceCredits,1000)
   assert.equal((await usage()).budget.spentMicros,50000);assert.equal((await usage()).budget.limitMicros,10000000)
   const testOrder=await create(6,'credits_10000','test');await apply(testOrder);assert.equal((await wallet()).balanceCredits,1000)
  })
  await t.test('subscription allowance is reserved first; purchased holds cannot be spent twice',async()=>{
   const used=await reserve(2,9850000);assert.equal(used.state,'reserved');await finish(2,used,9850000)
   const split=await reserve(3,500000);assert.equal(split.state,'reserved')
   assert.deepEqual(await wallet(),{balanceCredits:600,reservedCredits:400,debtCredits:0})
   assert.equal((await reserve(3,500000)).state,'pending')
   assert.equal((await reserve(4,700000)).state,'denied')
   await assert.rejects(rpc('xelay_max_ai_finish',[owner,hash('wrong-session'),request(3).requestId,hash('credits-3'),split.reservationId,250000,null,request(3)]),e=>e.code==='PT409')
   await finish(3,split,250000);await finish(3,split,250000)
   assert.equal((await usage()).budget.spentMicros,10000000)
   assert.deepEqual(await wallet(),{balanceCredits:850,reservedCredits:0,debtCredits:0})
  })
  await t.test('refund revokes paid credits once; consumed credit debt cannot resurrect through late approval',async()=>{
   await apply(order,'Refunded');await apply(order,'Refunded');await apply(order,'Approved')
   assert.deepEqual(await wallet(),{balanceCredits:0,reservedCredits:0,debtCredits:150})
   assert.equal((await usage()).budget.spentMicros,10000000)
   nextOrder=await create(7,'credits_3000');await apply(nextOrder)
   assert.deepEqual(await wallet(),{balanceCredits:2850,reservedCredits:0,debtCredits:0})
  })
  await t.test('released allowance is reused before spending a wallet hold, and overruns never debit unreserved credits',async()=>{
   await rows('update xelay_student_private.period_usage set spent_micros=9700000 where user_id=$1',[owner])
   const a=await reserve(5,300000),b=await reserve(6,300000);assert.equal(a.state,'reserved');assert.equal(b.state,'reserved')
   assert.equal((await wallet()).reservedCredits,300)
   await finish(5,a,10000);await finish(6,b,10000)
   assert.equal((await wallet()).balanceCredits,2850);assert.equal((await usage()).budget.spentMicros,9720000)
   const over=await reserve(7,100000);await finish(7,over,500000)
   assert.equal((await wallet()).balanceCredits,2850);assert.equal((await usage()).budget.spentMicros,10220000)
  })
  await t.test('a refund during a pending wallet request settles once, and later purchases cover consumed debt',async()=>{
   const pending=await reserve(9,300000);assert.equal(pending.state,'reserved')
   await apply(nextOrder,'Refunded');assert.deepEqual(await wallet(),{balanceCredits:0,reservedCredits:300,debtCredits:150})
   await finish(9,pending,200000);await finish(9,pending,200000)
   assert.deepEqual(await wallet(),{balanceCredits:0,reservedCredits:0,debtCredits:350})
   const refill=await create(11);await apply(refill);assert.equal((await wallet()).balanceCredits,650)
  })
  await t.test('a pending request settles its original period and never consumes a newly started month',async()=>{
   const pending=await reserve(10,100000);assert.equal(pending.state,'reserved')
   await rows("update xelay_student_private.grant_periods set valid_until=clock_timestamp()-interval'1 second'where grant_id in(select id from xelay_student_private.grants where user_id=$1)",[owner])
   await rpc('xelay_student_plan_grant',[owner,'max',new Date(Date.now()-1000).toISOString(),new Date(Date.now()+29*86400000).toISOString(),'synthetic-next-credits-grant'])
   await finish(10,pending,50000)
   assert.equal((await usage()).budget.spentMicros,0);assert.equal((await usage()).budget.reservedMicros,0)
   assert.equal((await wallet()).balanceCredits,600)
  })
  await t.test('credit ownership and expiry remain independent of subscription dates and old grades',async()=>{
   const before=await wallet()
   await rows("update xelay_student_private.grant_periods set valid_until=clock_timestamp()-interval'1 second'where grant_id in(select id from xelay_student_private.grants where user_id=$1)",[owner])
   assert.equal((await rpc('xelay_max_credit_status',[owner])).eligible,false)
   assert.equal((await rpc('xelay_max_ai_reserve',[owner,hash(session),request(8).requestId,hash('credits-8'),100000,10000000,request(8)])).state,'denied')
   await assert.rejects(create(9),e=>e.code==='42501')
   assert.deepEqual(await wallet(),before)
   assert.deepEqual((await rpc('xelay_max_credit_status',[other])).wallet,{balanceCredits:0,reservedCredits:0,debtCredits:0})
   assert.deepEqual(await rows('select*from public.official_grades order by id'),[{id:1,score:85},{id:2,score:92}])
  })
 }finally{await db.close()}
})
