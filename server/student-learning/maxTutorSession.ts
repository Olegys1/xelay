import {createHash} from 'node:crypto'
import {aiUsdToMicros,calculateAiCostMicros,type AiBillableUsage,type AiTokenRates} from '../../src/lib/studentAiBudget.js'
import {TUTOR_MODES,validateTutorBundle,validateTutorRequest,validateTutorPersonalContext,type MaxTutorBundle,type MaxTutorRequest,type TutorSource,type TutorConversationTurn,type TutorPersonalContext} from '../../src/lib/maxTutor.js'

export type MaxTutorIdentity={userId:string;sessionId:string}
export type MaxTutorEntitlement={userId:string;audience:'student'|'teacher'|'unresolved';planId:string;aiAllowance:'available'|'not_included'|'pending_legacy_policy';monthlyAiBudgetUsd:number}
export type MaxTutorAuthorizedSource=TutorSource&{canRead:boolean;aiAllowed:boolean}
export type MaxTutorReservationInput={userId:string;requestId:string;fingerprint:string;reserveMicros:number;monthlyLimitMicros:number}
export type MaxTutorSettlement={reservationId:string;userId:string;sessionId:string;requestId:string;fingerprint:string;chargeMicros:number;bundle:MaxTutorBundle|null}
export interface MaxTutorSessionPorts{
 currentSession():Promise<MaxTutorIdentity|null>
 resolveEntitlements(identity:MaxTutorIdentity):Promise<MaxTutorEntitlement>
 authorize(identity:MaxTutorIdentity,sourceRefs:readonly string[]):Promise<{userId:string;sources:MaxTutorAuthorizedSource[]}>
 resolveConversation?(identity:MaxTutorIdentity,runIds:readonly string[]):Promise<{userId:string;turns:TutorConversationTurn[]}>
 resolvePersonalContext?(identity:MaxTutorIdentity):Promise<{userId:string;context:TutorPersonalContext}>
 budget:{
  /** Atomically scope uniqueness to (userId,requestId), match fingerprint, and reserve within authoritative remaining allowance. */
  begin(input:MaxTutorReservationInput):Promise<unknown>
  /** Atomically/idempotently settle to this owner. Before storing a bundle, verify session and source authorization fingerprint in the same transaction. */
  finish(input:MaxTutorSettlement):Promise<void>
 }
 generate(request:MaxTutorRequest,options:{signal:AbortSignal;conversation?:readonly TutorConversationTurn[];personalContext?:TutorPersonalContext}):Promise<{bundle:unknown;usage:AiBillableUsage|null}>
 /** Required input/output safety classifier; must return literal true to approve. It must never execute source text. */
 moderate(text:string,options:{signal:AbortSignal}):Promise<boolean>
}
export type MaxTutorSessionConfiguration={reserveMicros:number;tokenRates:AiTokenRates;timeoutMs?:number;maxMonthlyBudgetUsd?:number}
type Failure='invalid_request'|'signed_out'|'forbidden'|'quota_exhausted'|'pending'|'conflict'|'invalid_output'|'generation_failed'|'identity_changed'|'context_changed'|'storage_failed'|'refused'|'moderation_failed'|'cancelled'|'timeout'
export type MaxTutorSessionResult={status:'ready';bundle:MaxTutorBundle;replayed:boolean}|{status:Failure}
type RawRequest={requestId:string;mode:MaxTutorRequest['mode'];prompt:string;sourceRefs:string[];ownNote?:{title:string;text:string};conversationRunIds?:string[];studyFormat?:MaxTutorRequest['studyFormat']}
type Context={request:MaxTutorRequest;fingerprint:string;monthlyLimitMicros:number;conversation:TutorConversationTurn[];personalContext?:TutorPersonalContext}
type Reservation={state:'reserved';reservationId:string}|{state:'replay';bundle:unknown}|{state:'pending'|'denied'|'conflict'}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const own=(v:object,k:string)=>Object.prototype.hasOwnProperty.call(v,k)
const fields=(v:Record<string,unknown>,allowed:string[],required=allowed)=>Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>own(v,k))
const id=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)
const plain=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)&&!/<\/?[a-z][^>]*>/i.test(v)
const validIdentity=(v:unknown):v is MaxTutorIdentity=>object(v)&&id(v.userId)&&id(v.sessionId)
const sameIdentity=(a:unknown,b:MaxTutorIdentity)=>validIdentity(a)&&a.userId===b.userId&&a.sessionId===b.sessionId
const fingerprint=(identity:MaxTutorIdentity,request:MaxTutorRequest,conversation:TutorConversationTurn[],personalContext?:TutorPersonalContext)=>createHash('sha256').update(JSON.stringify({userId:identity.userId,request,...(conversation.length?{conversation}:{}),...(personalContext?{personalContext}:{})})).digest('hex')
class BoundaryError extends Error{constructor(public status:Failure){super(status)}}
function parseRaw(value:unknown):RawRequest|null{
 if(!object(value)||!fields(value,['requestId','mode','prompt','sourceRefs','ownNote','conversationRunIds','studyFormat'],['requestId','mode','prompt'])||!id(value.requestId)||!TUTOR_MODES.some(m=>m.id===value.mode)||!plain(value.prompt,2400))return null
 const refs=value.sourceRefs===undefined?[]:value.sourceRefs;if(!Array.isArray(refs)||refs.some(r=>!id(r)||r==='own-note')||new Set(refs).size!==refs.length)return null
 let ownNote:RawRequest['ownNote'];if(value.ownNote!==undefined){const note=value.ownNote;if(!object(note)||!fields(note,['title','text'])||!plain(note.title,200)||!plain(note.text,20000))return null;ownNote={title:note.title,text:note.text}}
 if(value.mode!=='chat'&&refs.length+(ownNote?1:0)<1||refs.length+(ownNote?1:0)>3)return null
 const conversationRunIds=value.conversationRunIds
 if(conversationRunIds!==undefined&&(!Array.isArray(conversationRunIds)||conversationRunIds.length<1||conversationRunIds.length>4||conversationRunIds.some(ref=>!id(ref)||ref===value.requestId)||new Set(conversationRunIds).size!==conversationRunIds.length))return null
 return {requestId:value.requestId,mode:value.mode as RawRequest['mode'],prompt:value.prompt,sourceRefs:[...refs] as string[],...(ownNote?{ownNote}:{}),...(conversationRunIds?{conversationRunIds:[...conversationRunIds] as string[]}:{}),...(value.studyFormat!==undefined?{studyFormat:value.studyFormat as RawRequest['studyFormat']}:{})}
}
function parseReservation(value:unknown):Reservation|null{
 if(!object(value))return null
 if(value.state==='reserved'&&fields(value,['state','reservationId'])&&id(value.reservationId))return {state:'reserved',reservationId:value.reservationId}
 if(value.state==='replay'&&fields(value,['state','bundle']))return {state:'replay',bundle:value.bundle}
 if(['pending','denied','conflict'].includes(String(value.state))&&fields(value,['state']))return {state:value.state as 'pending'|'denied'|'conflict'}
 return null
}
function immutableRequest(request:MaxTutorRequest):MaxTutorRequest{request.sources.forEach(Object.freeze);Object.freeze(request.sources);if(request.conversationRunIds)Object.freeze(request.conversationRunIds);return Object.freeze(request)}
function abortFailure(signal:AbortSignal,timedOut:()=>boolean):BoundaryError{return new BoundaryError(timedOut()?'timeout':'cancelled')}
async function waitFor<T>(work:()=>Promise<T>,signal:AbortSignal,timedOut:()=>boolean):Promise<T>{
 return new Promise((resolve,reject)=>{let done=false;const finish=(value?:T,error?:unknown)=>{if(done)return;done=true;signal.removeEventListener('abort',abort);if(error)reject(error);else resolve(value as T)};const abort=()=>finish(undefined,abortFailure(signal,timedOut));if(signal.aborted){abort();return}signal.addEventListener('abort',abort,{once:true});Promise.resolve().then(()=>{if(signal.aborted)throw abortFailure(signal,timedOut);return work()}).then(v=>finish(v),e=>finish(undefined,e))})
}
function outputModerationText(bundle:MaxTutorBundle):string{return JSON.stringify(bundle)}

