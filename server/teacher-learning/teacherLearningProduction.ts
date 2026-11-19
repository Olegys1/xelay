import {createHash}from'node:crypto'
import {createClient}from'@supabase/supabase-js'
import {teacherLearningObject,teacherLearningUuid,validateTeacherLearningBundle,validateTeacherLearningDraft,validateTeacherLearningRequest,validateTeacherLearningSave,validateTeacherLearningStatus}from'../../src/lib/teacherLearningValidation.js'
import {createTeacherLearningProvider,teacherLearningPayload,TeacherModelError,TEACHER_LEARNING_RESERVATION_MICROS}from'./teacherLearningProvider.js'
import type{TeacherLearningBundle,TeacherLearningDraft}from'../../src/lib/teacherLearning.js'

const object=teacherLearningObject,project='https://baohfpadxvhqhhjjqtil.supabase.co'
type Client={auth:{getUser(token:string):PromiseLike<{data:{user:any};error:any}>};rpc(name:string,args?:Record<string,unknown>):PromiseLike<{data:any;error:any}>}
type Dependencies={environment?:Record<string,string|undefined>;clientFactory?:(url:string,key:string,options:any)=>Client;fetcher?:typeof fetch;now?:()=>number;trustedOrigins?:readonly string[]}
class TeacherApiError extends Error{constructor(public code:string,public status:number){super(code)}}
const fail=(code:string,status=503):never=>{throw new TeacherApiError(code,status)}
const exact=(v:Record<string,unknown>,allowed:string[])=>Object.keys(v).length===allowed.length&&allowed.every(k=>Object.prototype.hasOwnProperty.call(v,k))
const hash=(v:string)=>createHash('sha256').update(v).digest('hex')
export function teacherLearningConfiguration(env:Record<string,string|undefined>){
 const url=(env.SUPABASE_URL||env.VITE_SUPABASE_URL||'').replace(/\/$/,''),publicKey=env.SUPABASE_ANON_KEY||env.VITE_SUPABASE_ANON_KEY||'',privateKey=env.SUPABASE_SERVICE_ROLE_KEY||env.SUPABASE_SERVICE_ROLE||'',apiKey=env.OPENAI_API_KEY||''
 const valid=url===project&&!!publicKey&&!!privateKey&&publicKey!==privateKey&&!/\s/.test(publicKey+privateKey)&&publicKey.length<=8192&&privateKey.length<=8192
 const enabled=env.TEACHER_LEARNING_ENABLED==='true'&&valid,aiEnabled=enabled&&env.TEACHER_LEARNING_AI_ENABLED==='true'&&/^sk-[A-Za-z0-9_-]{20,296}$/.test(apiKey)
 const origins=['https://www.xelay.ink','https://xelay.ink'];if(env.VERCEL_ENV==='preview'&&/^[A-Za-z0-9-]+\.vercel\.app$/.test(env.VERCEL_URL||''))origins.push('https://'+env.VERCEL_URL)
 return{enabled,aiEnabled,url,publicKey,privateKey,apiKey,origins}
}
function mapFailure(error:any):never{
 if(error instanceof TeacherApiError)throw error
 const code=String(error?.code||'');if(code==='42501')return fail('forbidden',403);if(code==='PT409')return fail('conflict',409);if(code==='PT429')return fail('rate_limited',429);if(['22023','22P02'].includes(code))return fail('invalid_request',400)
 return fail('unavailable')
}
async function rpc(client:Client,name:string,args:Record<string,unknown>={}){let result:any;try{result=await client.rpc(name,args)}catch(error){return mapFailure(error)}if(result.error)return mapFailure(result.error);return result.data}
async function readBody(req:any){if(!/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type']||'')))return fail('invalid_request',400);let raw=req.body
 if(raw===undefined){const chunks:Buffer[]=[];let n=0;for await(const part of req){const b=Buffer.from(part);n+=b.length;if(n>170000)return fail('invalid_request',413);chunks.push(b)}raw=Buffer.concat(chunks).toString('utf8')}
 if(typeof raw==='string'){if(Buffer.byteLength(raw)>170000)return fail('invalid_request',413);try{raw=JSON.parse(raw)}catch{return fail('invalid_request',400)}}
 if(!object(raw)||Buffer.byteLength(JSON.stringify(raw))>170000)return fail('invalid_request',400);return raw
}
export function createTeacherLearningProduction(dependencies:Dependencies={}){
 const environment=dependencies.environment||process.env,config=teacherLearningConfiguration(environment),factory=dependencies.clientFactory||(createClient as unknown as NonNullable<Dependencies['clientFactory']>),now=dependencies.now||Date.now
 const provider=createTeacherLearningProvider({apiKey:config.apiKey,fetcher:dependencies.fetcher})
 const origins=dependencies.trustedOrigins&&environment.VERCEL_ENV!=='production'?[...config.origins,...dependencies.trustedOrigins]:config.origins
 return async(req:any,res:any)=>{
  res.setHeader('Cache-Control','no-store, private');res.setHeader('Pragma','no-cache');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Cross-Origin-Resource-Policy','same-origin');res.setHeader('Vary','Authorization, Origin')
  const send=(status:number,value:unknown)=>{if(res.writableEnded||res.destroyed)return;res.statusCode=status;res.setHeader('Content-Type','application/json;charset=utf-8');res.end(JSON.stringify(value))}
  try{
   if(req.method!=='POST'){res.setHeader('Allow','POST');return send(405,{code:'method_not_allowed'})}
   if(!origins.includes(String(req.headers?.origin||''))||req.headers?.['sec-fetch-site']==='cross-site')return fail('forbidden',403)
   if(!config.enabled)return fail('unavailable')
   const token=String(req.headers?.authorization||'').match(/^Bearer ([^\s]{16,8192})$/)?.[1];if(!token)return fail('signed_out',401)
   const auth={persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},caller=factory(config.url,config.publicKey,{auth,global:{headers:{Authorization:'Bearer '+token}}}),service=factory(config.url,config.privateKey,{auth})
   const verified=await caller.auth.getUser(token);if(verified.error||!verified.data?.user?.email_confirmed_at)return fail('signed_out',401)
   let claims:any;try{claims=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString('utf8'))}catch{return fail('signed_out',401)}
   const userId=verified.data.user.id,session=claims.session_id
   if(claims.sub!==userId||claims.role!=='authenticated'||!teacherLearningUuid(userId)||!teacherLearningUuid(session)||!Number.isSafeInteger(claims.exp)||claims.exp*1000<=now())return fail('signed_out',401)
   let status=await rpc(caller,'xelay_teacher_workspace_status');if(!object(status)||status.userId!==userId)return fail('identity_changed',401)
   const input=await readBody(req),action=input.action
   if(action==='status'){
    if(!exact(input,['action']))return fail('invalid_request',400)
    const courses=await rpc(caller,'xelay_teacher_ai_catalog');status={...status,available:config.aiEnabled,canGenerate:status.canGenerate===true&&config.aiEnabled,courses}
    return send(200,validateTeacherLearningStatus(status))
   }
   if(action==='history'){
    if(!exact(input,['action']))return fail('invalid_request',400)
    const drafts=await rpc(caller,'xelay_teacher_ai_history');if(!Array.isArray(drafts))return fail('unavailable')
    const valid:TeacherLearningDraft[]=[]
    for(const draft of drafts){try{valid.push(validateTeacherLearningDraft(draft))}catch{/* Quarantine an invalid legacy own row, preserving the rest of history. */}}
    return send(200,{userId,drafts:valid})
   }
   if(action==='candidates'){
    if(!exact(input,['action','scope'])||!object(input.scope)||!exact(input.scope,['courseId','groupIds'])||!teacherLearningUuid(input.scope.courseId)||!Array.isArray(input.scope.groupIds)||input.scope.groupIds.some((g:unknown)=>!teacherLearningUuid(g)))return fail('invalid_request',400)
    const candidates=await rpc(caller,'xelay_teacher_ai_candidates',{p_course_id:input.scope.courseId,p_group_ids:input.scope.groupIds});return send(200,{userId,...candidates})
   }
   if(action==='insights'){
    if(!exact(input,['action','scope'])||!object(input.scope)||!exact(input.scope,['courseId','groupIds','testId'])||!teacherLearningUuid(input.scope.courseId)||!Array.isArray(input.scope.groupIds)||input.scope.groupIds.some((g:unknown)=>!teacherLearningUuid(g))||input.scope.testId!==null&&!teacherLearningUuid(input.scope.testId))return fail('invalid_request',400)
    const report=await rpc(caller,'xelay_teacher_ai_insights',{p_course_id:input.scope.courseId,p_group_ids:input.scope.groupIds,p_test_id:input.scope.testId})
    return send(200,{userId,report})
   }
   if(action==='reminders'){
    if(!exact(input,['action','operation','payload'])||!['list','create','cancel'].includes(String(input.operation))||!object(input.payload))return fail('invalid_request',400)
    const reminders=await rpc(caller,'xelay_teacher_ai_reminders',{p_action:input.operation,p_payload:input.payload})
    return send(200,{userId,reminders})
   }
   if(action==='create_test'){
    if(!exact(input,['action','draftId','conditions'])||!teacherLearningUuid(input.draftId)||!object(input.conditions))return fail('invalid_request',400)
    const result=await rpc(caller,'xelay_teacher_ai_create_test',{p_draft_id:input.draftId,p_conditions:input.conditions})
    return send(200,{userId,...result})
   }
   if(action==='save_draft'){
    if(!exact(input,['action','save']))return fail('invalid_request',400)
    let save;try{save=validateTeacherLearningSave(input.save)}catch{return fail('invalid_request',400)}
    const previous=await rpc(caller,'xelay_teacher_ai_draft',{p_id:save.id})
    if(!previous)return fail('forbidden',403)
    try{validateTeacherLearningBundle(save.bundle,validateTeacherLearningRequest(previous.request))}catch{return fail('invalid_request',400)}
    const draft=await rpc(caller,'xelay_teacher_ai_draft_save',{p_id:save.id,p_expected_revision:save.expectedRevision,p_bundle:save.bundle,p_teacher_notes:save.teacherNotes,p_status:save.status})
    return send(200,{userId,draft:validateTeacherLearningDraft(draft)})
   }
   if(action!=='generate'||!exact(input,['action','request']))return fail('invalid_request',400)
   if(!config.aiEnabled)return fail('unavailable')
   let request;try{request=validateTeacherLearningRequest(input.request)}catch{return fail('invalid_request',400)}
   const context=await rpc(caller,'xelay_teacher_ai_context',{p_request:request})
   if(!object(context)||!object(context.context)||typeof context.contextHash!=='string'||!/^[a-f0-9]{64}$/.test(context.contextHash))return fail('unavailable')
   try{teacherLearningPayload(request,context.context)}catch{return fail('invalid_request',400)}
   const sessionHash=hash(session),fingerprint=hash(JSON.stringify({request,contextHash:context.contextHash,model:'gpt-5.4-mini',version:1}))
   const reservation=await rpc(service,'xelay_teacher_ai_reserve',{p_user_id:userId,p_session_hash:sessionHash,p_request:request,p_fingerprint:fingerprint,p_context_hash:context.contextHash,p_reserve_micros:TEACHER_LEARNING_RESERVATION_MICROS})
   if(!object(reservation))return fail('unavailable')
   if(reservation.state==='denied')return fail('quota_exhausted',429)
   if(reservation.state==='pending')return fail('pending',409)
   if(reservation.state==='conflict')return fail('conflict',409)
   if(reservation.state==='failed')return fail('generation_failed',409)
   if(reservation.state==='reserved'){
    if(!teacherLearningUuid(reservation.reservationId))return fail('unavailable')
    let bundle:TeacherLearningBundle|null=null,charge=TEACHER_LEARNING_RESERVATION_MICROS,failure:string|null=null
    try{const output=await provider.generate(request,context.context,AbortSignal.timeout(30000));bundle=output.bundle;charge=output.chargeMicros}catch(error){if(error instanceof TeacherModelError){failure=error.code;charge=error.chargeMicros}else failure='generation_failed'}
    const settled=await rpc(service,'xelay_teacher_ai_finish',{p_user_id:userId,p_session_hash:sessionHash,p_request_id:request.requestId,p_fingerprint:fingerprint,p_reservation_id:reservation.reservationId,p_charge_micros:charge,p_bundle:bundle})
    if(failure)return fail(failure,503)
    if(!object(settled)||settled.saved!==true)return fail('context_changed',409)
   }else if(reservation.state!=='replay')return fail('unavailable')
   const draft=await rpc(caller,'xelay_teacher_ai_draft',{p_id:request.requestId})
   if(!draft)return fail('context_changed',409)
   return send(200,{userId,draft:validateTeacherLearningDraft(draft)})
  }catch(error){if(error instanceof TeacherApiError)return send(error.status,{code:error.code});return send(503,{code:'unavailable'})}
 }
}
