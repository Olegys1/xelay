import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import path from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const native=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map()
function load(file){const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module);const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;vm.runInNewContext(code,{module,exports:module.exports,process,Buffer,TextEncoder,TextDecoder,Uint8Array,AbortController,AbortSignal,Response,URL,Set,Map,Promise,Date,Number,JSON,setTimeout,clearTimeout,fetch:()=>{throw Error('Live calls forbidden')},require(name){if(name.startsWith('.')&&name.endsWith('.js'))name=name.slice(0,-3);if(name==='@supabase/supabase-js')return {createClient(){throw Error('A test must inject its database')}};return name.startsWith('.')?load(path.resolve(path.dirname(absolute),name)+'.ts'):native(name)}},{filename:absolute});return module.exports}
const api=load('server/student-learning/maxTutorProduction.ts'),tutor=load('src/lib/maxTutor.ts'),plain=v=>JSON.parse(JSON.stringify(v))
const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',SESSION='33333333-3333-4333-8333-333333333333',NOW=1794823200000
const KEY=['sk','synthetic','server','credential','for','max','tests'].join('-')
const environment={STUDENT_MAX_ENABLED:'true',STUDENT_MAX_AI_ENABLED:'true',SUPABASE_URL:'https://baohfpadxvhqhhjjqtil.supabase.co',SUPABASE_ANON_KEY:'synthetic-public-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-private-key',OPENAI_API_KEY:KEY}
const token=(extra={})=>['synthetic-header',Buffer.from(JSON.stringify({sub:OWNER,role:'authenticated',session_id:SESSION,exp:Math.floor(NOW/1000)+3600,...extra})).toString('base64url'),'synthetic-signature'].join('.')
const original=tutor.createTutorDemo('run-1','quiz'),request=()=>plain(original.request)
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})

function fixture(options={}){
 const calls=[],providerInputs=[],sources=new Map(),reservations=new Map(),saved=new Map();let spent=0,authCalls=0,providerCalls=0,moderationCalls=0
 let state={userId:OWNER,audience:'student',planId:'max',aiAllowance:'available',monthlyAiBudgetUsd:10,budgetPeriod:'subscription_month',budgetResetsAt:new Date(NOW+86400000).toISOString(),expiresAt:new Date(NOW+86400000).toISOString(),budget:{limitMicros:10000000,spentMicros:0,reservedMicros:0},...options.workspace}
 const rpc=async(role,name,args={})=>{
  calls.push({role,name,args:plain(args)});if(options.rpc){const result=await options.rpc(role,name,args,{saved,sources,reservations,setWorkspace:value=>state={...state,...value}});if(result!==undefined)return result}
  const ok=data=>({data,error:null}),denied=()=>({data:null,error:{code:'42501',message:'PRIVATE_DB_ERROR'}})
  if(name==='xelay_student_workspace_status')return ok({...state,budget:{...state.budget,spentMicros:spent}})
  if(name==='xelay_max_sources_put'){if(role!=='caller')return denied();const existing=sources.get(args.p_request_id);if(existing&&JSON.stringify(existing)!==JSON.stringify(args.p_sources))return {data:null,error:{code:'PT409'}};sources.set(args.p_request_id,plain(args.p_sources));return ok(plain(args.p_sources))}
  if(name==='xelay_max_sources_get')return ok({userId:OWNER,sources:(sources.get(args.p_request_id)||[]).filter(s=>args.p_source_ids.includes(s.id)).map(s=>({...s,canRead:true,aiAllowed:true}))})
  if(name==='xelay_max_ai_reserve'){
   if(role!=='service')return denied();const prior=reservations.get(args.p_request_id);if(prior)return ok(prior.fingerprint!==args.p_fingerprint?{state:'conflict'}:prior.bundle?{state:'replay',bundle:prior.bundle}:{state:'pending'})
   if(options.quotaDenied)return ok({state:'denied'})
   reservations.set(args.p_request_id,{fingerprint:args.p_fingerprint,reserve:args.p_reserve_micros,request:plain(args.p_request)});return ok({state:'reserved',reservationId:'44444444-4444-4444-8444-444444444444'})
  }
  if(name==='xelay_max_ai_finish'){
   if(role!=='service')return denied();const row=reservations.get(args.p_request_id);if(!row)return denied();row.bundle=args.p_bundle;spent+=args.p_charge_micros
   if(args.p_bundle)saved.set(args.p_request_id,{id:args.p_request_id,createdAt:new Date(NOW).toISOString(),demo:false,request:args.p_request,bundle:args.p_bundle,progress:plain(tutor.emptyTutorProgress()),revision:1});return ok({settled:true,stored:!!args.p_bundle,replayed:false})
  }
  if(name==='xelay_max_runs_list')return ok([...saved.values()].reverse().slice(0,args.p_limit))
  if(name==='xelay_max_run_progress'){const row=saved.get(args.p_run_id);if(!row)return denied();if(row.revision!==args.p_expected_version)return {data:null,error:{code:'PT409'}};row.progress=plain(args.p_progress);row.revision++;return ok(row)}
  throw Error('Unexpected RPC '+name)
 }
 const factory=(_url,key)=>{
  const role=key===environment.SUPABASE_ANON_KEY?'caller':'service'
  return {
   auth:{async getUser(){authCalls++;return options.authDenied?{data:{user:null},error:{message:'PRIVATE_AUTH_ERROR'}}:{data:{user:{id:OWNER,email_confirmed_at:'2026-11-16T00:00:00Z',user_metadata:{first_name:'FORGED_METADATA_NAME',planId:'max'}}},error:null}}},
   rpc:(name,args)=>rpc(role,name,args),
   from(table){return{select(columns){return{eq(column,value){return{async maybeSingle(){
    calls.push({role,name:'profile-select',args:{table,columns,column,value}})
    return options.profileError?{data:null,error:{message:'PRIVATE_PROFILE_ERROR'}}:{data:options.profile||{id:OWNER},error:null}
   }}}}}}}
  }
 }
 const fetcher=async(url,init)=>{
  const payload=JSON.parse(init.body);if(url==='https://api.openai.com/v1/moderations'){moderationCalls++;if(options.moderationError)throw Error('PRIVATE_MODERATION_ERROR');return json({results:[{flagged:options.flagged===true||options.flagOutput&&moderationCalls>1?true:false}]})}
  if(url!=='https://api.openai.com/v1/responses')throw Error('Unexpected network URL')
  providerCalls++;if(options.generate)return options.generate(payload,{sources,saved,reservations,setWorkspace:value=>state={...state,...value}})
  const content=JSON.parse(payload.input[0].content[0].text),bundle=plain(original.bundle);providerInputs.push(content);bundle.mode=content.mode;const ids=content.sources.map(s=>s.id);for(const q of bundle.questions)q.sourceId=ids[0]||'';for(const c of bundle.cards)c.sourceId=ids[0]||'';bundle.citations=content.sources.length?[{sourceId:ids[0],quote:content.sources[0].text.slice(0,100)}]:[]
  if(content.mode==='chat'){bundle.questions=[];bundle.cards=[];bundle.plan=[];bundle.math=null;bundle.introduction='Інфляція — це зростання загального рівня цін.';bundle.steps=[]}
  if(content.mode==='plan'){const base=bundle.questions;bundle.questions=bundle.plan.flatMap((_,index)=>base.map((q,at)=>({...q,id:`plan-${index}-q-${at}`})));bundle.plan=bundle.plan.map((block,index)=>({...block,questionIds:bundle.questions.slice(index*3,index*3+3).map(q=>q.id)}))}
  return json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(bundle)}]}],usage:{input_tokens:1000,output_tokens:500,total_tokens:1500,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:100}}})
 }
 const handler=api.createMaxTutorProduction({environment:{...environment,...options.environment},clientFactory:factory,fetcher,now:()=>NOW,...(options.groupMaterialsFactory?{groupMaterialsFactory:options.groupMaterialsFactory}:{})})
 async function call(action='status',body,headers={}){const req=new EventEmitter(),res=new EventEmitter();req.method=body===undefined?'GET':'POST';req.url='/api/student-learning?action='+action;req.headers={authorization:'Bearer '+token(),'content-type':'application/json',...(body===undefined?{}:{origin:'https://www.xelay.ink'}),...headers};req.body=body;const responseHeaders={};res.text='';res.setHeader=(name,value)=>responseHeaders[name]=value;if(options.streaming)res.write=text=>{res.text+=text;options.onChunk?.(JSON.parse(text));return true};res.end=text=>{res.text+=text||'';res.writableEnded=true};await handler(req,res);let value;try{value=JSON.parse(res.text)}catch{};const events=responseHeaders['Content-Type']?.startsWith('application/x-ndjson')?res.text.trim().split('\n').map(line=>JSON.parse(line)):[];return {http:res.statusCode,headers:responseHeaders,value,events,req,res}}
 return {call,calls,providerInputs,sources,saved,reservations,get authCalls(){return authCalls},get providerCalls(){return providerCalls},get moderationCalls(){return moderationCalls},get spent(){return spent},setWorkspace(value){state={...state,...value}}}
}