/** Offline orchestration contract only. No route, keys, database implementation or paid provider is wired here. */
export function createMaxTutorSession(ports:MaxTutorSessionPorts,configuration:MaxTutorSessionConfiguration){
 const timeoutMs=configuration.timeoutMs??30000,maxBudget=configuration.maxMonthlyBudgetUsd??10
 if(!Number.isSafeInteger(configuration.reserveMicros)||configuration.reserveMicros<=0||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isFinite(maxBudget)||maxBudget<=0||maxBudget>10||typeof ports.moderate!=='function')throw Error('Invalid tutor session configuration')
 calculateAiCostMicros({inputTokens:0,cachedInputTokens:0,outputTokens:0},configuration.tokenRates)
 return {async run(input:unknown,options:{signal?:AbortSignal}={}):Promise<MaxTutorSessionResult>{
  const raw=parseRaw(input);if(!raw)return {status:'invalid_request'}
  const controller=new AbortController();let timedOut=false;const externalAbort=()=>controller.abort();if(options.signal?.aborted)controller.abort();else options.signal?.addEventListener('abort',externalAbort,{once:true});const timer=setTimeout(()=>{timedOut=true;controller.abort()},timeoutMs)
  const call=<T,>(fn:()=>Promise<T>)=>waitFor(fn,controller.signal,()=>timedOut)
  let identity:MaxTutorIdentity,reservation:Extract<Reservation,{state:'reserved'}>|null=null,initial:Context|null=null,providerCalled=false,chargeMicros=0,bundle:MaxTutorBundle|null=null,status:Failure|'ready'='generation_failed',replayed=false
  async function sessionCheck(){let current:unknown;try{current=await call(()=>ports.currentSession())}catch(e){if(e instanceof BoundaryError)throw e;throw new BoundaryError('identity_changed')}if(!sameIdentity(current,identity))throw new BoundaryError('identity_changed')}
  async function context():Promise<Context>{
   await sessionCheck();let authorization:unknown,entitlement:unknown
   try{[authorization,entitlement]=await call(()=>Promise.all([ports.authorize(identity,raw!.sourceRefs),ports.resolveEntitlements(identity)]))}catch(e){if(e instanceof BoundaryError)throw e;throw new BoundaryError('forbidden')}
   if(!object(authorization)||authorization.userId!==identity.userId||!Array.isArray(authorization.sources)||authorization.sources.length!==raw!.sourceRefs.length||!object(entitlement)||entitlement.userId!==identity.userId||entitlement.audience!=='student'||entitlement.planId!=='max'||entitlement.aiAllowance!=='available'||typeof entitlement.monthlyAiBudgetUsd!=='number'||!Number.isFinite(entitlement.monthlyAiBudgetUsd)||entitlement.monthlyAiBudgetUsd<0)throw new BoundaryError('forbidden')
   const monthlyLimitMicros=aiUsdToMicros(Math.min(maxBudget,entitlement.monthlyAiBudgetUsd));if(monthlyLimitMicros===0)throw new BoundaryError('quota_exhausted')
   const sources:TutorSource[]=[],seen=new Set<string>();for(const s of authorization.sources){if(!object(s)||!id(s.id)||!raw!.sourceRefs.includes(s.id)||seen.has(s.id)||s.canRead!==true||s.aiAllowed!==true||!['own_note','own_excerpt'].includes(String(s.kind)))throw new BoundaryError('forbidden');seen.add(s.id);sources.push({id:s.id,title:s.title as string,text:s.text as string,page:s.page as number|null,kind:s.kind as TutorSource['kind']})}
   const ordered=raw!.sourceRefs.map(ref=>sources.find(s=>s.id===ref)!);if(raw!.ownNote)ordered.unshift({id:'own-note',title:raw!.ownNote.title,text:raw!.ownNote.text,page:null,kind:'own_note'})
   let request:MaxTutorRequest;try{request=immutableRequest(validateTutorRequest({requestId:raw!.requestId,mode:raw!.mode,prompt:raw!.prompt,sources:ordered,...(raw!.conversationRunIds?{conversationRunIds:raw!.conversationRunIds}:{}),...(raw!.studyFormat!==undefined?{studyFormat:raw!.studyFormat}:{})}))}catch{throw new BoundaryError('invalid_request')}
   let conversation:TutorConversationTurn[]=[]
   if(raw!.conversationRunIds){
    if(!ports.resolveConversation)throw new BoundaryError('forbidden')
    let history:unknown;try{history=await call(()=>ports.resolveConversation!(identity,raw!.conversationRunIds!))}catch(e){if(e instanceof BoundaryError)throw e;throw new BoundaryError('forbidden')}
    if(!object(history)||history.userId!==identity.userId||!Array.isArray(history.turns)||history.turns.length!==raw!.conversationRunIds.length*2||history.turns.length>8)throw new BoundaryError('forbidden')
    let size=0
    for(const [index,turn]of history.turns.entries()){
     if(!object(turn)||!fields(turn,['role','content'])||turn.role!==(index%2===0?'user':'assistant')||!plain(turn.content,3000))throw new BoundaryError('forbidden')
     size+=turn.content.length;if(size>12000)throw new BoundaryError('forbidden')
     conversation.push(Object.freeze({role:turn.role as TutorConversationTurn['role'],content:turn.content}))
    }
    Object.freeze(conversation)
   }
   let personalContext:TutorPersonalContext|undefined
   if(ports.resolvePersonalContext){
    let personal:unknown;try{personal=await call(()=>ports.resolvePersonalContext!(identity));if(!object(personal)||!fields(personal,['userId','context'])||personal.userId!==identity.userId)throw Error('Invalid owner');personalContext=validateTutorPersonalContext(personal.context)}catch(e){if(e instanceof BoundaryError)throw e;throw new BoundaryError('forbidden')}
    Object.freeze(personalContext.profile);Object.freeze(personalContext.practice.topics);Object.freeze(personalContext.practice);Object.freeze(personalContext)
   }
   await sessionCheck();return {request,fingerprint:fingerprint(identity,request,conversation,personalContext),monthlyLimitMicros,conversation,...(personalContext?{personalContext}:{})}
  }
  async function recheck(){const current=await context();if(current.fingerprint!==initial!.fingerprint||current.monthlyLimitMicros!==initial!.monthlyLimitMicros)throw new BoundaryError('context_changed')}
  async function moderate(text:string){let ok:unknown;try{ok=await call(()=>ports.moderate(text,{signal:controller.signal}))}catch(e){if(e instanceof BoundaryError)throw e;throw new BoundaryError('moderation_failed')}if(ok!==true)throw new BoundaryError('refused')}
  try{
   let first:unknown;try{first=await call(()=>ports.currentSession())}catch(e){if(e instanceof BoundaryError)throw e;throw new BoundaryError('signed_out')}if(!validIdentity(first))throw new BoundaryError('signed_out');identity={userId:first.userId,sessionId:first.sessionId}
   initial=await context();await moderate(JSON.stringify({prompt:initial.request.prompt,sources:initial.request.sources,...(initial.conversation.length?{conversation:initial.conversation}:{}),...(initial.personalContext?{personalContext:initial.personalContext}:{})}));await recheck();if(configuration.reserveMicros>initial.monthlyLimitMicros)throw new BoundaryError('quota_exhausted')
   let decision:Reservation|null;try{decision=parseReservation(await call(()=>ports.budget.begin({userId:identity.userId,requestId:raw.requestId,fingerprint:initial!.fingerprint,reserveMicros:configuration.reserveMicros,monthlyLimitMicros:initial!.monthlyLimitMicros})))}catch{throw new BoundaryError('storage_failed')}
   if(!decision)throw new BoundaryError('storage_failed');if(decision.state==='denied')throw new BoundaryError('quota_exhausted');if(decision.state==='pending'||decision.state==='conflict')throw new BoundaryError(decision.state)
   if(decision.state==='replay'){
    await recheck();try{bundle=validateTutorBundle(decision.bundle,initial.request)}catch{throw new BoundaryError('invalid_output')}await moderate(outputModerationText(bundle));await recheck();status='ready';replayed=true
   }else{
    if(decision.state!=='reserved')throw new BoundaryError('storage_failed');reservation=decision;await recheck();if(controller.signal.aborted)throw abortFailure(controller.signal,()=>timedOut)
    providerCalled=true;chargeMicros=configuration.reserveMicros
    let generated:unknown;try{generated=await call(()=>ports.generate(initial!.request,{signal:controller.signal,...(initial!.conversation.length?{conversation:initial!.conversation}:{}),...(initial!.personalContext?{personalContext:initial!.personalContext}:{})}))}catch(e){if(e instanceof BoundaryError)throw e;throw new BoundaryError('generation_failed')}
    if(!object(generated))throw new BoundaryError('invalid_output')
    try{if(generated.usage!==null&&generated.usage!==undefined)chargeMicros=calculateAiCostMicros(generated.usage as AiBillableUsage,configuration.tokenRates)}catch{/* Unknown usage retains conservative reservation. */}
    await recheck();try{bundle=validateTutorBundle(generated.bundle,initial.request)}catch{throw new BoundaryError('invalid_output')}await moderate(outputModerationText(bundle));await recheck();status='ready'
   }
  }catch(e){bundle=null;status=e instanceof BoundaryError?e.status:'generation_failed'}
  finally{clearTimeout(timer);options.signal?.removeEventListener('abort',externalAbort)}
  if(reservation&&initial!){
   let finishTimer:ReturnType<typeof setTimeout>|undefined
   try{await Promise.race([ports.budget.finish({reservationId:reservation.reservationId,userId:identity!.userId,sessionId:identity!.sessionId,requestId:raw.requestId,fingerprint:initial.fingerprint,chargeMicros:providerCalled?chargeMicros:0,bundle:status==='ready'?bundle:null}),new Promise<never>((_,reject)=>{finishTimer=setTimeout(()=>reject(Error('Settlement unavailable')),Math.min(timeoutMs,30000))})])}catch{return {status:'storage_failed'}}finally{if(finishTimer!==undefined)clearTimeout(finishTimer)}
  }
  if((controller.signal.aborted||options.signal?.aborted)&&status==='ready')return {status:timedOut?'timeout':'cancelled'}
  return status==='ready'&&bundle?{status:'ready',bundle,replayed}:{status:status==='ready'?'invalid_output':status}
 }}
}
