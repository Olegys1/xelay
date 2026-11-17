import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync}from'node:fs'
import{createRequire}from'node:module'
import{EventEmitter}from'node:events'
import{fileURLToPath}from'node:url'
import path from'node:path'
import vm from'node:vm'
import ts from'typescript'
import{PGlite}from'@electric-sql/pglite'

// Offline application-flow proof: actual browser client, API handler/provider
// adapter and PostgreSQL functions. Only identity verification and the provider
// response are synthetic. No socket, real key, payment or hosted account is used.
const native=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map()
function load(file){
 const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute).exports
 const module={exports:{}};cache.set(absolute,module)
 const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText
 vm.runInNewContext(code,{module,exports:module.exports,process,Buffer,TextEncoder,TextDecoder,Uint8Array,AbortController,AbortSignal,Response,URL,Set,Map,Promise,Date,Number,JSON,setTimeout,clearTimeout,
  fetch(){throw Error('External network forbidden in chat integration')},require(name){
   if(name.startsWith('.')&&/\.(?:js|ts)$/.test(name))name=name.slice(0,-3)
   if(name==='@supabase/supabase-js')return{createClient(){throw Error('This fixture must supply its isolated database')}}
   return name.startsWith('.')?load(path.resolve(path.dirname(absolute),name)+'.ts'):native(name)
  }},{filename:absolute});return module.exports
}
const production=load('server/student-learning/maxTutorProduction.ts'),clientApi=load('src/lib/maxTutorProductionClient.ts'),tutor=load('src/lib/maxTutor.ts'),local=load('src/lib/maxTutorLocalClient.ts')
const read=name=>readFileSync(path.join(root,'supabase/migrations',name),'utf8'),plain=value=>JSON.parse(JSON.stringify(value))
const id=n=>`73000000-0000-4000-8000-${String(n).padStart(12,'0')}`,owner={id:id(1),session:id(101)},other={id:id(2),session:id(102)}
const key=['sk','synthetic','isolated','max','integration','credential'].join('-'),now=Date.now()
const token=actor=>['synthetic-header',Buffer.from(JSON.stringify({sub:actor.id,role:'authenticated',session_id:actor.session,exp:Math.floor(now/1000)+3600})).toString('base64url'),'synthetic-signature'].join('.')
const environment={STUDENT_MAX_ENABLED:'true',STUDENT_MAX_AI_ENABLED:'true',SUPABASE_URL:'https://baohfpadxvhqhhjjqtil.supabase.co',SUPABASE_ANON_KEY:'synthetic-public',SUPABASE_SERVICE_ROLE_KEY:'synthetic-private',OPENAI_API_KEY:key}
const note={id:'own-note',title:'Мій конспект про проєкт',text:'Навчальний проєкт має три етапи: підготовка, виконання й перевірка. Під час підготовки визначають мету. Під час виконання створюють результат. Під час перевірки зіставляють результат із метою.',page:null,kind:'own_note'}
const empty=()=>({answers:{},submitted:[],cardRatings:{},doneTasks:[]})