test('Plus API permits basic cloud study but rejects Max formats before any paid work',async()=>{
 const f=fixture({workspace:{planId:'plus',monthlyAiBudgetUsd:3,budget:{limitMicros:3000000,spentMicros:0,reservedMicros:0}}})
 const status=await f.call();assert.equal(status.value.canGenerate,true);assert.equal(status.value.budget.limitUsd,3)
 for(const mode of ['chat','quiz','cards']){const r={...request(),requestId:'plus-'+mode,mode,sources:[]};assert.equal((await f.call('generate',r)).http,200)}
 const count=f.providerCalls
 for(const r of [{...request(),mode:'plan'},{...request(),mode:'math'},{...request(),studyFormat:'true_false'}])assert.equal((await f.call('generate',r)).http,403)
 assert.equal(f.providerCalls,count)
 const history=await f.call('history');assert.equal(history.value.runs.length,3)
})

test('a 50-credit gift can fund a bounded short chat after base quota, while quizzes retain their full output',async()=>{
 let payload
 const f=fixture({workspace:{winterPromoCredits:50},rpc(_role,name){if(name==='xelay_student_workspace_status')return{data:{userId:OWNER,audience:'student',planId:'plus',aiAllowance:'available',monthlyAiBudgetUsd:3,budgetPeriod:'subscription_month',budgetResetsAt:new Date(NOW+86400000).toISOString(),expiresAt:new Date(NOW+86400000).toISOString(),budget:{limitMicros:3000000,spentMicros:3000000,reservedMicros:0},winterPromoCredits:50},error:null}},generate(value){payload=value;const bundle=plain(original.bundle);bundle.mode='chat';bundle.questions=[];bundle.cards=[];bundle.plan=[];bundle.math=null;bundle.citations=[];bundle.steps=[];return json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(bundle)}]}],usage:{input_tokens:1000,output_tokens:500,total_tokens:1500,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:100}}})}})
 const result=await f.call('generate',{requestId:'small-promo-chat',mode:'chat',prompt:'Привіт!',sources:[]})
 assert.equal(result.http,200);assert.equal(payload.model,'gpt-5.4-mini');assert.equal(payload.max_output_tokens,2048)
 const reserve=f.calls.find(c=>c.name==='xelay_max_ai_reserve').args.p_reserve_micros
 assert.equal(reserve,39600);assert.ok(Buffer.byteLength(JSON.stringify(payload))<=40000);assert.equal(f.spent,3000)
 const quiz=fixture({workspace:{winterPromoCredits:50},generate(value){payload=value;return json({status:'incomplete'})}})
 await quiz.call('generate',{...request(),prompt:'Створи тест на 20 запитань'})
 assert.equal(payload.model,'gpt-6.1-sol');assert.equal(payload.max_output_tokens,8192)
 assert.equal(payload.text.format.schema.properties.questions.minItems,20)
})

test('credit wallet status is negotiated so already-open older clients retain their exact contract',async()=>{
 const wallet={balanceCredits:1000,reservedCredits:0,debtCredits:0},f=fixture({workspace:{purchasedCredits:wallet}})
 const old=await f.call();assert.equal(old.http,200);assert.equal(Object.hasOwn(old.value,'purchasedCredits'),false)
 const next=await f.call('status',undefined,{'x-xelay-ai-credits':'1'});assert.equal(next.http,200);assert.deepEqual(next.value.purchasedCredits,wallet)
 assert.equal(next.value.budget.limitUsd,10);assert.equal(f.providerCalls,0)
 const rolling=await fixture().call('status',undefined,{'x-xelay-ai-credits':'1'});assert.equal(rolling.http,200);assert.equal(Object.hasOwn(rolling.value,'purchasedCredits'),false)
})

