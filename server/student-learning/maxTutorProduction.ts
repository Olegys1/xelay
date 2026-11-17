import {createHash} from 'node:crypto'
import {createClient} from '@supabase/supabase-js'
import {parseTutorState,validateTutorRequest,validateTutorStudyProgress,validateTutorPersonalContext,type MaxTutorRequest,type TutorProgress,type TutorRun,type TutorConversationTurn,type TutorPersonalContext} from '../../src/lib/maxTutor.js'
import {createMaxTutorSession,type MaxTutorEntitlement,type MaxTutorIdentity} from './maxTutorSession.js'
import {createMaxTutorOpenAi} from './maxTutorOpenAi.js'
import {createMaxTutorProductionLedger,type MaxProductionRpcClient} from './maxTutorProductionLedger.js'
import {createTutorProgressResponse} from './maxTutorProgressResponse.js'

const PROJECT='https://baohfpadxvhqhhjjqtil.supabase.co'
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/
const BODY_BYTES=96_000,HISTORY_BYTES=1_350_000
const RATES={
 'gpt-6.1-sol':{inputUsdPerMillion:4,cachedInputUsdPerMillion:0.2,outputUsdPerMillion:20},
 'gpt-5.4':{inputUsdPerMillion:2.5,cachedInputUsdPerMillion:0.25,outputUsdPerMillion:15},
 'gpt-5.4-mini':{inputUsdPerMillion:0.75,cachedInputUsdPerMillion:0.075,outputUsdPerMillion:4.5},
}
type Model=keyof typeof RATES
type SavedRun=TutorRun&{revision:number}
type Client=MaxProductionRpcClient&{auth:{getUser(token:string):PromiseLike<{data:{user:any};error:any}>};from?:(table:string)=>{select:(columns:string)=>{eq:(column:string,value:string)=>{maybeSingle:()=>PromiseLike<{data:unknown;error:unknown}>}}}}
type Factory=(url:string,key:string,options:any)=>Client
type Dependencies={environment?:Record<string,string|undefined>;fetcher?:typeof fetch;clientFactory?:Factory;now?:()=>number}
type Workspace={userId:string;audience:'student'|'teacher'|'unresolved';planId:'free'|'start'|'plus'|'max';aiAllowance:MaxTutorEntitlement['aiAllowance'];monthlyAiBudgetUsd:number;expiresAt:string|null;budgetPeriod:'subscription_month'|'utc_calendar_month';budgetResetsAt:string|null;budget:{limitMicros:number;spentMicros:number;reservedMicros:number};purchasedCredits?:{balanceCredits:number;reservedCredits:number;debtCredits:number}}
type Actor={identity:MaxTutorIdentity;expiresAt:number;caller:Client;service:Client;sessionHash:string}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const keys=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).length===allowed.length&&allowed.every(k=>Object.prototype.hasOwnProperty.call(v,k))
const integer=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
const messages:Record<string,string>={
 unavailable:'Навчальний помічник тимчасово недоступний. Збережені матеріали залишаються у твоєму просторі.',
 signed_out:'Сесію завершено. Увійди до Xelay ще раз.',forbidden:'Ця дія недоступна для цього облікового запису.',
 invalid_request:'Перевір запит і вибрані власні матеріали.',quota_exhausted:'Ліміту ШІ цього періоду підписки недостатньо для нового запиту.',
 conflict:'Дані вже змінилися в іншому вікні. Онови стан перед наступним збереженням.',pending:'Цей запит уже виконується. Зачекай на його результат.',
 generation_failed:'Модель не завершила відповідь. Перевір стан запиту перед новою спробою.',invalid_output:'Відповідь моделі не пройшла перевірку.',
 storage_failed:'Не вдалося підтвердити збереження. Зачекай і онови історію; новий платний запит автоматично не надсилається.',
 identity_changed:'Сесію змінено. Онови стан помічника.',context_changed:'Вибрані матеріали чи умови доступу змінилися.',
 moderation_failed:'Перевірка безпеки зараз недоступна. Запит не продовжуємо.',refused:'Не вдалося безпечно підготувати цей навчальний матеріал.',
 cancelled:'Запит зупинено.',timeout:'Модель не встигла відповісти. Перевір стан перед наступним запитом.',
 rate_limited:'Забагато запитів поспіль. Дочекайся завершення поточного розбору або спробуй за хвилину.',
}
class MaxProductionError extends Error{constructor(public status:number,public code:string){super(messages[code]||messages.unavailable)}}
const fail=(status:number,code:string):never=>{throw new MaxProductionError(status,code)}
function send(res:any,status:number,value:unknown){if(res.writableEnded||res.destroyed)return;res.statusCode=status;res.setHeader('Content-Type','application/json;charset=utf-8');res.end(JSON.stringify(value))}
function headers(res:any){res.setHeader('Cache-Control','no-store, private');res.setHeader('Pragma','no-cache');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Vary','Authorization, Origin')}
export function maxTutorProductionConfiguration(env:Record<string,string|undefined>){
 const model=(env.STUDENT_MAX_MODEL||'gpt-6.1-sol') as Model,url=(env.SUPABASE_URL||env.VITE_SUPABASE_URL||'').replace(/\/$/,'')
 const publicKey=env.SUPABASE_ANON_KEY||env.VITE_SUPABASE_ANON_KEY||'',privateKey=env.SUPABASE_SERVICE_ROLE_KEY||env.SUPABASE_SERVICE_ROLE||'',apiKey=env.OPENAI_API_KEY||''
 const valid=url===PROJECT&&!!publicKey&&!!privateKey&&publicKey!==privateKey&&publicKey.length<=8192&&privateKey.length<=8192&&!/\s/.test(publicKey+privateKey)
 const enabled=env.STUDENT_MAX_ENABLED==='true'&&valid,modelValid=Object.prototype.hasOwnProperty.call(RATES,model)
 const aiEnabled=enabled&&env.STUDENT_MAX_AI_ENABLED==='true'&&modelValid&&/^sk-[A-Za-z0-9_-]{20,296}$/.test(apiKey)
 const origins=['https://www.xelay.ink','https://xelay.ink']
 if(env.VERCEL_ENV==='preview'&&/^[a-zA-Z0-9-]+\.vercel\.app$/.test(env.VERCEL_URL||''))origins.push(`https://${env.VERCEL_URL}`)
 return {enabled,aiEnabled,url,publicKey,privateKey,apiKey,model:modelValid?model:'gpt-6.1-sol' as Model,origins}
}
async function body(req:any):Promise<unknown>{
 if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type']||'')))return fail(400,'invalid_request')
 if(req.body!==undefined){let parsed:unknown=req.body;if(typeof parsed==='string'){if(Buffer.byteLength(parsed)>BODY_BYTES)return fail(413,'invalid_request');try{parsed=JSON.parse(parsed)}catch{return fail(400,'invalid_request')}}if(!object(parsed)||Buffer.byteLength(JSON.stringify(parsed))>BODY_BYTES)return fail(400,'invalid_request');return parsed}
 const chunks:Buffer[]=[];let size=0
 for await(const chunk of req){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>BODY_BYTES)return fail(413,'invalid_request');chunks.push(bytes)}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))}catch{return fail(400,'invalid_request')}
}
async function rpc(client:MaxProductionRpcClient,name:string,args?:Record<string,unknown>):Promise<unknown>{
 const result=await client.rpc(name,args)
 if(result.error){if(['PT409','40001'].includes(result.error.code))return fail(409,'conflict');if(result.error.code==='42501')return fail(403,'forbidden');if(result.error.code==='PT429')return fail(429,['MAX_REQUEST_RATE_LIMIT','MAX_CONCURRENCY_LIMIT'].includes(result.error.message)?'rate_limited':'quota_exhausted');return fail(503,'storage_failed')}
 return result.data
}
function workspace(value:unknown,userId:string,now:number):Workspace{
 // Deploy this bridge before the database migration. Only the exact old capped
 // accounting contract may omit period metadata; it never inherits the new cap.
 if(object(value)&&value.budgetPeriod===undefined&&value.budgetResetsAt===undefined&&typeof value.monthlyAiBudgetUsd==='number'&&value.monthlyAiBudgetUsd<=6&&object(value.budget)&&integer(value.budget.limitMicros)&&value.budget.limitMicros<=6000000){const date=new Date(now);value={...value,budgetPeriod:'utc_calendar_month',budgetResetsAt:new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)).toISOString()}}
 if(!object(value)||value.userId!==userId||!['student','teacher','unresolved'].includes(String(value.audience))||!['free','start','plus','max'].includes(String(value.planId))||!['available','not_included','pending_legacy_policy'].includes(String(value.aiAllowance))||typeof value.monthlyAiBudgetUsd!=='number'||!Number.isFinite(value.monthlyAiBudgetUsd)||value.monthlyAiBudgetUsd<0||value.monthlyAiBudgetUsd>10||!['subscription_month','utc_calendar_month'].includes(String(value.budgetPeriod))||!(value.budgetResetsAt===null||typeof value.budgetResetsAt==='string'&&Number.isFinite(Date.parse(value.budgetResetsAt)))||!(value.expiresAt===null||typeof value.expiresAt==='string'&&Number.isFinite(Date.parse(value.expiresAt)))||!object(value.budget)||!integer(value.budget.limitMicros)||value.budget.limitMicros>10000000||value.budgetPeriod==='utc_calendar_month'&&(value.monthlyAiBudgetUsd>6||value.budget.limitMicros>6000000)||!integer(value.budget.spentMicros)||!integer(value.budget.reservedMicros))return fail(503,'unavailable')
 if(value.purchasedCredits!==undefined&&(!object(value.purchasedCredits)||!keys(value.purchasedCredits,['balanceCredits','reservedCredits','debtCredits'])||Object.values(value.purchasedCredits).some(v=>typeof v!=='number'||!Number.isFinite(v)||v<0||v>1000000000)))return fail(503,'unavailable')
 return value as unknown as Workspace
}
function allowGeneration(w:Workspace,enabled:boolean,now:number){return enabled&&w.audience==='student'&&w.planId==='max'&&w.aiAllowance==='available'&&w.monthlyAiBudgetUsd>0&&typeof w.budgetResetsAt==='string'&&Date.parse(w.budgetResetsAt)>now&&typeof w.expiresAt==='string'&&Date.parse(w.expiresAt)>now}
function savedRun(value:unknown):SavedRun{
 if(!object(value)||value.demo!==false||!integer(value.revision)||value.revision<1)return fail(503,'storage_failed')
 const parsed=parseTutorState(JSON.stringify({version:1,runs:[value],activeRunId:value.id}))
 if(parsed.runs.length!==1)return fail(503,'storage_failed')
 return {...parsed.runs[0],revision:value.revision}
}
async function runs(actor:Actor):Promise<SavedRun[]>{
 const raw=await rpc(actor.caller,'xelay_max_runs_list',{p_limit:12}),list=Array.isArray(raw)?raw:object(raw)&&Array.isArray(raw.runs)?raw.runs:null
 if(!list||list.length>12)return fail(503,'storage_failed')
 const safe=list.map(savedRun);if(new Set(safe.map(r=>r.id)).size!==safe.length)return fail(503,'storage_failed')
 while(Buffer.byteLength(JSON.stringify(safe))>HISTORY_BYTES&&safe.length>1)safe.pop()
 if(Buffer.byteLength(JSON.stringify(safe))>HISTORY_BYTES)return fail(503,'storage_failed')
 return safe
}
/** Available runs must come from the authenticated owner's scoped RPC. Only
 * immutable dialogue text is reused; activity keys and progress are excluded. */
