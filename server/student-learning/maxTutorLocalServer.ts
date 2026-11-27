import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto'
import type {IncomingMessage,ServerResponse} from 'node:http'
import {createMaxTutorLocalLedger} from './maxTutorLocalLedger'
import {createMaxTutorOpenAi} from './maxTutorOpenAi'
import {createMaxTutorSession} from './maxTutorSession'
import {createTutorProgressResponse} from './maxTutorProgressResponse'
import {validateTutorGenerationRequest,type MaxTutorRequest,type MaxTutorBundle,type TutorConversationTurn} from '../../src/lib/maxTutor'

const MODELS=[{id:'gpt-6.1-sol',label:'GPT-6.1 Sol'},{id:'gpt-5.4-mini',label:'GPT-5.4 mini'},{id:'gpt-5.4',label:'GPT-5.4'}] as const
type Model=typeof MODELS[number]['id']
// Sol uses the more conservative of currently conflicting official pricing pages; this is
// local estimated accounting, never an assertion about the final provider invoice.
const RATES={
 'gpt-6.1-sol':{inputUsdPerMillion:4,cachedInputUsdPerMillion:0.2,outputUsdPerMillion:20},
 'gpt-5.4-mini':{inputUsdPerMillion:0.75,cachedInputUsdPerMillion:0.075,outputUsdPerMillion:4.5},
 'gpt-5.4':{inputUsdPerMillion:2.5,cachedInputUsdPerMillion:0.25,outputUsdPerMillion:15},
}
const BODY_LIMIT=96*1024,COOKIE='xelay_local_max',SESSION_MS=8*60*60*1000
const keyValid=(value:unknown):value is string=>typeof value==='string'&&/^sk-[A-Za-z0-9_-]{20,296}$/.test(value)
const safeEqual=(left:unknown,right:string)=>{if(typeof left!=='string'||!(/^[a-f0-9]{64}$/).test(left)||left.length!==right.length)return false;return timingSafeEqual(Buffer.from(left),Buffer.from(right))}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const allowedFields=(v:Record<string,unknown>,keys:string[])=>Object.keys(v).every(k=>keys.includes(k))
const messages:Record<string,string>={
 unavailable:'Локальний помічник зараз недоступний. Спробуй пізніше.',
 forbidden:'Цю дію можна виконати лише у власній локальній вкладці Xelay.',
 invalid_request:'Перевір запит і вибрані особисті матеріали.',
 unconfigured:'Підключи модель у локальних налаштуваннях помічника.',
 quota_exhausted:'Локального ліміту вже недостатньо для нового запиту. Перевір витрати в налаштуваннях.',
 pending:'Цей запит уже виконується. Зачекай на його результат.',
 conflict:'Цей запит уже використано. Для іншого завдання почни новий запит.',
 refused:'Не вдалося безпечно підготувати цей матеріал. Спробуй уточнити навчальне завдання.',
 moderation_failed:'Перевірка безпеки недоступна. Матеріал не надсилаємо далі.',
 generation_failed:'Модель не завершила відповідь. Перевір доступ моделі й ліміт API та спробуй новий запит.',
 storage_failed:'Локальне збереження витрат недоступне. Новий платний запит не запускаємо.',
 identity_changed:'Локальне підключення змінилося. Онови стан помічника.',
 context_changed:'Матеріали чи умови змінилися. Спробуй ще раз із поточними джерелами.',
 invalid_output:'Відповідь моделі не пройшла перевірку. Підготовлений приклад не підставляємо.',
 signed_out:'Відкрий локального помічника ще раз.',cancelled:'Запит зупинено.',timeout:'Модель не встигла відповісти. Запит зупинено.',
 rate_limited:'Забагато запитів поспіль. Зачекай хвилину.',not_found:'Локальний шлях не знайдено.',
}
function send(res:ServerResponse,status:number,value:unknown){
 res.statusCode=status;res.setHeader('Cache-Control','no-store, private');res.setHeader('Pragma','no-cache');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Content-Type','application/json;charset=utf-8');res.end(JSON.stringify(value))
}
function error(res:ServerResponse,status:number,code:string){send(res,status,{status:code,error:messages[code]||messages.unavailable})}
async function body(req:IncomingMessage):Promise<unknown>{
 if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type']||'')))throw Error('Invalid body')
 const declared=req.headers['content-length'];if(declared&&(!/^\d+$/.test(declared)||Number(declared)>BODY_LIMIT))throw Error('Invalid body')
 const chunks:Buffer[]=[];let length=0
 for await(const chunk of req){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=bytes.length;if(length>BODY_LIMIT)throw Error('Invalid body');chunks.push(bytes)}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
}
async function moderation(fetcher:typeof fetch,key:string,text:string,signal:AbortSignal):Promise<boolean>{
 const endpoint='https://api.openai.com/v1/moderations'
 const response=await fetcher(endpoint,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({model:'omni-moderation-latest',input:text}),signal})
 if(!response.ok||response.redirected||response.url&&response.url!==endpoint||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||!response.body){void response.body?.cancel().catch(()=>{});throw Error('Moderation unavailable')}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>128*1024)throw Error('Moderation too large');chunks.push(part.value)}}finally{void reader.cancel().catch(()=>{});reader.releaseLock()}
 const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)))
 if(!object(data)||!Array.isArray(data.results)||!data.results.length||data.results.length>10||data.results.some(r=>!object(r)||typeof r.flagged!=='boolean'))throw Error('Moderation unavailable')
 return data.results.every(r=>r.flagged===false)
}

