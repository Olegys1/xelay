import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'

const migration=await readFile(new URL('../supabase/migrations/202611160100_student_max_workspace.sql',import.meta.url),'utf8')
const id=n=>`41000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const owner=id(1),other=id(2),session=id(101),otherSession=id(102),hash=v=>createHash('sha256').update(v).digest('hex'),failure=code=>e=>e.code===code
const source={id:'own-note',title:'Власний конспект',text:'Попит зменшується зі зростанням ціни за інших рівних умов.',page:null,kind:'own_note'}
const request=n=>({requestId:'request-'+n,mode:'quiz',prompt:'Створи тест за моїм конспектом.',sources:[source]})
const bundle={version:1,mode:'quiz',title:'Попит',introduction:'Навчальна перевірка за конспектом.',steps:[],questions:[{id:'q-1',text:'Як змінюється попит зі зростанням ціни?',options:['Зменшується','Збільшується'],correctIndex:0,explanation:'Це прямо вказано в обраному конспекті.',sourceId:'own-note'}],cards:[{id:'card-1',front:'Зростання ціни',back:'Величина попиту зменшується.',sourceId:'own-note'}],plan:[{id:'plan-1',label:'Повторити правило',minutes:10,tasks:['Прочитати конспект']}],math:null,citations:[{sourceId:'own-note',quote:'Попит зменшується'}]}
const empty=()=>({answers:{},submitted:[],cardRatings:{},doneTasks:[]})

test('production Max SQL keeps identity, quota, content and progress private and durable',{timeout:120000},async t=>{
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.uid()returns uuid language sql stable as $$select(auth.jwt()->>'sub')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt()to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid references auth.users(id),not_after timestamptz);
 create table public.profiles(id uuid primary key,account_type text default 'student');
 create table public.participant_entitlements(user_id uuid,valid_until timestamptz,revoked_at timestamptz);
 create function public.xelay_has_participant_access(u uuid)returns boolean language sql stable security definer as $$select exists(select 1 from public.participant_entitlements where user_id=u and valid_until>now()and revoked_at is null)$$;
 create table public.official_grade_sentinel(id integer primary key,score integer);insert into public.official_grade_sentinel values(1,85);
 insert into auth.users(id,email_confirmed_at)values('${owner}',now()),('${other}',now());insert into public.profiles(id)select id from auth.users;
 insert into auth.sessions(id,user_id)values('${session}','${owner}'),('${otherSession}','${other}');`)
 await db.exec(migration)
 const q=async(sql,args=[])=>(await db.query(sql,args)).rows
 const as=async(role,fn,u=owner,s=session)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:u,session_id:s,role})]);try{return await fn()}finally{await db.exec('reset role')}}
 const rpc=async(name,args=[])=>(await q(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) v`,args))[0].v
 const call=(name,args=[],u=owner,s=session)=>as('authenticated',()=>rpc(name,args),u,s)
 const service=(name,args=[])=>as('service_role',()=>rpc(name,args))
 const grant=async(reference='test-grant-1')=>{await service('xelay_student_audience_assign',[owner,'student','Audited synthetic student account']);return service('xelay_student_plan_grant',[owner,'max',new Date(Date.now()-10000).toISOString(),new Date(Date.now()+86400000).toISOString(),reference])}
 const put=n=>call('xelay_max_sources_put',[request(n).requestId,request(n).sources])
 const reserve=(n,amount=500000,fingerprint=hash('request-'+n))=>service('xelay_max_ai_reserve',[owner,hash(session),request(n).requestId,fingerprint,amount,6000000,request(n)])
 const finish=(n,reservation,charge=10000,b=bundle,r=request(n))=>service('xelay_max_ai_finish',[owner,hash(session),request(n).requestId,hash('request-'+n),reservation.reservationId,charge,b,r])
 try{
 await t.test('migration grants nothing to existing mutable profiles and every private table has RLS plus no direct grants',async()=>{
  assert.equal((await call('xelay_student_workspace_status')).audience,'unresolved');assert.equal((await call('xelay_student_workspace_status')).planId,'free')
  for(const table of ['audiences','grants','grant_periods','schedule_audit','sources','usage','requests','runs'])for(const role of ['anon','authenticated','service_role'])for(const privilege of ['select','insert','update','delete'])assert.equal((await q('select has_table_privilege($1,$2,$3)allowed',[role,'xelay_student_private.'+table,privilege]))[0].allowed,false)
  for(const table of ['audiences','grants','grant_periods','schedule_audit','sources','usage','requests','runs'])assert.equal((await q('select relrowsecurity from pg_class where oid=$1::regclass',['xelay_student_private.'+table]))[0].relrowsecurity,true)
  await db.exec(`update public.profiles set account_type='teacher' where id='${owner}'`);assert.equal((await call('xelay_student_workspace_status')).audience,'unresolved')
  await assert.rejects(call('xelay_student_audience_assign',[owner,'student','Forged caller assignment']),failure('42501'))
 })
 await t.test('audited immutable audience and explicit grant enforce Max without expanding legacy access',async()=>{
  const state=await grant();assert.equal(state.planId,'max');assert.equal(state.aiAllowance,'available');assert.equal(state.budget.limitMicros,6000000)
  await assert.rejects(service('xelay_student_audience_assign',[owner,'teacher','Changing historical billing role']),failure('PT409'))
  await db.exec(`update public.profiles set account_type='teacher' where id='${owner}'`);assert.equal((await call('xelay_student_workspace_status')).audience,'student')
  assert.equal((await call('xelay_student_workspace_status',[],other,otherSession)).planId,'free')
 })
 await t.test('new initial signup captures type once; mutable later profile cannot change billing identity',async()=>{
  await db.exec(`insert into auth.users(id,email_confirmed_at)values('${id(3)}',now());insert into public.profiles(id,account_type)values('${id(3)}','student');update profiles set account_type='teacher'where id='${id(3)}'`)
  assert.equal((await service('xelay_student_workspace_entitlement',[id(3)])).audience,'student')
 })
 await t.test('all caller status/read/progress RPCs reject revoked or foreign session claims',async()=>{
  for(const[name,args]of[['xelay_student_workspace_status',[]],['xelay_max_runs_list',[12]],['xelay_max_sources_get',['request-1',[]]],['xelay_max_run_progress',['request-1',1,empty()]]])await assert.rejects(call(name,args,owner,otherSession),failure('42501'))
  await assert.rejects(as('anon',()=>rpc('xelay_student_workspace_status')),failure('42501'))
 })
 await t.test('request-scoped sources are explicit, immutable, isolated and bounded before model dispatch',async()=>{
  await put(1);await put(1);const read=await call('xelay_max_sources_get',['request-1',['own-note']]);assert.equal(read.userId,owner);assert.equal(read.sources[0].text,source.text)
  await assert.rejects(call('xelay_max_sources_put',['request-1',[{...source,text:'Changed in-flight source.'}]]),failure('PT409'))
  await assert.rejects(call('xelay_max_sources_get',['request-1',['own-note']],other,otherSession),failure('42501'))
  for(const changed of [{...source,kind:'official_test_key'},{...source,text:'ї'.repeat(13000)},{...source,kind:null},{...source,extra:'foreign'}])await assert.rejects(call('xelay_max_sources_put',['invalid-source',[changed]]))
  await put(2);assert.equal((await call('xelay_max_sources_get',['request-2',['own-note']])).sources[0].text,source.text)
 })
 let first
 await t.test('one atomic reservation enforces fingerprint, duplicate pending and per-user monthly cap',async()=>{
  first=await reserve(1,5500000);assert.equal(first.state,'reserved');assert.equal((await reserve(1,5500000)).state,'pending');assert.equal((await reserve(1,5500000,hash('other-content'))).state,'conflict')
  assert.equal((await reserve(2,600000)).state,'denied');assert.equal((await call('xelay_student_workspace_status')).budget.reservedMicros,5500000)
  await assert.rejects(call('xelay_max_ai_reserve',[owner,hash(session),'request-2',hash('request-2'),1,6000000,request(2)]),failure('42501'))
 })
 await t.test('settlement records actual cost once and same request replays the stored server artifact',async()=>{
  assert.equal((await finish(1,first)).stored,true);assert.equal((await finish(1,first)).replayed,true)
  assert.equal((await reserve(1)).state,'replay');const usage=(await call('xelay_student_workspace_status')).budget;assert.equal(usage.spentMicros,10000);assert.equal(usage.reservedMicros,0)
  await assert.rejects(finish(1,first,999),failure('PT409'));assert.equal((await call('xelay_max_runs_list',[12])).length,1)
 })
 await t.test('progress is owner-only, revisioned, validates against immutable generated questions and survives reread',async()=>{
  const progress={answers:{'q-1':1},submitted:['q-1'],cardRatings:{'card-1':'known'},doneTasks:['plan-1:0']},saved=await call('xelay_max_run_progress',['request-1',1,progress]);assert.equal(saved.revision,2);assert.deepEqual(saved.progress,progress)
  assert.deepEqual((await call('xelay_max_runs_list',[12]))[0].progress,progress)
  assert.equal((await call('xelay_max_run_progress',['request-1',1,progress])).revision,2)
  await assert.rejects(call('xelay_max_run_progress',['request-1',1,empty()]),failure('PT409'))
  await assert.rejects(call('xelay_max_run_progress',['request-1',2,{...progress,answers:{'q-1':99}}]),failure('22023'))
  await assert.rejects(call('xelay_max_run_progress',['request-1',2,progress],other,otherSession),failure('42501'))
 })
 await t.test('revoked subscription denies new model work but retained own history/progress remain available',async()=>{
  await db.exec(`update xelay_student_private.grants set revoked_at=now()where user_id='${owner}'`)
  assert.equal((await reserve(2)).state,'denied');assert.equal((await call('xelay_max_runs_list',[12])).length,1)
  assert.equal((await call('xelay_max_run_progress',['request-1',2,empty()])).revision,3)
  await grant('test-grant-2')
 })
 await t.test('logout during generation still settles cost but cannot store or replay the output',async()=>{
  const pending=await reserve(2);assert.equal(pending.state,'reserved');await db.exec(`delete from auth.sessions where id='${session}'`)
  const done=await finish(2,pending,12345);assert.equal(done.stored,false)
  await db.exec(`insert into auth.sessions(id,user_id)values('${session}','${owner}')`);assert.equal((await reserve(2)).state,'conflict')
  assert.equal((await call('xelay_student_workspace_status')).budget.spentMicros,22345)
 })
 await t.test('invalid model citations fail closed while accounting for already incurred provider cost',async()=>{
  await put(3);const pending=await reserve(3);const invalid={...bundle,citations:[{sourceId:'own-note',quote:'Invented quotation'}]};assert.equal((await finish(3,pending,1000,invalid,request(3))).stored,false)
  assert.equal((await call('xelay_max_runs_list',[12])).length,1)
 })
 await t.test('third active reservation is blocked atomically but identical completed replay is not; old unknown work retains money',async()=>{
  await put(6);await put(7);await put(8);const six=await reserve(6,50000),seven=await reserve(7,50000);assert.equal(six.state,'reserved');assert.equal(seven.state,'reserved');assert.equal((await reserve(8,50000)).state,'pending');assert.equal((await reserve(1)).state,'replay')
  assert.equal((await call('xelay_student_workspace_status')).budget.reservedMicros,100000)
  await db.exec("update xelay_student_private.requests set created_at=clock_timestamp()-interval'10 minutes'where request_id in('request-6','request-7')")
  const eight=await reserve(8,50000);assert.equal(eight.state,'reserved');assert.equal((await call('xelay_student_workspace_status')).budget.reservedMicros,150000)
  await finish(6,six,50000,null,null);await finish(7,seven,50000,null,null);await finish(8,eight,0,null,null)
 })
 await t.test('unknown result keeps full reserved cost; no timer, retry or new month can erase it',async()=>{
  await put(4);const pending=await reserve(4,5000000);assert.equal((await finish(4,pending,5000000,null,null)).stored,false);assert.equal((await reserve(4)).state,'conflict')
  await put(5);assert.equal((await reserve(5,1000000)).state,'denied');assert.equal((await q('select score from public.official_grade_sentinel'))[0].score,85)
 })
 await t.test('ten new request reservations in one minute block further fanout without blocking old replay',async()=>{
  await put(9)
  for(let i=0;i<10;i++)await db.query("insert into xelay_student_private.requests(user_id,request_id,fingerprint,session_hash,period,reserve_micros,charge_micros,state,request)values($1,$2,$3,$4,date_trunc('month',now()at time zone'UTC')::date,1,0,'done',$5)on conflict do nothing",[owner,'rate-'+i,hash('rate-'+i),hash(session),request('rate-'+i)])
  assert.equal((await reserve(9,1)).state,'pending');assert.equal((await reserve(1)).state,'replay')
 })
 }finally{await db.close()}
})