export function resolveTutorConversation(available:readonly TutorRun[],refs:readonly string[]):TutorConversationTurn[]{
 if(refs.length>4||new Set(refs).size!==refs.length)return fail(403,'forbidden')
 const turns:TutorConversationTurn[]=[]
 for(const ref of refs){
  const run=available.find(value=>value.id===ref&&!value.demo)
  if(!run)return fail(403,'forbidden')
  const user=run.request.prompt.slice(0,1200),assistant=[run.bundle.introduction.slice(0,1200),...run.bundle.steps.map(step=>`${step.title}: ${step.body}`).slice(0,2)].join('\n').slice(0,1800)
  turns.push({role:'user',content:user},{role:'assistant',content:assistant})
 }
 return turns
}
const emptyProfile=():TutorPersonalContext['profile']=>({firstName:null,displayName:null,faculty:null,specialty:null,studyYear:null})
const profileLabel=(value:unknown,max:number):string|null=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max&&!/[\u0000-\u001f\u007f<>]/u.test(value)?value.trim():null
/** A single caller-scoped, column-allowlisted read. A missing profile only
 * disables personalization; user metadata and service-role reads are not used. */
async function ownProfile(actor:Actor):Promise<TutorPersonalContext['profile']>{
 if(typeof actor.caller.from!=='function')return emptyProfile()
 try{
  const result=await actor.caller.from('profiles').select('id,first_name,full_name,faculty,specialty,study_year').eq('id',actor.identity.userId).maybeSingle()
  if(result.error||!object(result.data)||result.data.id!==actor.identity.userId)return emptyProfile()
  const row=result.data,firstName=profileLabel(row.first_name,60)
  return {firstName,displayName:firstName?null:profileLabel(row.full_name,120),faculty:profileLabel(row.faculty,160),specialty:profileLabel(row.specialty,160),studyYear:Number.isInteger(row.study_year)&&Number(row.study_year)>=1&&Number(row.study_year)<=8?Number(row.study_year):null}
 }catch{return emptyProfile()}
}
/** Practice context is limited to the same selected, owner-authorized turns.
 * Never include option keys, answer text, official tests, contacts or other runs. */