type Configuration={origin:string;privateDirectory:string;fetcher?:typeof fetch;environmentApiKey?:string}
type Session={cookie:string;csrf:string;sessionId:string;expires:number}

/** Loopback-only real-model bridge for this preview. This is not production login or paid-tier enforcement. */
export async function createMaxTutorLocalServer(configuration:Configuration){
 const origin=new URL(configuration.origin)
 if(origin.protocol!=='http:'||!['127.0.0.1','localhost'].includes(origin.hostname)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash||origin.origin!==configuration.origin)throw Error('Invalid local origin')
 const ledger=await createMaxTutorLocalLedger(configuration.privateDirectory),initial=await ledger.snapshot(),ownerId=initial.ownerId
 const sessions=new Map<string,Session>(),active=new Set<AbortController>(),fetcher=configuration.fetcher||fetch
 const histories=new Map<string,Map<string,{request:MaxTutorRequest;bundle:MaxTutorBundle}>>()
 let apiKey=keyValid(configuration.environmentApiKey)?configuration.environmentApiKey:'',model:Model='gpt-6.1-sol',generation=0,closed=false
 const runTimes:number[]=[],configureTimes:number[]=[]
 function limited(list:number[],maximum:number){const now=Date.now();while(list.length&&list[0]<now-60000)list.shift();if(list.length>=maximum)return true;list.push(now);return false}
 function rotate(){generation++;histories.clear();for(const item of sessions.values())item.sessionId='session-'+randomUUID()}
 function session(req:IncomingMessage){const token=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);const s=token?sessions.get(token):undefined;return s&&s.expires>Date.now()?s:null}
 async function status(s:Session){const snapshot=await ledger.snapshot();return {status:'ready',connected:!!apiKey,model,scope:{userId:ownerId,sessionId:s.sessionId},csrfToken:s.csrf,budget:{limitUsd:snapshot.limitMicros/1e6,spentUsd:snapshot.spentMicros/1e6,reservedUsd:snapshot.reservedMicros/1e6,remainingUsd:Math.max(0,snapshot.limitMicros-snapshot.spentMicros-snapshot.reservedMicros)/1e6},models:MODELS,localOnly:true,estimatedAccounting:true}}
 return {
  async handle(req:IncomingMessage,res:ServerResponse):Promise<boolean>{
   let output:ReturnType<typeof createTutorProgressResponse>|undefined
   let url:URL;try{url=new URL(req.url||'/',configuration.origin)}catch{return false}
   if(!url.pathname.startsWith('/api/local-max/'))return false
   const address=req.socket.remoteAddress
   if(closed||req.headers.host!==origin.host||address&&!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address)||req.headers.origin&&req.headers.origin!==configuration.origin||url.search||req.headers['sec-fetch-site']==='cross-site'){error(res,403,'forbidden');return true}
   try{
    if(url.pathname==='/api/local-max/status'&&req.method==='GET'){
     let s=session(req)
     if(!s){for(const [token,item] of sessions)if(item.expires<Date.now()){sessions.delete(token);histories.delete(item.sessionId)}if(sessions.size>=32){error(res,429,'rate_limited');return true}s={cookie:randomBytes(32).toString('hex'),csrf:randomBytes(32).toString('hex'),sessionId:'session-'+randomUUID(),expires:Date.now()+SESSION_MS};sessions.set(s.cookie,s);res.setHeader('Set-Cookie',`${COOKIE}=${s.cookie}; Path=/api/local-max/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS/1000}`)}
     send(res,200,await status(s));return true
    }
    if(req.method!=='POST'){error(res,404,'not_found');return true}
    const s=session(req)
    if(!s||req.headers.origin!==configuration.origin||!safeEqual(req.headers['x-xelay-csrf'],s.csrf)){error(res,403,'forbidden');return true}
    let input:unknown;try{input=await body(req)}catch{error(res,400,'invalid_request');return true}
    if(url.pathname==='/api/local-max/configure'){
     if(limited(configureTimes,5)){error(res,429,'rate_limited');return true}
     if(!object(input)||!allowedFields(input,['apiKey','model','limitUsd'])||!keyValid(input.apiKey)||input.model!==undefined&&!MODELS.some(m=>m.id===input.model)||input.limitUsd!==undefined&&(typeof input.limitUsd!=='number'||!Number.isFinite(input.limitUsd)||input.limitUsd<0.1||input.limitUsd>6)){error(res,400,'invalid_request');return true}
     const nextKey=input.apiKey,nextModel=(input.model||'gpt-6.1-sol') as Model,nextLimit=Math.ceil(Number(input.limitUsd??1)*1e6)
     for(const controller of active)controller.abort()
     await ledger.configure(nextLimit,()=>{apiKey=nextKey;model=nextModel;rotate()})
     send(res,200,await status(s));return true
    }
    if(url.pathname==='/api/local-max/disconnect'){
     if(!object(input)||Object.keys(input).length){error(res,400,'invalid_request');return true}
     for(const controller of active)controller.abort()
     await ledger.configure((await ledger.snapshot()).limitMicros,()=>{apiKey='';rotate()});send(res,200,await status(s));return true
    }
    if(url.pathname!=='/api/local-max/run'){error(res,404,'not_found');return true}
    if(!apiKey){error(res,503,'unconfigured');return true}
    if(limited(runTimes,10)||active.size>=2){error(res,429,'rate_limited');return true}
    let request:MaxTutorRequest;try{request=validateTutorGenerationRequest(input);const own=request.sources.find(source=>source.id==='own-note');if(own&&(own.kind!=='own_note'||own.page!==null))throw Error('Invalid note')}catch{error(res,400,'invalid_request');return true}
    const key=apiKey,chosenModel=model,version=generation,identity={userId:ownerId,sessionId:s.sessionId},sources=request.sources.map(source=>({...source})),sourceDigest=createHash('sha256').update(JSON.stringify(sources)).digest('hex')
    const history=histories.get(s.sessionId),conversation:TutorConversationTurn[]=[]
    for(const ref of request.conversationRunIds||[]){
     const previous=history?.get(ref);if(!previous){error(res,403,'forbidden');return true}
     conversation.push({role:'user',content:previous.request.prompt.slice(0,1200)},{role:'assistant',content:[previous.bundle.introduction.slice(0,1200),...previous.bundle.steps.slice(0,2).map(step=>`${step.title}: ${step.body}`)].join('\n').slice(0,1800)})
    }
    res.setHeader('Pragma','no-cache');res.setHeader('Cross-Origin-Resource-Policy','same-origin')
    output=createTutorProgressResponse(req,res)
    const controller=new AbortController();active.add(controller)
    const abort=()=>controller.abort(),onClose=()=>{if(!res.writableEnded)abort()};req.once('aborted',abort);res.once('close',onClose)
    const connected=()=>!closed&&generation===version&&apiKey===key&&sessions.get(s.cookie)===s&&s.sessionId===identity.sessionId&&s.expires>Date.now()&&!controller.signal.aborted
    try{
    const provider=createMaxTutorOpenAi({enabled:true,billingApproved:true,apiKey:key,model:chosenModel,fetcher,timeoutMs:45000})
    const rates=RATES[chosenModel],reserveMicros=Math.ceil((conversation.length?100000:70000)*rates.inputUsdPerMillion+8192*rates.outputUsdPerMillion)
    const gateway=createMaxTutorSession({
     currentSession:async()=>connected()?identity:null,
     resolveEntitlements:async()=>({userId:ownerId,audience:'student',planId:'max',aiAllowance:'available',monthlyAiBudgetUsd:(await ledger.snapshot()).limitMicros/1e6}),
     authorize:async(_who,refs)=>({userId:ownerId,sources:refs.map(id=>sources.find(source=>source.id===id)).filter((v):v is typeof sources[number]=>!!v).map(source=>({...source,canRead:true,aiAllowed:true}))}),
     resolveConversation:async()=>({userId:ownerId,turns:conversation}),
     budget:{begin:input=>ledger.begin(input),finish:input=>ledger.finish(input,()=>connected()&&createHash('sha256').update(JSON.stringify(sources)).digest('hex')===sourceDigest)},
     moderate:(text,options)=>moderation(fetcher,key,text,options.signal),generate:(value,options)=>provider.generate(value,options),
    },{reserveMicros,tokenRates:rates,timeoutMs:60000,maxMonthlyBudgetUsd:6})
     const own=request.sources.find(source=>source.id==='own-note')
     output.progress('preparing')
     const result=await gateway.run({requestId:request.requestId,mode:request.mode,prompt:request.prompt,sourceRefs:request.sources.filter(source=>source.id!=='own-note').map(source=>source.id),...(own?{ownNote:{title:own.title,text:own.text}}:{}),...(request.conversationRunIds?{conversationRunIds:request.conversationRunIds}:{}),...(request.studyFormat?{studyFormat:request.studyFormat}:{})},{signal:controller.signal,onProgress:output.progress})
     if(result.status==='ready'&&connected()){
      const current=histories.get(identity.sessionId)||new Map<string,{request:MaxTutorRequest;bundle:MaxTutorBundle}>();current.set(request.requestId,{request,bundle:result.bundle})
      while(current.size>12)current.delete(current.keys().next().value!);histories.set(identity.sessionId,current)
     }
     if(!res.writableEnded&&!res.destroyed){if(result.status==='ready'&&connected())output.send(200,result);else{const code=result.status==='ready'?'identity_changed':result.status;output.send(['quota_exhausted','pending','conflict'].includes(result.status)?429:503,{status:code,error:messages[code]||messages.unavailable})}}
    }finally{active.delete(controller);req.removeListener('aborted',abort);res.removeListener('close',onClose)}
    return true
   }catch{if(!res.writableEnded&&!res.destroyed){if(output)output.send(503,{status:'unavailable',error:messages.unavailable});else error(res,503,'unavailable')}return true}
  },
  async close(){for(const controller of active)controller.abort();await ledger.configure((await ledger.snapshot()).limitMicros,()=>{closed=true;apiKey='';rotate();sessions.clear();histories.clear()})},
 }
}