function groupFixture(options={}){
 const group=OTHER,material='55555555-5555-4555-8555-555555555555',id='gm_s_'+group+'_'+material,state={allowed:true,checks:0}
 const source={id,title:'Матеріал групи',text:'Проєкт має етапи підготовки, виконання та перевірки.',page:null,kind:'own_excerpt'}
 const guard=load('server/student-learning/studentGroupMaterialAccess.ts')
 const groupMaterialsFactory=async()=>guard.createStudentGroupMaterialAccess({userId:OWNER,
  groups:async()=>state.allowed?[{id:group,name:'Тестова група'}]:[],
  list:async()=>({records:[{kind:'material',id:material,groupId:group,title:source.title,allowAi:true}],truncated:false}),
  content:async()=>({userId:OWNER,allowAi:true,text:source.text,title:source.title,rightsVersion:'a'.repeat(32),truncated:false}),
  assertRights:async()=>{state.checks++;if(options.revokeAt===state.checks)state.allowed=false;return{userId:OWNER,allowAi:state.allowed,rightsVersion:'a'.repeat(32)}},
 })
 return Object.assign(fixture({...options,groupMaterialsFactory}),{state,source,group})
}
test('group material selection, quiz generation, answers and history retain exact provenance',async()=>{
 const f=groupFixture()
 assert.equal((await f.call('materials',{operation:'groups'})).value.value[0].id,f.group)
 const list=await f.call('materials',{operation:'list',groupId:f.group});assert.equal(list.http,200);assert.equal(list.value.value.items[0].id,f.source.id)
 assert.equal(f.providerCalls,0);assert.equal(f.moderationCalls,0)
 const preview=await f.call('materials',{operation:'preview',id:f.source.id});assert.deepEqual(preview.value.value.source,f.source)
 const r={requestId:'group-quiz',mode:'quiz',prompt:'Створи тест за матеріалом',sources:[f.source]},generated=await f.call('generate',r)
 assert.equal(generated.http,200);assert.deepEqual(f.providerInputs[0].sources,[f.source]);assert.ok(f.state.checks>=5)
 const run=generated.value.run,q=run.bundle.questions[0],progress={...run.progress,answers:{[q.id]:1},submitted:[q.id]}
 assert.equal((await f.call('progress',{runId:run.id,expectedRevision:1,progress})).http,200)
 const reloaded=(await f.call('history')).value.runs[0];assert.deepEqual(reloaded.request.sources,[f.source]);assert.equal(reloaded.progress.answers[q.id],1)
 f.state.allowed=false;const blocked=await f.call('generate',{requestId:'group-followup',mode:'chat',prompt:'Поясни попередню відповідь',sources:[],conversationRunIds:[run.id]})
 assert.equal(blocked.http,403);assert.equal(f.providerCalls,1)
 assert.equal((await f.call('history')).value.runs[0].progress.answers[q.id],1,'Revocation does not delete already saved personal answers')
})
test('group sources cannot bypass tier, identity, origin, author checks or immutable server text',async()=>{
 const denied=groupFixture({workspace:{planId:'free',aiAllowance:'not_included'}})
 assert.equal((await denied.call('materials',{operation:'groups'})).http,403)
 assert.equal((await groupFixture({authDenied:true}).call('materials',{operation:'groups'})).http,401)
 const f=groupFixture()
 assert.equal((await f.call('materials',{operation:'groups'},{origin:'https://foreign.example'})).http,403)
 assert.equal((await f.call('materials',{operation:'groups',userId:OTHER})).http,400)
 assert.equal((await f.call('materials',{operation:'preview',id:'unrelated'})).http,400)
 const forged=await f.call('generate',{requestId:'forged-group',mode:'quiz',prompt:'Створи тест',sources:[{...f.source,text:'Підміна'}]})
 assert.equal(forged.http,409);assert.equal(f.providerCalls,0);assert.equal(f.moderationCalls,0);assert.equal(f.sources.size,0)
 f.state.allowed=false;assert.equal((await f.call('materials',{operation:'preview',id:f.source.id})).http,403)
})
test('revocation between moderation and generation blocks a paid model call',async()=>{
 const f=groupFixture({revokeAt:3})
 const result=await f.call('generate',{requestId:'midflight-revoke',mode:'quiz',prompt:'Створи тест',sources:[f.source]})
 assert.notEqual(result.http,200);assert.equal(f.providerCalls,0);assert.equal(f.spent,0);assert.equal(f.saved.size,0)
})

test('production configuration is inert without explicit switches, fixed project and server credentials',()=>{
 for(const change of [{STUDENT_MAX_ENABLED:'false'},{SUPABASE_URL:'https://attacker.example'},{SUPABASE_SERVICE_ROLE_KEY:environment.SUPABASE_ANON_KEY}])assert.equal(api.maxTutorProductionConfiguration({...environment,...change}).enabled,false)
 for(const change of [{STUDENT_MAX_AI_ENABLED:'false'},{OPENAI_API_KEY:''},{STUDENT_MAX_MODEL:'https://attacker.example'}])assert.equal(api.maxTutorProductionConfiguration({...environment,...change}).aiEnabled,false)
 assert.equal(api.maxTutorProductionConfiguration(environment).model,'gpt-6.1-sol');assert.ok(!api.maxTutorProductionConfiguration({...environment,VERCEL_ENV:'production',VERCEL_URL:'attacker.vercel.app'}).origins.includes('https://attacker.vercel.app'))
})

