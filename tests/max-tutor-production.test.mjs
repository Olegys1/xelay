import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import {EventEmitter} from 'node:events'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const native=createRequire(import.meta.url),root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map()
function load(file){const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module);const code=ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;vm.runInNewContext(code,{module,exports:module.exports,process,Buffer,TextEncoder,TextDecoder,Uint8Array,AbortController,AbortSignal,Response,URL,Set,Map,Promise,Date,Number,JSON,setTimeout,clearTimeout,fetch:()=>{throw Error('Live calls forbidden')},require(name){if(name==='@supabase/supabase-js')return {createClient(){throw Error('A test must inject its database')}};return name.startsWith('.')?load(path.resolve(path.dirname(absolute),name)+'.ts'):native(name)}},{filename:absolute});return module.exports}
const api=load('server/student-learning/maxTutorProduction.ts'),tutor=load('src/lib/maxTutor.ts'),plain=v=>JSON.parse(JSON.stringify(v))
const OWNER='11111111-1111-4111-8111-111111111111',OTHER='22222222-2222-4222-8222-222222222222',SESSION='33333333-3333-4333-8333-333333333333',NOW=1794823200000
const KEY=['sk','synthetic','server','credential','for','max','tests'].join('-')
const environment={STUDENT_MAX_ENABLED:'true',STUDENT_MAX_AI_ENABLED:'true',SUPABASE_URL:'https://baohfpadxvhqhhjjqtil.supabase.co',SUPABASE_ANON_KEY:'synthetic-public-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-private-key',OPENAI_API_KEY:KEY}
const token=(extra={})=>['synthetic-header',Buffer.from(JSON.stringify({sub:OWNER,role:'authenticated',session_id:SESSION,exp:Math.floor(NOW/1000)+3600,...extra})).toString('base64url'),'synthetic-signature'].join('.')
const original=tutor.createTutorDemo('run-1','quiz'),request=()=>plain(original.request)
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})

function fixture(options={}){
 const calls=[],sources=new Map(),reservations=new Map(),saved=new Map();let spent=0,authCalls=0,providerCalls=0,moderationCalls=0
 let state={userId:OWNER,audience:'student',planId:'max',aiAllowance:'available',monthlyAiBudgetUsd:6,expiresAt:new Date(NOW+86400000).toISOString(),budget:{limitMicros:6000000,spentMicros:0,reservedMicros:0},...options.workspace}
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
 const factory=(_url,key)=>{const role=key===environment.SUPABASE_ANON_KEY?'caller':'service';return {auth:{async getUser(){authCalls++;return options.authDenied?{data:{user:null},error:{message:'PRIVATE_AUTH_ERROR'}}:{data:{user:{id:OWNER,email_confirmed_at:'2026-11-16T00:00:00Z'}},error:null}}},rpc:(name,args)=>rpc(role,name,args)}}
 const fetcher=async(url,init)=>{
  const payload=JSON.parse(init.body);if(url==='https://api.openai.com/v1/moderations'){moderationCalls++;if(options.moderationError)throw Error('PRIVATE_MODERATION_ERROR');return json({results:[{flagged:options.flagged===true||options.flagOutput&&moderationCalls>1?true:false}]})}
  if(url!=='https://api.openai.com/v1/responses')throw Error('Unexpected network URL')
  providerCalls++;if(options.generate)return options.generate(payload,{sources,saved,reservations,setWorkspace:value=>state={...state,...value}})
  const content=JSON.parse(payload.input[0].content[0].text),bundle=plain(original.bundle);bundle.mode=content.mode;const ids=content.sources.map(s=>s.id);for(const q of bundle.questions)q.sourceId=ids[0];for(const c of bundle.cards)c.sourceId=ids[0];bundle.citations=[{sourceId:ids[0],quote:content.sources[0].text.slice(0,100)}]
  return json({status:'completed',output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(bundle)}]}],usage:{input_tokens:1000,output_tokens:500,total_tokens:1500,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:100}}})
 }
 const handler=api.createMaxTutorProduction({environment:{...environment,...options.environment},clientFactory:factory,fetcher,now:()=>NOW})
 async function call(action='status',body,headers={}){const req=new EventEmitter(),res=new EventEmitter();req.method=body===undefined?'GET':'POST';req.url='/api/student-learning?action='+action;req.headers={authorization:'Bearer '+token(),'content-type':'application/json',...(body===undefined?{}:{origin:'https://www.xelay.ink'}),...headers};req.body=body;const responseHeaders={};res.setHeader=(name,value)=>responseHeaders[name]=value;res.end=text=>{res.text=text;res.writableEnded=true};await handler(req,res);let value;try{value=JSON.parse(res.text)}catch{};return {http:res.statusCode,headers:responseHeaders,value,req,res}}
 return {call,calls,sources,saved,reservations,get authCalls(){return authCalls},get providerCalls(){return providerCalls},get moderationCalls(){return moderationCalls},get spent(){return spent},setWorkspace(value){state={...state,...value}}}
}

test('production configuration is inert without explicit switches, fixed project and server credentials',()=>{
 for(const change of [{STUDENT_MAX_ENABLED:'false'},{SUPABASE_URL:'https://attacker.example'},{SUPABASE_SERVICE_ROLE_KEY:environment.SUPABASE_ANON_KEY}])assert.equal(api.maxTutorProductionConfiguration({...environment,...change}).enabled,false)
 for(const change of [{STUDENT_MAX_AI_ENABLED:'false'},{OPENAI_API_KEY:''},{STUDENT_MAX_MODEL:'https://attacker.example'}])assert.equal(api.maxTutorProductionConfiguration({...environment,...change}).aiEnabled,false)
 assert.equal(api.maxTutorProductionConfiguration(environment).model,'gpt-6.1-sol');assert.ok(!api.maxTutorProductionConfiguration({...environment,VERCEL_ENV:'production',VERCEL_URL:'attacker.vercel.app'}).origins.includes('https://attacker.vercel.app'))
})
test('status is authenticated, owner scoped and private, without provider calls or key echoes',async()=>{
 const f=fixture(),r=await f.call();assert.equal(r.http,200);assert.equal(r.value.canGenerate,true);assert.equal(r.value.scope.userId,OWNER);assert.equal(r.value.scope.sessionId,SESSION);assert.equal(r.value.localOnly,false);assert.equal(r.value.budgetPeriod,'utc_calendar_month');assert.equal(r.value.budgetResetsAt,'2026-12-01T00:00:00.000Z');assert.match(r.headers['Cache-Control'],/no-store/);assert.equal(r.headers['Access-Control-Allow-Origin'],undefined);assert.equal(f.providerCalls,0);assert.ok(!JSON.stringify(r.value).includes(KEY));assert.ok(!JSON.stringify(r.value).includes('synthetic-private-key'));assert.equal(f.authCalls,1)
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
 for(const message of ['MAX_REQUEST_RATE_LIMIT','MAX_CONCURRENCY_LIMIT']){const f=fixture({rpc:async(_role,name)=>name==='xelay_max_sources_put'?{data:null,error:{code:'PT429',message}}:undefined}),r=await f.call('generate',request());assert.equal(r.http,429);assert.equal(r.value.status,'rate_limited');assert.doesNotMatch(r.value.error,/місяц/);assert.equal(f.moderationCalls,0);assert.equal(f.providerCalls,0)}
 const f=fixture({quotaDenied:true}),r=await f.call('generate',request());assert.equal(r.http,429);assert.equal(r.value.status,'quota_exhausted');assert.match(r.value.error,/місяц/);assert.equal(f.providerCalls,0)
})
