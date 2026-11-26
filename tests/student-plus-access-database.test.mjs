import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'
const files=['202611160100_student_max_workspace.sql','20261116155610_student_max_paid_period.sql','20261116161046_student_max_tutor_chat.sql','20261116165652_student_max_study_formats.sql','20261117070036_student_max_topic_generation.sql','20261117105257_student_max_ai_credits.sql','20261126154456_student_plus_ai_access.sql']
const owner='76000000-0000-4000-8000-000000000001', other='76000000-0000-4000-8000-000000000002', session='76000000-0000-4000-8000-000000000101'
const hash=v=>createHash('sha256').update(v).digest('hex')
test('Plus paid-period allowance, private cloud progress and Max boundaries', {timeout:120000}, async t=>{
 const db=new PGlite();t.after(()=>db.close())
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
 insert into auth.sessions(id,user_id)values('${session}','${owner}'),('76000000-0000-4000-8000-000000000102','${other}');`)
 for(const file of files)await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'))
 const q=async(s,a=[])=>(await db.query(s,a)).rows
 const as=async(role,work,user=owner)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:user===owner?session:'76000000-0000-4000-8000-000000000102',role})]);try{return await work()}finally{await db.exec('reset role')}}
 const rpc=(role,name,a=[],user=owner)=>as(role,async()=>(await q(`select public.${name}(${a.map((_,i)=>'$'+(i+1)).join(',')})v`,a))[0].v,user)
 const service=(name,a=[])=>rpc('service_role',name,a),own=(name,a=[])=>rpc('authenticated',name,a)
 await service('xelay_student_audience_assign',[owner,'student','Synthetic subscription boundary check'])
 await service('xelay_student_plan_grant',[owner,'plus',new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+29*86400000).toISOString(),'synthetic-plus-grant'])
 const request=(id,mode='quiz',extra={})=>({requestId:id,mode,prompt:'Попит і пропозиція',sources:[],...extra})
 const reserve=(r,amount=100000)=>service('xelay_max_ai_reserve',[owner,hash(session),r.requestId,hash(JSON.stringify(r)),amount,10000000,r])
 const finish=(r,res,charge,bundle=null)=>service('xelay_max_ai_finish',[owner,hash(session),r.requestId,hash(JSON.stringify(r)),res.reservationId,charge,bundle,r])
 const e=await own('xelay_student_workspace_status');assert.equal(e.planId,'plus');assert.equal(e.budget.limitMicros,3000000);assert.equal(e.budgetPeriod,'subscription_month')
 const windows=await q(`select count(distinct (grant_id,cycle))::int n from generate_series(now(),now()+interval '20 days',interval '1 day') d cross join lateral xelay_student_private.max_budget_window($1,d)`,[owner]);assert.equal(windows[0].n,1)
 for(const mode of ['plan','math'])assert.equal((await reserve(request('denied-'+mode,mode))).state,'denied')
 assert.equal((await reserve(request('denied-format','quiz',{studyFormat:'true_false'}))).state,'denied')
 const r=request('saved-plus'),held=await reserve(r);assert.equal(held.state,'reserved');assert.equal((await reserve(r)).state,'pending')
 const b={version:1,mode:'quiz',title:'Попит',introduction:'Перевірка',steps:[],questions:[{id:'q1',text:'Ціна зростає. Попит?',options:['Менший','Більший'],correctIndex:0,explanation:'За інших рівних умов.',sourceId:''}],cards:[],plan:[],math:null,citations:[]}
 await finish(r,held,50000,b);assert.equal((await reserve(r)).state,'replay')
 const history=await own('xelay_max_runs_list',[12]);assert.equal(history[0].id,r.requestId)
 const progress={answers:{q1:1},submitted:['q1'],cardRatings:{},doneTasks:[]}
 await own('xelay_max_run_progress',[r.requestId,history[0].revision,progress])
 assert.deepEqual((await own('xelay_max_runs_list',[12]))[0].progress,progress)
 await assert.rejects(own('xelay_max_run_progress',[r.requestId,history[0].revision,{...progress,answers:{q1:0}}]),e=>e.code==='PT409')
 assert.deepEqual(await rpc('authenticated','xelay_max_runs_list',[12],other),[])
 await assert.rejects(rpc('authenticated','xelay_max_run_progress',[r.requestId,2,progress],other),e=>e.code==='42501')
 await db.query('insert into xelay_student_private.credit_wallets(user_id,granted_micros) values($1,10000000)on conflict(user_id)do update set granted_micros=10000000',[owner])
 const spend=request('spend-plus','chat'),rest=await reserve(spend,2950000);assert.equal(rest.state,'reserved');await finish(spend,rest,2950000)
 const full=await own('xelay_student_workspace_status');assert.equal(full.budget.spentMicros,3000000);assert.equal(full.purchasedCredits.balanceCredits,10000)
 assert.equal((await reserve(request('no-wallet-for-plus','cards'))).state,'denied')
 await db.query('update xelay_student_private.grant_periods set valid_until=now()-interval \'1 second\' where grant_id in(select id from xelay_student_private.grants where user_id=$1)',[owner])
 assert.equal((await own('xelay_student_workspace_status')).planId,'free');assert.equal((await reserve(request('expired-plus'))).state,'denied')
 assert.deepEqual((await own('xelay_max_runs_list',[12]))[0].progress,progress)
 assert.deepEqual(await q('select*from official_grades order by id'),[{id:1,score:85},{id:2,score:92}])
})