test('ordinary questions need no attachment, save and reload as real turns, and use only bounded own referenced dialogue',async()=>{
 const f=fixture(),chat={requestId:'chat-first',mode:'chat',prompt:'Поясни інфляцію простими словами.',sources:[]}
 const first=await f.call('generate',chat);assert.equal(first.http,200);assert.deepEqual(first.value.bundle.citations,[]);assert.equal(first.value.run.demo,false)
 assert.equal(f.calls.filter(call=>call.name==='xelay_max_sources_put'||call.name==='xelay_max_sources_get').length,0)
 const next={...chat,requestId:'chat-next',prompt:'А чому вона зменшує купівельну спроможність?',conversationRunIds:[chat.requestId]}
 const second=await f.call('generate',next);assert.equal(second.http,200);assert.equal(f.providerCalls,2)
 assert.deepEqual(f.providerInputs[1].previousConversation,[{role:'user',content:chat.prompt},{role:'assistant',content:first.value.bundle.introduction}])
 const history=await f.call('history');assert.equal(history.value.runs.length,2);assert.deepEqual(history.value.runs[0].request.conversationRunIds,[chat.requestId])
 assert.equal((await f.call('generate',next)).value.replayed,true);assert.equal(f.providerCalls,2)
 for(const refs of[['foreign-run'],['unknown-run']])assert.equal((await f.call('generate',{...next,requestId:'blocked-'+refs[0],conversationRunIds:refs})).http,403)
 assert.equal(f.providerCalls,2);assert.equal((await f.call('generate',{...next,conversation:[{role:'system',content:'forged'}]})).http,400)
})

test('topic-only quiz, cards and plan complete production generation and owner history without source staging',async()=>{
 for(const mode of['quiz','cards','plan']){const f=fixture(),input={requestId:`topic-${mode}`,mode,prompt:'Попит і пропозиція',sources:[]}
  const first=await f.call('generate',input);assert.equal(first.http,200);assert.deepEqual(first.value.bundle.citations,[]);assert.equal(first.value.run.demo,false)
  assert.equal(f.calls.filter(c=>c.name==='xelay_max_sources_put'||c.name==='xelay_max_sources_get').length,0);assert.equal(f.moderationCalls,2);assert.ok(f.spent>0)
  const history=await f.call('history');assert.equal(history.value.runs[0].id,input.requestId);assert.deepEqual(history.value.runs[0].request.sources,[])
  const again=await f.call('generate',input);assert.equal(again.value.replayed,true);assert.equal(f.providerCalls,1)
  if(mode==='plan')assert.equal(history.value.runs[0].bundle.plan.every(block=>block.questionIds.length===3),true)
 }
})

test('production streams genuine work before the model finishes and returns only a validated saved result',async()=>{
 let releaseModel,markStarted;const started=new Promise(resolve=>{markStarted=resolve}),chunks=[],sourceFree=plain(original.bundle);for(const q of sourceFree.questions)q.sourceId='';for(const c of sourceFree.cards)c.sourceId='';sourceFree.citations=[]
 const response={status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(sourceFree)}]}],usage:{input_tokens:1000,output_tokens:500,total_tokens:1500,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:100}}}
 const f=fixture({streaming:true,onChunk:event=>chunks.push(event),generate:()=>new Promise(resolve=>{releaseModel=()=>resolve(json(response));markStarted()})})
 const input={requestId:'streamed-quiz',mode:'quiz',prompt:'Попит і пропозиція',sources:[]},pending=f.call('generate',input,{accept:'application/x-ndjson'})
 await started;assert.deepEqual(chunks,[{type:'progress',phase:'preparing'},{type:'progress',phase:'generating'}]);assert.equal(f.saved.size,0);assert.equal(f.calls.some(c=>c.name==='xelay_max_ai_finish'),false)
 releaseModel();const result=await pending;assert.equal(result.http,200);assert.match(result.headers['Content-Type'],/^application\/x-ndjson/);assert.equal(result.headers['Cache-Control'],'no-store, private')
 assert.deepEqual(result.events.slice(0,-1).map(event=>event.phase),['preparing','generating','validating','saving']);const final=result.events.at(-1);assert.equal(final.type,'result');assert.equal(final.status,200);assert.equal(final.value.status,'ready');assert.equal(final.value.run.id,input.requestId);assert.deepEqual(final.value.bundle,sourceFree);assert.equal(f.saved.size,1)
 assert.equal(result.events.filter(event=>event.type==='result').length,1);assert.equal(result.value,undefined,'NDJSON does not mix an extra unframed JSON result');assert.ok(f.spent>0)
})

test('streamed failures terminate once without leaking unvalidated bundles or raw upstream details',async()=>{
 for(const [options,code,phases]of[
  [{generate:async()=>{throw Error('PRIVATE_PROVIDER_FAILURE')}},'generation_failed',['preparing','generating']],
  [{flagOutput:true},'refused',['preparing','generating','validating']],
  [{rpc:async(_role,name)=>name==='xelay_max_ai_finish'?{data:null,error:{code:'XX000',message:'PRIVATE_FINISH_FAILURE'}}:undefined},'storage_failed',['preparing','generating','validating','saving']],
 ]){const f=fixture({...options,streaming:true}),result=await f.call('generate',request(),{accept:'application/x-ndjson'});assert.equal(result.http,200,'HTTP streaming status is already committed');assert.deepEqual(result.events.slice(0,-1).map(event=>event.phase),phases)
  assert.equal(result.events.filter(event=>event.type==='result').length,1);const final=result.events.at(-1);assert.equal(final.type,'result');assert.equal(final.status,503);assert.equal(final.value.status,code);assert.equal(final.value.bundle,undefined);assert.equal(f.saved.size,0);assert.doesNotMatch(result.res.text,/PRIVATE_|synthetic-server-key/);assert.equal(result.value,undefined)
 }
})

test('early unauthenticated or invalid source requests never start a progress stream',async()=>{
 for(const [options,input,headers,status]of[
  [{authDenied:true},request(),{},401],
  [{},{...request(),sources:[{...request().sources[0],kind:'official_test_key'}]},{},400],
  [{},request(),{origin:'https://foreign.invalid'},403],
 ]){const f=fixture({...options,streaming:true}),result=await f.call('generate',input,{accept:'application/x-ndjson',...headers});assert.equal(result.http,status);assert.deepEqual(result.events,[]);assert.match(result.headers['Content-Type'],/^application\/json/);assert.equal(f.providerCalls,0);assert.equal(f.calls.some(c=>c.name==='xelay_max_ai_reserve'),false)}
})

