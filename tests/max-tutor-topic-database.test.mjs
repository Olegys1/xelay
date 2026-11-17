import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'

const migrations=await Promise.all(['202611160100_student_max_workspace.sql','20261116155610_student_max_paid_period.sql','20261116161046_student_max_tutor_chat.sql','20261116165652_student_max_study_formats.sql','20261117070036_student_max_topic_generation.sql'].map(name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8')))
const id=n=>`74000000-0000-4000-8000-${String(n).padStart(12,'0')}`,owner=id(1),other=id(2),session=id(101),otherSession=id(102)
const hash=v=>createHash('sha256').update(v).digest('hex'),copy=v=>JSON.parse(JSON.stringify(v))
const source={id:'own-note',title:'Мій конспект',text:'Попит зменшується зі зростанням ціни.',page:null,kind:'own_note'}
const request=(name,mode='quiz',extra={})=>({requestId:'topic-db-'+name,mode,prompt:'Попит і пропозиція',sources:[],...extra})
const question=(name,sourceId='')=>({id:name,text:'Як зміниться величина попиту зі зростанням ціни за інших рівних умов?',options:['Зменшиться','Збільшиться'],correctIndex:0,explanation:'За інших рівних умов ціна й величина попиту мають обернений зв’язок.',sourceId})
const bundle=(mode='quiz',extra={})=>({version:1,mode,title:'Попит і пропозиція',introduction:'Вступна практика за темою.',steps:[{title:'Правило',body:'За інших рівних умов зі зростанням ціни величина попиту зменшується.'}],questions:mode==='quiz'?[question('q-one')]:[],cards:mode==='cards'?[{id:'card-one',front:'Зміна ціни',back:'Рух уздовж кривої попиту.',sourceId:''}]:[],plan:[],math:null,citations:[],...extra})
const planBundle=()=>{const steps=Array.from({length:5},(_,index)=>({id:'step-'+index,label:'Тема '+(index+1),minutes:20,tasks:['Прочитати пояснення','Пройти практику'],questionIds:Array.from({length:3},(_,at)=>`step-${index}-q-${at}`)}));return bundle('plan',{questions:steps.flatMap(step=>step.questionIds.map(q=>question(q))),plan:steps})}
function studyBundle(format){const study={format,gaps:[],reading:[],written:[],dialogue:[]},mode=format==='true_false'?'quiz':'explain',value=bundle(mode,{version:2,questions:[],study})
 if(format==='true_false')value.questions=[{...question('tf-one'),options:['Правда','Неправда']}]
 if(format==='gap_fill')study.gaps=[{id:'gap-one',before:'Величина попиту ',after:' зі зростанням ціни.',acceptedAnswers:['зменшується'],explanation:'Ціна й величина попиту мають обернений зв’язок.',sourceId:''}]
 if(format==='smart_text')study.reading=[{id:'read-one',text:'Попит описує зв’язок ціни й кількості.',terms:[{term:'Попит',explanation:'Економічне поняття.'}],sourceId:''}]
 if(format==='written'||format==='exercise')study.written=[{id:'write-one',prompt:'Поясни зв’язок ціни й попиту.',criteria:['Описано інші рівні умови'],modelAnswer:'Зі зростанням ціни величина попиту зменшується.',sourceId:''}]
 if(format==='podcast')study.dialogue=[{id:'voice-one',speaker:'student',text:'Що таке попит?',sourceId:''},{id:'voice-two',speaker:'tutor',text:'Зв’язок ціни та кількості за інших рівних умов.',sourceId:''}]
 return value
}

test('topic-only Max database flow keeps saved step practice, allowance and private ownership',{timeout:120000},async t=>{
 const db=new PGlite(),q=async(sql,args=[])=>(await db.query(sql,args)).rows
 const as=async(role,user,sid,work)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:sid,role})]);try{return await work()}finally{await db.exec('reset role')}}
 const rpc=(name,args=[])=>q(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})v`,args).then(rows=>rows[0].v)
 const service=(name,args=[])=>as('service_role',owner,session,()=>rpc(name,args)),own=(name,args=[])=>as('authenticated',owner,session,()=>rpc(name,args))
 const reserve=(r,user=owner,sid=session)=>service('xelay_max_ai_reserve',[user,hash(sid),r.requestId,hash(JSON.stringify(r)),100000,10000000,r])
 const finish=(r,row,b,user=owner,sid=session)=>service('xelay_max_ai_finish',[user,hash(sid),r.requestId,hash(JSON.stringify(r)),row.reservationId,1234,b,r])
 const valid=(b,r)=>q('select xelay_student_private.bundle_valid($1,$2)v',[b,r]).then(rows=>rows[0].v)
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
  for(const user of[owner,other]){await service('xelay_student_audience_assign',[user,'student','Synthetic private topic regression']);await service('xelay_student_plan_grant',[user,'max',new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+86400000).toISOString(),'synthetic-topic-grant-'+user])}
  const legacyRequest=request('legacy','plan',{sources:[source]}),legacyBundle=bundle('plan',{questions:[question('legacy-q',source.id)],plan:[{id:'legacy-step',label:'Повторення',minutes:10,tasks:['Повторити конспект']}],citations:[{sourceId:source.id,quote:source.text}]})
  await own('xelay_max_sources_put',[legacyRequest.requestId,[source]]);const legacyReservation=await reserve(legacyRequest);assert.equal((await finish(legacyRequest,legacyReservation,legacyBundle)).stored,true)
  const beforeLegacy=await q('select *from xelay_student_private.runs where id=$1',[legacyRequest.requestId]),beforeGrants=await q('select *from xelay_student_private.grants order by id')
  await db.exec(migrations.at(-1))
  await t.test('migration preserves legacy saved plans, grants and official grades byte-for-byte',async()=>{
   assert.deepEqual(await q('select *from xelay_student_private.runs where id=$1',[legacyRequest.requestId]),beforeLegacy)
   assert.deepEqual(await q('select *from xelay_student_private.grants order by id'),beforeGrants);assert.equal(await valid(legacyBundle,legacyRequest),true)
   assert.deepEqual(await q('select *from official_grades'),[{id:1,score:85}])
  })
  await t.test('ordinary chat, topic quiz and cards reserve, settle, replay once and reload for their owner',async()=>{
   for(const mode of['chat','quiz','cards']){const user=mode==='chat'?other:owner,sid=mode==='chat'?otherSession:session,r=request(mode,mode),b=bundle(mode),row=await reserve(r,user,sid)
    assert.equal(row.state,'reserved');assert.equal((await reserve(r,user,sid)).state,'pending');assert.equal((await finish(r,row,b,user,sid)).stored,true);assert.equal((await finish(r,row,b,user,sid)).replayed,true)
    assert.equal((await reserve(r,user,sid)).state,'replay');const history=await as('authenticated',user,sid,()=>rpc('xelay_max_runs_list',[12]));assert.deepEqual(history.find(run=>run.id===r.requestId).bundle,b)
   }
  })
  await t.test('five topics have independent quizzes; all15answers and completed steps save and reload',async()=>{
   const r=request('five-step-plan','plan'),b=planBundle(),row=await reserve(r);assert.equal(row.state,'reserved');assert.equal((await finish(r,row,b)).stored,true)
   const original=(await own('xelay_max_runs_list',[12])).find(run=>run.id===r.requestId)
   const progress={answers:Object.fromEntries(b.questions.map(q=>[q.id,0])),submitted:b.questions.map(q=>q.id),cardRatings:{},doneTasks:b.plan.flatMap(block=>block.tasks.map((_,at)=>block.id+':'+at))}
   const saved=await own('xelay_max_run_progress',[r.requestId,original.revision,progress]);assert.equal(saved.progress.submitted.length,15);assert.equal(saved.progress.doneTasks.length,10)
   const history=(await own('xelay_max_runs_list',[12])).find(run=>run.id===r.requestId);assert.deepEqual(history.progress,progress);assert.equal(history.bundle.plan.length,5);assert.equal(history.bundle.plan.every(block=>block.questionIds.length===3),true)
   await assert.rejects(own('xelay_max_run_progress',[r.requestId,saved.revision,{...progress,answers:{...progress.answers,foreign:0},submitted:[...progress.submitted,'foreign']}]),/MAX_PROGRESS_INVALID/)
  })
  await t.test('all six topic-only study formats settle and restore real progress without fake source rows',async()=>{
   for(const format of['true_false','gap_fill','smart_text','written','exercise','podcast']){const b=studyBundle(format),r=request(format,b.mode,{studyFormat:format}),row=await reserve(r);assert.equal(row.state,'reserved');assert.equal((await finish(r,row,b)).stored,true)
    const run=(await own('xelay_max_runs_list',[12])).find(item=>item.id===r.requestId),progress={...run.progress}
    if(format==='true_false'){progress.answers={'tf-one':0};progress.submitted=['tf-one']}
    if(format==='gap_fill'){progress.studyAnswers={'gap-one':'зменшується'};progress.studySubmitted=['gap-one']}
    if(format==='written'||format==='exercise'){progress.studyAnswers={'write-one':'Моя власна відповідь.'};progress.studySubmitted=['write-one'];progress.studyRatings={'write-one':'repeat'}}
    if(format==='smart_text')progress.studyDone=['read-one'];if(format==='podcast')progress.studyDone=['voice-one','voice-two']
    assert.deepEqual((await own('xelay_max_run_progress',[r.requestId,run.revision,progress])).progress,progress)
   }
   assert.equal((await q('select count(*)::integer n from xelay_student_private.sources'))[0].n,1,'Only the preexisting genuine source is stored')
  })
  await t.test('forged sources, citations, incomplete step mappings and unknown references remain rejected',async()=>{
   const r=request('forgery'),b=bundle();for(const bad of[{...b,citations:[{sourceId:'',quote:'Made up source'}]},{...b,questions:[question('q-one','general-knowledge')]},{...b,questions:[question('q-one',source.id)]},{...b,questions:[question('q-one',null)]},{...b,questions:[question('q-one',0)]}])assert.equal(await valid(bad,r),false)
   const backed=request('backed','quiz',{sources:[source]});assert.equal(await valid(b,backed),false);assert.equal(await valid({...b,questions:[question('q-one',source.id)],citations:[{sourceId:source.id,quote:'Invented'}]},backed),false)
   assert.equal(await valid({...b,questions:[question('q-one',source.id)],citations:[{sourceId:source.id,quote:source.text}]},backed),true)
   const plan=planBundle(),planRequest=request('invalid-plan','plan');for(const mutate of[p=>{p.plan[0].questionIds=[]},p=>{delete p.plan[0].questionIds},p=>{p.plan[1].questionIds=[p.questions[0].id]},p=>{p.plan[0].questionIds=['unknown']},p=>{p.plan[0].questionIds=null}]){const invalid=copy(plan);mutate(invalid);assert.equal(await valid(invalid,planRequest),false)}
   assert.equal(await valid({...plan,mode:'quiz'},{...planRequest,mode:'quiz'}),false,'Step metadata cannot be used to bypass ordinary quiz bounds')
   const gap=studyBundle('gap_fill'),gapRequest=request('backed-gap','explain',{sources:[source],studyFormat:'gap_fill'});gap.study.gaps[0].sourceId=source.id;gap.citations=[{sourceId:source.id,quote:source.text}];gap.study.gaps[0].acceptedAnswers=['Відсутнє слово'];assert.equal(await valid(gap,gapRequest),false,'Grounded gap answers must remain literal source text')
   gap.study.gaps[0].acceptedAnswers=['зменшується'];assert.equal(await valid(gap,gapRequest),true);gap.study.gaps[0].sourceId='';assert.equal(await valid(gap,gapRequest),false,'Source-free references cannot bypass supplied materials')
   await assert.rejects(reserve(request('unknown-history','quiz',{conversationRunIds:['unknown-run']}),other,otherSession),/MAX_SOURCE_CHANGED/)
   await assert.rejects(reserve(request('foreign-history','quiz',{conversationRunIds:[request('quiz').requestId]}),other,otherSession),/MAX_SOURCE_CHANGED/)
  })
  await t.test('private ACLs, independent metering and original assessment records remain intact',async()=>{
   const ownHistory=await own('xelay_max_runs_list',[12]),otherHistory=await as('authenticated',other,otherSession,()=>rpc('xelay_max_runs_list',[12]));assert.equal(ownHistory.some(run=>run.id===request('chat','chat').requestId),false);assert.equal(otherHistory.length,1)
   const status=await own('xelay_student_workspace_status');assert.equal(status.budget.limitMicros,10000000);assert.equal(status.budget.spentMicros,10*1234);assert.equal(status.budget.reservedMicros,0)
   for(const role of['anon','authenticated','service_role'])for(const fn of['topic_reference_valid(jsonb,jsonb)','grounded_bundle_valid(jsonb,jsonb)','pre_study_request_valid(jsonb)','pre_study_progress_valid(jsonb,jsonb)','study_valid(jsonb,jsonb)'])assert.equal((await q('select has_function_privilege($1,$2,$3)v',[role,'xelay_student_private.'+fn,'execute']))[0].v,false)
   await assert.rejects(as('authenticated',other,otherSession,()=>rpc('xelay_max_run_progress',[request('five-step-plan','plan').requestId,1,{answers:{},submitted:[],cardRatings:{},doneTasks:[]} ])),/MAX_RUN_UNAVAILABLE/)
   assert.deepEqual(await q('select *from official_grades'),[{id:1,score:85}]);assert.deepEqual(await q('select *from xelay_student_private.grants order by id'),beforeGrants)
  })
 }finally{await db.close()}
})
