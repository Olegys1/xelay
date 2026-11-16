import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile}from'node:fs/promises'
import{createHash}from'node:crypto'
import{PGlite}from'@electric-sql/pglite'

const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')
const migrations=await Promise.all(['202611160100_student_max_workspace.sql','20261116155610_student_max_paid_period.sql','20261116161046_student_max_tutor_chat.sql'].map(read))
const id=n=>`72000000-0000-4000-8000-${String(n).padStart(12,'0')}`,owner=id(1),other=id(2),session=id(101),otherSession=id(102)
const hash=v=>createHash('sha256').update(v).digest('hex')
const source={id:'own-note',title:'Мій конспект',text:'Підготовка, виконання, перевірка.',page:null,kind:'own_note'}
const request=(n,extra={})=>({requestId:'chat-sql-'+n,mode:'chat',prompt:'Поясни інфляцію простими словами.',sources:[],...extra})
const bundle=(extra={})=>({version:1,mode:'chat',title:'Про інфляцію',introduction:'Інфляція означає зростання загального рівня цін.',steps:[],questions:[],cards:[],plan:[],math:null,citations:[],...extra})

test('ordinary Max chat is metered and private while grounded activities retain exact citation checks',{timeout:120000},async t=>{
 const db=new PGlite(),q=async(sql,args=[])=>(await db.query(sql,args)).rows
 const as=async(role,user,sid,work)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:sid,role})]);try{return await work()}finally{await db.exec('reset role')}}
 const rpc=(name,args=[])=>q(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})v`,args).then(rows=>rows[0].v)
 const service=(name,args=[])=>as('service_role',owner,session,()=>rpc(name,args)),own=(name,args=[])=>as('authenticated',owner,session,()=>rpc(name,args))
 const reserve=(r,user=owner,sid=session)=>service('xelay_max_ai_reserve',[user,hash(sid),r.requestId,hash(JSON.stringify(r)),100000,10000000,r])
 const finish=(r,row,b,user=owner,sid=session)=>service('xelay_max_ai_finish',[user,hash(sid),r.requestId,hash(JSON.stringify(r)),row.reservationId,1234,b,r])
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid()returns uuid language sql stable as $$select(auth.jwt()->>'sub')::uuid$$;
   grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt()to anon,authenticated,service_role;
   create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);create table public.profiles(id uuid primary key,account_type text default'student');
   create function public.xelay_has_participant_access(uuid)returns boolean language sql stable security definer as $$select false$$;
   create table public.official_grades(id integer primary key,score integer);insert into public.official_grades values(1,85);
   insert into auth.users(id,email_confirmed_at)values('${owner}',now()),('${other}',now());insert into profiles(id)select id from auth.users;
   insert into auth.sessions(id,user_id)values('${session}','${owner}'),('${otherSession}','${other}');`)
  for(const migration of migrations)await db.exec(migration)
  for(const user of[owner,other]){
   await service('xelay_student_audience_assign',[user,'student','Synthetic private chat regression'])
   await service('xelay_student_plan_grant',[user,'max',new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+86400000).toISOString(),'synthetic-chat-grant-'+user])
  }
  await t.test('source-free ordinary question reserves allowance, stores a real turn, replays once and reloads through own history',async()=>{
   const r=request(1);assert.deepEqual(await own('xelay_max_sources_put',[r.requestId,[]]),[])
   const row=await reserve(r);assert.equal(row.state,'reserved');assert.equal((await reserve(r)).state,'pending')
   assert.equal((await finish(r,row,bundle())).stored,true);assert.equal((await finish(r,row,bundle())).replayed,true)
   const history=await own('xelay_max_runs_list',[12]);assert.equal(history.length,1);assert.equal(history[0].id,r.requestId);assert.equal(history[0].request.mode,'chat');assert.deepEqual(history[0].request.sources,[])
   const status=await own('xelay_student_workspace_status');assert.equal(status.budget.limitMicros,10000000);assert.equal(status.budget.spentMicros,1234);assert.equal(status.budget.reservedMicros,0)
  })
  await t.test('every source-backed study mode still rejects zero sources; a conversation cannot supply fake sources or citations',async()=>{
   for(const mode of['explain','quiz','cards','plan','math'])await assert.rejects(reserve(request('empty-'+mode,{mode})),/MAX_RESERVATION_INVALID/)
   const r=request(2);const row=await reserve(r)
   assert.equal((await finish(r,row,bundle({citations:[{sourceId:'invented',quote:'Not a real source'}]}))).stored,false)
   assert.equal((await q('select count(*)::integer n from xelay_student_private.runs where id=$1',[r.requestId]))[0].n,0)
   assert.equal((await q('select xelay_student_private.bundle_valid($1,$2)v',[bundle({questions:[{id:'fake'}]}),r]))[0].v,false)
  })
  await t.test('chat with a selected note requires literal current citations, independently of previous dialogue',async()=>{
   const r=request(3,{sources:[source],conversationRunIds:[request(1).requestId]});await own('xelay_max_sources_put',[r.requestId,[source]])
   assert.equal((await q('select xelay_student_private.bundle_valid($1,$2)v',[bundle(),r]))[0].v,false)
   assert.equal((await q('select xelay_student_private.bundle_valid($1,$2)v',[bundle({citations:[{sourceId:source.id,quote:'Invented'}]}),r]))[0].v,false)
   const row=await reserve(r),valid=bundle({introduction:'У конспекті наведено три етапи.',citations:[{sourceId:source.id,quote:'Підготовка, виконання, перевірка.'}]})
   assert.equal((await finish(r,row,valid)).stored,true)
  })
  await t.test('conversation references are bounded, unique and matched to this owner only',async()=>{
   const foreign=request('foreign');const reserved=await reserve(foreign,other,otherSession);assert.equal((await finish(foreign,reserved,bundle(),other,otherSession)).stored,true)
   for(const refs of[[],Array(5).fill(request(1).requestId),[request(1).requestId,request(1).requestId],['constructor']])await assert.rejects(reserve(request('invalid-refs',{conversationRunIds:refs})),/MAX_RESERVATION_INVALID/)
   await assert.rejects(reserve(request('foreign-ref',{conversationRunIds:[foreign.requestId]})),/MAX_SOURCE_CHANGED/)
   await assert.rejects(reserve(request('unknown-ref',{conversationRunIds:['unknown-run']})),/MAX_SOURCE_CHANGED/)
   const ownTurn=request(4,{conversationRunIds:[request(1).requestId,request(3).requestId]});const row=await reserve(ownTurn);assert.equal((await finish(ownTurn,row,bundle())).stored,true)
   const history=await own('xelay_max_runs_list',[12]);assert.ok(history.every(turn=>turn.id!==foreign.requestId));assert.deepEqual(history.find(turn=>turn.id===ownTurn.requestId).request.conversationRunIds,ownTurn.conversationRunIds)
  })
  await t.test('new validator helper is private and official assessment records are untouched',async()=>{
   for(const role of['anon','authenticated','service_role'])assert.equal((await q('select has_function_privilege($1,$2,$3)v',[role,'xelay_student_private.grounded_bundle_valid(jsonb,jsonb)','execute']))[0].v,false)
   assert.deepEqual(await q('select *from official_grades'),[{id:1,score:85}])
  })
 }finally{await db.close()}
})