test('greeting uses caller-scoped own profile, no contacts or leftover source and real paid generation',async()=>{
 const f=fixture({profile:{id:OWNER,first_name:'Олег',full_name:'Прізвище Олег',faculty:'Економічний факультет',specialty:'Економіка',study_year:2,email:'PRIVATE_EMAIL',phone:'PRIVATE_PHONE',bio:'PRIVATE_BIO'}})
 const status=await f.call('status');assert.equal(status.value.profileDisplayName,'Олег');assert.doesNotMatch(JSON.stringify(status.value),/PRIVATE_|FORGED_METADATA_NAME/)
 const r=await f.call('generate',{requestId:'personal-greeting',mode:'chat',prompt:'Привет!',sources:request().sources});assert.equal(r.http,200);assert.equal(f.providerCalls,1);assert.ok(f.spent>0);assert.equal(r.value.run.demo,false);assert.deepEqual(r.value.run.request.sources,[])
 const context=f.providerInputs[0].personalContext;assert.deepEqual(context.profile,{firstName:'Олег',displayName:null,faculty:'Економічний факультет',specialty:'Економіка',studyYear:2});assert.deepEqual(context.practice,{topics:[],checkedAnswers:0,correctAnswers:0,completedQuizzes:0})
 assert.doesNotMatch(JSON.stringify(f.providerInputs),/PRIVATE_EMAIL|PRIVATE_PHONE|PRIVATE_BIO|FORGED_METADATA_NAME|correctIndex/)
 const reads=f.calls.filter(c=>c.name==='profile-select');assert.equal(reads.length,2);for(const read of reads){assert.equal(read.role,'caller');assert.equal(read.args.table,'profiles');assert.equal(read.args.columns,'id,first_name,full_name,faculty,specialty,study_year');assert.equal(read.args.column,'id');assert.equal(read.args.value,OWNER)}
 assert.equal(f.calls.filter(c=>c.name==='xelay_max_sources_put').length,0)
 for(const extra of[{personalContext:context},{profile:{firstName:'forged'}},{displayName:'forged'}])assert.equal((await f.call('generate',{requestId:'forged-greeting',mode:'chat',prompt:'Привіт',sources:[],...extra})).http,400)
})

test('missing, foreign or failed profile does not impersonate a name or prevent ordinary chat',async()=>{
 for(const options of[{profile:{id:OTHER,first_name:'PRIVATE_OTHER'}},{profileError:true},{profile:{id:OWNER,first_name:'<script>',full_name:'\u0000bad',email:'PRIVATE_EMAIL'}}]){
  const f=fixture(options);assert.equal((await f.call('status')).value.profileDisplayName,undefined)
  const r=await f.call('generate',{requestId:'unnamed-greeting',mode:'chat',prompt:'Привіт',sources:[]});assert.equal(r.http,200);assert.equal(f.providerInputs[0].personalContext.profile.firstName,null);assert.doesNotMatch(JSON.stringify(f.providerInputs),/PRIVATE_OTHER|PRIVATE_EMAIL|FORGED_METADATA_NAME|script/)
 }
})

test('personal learning context summarizes only selected owned private practice without raw answers or keys',async()=>{
 const f=fixture({profile:{id:OWNER,first_name:'Олег'}});assert.equal((await f.call('generate',request())).http,200)
 const run=f.saved.get(request().requestId);run.progress.answers=Object.fromEntries(run.bundle.questions.map(q=>[q.id,q.correctIndex]));run.progress.submitted=run.bundle.questions.map(q=>q.id)
 run.bundle.questions[0].explanation+=' PRIVATE_EXPLANATION';run.request.sources[0].text+=' PRIVATE_DOCUMENT'
 const r=await f.call('generate',{requestId:'practice-checkin',mode:'chat',prompt:'Як справи?',sources:[],conversationRunIds:[run.id]});assert.equal(r.http,200)
 const context=f.providerInputs.at(-1).personalContext;assert.deepEqual(context.practice,{topics:[run.bundle.title],checkedAnswers:3,correctAnswers:3,completedQuizzes:1})
 assert.doesNotMatch(JSON.stringify(context),/PRIVATE_EXPLANATION|PRIVATE_DOCUMENT|correctIndex|answers|user_id/)
 assert.throws(()=>api.resolveTutorPersonalContext(context.profile,[{...run,demo:true}],[run.id]))
 assert.throws(()=>api.resolveTutorPersonalContext(context.profile,[run],['foreign-run']))
})

test('dialogue reuse excludes quiz keys/progress and protected source data, and rejects oversized or self-referencing history',async()=>{
 const f=fixture();assert.equal((await f.call('generate',request())).http,200)
 const run=f.saved.get(request().requestId);run.bundle.questions[0].options[0]='PRIVATE_QUIZ_KEY_MARKER';run.progress.answers={private:99}
 const chat={requestId:'chat-after-quiz',mode:'chat',prompt:'Поясни попереднє пояснення.',sources:[],conversationRunIds:[run.id]}
 assert.equal((await f.call('generate',chat)).http,200);assert.doesNotMatch(JSON.stringify(f.providerInputs.at(-1).previousConversation),/PRIVATE_QUIZ_KEY_MARKER|correctIndex|private/)
 for(const change of[{conversationRunIds:Array(5).fill(run.id)},{conversationRunIds:[chat.requestId]},{sources:[{...request().sources[0],kind:'official_test_key'}]}])assert.equal((await f.call('generate',{...chat,...change})).http,400)
 const huge=Array.from({length:4},(_,n)=>({...run,id:'own-saved-'+n,request:{...run.request,prompt:'п'.repeat(2400)},bundle:{...run.bundle,introduction:'в'.repeat(2400),steps:Array.from({length:12},()=>({title:'крок',body:'б'.repeat(1600)}))}}))
 const turns=api.resolveTutorConversation(huge,huge.map(r=>r.id));assert.equal(turns.length,8);assert.ok(turns.reduce((n,t)=>n+t.content.length,0)<=12000)
})
test('status is authenticated, owner scoped and private, without provider calls or key echoes',async()=>{
 const f=fixture(),r=await f.call();assert.equal(r.http,200);assert.equal(r.value.canGenerate,true);assert.equal(r.value.scope.userId,OWNER);assert.equal(r.value.scope.sessionId,SESSION);assert.equal(r.value.localOnly,false);assert.equal(r.value.budgetPeriod,'subscription_month');assert.equal(r.value.budgetResetsAt,new Date(NOW+86400000).toISOString());assert.match(r.headers['Cache-Control'],/no-store/);assert.equal(r.headers['Access-Control-Allow-Origin'],undefined);assert.equal(f.providerCalls,0);assert.ok(!JSON.stringify(r.value).includes(KEY));assert.ok(!JSON.stringify(r.value).includes('synthetic-private-key'));assert.equal(f.authCalls,1)
})
test('code-first rollout handles old capped SQL without relabeling its period or granting the new allowance',async()=>{
 const legacy={monthlyAiBudgetUsd:6,budgetPeriod:undefined,budgetResetsAt:undefined,budget:{limitMicros:6000000,spentMicros:1234,reservedMicros:0}}
 const f=fixture({workspace:legacy}),r=await f.call()
 assert.equal(r.http,200);assert.equal(r.value.canGenerate,true);assert.equal(r.value.budgetPeriod,'utc_calendar_month');assert.equal(r.value.budget.limitUsd,6)
 assert.equal(r.value.budgetResetsAt,'2026-12-01T00:00:00.000Z')
 assert.equal((await f.call('generate',request())).http,200)
 for(const change of [{monthlyAiBudgetUsd:10},{budget:{limitMicros:10000000,spentMicros:0,reservedMicros:0}},{budgetPeriod:'untrusted'}]){
  const bad=fixture({workspace:{...legacy,...change}}),result=await bad.call();assert.equal(result.http,503);assert.equal(bad.providerCalls,0)
 }
})