export function resolveTutorPersonalContext(profile:TutorPersonalContext['profile'],available:readonly TutorRun[],refs:readonly string[]):TutorPersonalContext{
 if(refs.length>4||new Set(refs).size!==refs.length)return fail(403,'forbidden')
 const practice:TutorPersonalContext['practice']={topics:[],checkedAnswers:0,correctAnswers:0,completedQuizzes:0}
 for(const ref of refs){
  const run=available.find(r=>r.id===ref&&!r.demo);if(!run)return fail(403,'forbidden')
  if(!practice.topics.includes(run.bundle.title))practice.topics.push(run.bundle.title)
  const checked=run.bundle.questions.filter(q=>run.progress.submitted.includes(q.id)&&Number.isInteger(run.progress.answers[q.id]))
  practice.checkedAnswers+=checked.length;practice.correctAnswers+=checked.filter(q=>run.progress.answers[q.id]===q.correctIndex).length
  if(run.bundle.questions.length&&checked.length===run.bundle.questions.length)practice.completedQuizzes++
 }
 return validateTutorPersonalContext({profile,practice})
}
function progress(raw:unknown,run:SavedRun):TutorProgress{
 if(!object(raw)||!keys(raw,['answers','submitted','cardRatings','doneTasks',...(run.bundle.version===2?['version','studyAnswers','studySubmitted','studyRatings','studyDone']:[])])||!object(raw.answers)||!Array.isArray(raw.submitted)||!object(raw.cardRatings)||!Array.isArray(raw.doneTasks))return fail(400,'invalid_request')
 const b=run.bundle,answers:Record<string,number>={},cardRatings:Record<string,'known'|'repeat'>={}
 for(const [id,value]of Object.entries(raw.answers)){const q=b.questions.find(q=>q.id===id);if(!q||!integer(value)||value>=q.options.length)return fail(400,'invalid_request');answers[id]=value}
 if(raw.submitted.length>12||new Set(raw.submitted).size!==raw.submitted.length||raw.submitted.some(id=>typeof id!=='string'||!Object.prototype.hasOwnProperty.call(answers,id)))return fail(400,'invalid_request')
 for(const [id,value]of Object.entries(raw.cardRatings)){if(!b.cards.some(c=>c.id===id)||!['known','repeat'].includes(String(value)))return fail(400,'invalid_request');cardRatings[id]=value as 'known'|'repeat'}
 const tasks=new Set(b.plan.flatMap(p=>p.tasks.map((_,index)=>`${p.id}:${index}`)))
 if(raw.doneTasks.length>112||new Set(raw.doneTasks).size!==raw.doneTasks.length||raw.doneTasks.some(id=>typeof id!=='string'||!tasks.has(id)))return fail(400,'invalid_request')
 let study={};if(run.bundle.version===2)try{study=validateTutorStudyProgress(raw,run.bundle)}catch{return fail(400,'invalid_request')}
 return {answers,submitted:[...raw.submitted] as string[],cardRatings,doneTasks:[...raw.doneTasks] as string[],...study}
}
async function moderate(fetcher:typeof fetch,key:string,text:string,signal:AbortSignal){
 const endpoint='https://api.openai.com/v1/moderations',response=await fetcher(endpoint,{method:'POST',redirect:'error',signal,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({model:'omni-moderation-latest',input:text})})
 if(!response.ok||response.redirected||response.url&&response.url!==endpoint||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||!response.body)throw Error('Moderation unavailable')
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let total=0
 try{for(;;){const r=await reader.read();if(r.done)break;total+=r.value.byteLength;if(total>128000)throw Error('Moderation unavailable');chunks.push(r.value)}}finally{void reader.cancel().catch(()=>{});reader.releaseLock()}
 const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
 if(!object(data)||!Array.isArray(data.results)||!data.results.length||data.results.length>10||data.results.some(r=>!object(r)||typeof r.flagged!=='boolean'))throw Error('Moderation unavailable')
 return data.results.every(r=>r.flagged===false)
}