test('actual Max client → handler → isolated SQL → saved chat, quiz, feedback and owner-only continuation',{timeout:120000},async t=>{
 const db=new PGlite(),rpcCalls=[],providerPayloads=[],moderations=[],actors=new Map([[token(owner),owner],[token(other),other]])
 let providerCalls=0,clock=now,queue=Promise.resolve()
 const queued=work=>{const result=queue.then(work);queue=result.catch(()=>{});return result}
 const rows=async(sql,args=[])=>(await db.query(sql,args)).rows
 const argsByRpc={xelay_student_workspace_status:[],xelay_max_runs_list:['p_limit'],xelay_max_sources_put:['p_request_id','p_sources'],xelay_max_sources_get:['p_request_id','p_source_ids'],
  xelay_max_ai_reserve:['p_user_id','p_session_hash','p_request_id','p_fingerprint','p_reserve_micros','p_monthly_limit_micros','p_request'],
  xelay_max_ai_finish:['p_user_id','p_session_hash','p_request_id','p_fingerprint','p_reservation_id','p_charge_micros','p_bundle','p_request'],
  xelay_max_run_progress:['p_run_id','p_expected_version','p_progress'],xelay_student_library_run:['p_run_id'],xelay_student_audience_assign:['p_user_id','p_audience','p_reason'],
  xelay_student_plan_grant:['p_user_id','p_plan_id','p_valid_from','p_valid_until','p_reference']}
 async function databaseRpc(role,actor,name,args={}){
  const names=argsByRpc[name];assert.ok(names,'Unexpected fixture RPC '+name)
  return queued(async()=>{
   await db.exec('set role '+role)
   await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:actor?.id,session_id:actor?.session,role})])
   rpcCalls.push({role,userId:actor?.id,name,args:plain(args)})
   try{return(await rows(`select public.${name}(${names.map((_,i)=>'$'+(i+1)).join(',')})v`,names.map(name=>args[name]??null)))[0].v}
   finally{await db.exec('reset role')}
  })
 }
 const factory=(_url,apiKey,options)=>{
  const supplied=options?.global?.headers?.Authorization?.replace(/^Bearer /,''),actor=actors.get(supplied),role=apiKey===environment.SUPABASE_ANON_KEY?'authenticated':'service_role'
  return{auth:{async getUser(value){const verified=actors.get(value);return{data:{user:verified?{id:verified.id,email_confirmed_at:new Date(now).toISOString()}:null},error:null}}},
   from(table){assert.equal(table,'profiles');return{select(columns){assert.equal(columns,'id,first_name,full_name,faculty,specialty,study_year');return{eq(column,value){assert.equal(column,'id');assert.equal(value,actor.id);return{async maybeSingle(){return queued(async()=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:actor.id,session_id:actor.session,role})]);try{return{data:(await rows('select id,first_name,full_name,faculty,specialty,study_year from profiles where id=$1',[value]))[0]||null,error:null}}finally{await db.exec('reset role')}})}}}}}}},
   async rpc(name,args){try{return{data:await databaseRpc(role,actor,name,args),error:null}}catch(error){return{data:null,error:{code:error.code,message:error.message}}}}}
 }
 const response=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}})
 const provider=async(url,options)=>{
  const payload=JSON.parse(options.body)
  if(url==='https://api.openai.com/v1/moderations'){moderations.push(payload.input);return response({results:[{flagged:false}]})}
  assert.equal(url,'https://api.openai.com/v1/responses');providerCalls++;providerPayloads.push(payload)
  const input=JSON.parse(payload.input[0].content[0].text),source=input.sources[0]
  const bundle={version:1,mode:input.mode,title:'Особистий навчальний розбір',introduction:input.mode==='chat'?'Інфляція — це зростання загального рівня цін.':'У конспекті наведено підготовку, виконання й перевірку.',steps:[],questions:[],cards:[],plan:[],math:null,citations:source?[{sourceId:source.id,quote:'Навчальний проєкт має три етапи: підготовка, виконання й перевірка.'}]:[]}
  if(input.mode==='quiz')bundle.questions=[
   {id:'q-prepare',text:'Коли визначають мету?',options:['Під час підготовки','Лише після перевірки','Під час відпочинку','Мету не визначають'],correctIndex:0,explanation:'Мету визначають під час підготовки.',sourceId:source.id},
   {id:'q-execute',text:'Що створюють під час виконання?',options:['Нову мету','Результат','Список цін','Розклад'],correctIndex:1,explanation:'У конспекті вказано створення результату.',sourceId:source.id},
   {id:'q-check',text:'Що відбувається під час перевірки?',options:['Видаляють мету','Змінюють тему','Зіставляють результат із метою','Скасовують усі етапи'],correctIndex:2,explanation:'Результат зіставляють із метою.',sourceId:source.id}]
  if(input.mode==='explain')bundle.steps=[{title:'Підготовка та перевірка',body:'Спочатку визначають мету, а наприкінці порівнюють із нею результат.'}]
  if(input.studyFormat){
   bundle.version=2;bundle.study={format:input.studyFormat,gaps:[],reading:[],written:[],dialogue:[]};bundle.questions=[]
   if(input.studyFormat==='true_false')bundle.questions=[{id:'true-prepare',text:'Під час підготовки визначають мету.',options:['Правда','Неправда'],correctIndex:0,explanation:'Так зазначено в конспекті.',sourceId:source.id}]
   if(input.studyFormat==='gap_fill')bundle.study.gaps=[{id:'gap-prepare',before:'Перший етап проєкту — ',after:'.',acceptedAnswers:['підготовка'],explanation:'Саме цей етап названо першим.',sourceId:source.id}]
   if(input.studyFormat==='smart_text'){
    bundle.study.reading=[{id:'read-prepare',text:'Підготовка визначає мету проєкту.',terms:[{term:'Підготовка',explanation:'Перший етап навчального проєкту.'}],sourceId:source.id}]
    bundle.questions=[{id:'read-check',text:'Під час підготовки визначають мету?',options:['Так','Ні'],correctIndex:0,explanation:'Це прямо зазначено в конспекті.',sourceId:source.id}]
   }
   if(['written','exercise'].includes(input.studyFormat))bundle.study.written=[{id:'written-compare',prompt:'Поясни зв’язок мети й перевірки проєкту.',criteria:['Зазначено визначення мети','Пояснено порівняння результату з метою'],modelAnswer:'Під час підготовки визначають мету. Під час перевірки зіставляють із нею результат.',sourceId:source.id}]
   if(input.studyFormat==='podcast')bundle.study.dialogue=[{id:'dialogue-1',speaker:'student',text:'Навіщо спочатку визначати мету?',sourceId:source.id},{id:'dialogue-2',speaker:'tutor',text:'Щоб під час перевірки зіставити з нею отриманий результат.',sourceId:source.id}]
  }
  return response({status:'completed',error:null,incomplete_details:null,output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(bundle)}]}],usage:{input_tokens:1000,input_tokens_details:{cached_tokens:0},output_tokens:500,output_tokens_details:{reasoning_tokens:100},total_tokens:1500}})
 }
 const handler=production.createMaxTutorProduction({environment,clientFactory:factory,fetcher:provider,now:()=>clock})
 const browserFetch=async(address,options={})=>{
  const url=new URL(address,'https://www.xelay.ink');assert.equal(url.origin,'https://www.xelay.ink')
  const req=new EventEmitter(),res=new EventEmitter(),headers=new Headers();let output=''
  req.method=options.method||'GET';req.url=url.pathname+url.search;req.headers=Object.fromEntries(Object.entries(options.headers||{}).map(([name,value])=>[name.toLowerCase(),value]));if(req.method==='POST')req.headers.origin=url.origin;req.body=options.body
  res.statusCode=200;res.writableEnded=false;res.destroyed=false;res.setHeader=(name,value)=>headers.set(name,String(value));res.end=value=>{output=value||'';res.writableEnded=true}
  await handler(req,res);return new Response(output,{status:res.statusCode,headers})
 }
 const client=actor=>clientApi.createMaxTutorProductionClient({ownerId:actor.id,credential:async()=>({userId:actor.id,sessionId:actor.session,accessToken:token(actor)}),fetcher:browserFetch})
 const mine=client(owner),theirs=client(other)
 let first,quiz,finished
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid()returns uuid language sql stable as $$select(auth.jwt()->>'sub')::uuid$$;
   grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt()to anon,authenticated,service_role;
   create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);create table public.profiles(id uuid primary key,account_type text default'student',first_name text,full_name text,faculty text,specialty text,study_year integer);
   alter table profiles enable row level security;create policy own_profile on profiles for select to authenticated using(id=auth.uid());grant select on profiles to authenticated;
   create function public.xelay_has_participant_access(uuid)returns boolean language sql stable security definer as $$select false$$;
   create table public.official_grade_sentinel(id integer primary key,score integer);insert into public.official_grade_sentinel values(1,85),(2,92);
   insert into auth.users(id,email_confirmed_at)values('${owner.id}',now()),('${other.id}',now());insert into profiles(id)select id from auth.users;
   update profiles set first_name=case when id='${owner.id}'then'Олег'else'Інший студент'end,faculty='Економічний факультет',study_year=2;
   insert into auth.sessions(id,user_id)values('${owner.session}','${owner.id}'),('${other.session}','${other.id}');`)
  // Admin-source fixtures need no payment implementation. These are the actual
  // installed workspace, paid-period accounting and chat migrations unchanged.
  for(const name of['202611160100_student_max_workspace.sql','20261116155610_student_max_paid_period.sql','20261116161046_student_max_tutor_chat.sql','20261116165652_student_max_study_formats.sql','20261117171709_student_learning_cloud_library.sql'])await db.exec(read(name))
  for(const actor of[owner,other]){
   await databaseRpc('service_role',null,'xelay_student_audience_assign',{p_user_id:actor.id,p_audience:'student',p_reason:'Approved isolated integration account'})
   await databaseRpc('service_role',null,'xelay_student_plan_grant',{p_user_id:actor.id,p_plan_id:'max',p_valid_from:new Date(now-86400000).toISOString(),p_valid_until:new Date(now+7*86400000).toISOString(),p_reference:'chat-integration-'+actor.id})
  }
  await t.test('profile name comes through the real authenticated SELECT and greeting reaches provider without study sources',async()=>{
   const status=await mine.status();assert.equal(status.profileDisplayName,'Олег')
   const greeting=await mine.generate({requestId:'integration-profile-greeting',mode:'chat',prompt:'Привет!',sources:[note]})
   assert.equal(greeting.run.demo,false);assert.deepEqual(plain(greeting.run.request.sources),[])
   const input=JSON.parse(providerPayloads.at(-1).input[0].content[0].text);assert.equal(input.personalContext.profile.firstName,'Олег');assert.equal(input.personalContext.profile.studyYear,2);assert.deepEqual(input.sources,[]);assert.doesNotMatch(JSON.stringify(input.personalContext),/Інший студент|email|correctIndex/)
  })
  await t.test('ordinary source-free question reaches the real handler and reloads from actual SQL through a fresh client',async()=>{
   const before=await mine.status();assert.equal(before.budget.limitUsd,10);assert.equal(before.budgetPeriod,'subscription_month')
   first=await mine.generate({requestId:'chat-integration-first',mode:'chat',prompt:'Поясни інфляцію простими словами.',sources:[]})
   assert.equal(first.run.demo,false);assert.deepEqual(plain(first.run.bundle.citations),[]);assert.equal(first.run.request.mode,'chat')
   const restored=await client(owner).history();assert.equal(restored.runs[0].id,first.run.id);assert.equal(restored.runs[0].bundle.introduction,first.run.bundle.introduction)
   const status=await mine.status();assert.equal(status.budget.spentUsd-before.budget.spentUsd,0.014);assert.equal(status.budget.reservedUsd,0)
   assert.equal(rpcCalls.filter(call=>call.name==='xelay_max_sources_put'||call.name==='xelay_max_sources_get').length,0)
  })
  await t.test('selected own note creates three questions; saved answers survive reread and actual feedback identifies the mistake',async()=>{
   quiz=await mine.generate({requestId:'chat-integration-quiz',mode:'quiz',prompt:'Створи рівно три запитання за моїм конспектом.',sources:[note],conversationRunIds:[first.run.id]})
   assert.equal(quiz.run.bundle.questions.length,3);assert.equal(quiz.run.request.sources[0].text,note.text)
   const selected=tutor.answerTutorQuestion(empty(),quiz.run.bundle,'q-prepare',0)
   let saved=await mine.progress(quiz.run,selected),restored=(await client(owner).history()).runs.find(run=>run.id===quiz.run.id)
   assert.equal(restored.progress.answers['q-prepare'],0);assert.equal(restored.revision,saved.revision)
   let progress=tutor.submitTutorQuestion(restored.progress,restored.bundle,'q-prepare')
   progress=tutor.submitTutorQuestion(tutor.answerTutorQuestion(progress,restored.bundle,'q-execute',0),restored.bundle,'q-execute')
   progress=tutor.submitTutorQuestion(tutor.answerTutorQuestion(progress,restored.bundle,'q-check',2),restored.bundle,'q-check')
   saved=await mine.progress(restored,progress);finished=(await client(owner).history()).runs.find(run=>run.id===saved.id)
   assert.deepEqual(plain(tutor.tutorQuizResult(finished.bundle,finished.progress)),{answered:3,total:3,correct:2,mistakes:['q-execute']})
   assert.deepEqual(plain(finished.progress),plain(progress));assert.equal(finished.revision,3)
  })
  await t.test('follow-up resolves previous own messages server-side while quiz keys/progress are absent from automatic dialogue context',async()=>{
   const prompt=local.buildTutorPersonalFollowUp(finished,'explain');assert.match(prompt,/2 правильних із 3/);assert.match(prompt,/Моя перевірена відповідь/)
   const next=await mine.generate({requestId:'chat-integration-feedback',mode:'explain',prompt,sources:[note],conversationRunIds:[first.run.id,quiz.run.id]})
   assert.equal(next.run.bundle.mode,'explain');assert.ok(next.run.bundle.steps.length>0)
   const input=JSON.parse(providerPayloads.at(-1).input[0].content[0].text)
   assert.equal(input.previousConversation.length,4);assert.equal(input.previousConversation[2].content,quiz.run.request.prompt)
   assert.doesNotMatch(JSON.stringify(input.previousConversation),/correctIndex|answers|submitted|q-execute/)
   assert.match(input.prompt,/Це мій особистий тест/);assert.ok(moderations.some(text=>text.includes('previousConversation')||text.includes('conversation')))
   assert.deepEqual(plain((await client(owner).history()).runs[0].request.conversationRunIds),[first.run.id,quiz.run.id])
  })
  await t.test('same saved request replays without another model call or charge and changed content conflicts',async()=>{
   const before=await mine.status(),count=providerCalls,result=await mine.generate(quiz.run.request)
   assert.equal(result.replayed,true);assert.equal(providerCalls,count);assert.equal((await mine.status()).budget.spentUsd,before.budget.spentUsd)
   await assert.rejects(mine.generate({...quiz.run.request,prompt:'Інший запит під тим самим номером.'}),error=>error.code==='conflict')
   assert.equal(providerCalls,count)
  })
  await t.test('other account cannot read, continue or update the owner’s saved test; rejection spends no allowance',async()=>{
   const count=providerCalls;assert.equal((await theirs.history()).runs.length,0)
   await assert.rejects(theirs.generate({requestId:'foreign-follow-up',mode:'chat',prompt:'Поясни попереднє.',sources:[],conversationRunIds:[quiz.run.id]}),error=>error.code==='forbidden')
   await assert.rejects(theirs.progress(finished,finished.progress),error=>error.code==='forbidden')
   assert.ok(rpcCalls.some(call=>call.name==='xelay_student_library_run'&&call.userId===other.id),'missing recent references use the actual caller-scoped archive function')
   assert.equal(providerCalls,count);assert.equal((await theirs.status()).budget.spentUsd,0)
  })
  clock+=61000
  for(const format of['true_false','gap_fill','smart_text','written','exercise','podcast'])await t.test(`${format}: real version2 generation, validated progress, autosave and reload keep old version1 answers`,async()=>{
   const generated=await mine.generate({requestId:'study-integration-'+format,mode:tutor.tutorStudyMode(format),prompt:'Створи вправу за моїм конспектом.',sources:[note],studyFormat:format})
   const run=generated.run;assert.equal(run.bundle.version,2);assert.equal(run.bundle.study.format,format);assert.equal(run.progress.version,2)
   let progress=run.progress
   if(format==='true_false')progress=tutor.submitTutorQuestion(tutor.answerTutorQuestion(progress,run.bundle,'true-prepare',0),run.bundle,'true-prepare')
   if(format==='gap_fill'){
    progress=tutor.submitTutorStudy(tutor.answerTutorStudy(progress,run.bundle,'gap-prepare',' ПІДГОТОВКА '),run.bundle,'gap-prepare')
    assert.equal(tutor.tutorStudyResult(run.bundle,progress).correct,1)
    assert.equal(tutor.answerTutorStudy(progress,run.bundle,'gap-prepare','Changed'),progress,'Submitted text is locked until an explicit new practice')
   }
   if(format==='smart_text')progress=tutor.toggleTutorStudyDone(progress,run.bundle,'read-prepare')
   if(format==='written'||format==='exercise'){
    progress=tutor.submitTutorStudy(tutor.answerTutorStudy(progress,run.bundle,'written-compare','Спочатку визначають мету, а потім порівнюють із нею результат.'),run.bundle,'written-compare')
    progress=tutor.rateTutorStudy(progress,run.bundle,'written-compare','known');assert.equal(tutor.tutorStudyResult(run.bundle,progress).writtenSubmitted,1);assert.equal(progress.aiScore,undefined)
   }
   if(format==='podcast')progress=tutor.toggleTutorStudyDone(progress,run.bundle,'dialogue-2')
   const saved=await mine.progress(run,progress),restored=(await client(owner).history()).runs.find(item=>item.id===run.id)
   assert.deepEqual(plain(restored.progress),plain(progress));assert.equal(restored.revision,saved.revision)
   const old=(await mine.history()).runs.find(item=>item.id===finished.id);assert.deepEqual(plain(old.progress),plain(finished.progress));assert.equal(old.bundle.version,1)
   await assert.rejects(theirs.progress(restored,restored.progress),error=>error.code==='forbidden')
   assert.throws(()=>clientApi.validateProductionProgress({...progress,studyAnswers:{foreign:'forged'}},run))
   assert.throws(()=>clientApi.validateProductionProgress({...progress,aiScore:100},run))
   for(const invalid of[{...progress,studyAnswers:{foreign:'forged'}},{...progress,aiScore:100}])await assert.rejects(databaseRpc('authenticated',owner,'xelay_max_run_progress',{p_run_id:run.id,p_expected_version:restored.revision,p_progress:invalid}),error=>error.code==='22023')
   assert.equal((await mine.history()).runs.find(item=>item.id===run.id).revision,restored.revision)
   const corrupt=plain(run.bundle);if(format==='true_false')corrupt.questions[0].options=['Так','Ні'];else corrupt.study[format==='gap_fill'?'gaps':format==='smart_text'?'reading':format==='podcast'?'dialogue':'written'][0].sourceId='foreign-source'
   assert.equal((await queued(()=>rows('select xelay_student_private.bundle_valid($1,$2)v',[corrupt,run.request])))[0].v,false)
   if(format!=='true_false'){
    const key=format==='gap_fill'?'gaps':format==='smart_text'?'reading':format==='podcast'?'dialogue':'written',typedRequest=plain(run.request);typedRequest.sources[0].id='123'
    const typedBundle=plain(run.bundle);typedBundle.citations.forEach(c=>{c.sourceId='123'});typedBundle.questions.forEach(q=>{q.sourceId='123'});typedBundle.study[key].forEach(item=>{item.sourceId='123'})
    assert.equal((await queued(()=>rows('select xelay_student_private.bundle_valid($1,$2)v',[typedBundle,typedRequest])))[0].v,true)
    for(const field of['id','sourceId']){const numeric=plain(typedBundle);numeric.study[key][0][field]=field==='id'?777:123;assert.throws(()=>tutor.validateTutorBundle(numeric,typedRequest));assert.equal((await queued(()=>rows('select xelay_student_private.bundle_valid($1,$2)v',[numeric,typedRequest])))[0].v,false)}
   }
   if(format==='gap_fill'){
    const spellingRequest=plain(run.request);spellingRequest.sources[0].text="З'ясування мети.";const spelling=plain(run.bundle);spelling.citations=[{sourceId:spellingRequest.sources[0].id,quote:spellingRequest.sources[0].text}];spelling.study.gaps[0].acceptedAnswers=['з’ясування']
    assert.throws(()=>tutor.validateTutorBundle(spelling,spellingRequest));assert.equal((await queued(()=>rows('select xelay_student_private.bundle_valid($1,$2)v',[spelling,spellingRequest])))[0].v,false)
    spelling.study.gaps[0].acceptedAnswers=["З'ясування"];assert.equal(tutor.validateTutorBundle(spelling,spellingRequest).version,2);assert.equal((await queued(()=>rows('select xelay_student_private.bundle_valid($1,$2)v',[spelling,spellingRequest])))[0].v,true)
   }
  })
  await t.test('actual ledger charges one amount per generation and official grades remain byte-for-byte unchanged',async()=>{
   const state=await mine.status();assert.equal(state.budget.limitUsd,10);assert.equal(state.budget.reservedUsd,0);assert.equal(state.budget.spentUsd,providerCalls*0.014)
   const requestRows=await queued(()=>rows('select state,charge_micros,budget_grant_id from xelay_student_private.requests where user_id=$1',[owner.id]))
   assert.equal(requestRows.length,providerCalls);assert.ok(requestRows.every(row=>row.state==='done'&&row.charge_micros===14000&&row.budget_grant_id))
   assert.deepEqual(await queued(()=>rows('select *from public.official_grade_sentinel order by id')),[{id:1,score:85},{id:2,score:92}])
   for(const role of['anon','authenticated','service_role'])for(const fn of['study_valid(jsonb,jsonb)','study_text(jsonb,integer,boolean)','initialize_study_progress()'])assert.equal((await queued(()=>rows('select has_function_privilege($1,$2,$3)v',[role,'xelay_student_private.'+fn,'execute'])))[0].v,false)
  })
 }finally{await queue;await db.close()}
})