test('cross-origin, absent mutation origin, foreign/expired claims and unsigned authority are rejected before generation',async()=>{
 const f=fixture();for(const headers of [{origin:'https://evil.example'},{origin:undefined},{authorization:'Bearer '+token({sub:OTHER})},{authorization:'Bearer '+token({session_id:'invalid'})},{authorization:'Bearer '+token({exp:1})},{authorization:'Basic nope'}]){const r=await f.call('generate',request(),headers);assert.ok([401,403].includes(r.http));assert.equal(f.providerCalls,0)}
 const denied=fixture({authDenied:true});assert.equal((await denied.call()).http,401);assert.equal(denied.calls.length,0)
})
test('client cannot grant Max, supply a secret/model/identity or send protected test source types',async()=>{
 for(const change of [{planId:'max'},{apiKey:KEY},{userId:OTHER},{model:'gpt-6.1-sol'},{sources:[{...request().sources[0],kind:'official_test_key'}]}]){const f=fixture(),r=await f.call('generate',{...request(),...change});assert.equal(r.http,400);assert.equal(f.providerCalls,0);assert.ok(!JSON.stringify(r.value).includes(KEY))}
 for(const workspace of [{planId:'free'},{audience:'teacher'},{audience:'unresolved'},{aiAllowance:'pending_legacy_policy'},{expiresAt:new Date(NOW-1).toISOString()}]){const f=fixture({workspace}),r=await f.call('generate',request());assert.equal(r.http,403);assert.equal(f.providerCalls,0)}
})
test('real route stages only selected text and uses verified owner/session with an atomic service-only reservation',async()=>{
 const f=fixture(),r=await f.call('generate',request());assert.equal(r.http,200);assert.equal(r.value.status,'ready');assert.equal(r.value.run.id,request().requestId);assert.equal(r.value.run.revision,1);assert.equal(r.value.run.demo,false);assert.equal(f.providerCalls,1);assert.equal(f.moderationCalls,2);assert.ok(f.spent>0);assert.equal(f.authCalls,1)
 const put=f.calls.find(c=>c.name==='xelay_max_sources_put'),reserve=f.calls.find(c=>c.name==='xelay_max_ai_reserve'),finish=f.calls.find(c=>c.name==='xelay_max_ai_finish');assert.equal(put.role,'caller');assert.equal(reserve.role,'service');assert.equal(finish.role,'service');assert.equal(reserve.args.p_user_id,OWNER);assert.match(reserve.args.p_session_hash,/^[a-f0-9]{64}$/);assert.equal(reserve.args.p_session_hash,finish.args.p_session_hash);assert.deepEqual(put.args.p_sources,request().sources);assert.equal(finish.args.p_request.requestId,request().requestId)
})
test('same request replays immutable stored generation without a second model charge; changed source conflicts',async()=>{
 const f=fixture();await f.call('generate',request());const spent=f.spent,r=await f.call('generate',request());assert.equal(r.http,200);assert.equal(r.value.replayed,true);assert.equal(f.providerCalls,1);assert.equal(f.spent,spent)
 const changed=request();changed.sources[0].text+=' Змінено.';const conflict=await f.call('generate',changed);assert.equal(conflict.http,409);assert.equal(f.providerCalls,1)
})
test('personal answers save durably, history restores them and stale revisions return current run without overwriting',async()=>{
 const f=fixture(),generated=await f.call('generate',request()),run=generated.value.run,q=run.bundle.questions[0],progress={answers:{[q.id]:q.correctIndex},submitted:[q.id],cardRatings:{},doneTasks:[]};const saved=await f.call('progress',{runId:run.id,expectedRevision:1,progress});assert.equal(saved.http,200);assert.equal(saved.value.run.revision,2);assert.deepEqual(saved.value.run.progress,progress)
 const restored=await f.call('history');assert.deepEqual(restored.value.runs[0].progress,progress);const stale=await f.call('progress',{runId:run.id,expectedRevision:1,progress:{...progress,submitted:[]}});assert.equal(stale.http,409);assert.equal(stale.value.run.revision,2);assert.deepEqual(stale.value.run.progress,progress);assert.equal(f.providerCalls,1)
})
test('20 and 30 question quizzes preserve every answer through HTTP history and maintain bounded personal context',async()=>{
 for(const count of [20,30]){
  const input={...request(),requestId:`quiz-${count}`,prompt:`Створи тест на ${count} запитань`},bundle=plain(original.bundle)
  bundle.questions=Array.from({length:count},(_,index)=>({...bundle.questions[0],id:`question-${index}`}))
  const f=fixture({generate:async payload=>{
   assert.equal(payload.text.format.schema.properties.questions.minItems,count);assert.equal(payload.text.format.schema.properties.questions.maxItems,count)
   return json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(bundle)}]}],usage:{input_tokens:1000,output_tokens:500,total_tokens:1500,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:100}}})
  }})
  const generated=await f.call('generate',input);assert.equal(generated.http,200);const run=generated.value.run
  const progress={answers:Object.fromEntries(bundle.questions.map(q=>[q.id,q.correctIndex])),submitted:bundle.questions.map(q=>q.id),cardRatings:{},doneTasks:[]}
  const saved=await f.call('progress',{runId:run.id,expectedRevision:1,progress});assert.equal(saved.http,200);assert.equal(saved.value.run.progress.submitted.length,count)
  const restored=await f.call('history');assert.deepEqual(restored.value.runs[0].progress,progress);assert.equal(restored.value.runs[0].bundle.questions.length,count)
  for(const invalid of [{...progress,submitted:[...progress.submitted,'foreign']},{...progress,submitted:[...progress.submitted.slice(0,-1),progress.submitted[0]]},{...progress,answers:{...progress.answers,foreign:0}}])assert.equal((await f.call('progress',{runId:run.id,expectedRevision:2,progress:invalid})).http,400)
  const ownRuns=Array.from({length:4},(_,index)=>({...saved.value.run,id:`practice-${index}`}))
  const context=api.resolveTutorPersonalContext({firstName:'Олег',displayName:null,faculty:null,specialty:null,studyYear:null},ownRuns,ownRuns.map(r=>r.id))
  assert.equal(context.practice.checkedAnswers,count*4);assert.equal(context.practice.correctAnswers,count*4);assert.equal(context.practice.completedQuizzes,4)
  assert.equal(f.providerCalls,1)
 }
 const blocked=fixture(),response=await blocked.call('generate',{...request(),prompt:'Тест на 31 запитання'});assert.equal(response.http,400);assert.equal(blocked.providerCalls,0);assert.equal(blocked.reservations.size,0)
})