/** Production-only runtime. No local owner, API-key input, arbitrary model URL or client tier is accepted. */
export function createMaxTutorProduction(dependencies:Dependencies={}){
 const env=dependencies.environment||process.env,config=maxTutorProductionConfiguration(env),fetcher=dependencies.fetcher||fetch,now=dependencies.now||Date.now
 const factory=dependencies.clientFactory||createClient as unknown as Factory
 // Per-instance preflight protects moderation before the authoritative database reservation.
 // It is deliberately not described as a distributed rate limiter; SQL enforces the durable cap.
 const preflights=new Map<string,{active:number;times:number[]}>()
 function claim(userId:string){
  const time=now()
  for(const [id,row]of preflights)if(row.active===0&&row.times.every(t=>t<=time-60000))preflights.delete(id)
  const row=preflights.get(userId)||{active:0,times:[]};row.times=row.times.filter(t=>t>time-60000)
  if(row.active>=2||row.times.length>=10||!preflights.has(userId)&&preflights.size>=2000)return fail(429,'rate_limited')
  row.active++;row.times.push(time);preflights.set(userId,row)
  return ()=>{row.active=Math.max(0,row.active-1)}
 }
 const databaseFetch:typeof fetch=(input,init)=>fetcher(input,{...init,redirect:'error',signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)})
 async function authenticate(req:any):Promise<Actor>{
  const token=typeof req.headers?.authorization==='string'?req.headers.authorization.match(/^Bearer ([^\s]{1,8192})$/)?.[1]:null
  if(!token||token.split('.').length!==3)return fail(401,'signed_out')
  const auth={persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},service=factory(config.url,config.privateKey,{auth,global:{fetch:databaseFetch}}),caller=factory(config.url,config.publicKey,{auth,global:{fetch:databaseFetch,headers:{Authorization:`Bearer ${token}`}}})
  const verified=await caller.auth.getUser(token);if(verified.error||!verified.data?.user?.email_confirmed_at||typeof verified.data.user.id!=='string'||!UUID.test(verified.data.user.id))return fail(401,'signed_out')
  let claims:any;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'))}catch{return fail(401,'signed_out')}
  if(!object(claims)||claims.sub!==verified.data.user.id||claims.role!=='authenticated'||!integer(claims.exp)||claims.exp*1000<=now()||typeof claims.session_id!=='string'||!UUID.test(claims.session_id))return fail(401,'signed_out')
  return {identity:{userId:verified.data.user.id.toLowerCase(),sessionId:claims.session_id.toLowerCase()},expiresAt:claims.exp*1000,caller,service,sessionHash:createHash('sha256').update(claims.session_id.toLowerCase()).digest('hex')}
 }
 return async function handle(req:any,res:any){
  headers(res)
  const output=createTutorProgressResponse(req,res)
  let active=true;const controller=new AbortController(),abort=()=>{active=false;controller.abort()},closed=()=>{if(!res.writableEnded)abort()};req.once?.('aborted',abort);res.once?.('close',closed)
  let actor:Actor|undefined,release:(()=>void)|undefined
  try{
   const origin=req.headers?.origin
   if(origin!==undefined&&(typeof origin!=='string'||!config.origins.includes(origin))||req.headers?.['sec-fetch-site']==='cross-site')return fail(403,'forbidden')
   if(req.method!=='GET'&&req.method!=='POST'){res.setHeader('Allow','GET, POST');return send(res,405,{status:'invalid_request',error:'Метод не підтримується.'})}
   if(req.method==='POST'&&typeof origin!=='string')return fail(403,'forbidden')
   let url:URL;try{url=new URL(req.url||'/api/student-learning',config.origins[0])}catch{return fail(400,'invalid_request')}
   const supplied=req.query?.action??url.searchParams.get('action')??'status',action=typeof supplied==='string'?supplied:''
   if(!['status','history','generate','progress'].includes(action)||Array.from(url.searchParams.keys()).some(k=>k!=='action')||url.searchParams.getAll('action').length>1)return fail(400,'invalid_request')
   if((req.method==='GET')!==['status','history'].includes(action))return fail(405,'invalid_request')
   if(!config.enabled)return fail(503,'unavailable')
   actor=await authenticate(req)
   const current=()=>active&&!controller.signal.aborted&&actor!.expiresAt>now()?actor!.identity:null
 const getWorkspace=async()=>workspace(await rpc(actor!.caller,'xelay_student_workspace_status'),actor!.identity.userId,now())
   const w=await getWorkspace()
   if(action==='status'){const b=w.budget,budgetResetsAt=w.budgetResetsAt,p=await ownProfile(actor),profileDisplayName=p.firstName||p.displayName;return send(res,200,{status:'ready',scope:actor.identity,audience:w.audience,planId:w.planId,canGenerate:allowGeneration(w,config.aiEnabled,now()),canEdit:true,available:config.aiEnabled,model:config.model,budget:{limitUsd:b.limitMicros/1e6,spentUsd:b.spentMicros/1e6,reservedUsd:b.reservedMicros/1e6,remainingUsd:Math.max(0,b.limitMicros-b.spentMicros-b.reservedMicros)/1e6},budgetPeriod:w.budgetPeriod,budgetResetsAt,localOnly:false,...(req.headers?.['x-xelay-ai-credits']==='1'&&w.purchasedCredits?{purchasedCredits:w.purchasedCredits}:{}),...(profileDisplayName?{profileDisplayName}:{})})}
   if(action==='history'){const list=await runs(actor);return send(res,200,{status:'ready',scope:actor.identity,runs:list,activeRunId:list[0]?.id||''})}
   const input=await body(req)
   if(action==='progress'){
    if(!object(input)||!keys(input,['runId','progress','expectedRevision'])||typeof input.runId!=='string'||!ID.test(input.runId)||!integer(input.expectedRevision)||input.expectedRevision<1)return fail(400,'invalid_request')
    const run=(await runs(actor)).find(r=>r.id===input.runId);if(!run)return fail(403,'forbidden')
    const safe=progress(input.progress,run)
    try{const saved=savedRun(await rpc(actor.caller,'xelay_max_run_progress',{p_run_id:input.runId,p_expected_version:input.expectedRevision,p_progress:safe}));return send(res,200,{status:'ready',run:saved})}
    catch(e){if(e instanceof MaxProductionError&&e.code==='conflict'){const latest=(await runs(actor)).find(r=>r.id===input.runId);return send(res,409,{status:'conflict',error:messages.conflict,...(latest?{run:latest}:{})})}throw e}
   }
   if(!allowGeneration(w,config.aiEnabled,now()))return fail(config.aiEnabled?403:503,config.aiEnabled?'forbidden':'unavailable')
   let request:MaxTutorRequest;try{const parsed=validateTutorRequest(input),own=parsed.sources.find(s=>s.id==='own-note');if(own&&(own.kind!=='own_note'||own.page!==null))throw Error('Invalid own note');request={...parsed,sources:[...(own?[own]:[]),...parsed.sources.filter(s=>s.id!=='own-note')]}}catch{return fail(400,'invalid_request')}
   release=claim(actor.identity.userId)
   const previousRuns=request.conversationRunIds?await runs(actor):[],conversation=request.conversationRunIds?resolveTutorConversation(previousRuns,request.conversationRunIds):[]
   const personalContext=resolveTutorPersonalContext(await ownProfile(actor),previousRuns,request.conversationRunIds||[])
   // Topic-based work has no source rows to stage/read. Session, tier, allowance
   // and conversation ownership are still enforced by the same durable RPCs.
   const stored=request.sources.length?await rpc(actor.caller,'xelay_max_sources_put',{p_request_id:request.requestId,p_sources:request.sources}):[]
   const persisted=Array.isArray(stored)?stored:object(stored)&&Array.isArray(stored.sources)?stored.sources:null
   if(!persisted||JSON.stringify(validateTutorRequest({...request,sources:persisted}).sources)!==JSON.stringify(request.sources))return fail(503,'storage_failed')
   const provider=createMaxTutorOpenAi({enabled:true,billingApproved:true,apiKey:config.apiKey,model:config.model,fetcher,timeoutMs:45000}),rates=RATES[config.model]
   const gateway=createMaxTutorSession({
    currentSession:async()=>current(),
    resolveEntitlements:async()=>{const state=await getWorkspace();return {userId:state.userId,audience:state.audience,planId:state.planId,aiAllowance:allowGeneration(state,config.aiEnabled,now())?'available':'not_included',monthlyAiBudgetUsd:state.monthlyAiBudgetUsd}},
    authorize:async(_identity,refs)=>{if(request.sources.length===0)return {userId:actor!.identity.userId,sources:[]};const raw=await rpc(actor!.caller,'xelay_max_sources_get',{p_request_id:request.requestId,p_source_ids:[...refs]});return raw as any},
    resolveConversation:async(_identity,refs)=>{if(JSON.stringify(refs)!==JSON.stringify(request.conversationRunIds||[]))return fail(403,'forbidden');return {userId:actor!.identity.userId,turns:conversation}},
    resolvePersonalContext:async()=>({userId:actor!.identity.userId,context:personalContext}),
    budget:createMaxTutorProductionLedger(actor.service,actor.sessionHash,request),
    moderate:(text,options)=>moderate(fetcher,config.apiKey,text,options.signal),generate:(value,options)=>provider.generate(value,options),
   },{reserveMicros:Math.ceil((conversation.length?100000:70000)*rates.inputUsdPerMillion+8192*rates.outputUsdPerMillion),tokenRates:rates,timeoutMs:60000,maxMonthlyBudgetUsd:10})
   output.progress('preparing')
   const own=request.sources.find(s=>s.id==='own-note'),result=await gateway.run({requestId:request.requestId,mode:request.mode,prompt:request.prompt,sourceRefs:request.sources.filter(s=>s.id!=='own-note').map(s=>s.id),...(own?{ownNote:{title:own.title,text:own.text}}:{}),...(request.conversationRunIds?{conversationRunIds:request.conversationRunIds}:{}),...(request.studyFormat?{studyFormat:request.studyFormat}:{})},{signal:controller.signal,onProgress:output.progress})
   if(result.status!=='ready')return fail(['pending','quota_exhausted'].includes(result.status)?429:result.status==='conflict'?409:503,result.status)
   if(!current())return fail(401,'identity_changed')
   const run=(await runs(actor)).find(r=>r.id===request.requestId);if(!run)return fail(503,'storage_failed')
   return output.send(200,{status:'ready',bundle:result.bundle,replayed:result.replayed,run})
  }catch(e){if(e instanceof MaxProductionError)return output.send(e.status,{status:e.code,error:e.message});return output.send(503,{status:'unavailable',error:messages.unavailable})}
  finally{release?.();req.removeListener?.('aborted',abort);res.removeListener?.('close',closed)}
 }
}
