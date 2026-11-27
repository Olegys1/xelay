import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'

const names=['202611160100_student_max_workspace.sql','20261116155610_student_max_paid_period.sql','20261116161046_student_max_tutor_chat.sql','20261116165652_student_max_study_formats.sql','20261117070036_student_max_topic_generation.sql','20261126220000_student_mini_quiz_count.sql']
const migrations=await Promise.all(names.map(name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')))
const id=n=>`76000000-0000-4000-8000-${String(n).padStart(12,'0')}`,owner=id(1),other=id(2),session=id(101),otherSession=id(102)
const hash=value=>createHash('sha256').update(value).digest('hex'),copy=value=>JSON.parse(JSON.stringify(value))
const request=(name,extra={})=>({requestId:'quiz-count-'+name,mode:'quiz',prompt:'Створи тест за темою попиту.',sources:[],...extra})
const question=at=>({id:'q-'+String(at).padStart(2,'0')+'-'.repeat(75),text:`Питання ${at}: як ціна впливає на величину попиту?`,options:['Зменшує','Збільшує','Не впливає','Змінює пропозицію'],correctIndex:0,explanation:'За інших рівних умов залежність обернена.',sourceId:''})
const bundle=count=>({version:1,mode:'quiz',title:'Практика попиту',introduction:'Самостійна навчальна перевірка.',steps:[],questions:Array.from({length:count},(_,at)=>question(at+1)),cards:[],plan:[],math:null,citations:[]})
const completed=value=>({answers:Object.fromEntries(value.questions.map(q=>[q.id,0])),submitted:value.questions.map(q=>q.id),cardRatings:{},doneTasks:[]})

test('personal quizzes up to30 persist through private RPCs without changing old runs or official grades',{timeout:120000},async t=>{
 const db=new PGlite(),q=async(sql,args=[])=>(await db.query(sql,args)).rows
 const as=async(role,user,sid,work)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:sid,role})]);try{return await work()}finally{await db.exec('reset role')}}
 const rpc=(name,args=[])=>q(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})v`,args).then(rows=>rows[0].v)
 const service=(name,args=[])=>as('service_role',owner,session,()=>rpc(name,args)),own=(name,args=[])=>as('authenticated',owner,session,()=>rpc(name,args))
 const reserve=r=>service('xelay_max_ai_reserve',[owner,hash(session),r.requestId,hash(JSON.stringify(r)),100000,10000000,r])
 const finish=(r,row,b)=>service('xelay_max_ai_finish',[owner,hash(session),r.requestId,hash(JSON.stringify(r)),row.reservationId,1234,b,r])
 const valid=(b,r)=>q('select xelay_student_private.bundle_valid($1,$2)v',[b,r]).then(rows=>rows[0].v)
 const progressValid=(p,b)=>q('select xelay_student_private.progress_valid($1,$2)v',[p,b]).then(rows=>rows[0].v)
 const history=()=>own('xelay_max_runs_list',[12])
 const snapshot=()=>q("select p.oid::regprocedure::text signature,p.proacl::text acl,p.prosecdef,p.provolatile,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='xelay_student_private' order by signature")
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
  for(const migration of migrations.slice(0,-1))await db.exec(migration)
  for(const user of[owner,other]){await service('xelay_student_audience_assign',[user,'student','Synthetic quiz count regression']);await service('xelay_student_plan_grant',[user,'max',new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+86400000).toISOString(),'synthetic-quiz-count-'+user])}
  const legacyRequest=request('legacy-twelve'),legacyBundle=bundle(12),reservation=await reserve(legacyRequest)
  assert.equal((await finish(legacyRequest,reservation,legacyBundle)).stored,true)
  let legacy=(await history()).find(run=>run.id===legacyRequest.requestId)
  await own('xelay_max_run_progress',[legacy.id,legacy.revision,completed(legacyBundle)])
  const beforeRuns=await q('select *from xelay_student_private.runs order by id'),beforeGrants=await q('select *from xelay_student_private.grants order by id'),beforeAcl=await snapshot()
  assert.equal(await valid(bundle(20),request('before-twenty')),false)
  await db.exec(migrations.at(-1))

  await t.test('migration leaves existing twelve-question answers, grants, ACLs and grades unchanged',async()=>{
   assert.deepEqual(await q('select *from xelay_student_private.runs order by id'),beforeRuns)
   assert.deepEqual(await q('select *from xelay_student_private.grants order by id'),beforeGrants)
   assert.deepEqual(await snapshot(),beforeAcl)
   assert.deepEqual(await q('select *from official_grades'),[{id:1,score:85}])
   legacy=(await history()).find(run=>run.id===legacyRequest.requestId)
   assert.equal(await valid(legacy.bundle,legacy.request),true)
   assert.deepEqual(legacy.progress,completed(legacyBundle))
  })
  await t.test('twenty and thirty questions settle once and every answer saves and reloads including question30',async()=>{
   for(const count of[20,30]){
    const r=request(String(count)),b=bundle(count),row=await reserve(r)
    assert.equal(row.state,'reserved');assert.equal((await finish(r,row,b)).stored,true)
    assert.equal((await finish(r,row,b)).replayed,true);assert.equal((await reserve(r)).state,'replay')
    let saved=(await history()).find(run=>run.id===r.requestId)
    for(let answered=1;answered<=count;answered++){
     const progress=completed({...b,questions:b.questions.slice(0,answered)})
     saved=await own('xelay_max_run_progress',[r.requestId,saved.revision,progress])
     assert.equal(saved.progress.submitted.length,answered)
    }
    const reloaded=(await history()).find(run=>run.id===r.requestId)
    assert.deepEqual(reloaded.bundle,b);assert.deepEqual(reloaded.progress,completed(b))
    assert.ok(Buffer.byteLength(JSON.stringify(reloaded.progress))<12000,'Thirty maximum-length IDs fit unchanged progress byte cap')
   }
  })
  await t.test('version2 true-false quiz also stores30 and reloads its protected progress',async()=>{
   const r=request('true-false',{studyFormat:'true_false'}),b={...bundle(30),version:2,study:{format:'true_false',gaps:[],reading:[],written:[],dialogue:[]}}
   for(const item of b.questions)item.options=['Правда','Неправда']
   const row=await reserve(r);assert.equal((await finish(r,row,b)).stored,true)
   const run=(await history()).find(item=>item.id===r.requestId),progress={...run.progress,...completed(b)}
   await own('xelay_max_run_progress',[run.id,run.revision,progress])
   const restored=(await history()).find(item=>item.id===run.id);assert.deepEqual(restored.bundle,b);assert.deepEqual(restored.progress,progress)
  })
  await t.test('31questions reject, plan20/other12 bounds remain, invalid sources and answer keys remain invalid',async()=>{
   assert.equal(await valid(bundle(31),request('over-cap')),false)
   for(const [mode,count,expected]of[['plan',20,true],['plan',21,false],['explain',12,true],['explain',13,false]]){
    const value={...bundle(count),mode,steps:mode==='explain'?[{title:'Пояснення',body:'Короткий навчальний текст.'}]:[],plan:mode==='plan'?[{id:'step-one',label:'Повторення',minutes:15,tasks:['Повторити тему']}]:[]}
    assert.equal(await valid(value,request('mode-'+count,{mode})),expected)
   }
   for(const mutate of[
    b=>{b.questions[1].id=b.questions[0].id},b=>{b.questions[0].sourceId='foreign-source'},
    b=>{b.questions[0].correctIndex=[0,1]},b=>{b.questions[0].correctIndex=4},
    b=>{b.questions[0].options=['Єдиний варіант']},b=>{b.questions[0].text='<script>bad</script>'},
    b=>{b.questions[0].unexpected=true},b=>{b.citations=[{sourceId:'',quote:'Вигадане джерело'}]},
   ]){const bad=bundle(20);mutate(bad);assert.equal(await valid(bad,request('invalid')),false)}
   const tooLarge=bundle(30);tooLarge.introduction='x'.repeat(512001);assert.equal(await valid(tooLarge,request('oversize')),false)
  })
  await t.test('submitted IDs are bounded by the saved bundle; foreign IDs, duplicates and unauthorized writes fail',async()=>{
   const run=(await history()).find(item=>item.id===request('30').requestId),full=completed(run.bundle)
   for(const mutate of[
    p=>{p.submitted.push(p.submitted[0])},p=>{p.answers.foreign=0;p.submitted.push('foreign')},
    p=>{p.submitted[29]='foreign'},p=>{delete p.answers[p.submitted[29]]},
    p=>{p.answers[p.submitted[29]]=4},p=>{p.cardRatings.foreign='known'},p=>{p.doneTasks.push('foreign:0')},
   ]){const bad=copy(full);mutate(bad);assert.equal(await progressValid(bad,run.bundle),false);await assert.rejects(own('xelay_max_run_progress',[run.id,run.revision,bad]),/MAX_PROGRESS_INVALID/)}
   const shortBundle=bundle(2);assert.equal(await progressValid(completed(bundle(3)),shortBundle),false)
   const plan={...bundle(21),mode:'plan'};assert.equal(await progressValid(completed(plan),plan),false,'Progress alone cannot bypass the plan cap')
   await assert.rejects(as('authenticated',other,otherSession,()=>rpc('xelay_max_run_progress',[run.id,run.revision,full])),/MAX_RUN_UNAVAILABLE/)
   assert.deepEqual(await as('authenticated',other,otherSession,()=>rpc('xelay_max_runs_list',[12])),[])
   for(const role of['anon','authenticated','service_role'])for(const fn of['grounded_bundle_valid(jsonb,jsonb)','pre_study_progress_valid(jsonb,jsonb)'])assert.equal((await q('select has_function_privilege($1,$2,$3)v',[role,'xelay_student_private.'+fn,'execute']))[0].v,false)
   const status=await own('xelay_student_workspace_status');assert.equal(status.budget.spentMicros,4*1234);assert.equal(status.budget.reservedMicros,0)
   assert.deepEqual(await q('select *from xelay_student_private.grants order by id'),beforeGrants);assert.deepEqual(await q('select *from official_grades'),[{id:1,score:85}])
  })
  await t.test('guard refuses a changed database definition before overwriting any function',async()=>{
   const before=await q("select prosrc from pg_proc where oid='xelay_student_private.pre_study_progress_valid(jsonb,jsonb)'::regprocedure")
   await assert.rejects(db.exec(migrations.at(-1)),/MINI_QUIZ_COUNT_PREREQUISITE_OR_DRIFT/)
   await db.exec('rollback')
   assert.deepEqual(await q("select prosrc from pg_proc where oid='xelay_student_private.pre_study_progress_valid(jsonb,jsonb)'::regprocedure"),before)
  })
 }finally{await db.close()}
})