test('invented grades, unknown question IDs and foreign personal runs cannot be saved',async()=>{
 const f=fixture(),r=await f.call('generate',request()),run=r.value.run;for(const progress of [{answers:{unknown:0},submitted:[],cardRatings:{},doneTasks:[]},{answers:{},submitted:[],cardRatings:{},doneTasks:[],officialGrade:100},{answers:{},submitted:['unknown'],cardRatings:{},doneTasks:[]},{answers:{},submitted:[],cardRatings:{},doneTasks:['unknown:0']}])assert.equal((await f.call('progress',{runId:run.id,expectedRevision:1,progress})).http,400)
 assert.equal((await f.call('progress',{runId:'foreign-run',expectedRevision:1,progress:{answers:{},submitted:[],cardRatings:{},doneTasks:[]}})).http,403)
})
test('expired entitlement preserves own history and progress but blocks any new generation',async()=>{
 const f=fixture(),r=await f.call('generate',request());f.setWorkspace({planId:'free',aiAllowance:'not_included',monthlyAiBudgetUsd:0,expiresAt:new Date(NOW-1).toISOString()});assert.equal((await f.call('status')).value.canGenerate,false);assert.equal((await f.call('history')).value.runs.length,1);assert.equal((await f.call('progress',{runId:r.value.run.id,expectedRevision:1,progress:r.value.run.progress})).http,200);const next=request();next.requestId='new-after-expiry';assert.equal((await f.call('generate',next)).http,403);assert.equal(f.providerCalls,1)
})
test('budget denial and moderation failures do not generate or substitute a demo',async()=>{
 for(const options of [{quotaDenied:true},{moderationError:true},{flagged:true}]){const f=fixture(options),r=await f.call('generate',request());assert.notEqual(r.http,200);assert.equal(f.providerCalls,0);assert.equal(f.saved.size,0);assert.ok(!JSON.stringify(r.value).includes('PRIVATE_'))}
})
test('revoked identity/source rights fail before payment or result publication',async()=>{
 let checked=0;const f=fixture({rpc:async(_role,name)=>{if(name==='xelay_student_workspace_status'&&++checked>2)return {data:null,error:{code:'42501'}}}}),r=await f.call('generate',request());assert.notEqual(r.http,200);assert.equal(f.providerCalls,0);assert.equal(f.saved.size,0)
 const g=fixture({rpc:async(_role,name)=>name==='xelay_max_ai_finish'?{data:null,error:{code:'42501'}}:undefined}),failed=await g.call('generate',request());assert.equal(failed.http,503);assert.equal(g.saved.size,0);assert.equal(g.providerCalls,1)
})
test('unknown provider outcome retains conservative cost and exposes no raw provider secret',async()=>{
 const f=fixture({generate:async()=>{throw Error('PRIVATE_PROVIDER_SECRET '+KEY)}}),r=await f.call('generate',request());assert.equal(r.http,503);assert.equal(r.value.status,'generation_failed');assert.ok(f.spent>400000);assert.equal(f.saved.size,0);assert.ok(!JSON.stringify(r.value).includes('PRIVATE_'));assert.ok(!JSON.stringify(r.value).includes(KEY))
})

test('own-note uses the gateway note path but remains staged for transactional source checks',async()=>{
 const f=fixture(),r=request();r.sources[0]={...r.sources[0],id:'own-note',page:null};assert.equal((await f.call('generate',r)).http,200)
 const put=f.calls.find(c=>c.name==='xelay_max_sources_put'),get=f.calls.find(c=>c.name==='xelay_max_sources_get'),reserve=f.calls.find(c=>c.name==='xelay_max_ai_reserve');assert.equal(put.args.p_sources[0].id,'own-note');assert.deepEqual(get.args.p_source_ids,[]);assert.equal(reserve.args.p_request.sources[0].id,'own-note')
})

test('unapproved model output is charged but cannot become saved content or a demo fallback',async()=>{
 const f=fixture({flagOutput:true}),r=await f.call('generate',request());assert.equal(r.value.status,'refused');assert.equal(f.providerCalls,1);assert.equal(f.saved.size,0);assert.ok(f.spent>0);const finish=f.calls.find(c=>c.name==='xelay_max_ai_finish');assert.equal(finish.args.p_bundle,null)
})

test('settled charge without authorized persisted output cannot be presented as successful generation',async()=>{
 const f=fixture({rpc:async(_role,name)=>name==='xelay_max_ai_finish'?{data:{settled:true,stored:false},error:null}:undefined}),r=await f.call('generate',request());assert.equal(r.http,503);assert.equal(r.value.status,'storage_failed');assert.equal(f.providerCalls,1);assert.equal(f.saved.size,0)
})

test('per-instance burst preflight bounds active generation before more moderation or provider calls',async()=>{
 const releases=[];let started=0;const f=fixture({generate:async()=>{started++;await new Promise(resolve=>releases.push(resolve));throw Error('Synthetic stop')}});
 const a=request(),b=request(),c=request();a.requestId='active-a';b.requestId='active-b';c.requestId='active-c';const first=f.call('generate',a),second=f.call('generate',b);
 while(started<2)await new Promise(resolve=>setTimeout(resolve,0));const moderationBefore=f.moderationCalls,blocked=await f.call('generate',c);assert.equal(blocked.http,429);assert.equal(blocked.value.status,'rate_limited');assert.equal(f.moderationCalls,moderationBefore);assert.equal(f.providerCalls,2);for(const release of releases)release();await Promise.all([first,second]);
 const next=request();next.requestId='after-release';const pending=f.call('generate',next);while(started<3)await new Promise(resolve=>setTimeout(resolve,0));releases.at(-1)();assert.equal((await pending).value.status,'generation_failed');
})

test('per-instance ten-request minute bound cannot be bypassed by creating new request IDs',async()=>{
 const f=fixture({moderationError:true});for(let i=0;i<10;i++){const r=request();r.requestId='burst-'+i;assert.equal((await f.call('generate',r)).value.status,'moderation_failed')}const before=f.moderationCalls,r=request();r.requestId='burst-eleven';const blocked=await f.call('generate',r);assert.equal(blocked.http,429);assert.equal(blocked.value.status,'rate_limited');assert.equal(f.moderationCalls,before);assert.equal(f.providerCalls,0)
})

test('database concurrency and request-rate denials do not falsely report monthly AI allowance exhausted',async()=>{
 for(const message of ['MAX_REQUEST_RATE_LIMIT','MAX_CONCURRENCY_LIMIT']){const f=fixture({rpc:async(_role,name)=>name==='xelay_max_sources_put'?{data:null,error:{code:'PT429',message}}:undefined}),r=await f.call('generate',request());assert.equal(r.http,429);assert.equal(r.value.status,'rate_limited');assert.doesNotMatch(r.value.error,/періоду підписки/);assert.equal(f.moderationCalls,0);assert.equal(f.providerCalls,0)}
 const f=fixture({quotaDenied:true}),r=await f.call('generate',request());assert.equal(r.http,429);assert.equal(r.value.status,'quota_exhausted');assert.match(r.value.error,/періоду підписки/);assert.equal(f.providerCalls,0)
})

test('the emitted production API and its real dependency graph load under native Node ESM without extension resolution hooks',async()=>{
 const output=await mkdtemp(path.join(root,'.max-node-esm-'))
 assert.equal(path.dirname(path.resolve(output)),path.resolve(root));assert.ok(path.basename(output).startsWith('.max-node-esm-'),'Only the verified test directory may be removed')
 try{
  const entry=path.join(root,'api/student-learning.ts'),options={target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,rootDir:root,outDir:output,strict:true,skipLibCheck:true,noEmitOnError:true,rewriteRelativeImportExtensions:true,esModuleInterop:true,types:['node']},program=ts.createProgram([entry],options)
  const diagnostics=ts.getPreEmitDiagnostics(program);assert.equal(diagnostics.filter(d=>d.category===ts.DiagnosticCategory.Error).length,0,ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:f=>f,getCurrentDirectory:()=>root,getNewLine:()=> '\n'}))
  assert.equal(program.emit().emitSkipped,false)
  let runtimeEdges=0
  for(const file of program.getSourceFiles()){
   const sourceRelative=path.relative(root,file.fileName)
   if(file.isDeclarationFile||sourceRelative.startsWith('..'+path.sep)||path.isAbsolute(sourceRelative)||file.fileName.replaceAll('\\','/').includes('/node_modules/'))continue
   const relative=sourceRelative.replace(/\.tsx?$/,'.js'),emitted=await readFile(path.join(output,relative),'utf8'),ast=ts.createSourceFile(relative,emitted,ts.ScriptTarget.ES2022,true,ts.ScriptKind.JS)
   for(const statement of ast.statements){if(!(ts.isImportDeclaration(statement)||ts.isExportDeclaration(statement))||!statement.moduleSpecifier||!ts.isStringLiteral(statement.moduleSpecifier))continue;const specifier=statement.moduleSpecifier.text;if(!specifier.startsWith('.'))continue;runtimeEdges++;assert.match(specifier,/\.(?:js|mjs|json)$/,'Node ESM needs an explicit emitted extension: '+relative+' -> '+specifier)}
  }
  assert.ok(runtimeEdges>=7,'The complete API/session/provider/shared-library graph must be emitted')
  // Negative control demonstrates native Node resolution, not the permissive VM harness above.
  const control=path.join(output,'extension-control');await mkdir(control);await writeFile(path.join(control,'dependency.js'),'export const value = 1\n');await writeFile(path.join(control,'entry.js'),"export {value} from './dependency'\n")
  await assert.rejects(()=>import(pathToFileURL(path.join(control,'entry.js')).href),e=>e.code==='ERR_MODULE_NOT_FOUND')
  // Import the actual API output through Node's real ESM loader. Supabase is its installed package;
  // no provider factory, path resolver, module alias, network request or subprocess is substituted.
  const route=await import(pathToFileURL(path.join(output,'api/student-learning.js')).href);assert.equal(typeof route.default,'function');assert.equal(route.config.maxDuration,120)
  const runtime=await import(pathToFileURL(path.join(output,'server/student-learning/maxTutorProduction.js')).href),req=new EventEmitter(),res=new EventEmitter();req.method='GET';req.url='/api/student-learning?action=status';req.headers={};res.setHeader=()=>{};res.end=value=>{res.body=JSON.parse(value);res.writableEnded=true};await runtime.createMaxTutorProduction({environment:{}})(req,res);assert.equal(res.statusCode,503);assert.equal(res.body.status,'unavailable')
 }finally{await rm(output,{recursive:true,force:true})}
})
