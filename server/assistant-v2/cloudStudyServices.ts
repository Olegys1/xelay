import {createAuthenticatedAssistantReadService,type VerifiedAssistantSession,type AssistantReadRepository,type AuthenticatedAssistantReadScope} from './authenticatedRead.ts'
import {createSupabaseAssistantReadRepository,type AssistantCallerClient} from './supabaseReadRepository.ts'
import {boundedMaterialText,CLOUD_MATERIAL_LIMITS,extractCloudMaterialText} from './cloudMaterialText.ts'

export interface AssistantStorageReadDescriptor{bucket:'xelay-study-materials'|'xelay-teaching-files';path:string;size:number}
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i
const object=(v:unknown):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const fail=(code:string,status=403):never=>{throw Object.assign(new Error(code),{code,status})}
const abort=(signal?:AbortSignal)=>{if(signal?.aborted)fail('request_cancelled',499)}
export function createCloudStudyServices(d:{verifySession:(credential:string,signal?:AbortSignal)=>Promise<VerifiedAssistantSession|null>;createCallerClient:(session:VerifiedAssistantSession,credential:string)=>AssistantCallerClient;createCallerRepository?:(session:VerifiedAssistantSession,credential:string)=>AssistantReadRepository|Promise<AssistantReadRepository>;readStorageFile?:(descriptor:AssistantStorageReadDescriptor,signal?:AbortSignal)=>Promise<Uint8Array>;now?:()=>number;extractFileText?:typeof extractCloudMaterialText}){
 const now=d.now||Date.now
 const reads=createAuthenticatedAssistantReadService({verifySession:d.verifySession,now,createCallerRepository:d.createCallerRepository||((s,c)=>createSupabaseAssistantReadRepository({client:d.createCallerClient(s,c),userId:s.userId,credential:c,now}))})
 async function session(credential:string,signal?:AbortSignal){abort(signal);if(typeof credential!=='string'||credential.length<16||credential.length>8192||/\s/.test(credential))return fail('session_invalid',401);const s=await d.verifySession(credential,signal);if(!s||!UUID.test(s.userId)||s.accountActive!==true||s.emailConfirmed!==true||!Number.isFinite(Date.parse(s.expiresAt))||Date.parse(s.expiresAt)<=now())return fail('session_invalid',401);return s}
 async function resolve(credential:string,input:any,signal?:AbortSignal){
  if(!object(input)||Object.keys(input).some(k=>!['scope','materialId','rightsVersion'].includes(k))||!UUID.test(input.materialId)||!object(input.scope))return fail('invalid_request',400)
  if(Object.keys(input.scope).some(k=>!['groupId','courseId','subjectId','period','date'].includes(k)))return fail('invalid_scope',400)
  const s=await session(credential,signal),scope:AuthenticatedAssistantReadScope={...input.scope},client=d.createCallerClient(s,credential)
  delete (scope as any).date
  let material:any,kind:'study'|'teaching'
  if(!scope.groupId){
   if(!scope.courseId||!UUID.test(scope.courseId))return fail('group_required',400)
   kind='teaching'
  }else{
   let read
   try{read=await reads.read(credential,{topic:'materials',scope,limit:100},signal)}catch(error:any){
    if(error?.code!=='access_denied'||!scope.courseId)throw error
    const {courseId:_course,...studentScope}=scope
    read=await reads.read(credential,{topic:'materials',scope:studentScope,limit:100},signal)
   }
   material=read.records.find(r=>r.kind==='material'&&(r.materialId||r.id)===input.materialId&&(!scope.courseId||r.courseId===scope.courseId))
   if(!material||material.kind!=='material')return fail('material_unavailable')
   kind=material.materialSourceKind||(material.courseId?'teaching':'study')
  }
  const result=await client.rpc('xelay_assistant_material_ai',{p_kind:kind,p_material_id:input.materialId});abort(signal)
  if(result.error||!object(result.data))return fail('material_ai_unavailable',503)
  const rights=result.data
  if(rights.id!==input.materialId||rights.sourceKind!==kind||rights.allowAi!==true)return fail('material_ai_not_allowed')
  if(typeof rights.rightsVersion!=='string'||!/^[a-f\d]{32}$/.test(rights.rightsVersion)||typeof rights.title!=='string'||typeof rights.body!=='string'||!Array.isArray(rights.attachments)||rights.attachments.length>20)return fail('material_ai_unavailable',503)
  if(!material){
   if(rights.canChange!==true||rights.courseId!==scope.courseId)return fail('material_unavailable')
   material={id:input.materialId,materialId:input.materialId,materialSourceKind:kind,groupId:'',sourcePath:`/teaching?course=${scope.courseId}&home=materials`}
  }
  if(input.rightsVersion&&input.rightsVersion!==rights.rightsVersion||material.rightsVersion&&material.rightsVersion!==rights.rightsVersion)return fail('material_changed',409)
  return{s,scope,material,kind,client,rights}
 }
 async function assertMaterialRights(credential:string,input:{scope:AuthenticatedAssistantReadScope;materialId:string;rightsVersion:string},signal?:AbortSignal){
  const resolved=await resolve(credential,input,signal);const latest=await session(credential,signal)
  if(latest.userId!==resolved.s.userId||latest.sessionId!==resolved.s.sessionId)return fail('session_changed',401)
  return{userId:latest.userId,allowAi:true as const,rightsVersion:resolved.rights.rightsVersion}
 }
 return{
  read:reads.read,
  assertMaterialRights,
  async preparationPlan(credential:string,input:{scope:AuthenticatedAssistantReadScope},signal?:AbortSignal){
   if(!object(input)||Object.keys(input).some(k=>k!=='scope')||!object(input.scope))return fail('invalid_request',400)
   const s=await session(credential,signal),scope=input.scope
   const study=await reads.read(credential,{topic:'study',scope,limit:100},signal)
   const grades=await reads.read(credential,{topic:'results',scope:{groupId:scope.groupId,subjectId:scope.subjectId,period:scope.period||'current'},limit:100},signal)
   const items=study.records.filter(r=>r.kind==='homework'&&(!r.dueAt||Date.parse(r.dueAt)>=now())).map(r=>({id:r.id,title:r.title,condition:'body'in r?r.body:'',sourcePath:r.sourcePath,date:'date'in r?r.date:undefined,dueAt:'dueAt'in r?r.dueAt:null,steps:['Перегляньте повну умову викладача за посиланням.','Уточніть, які вимоги й умови застосовуються саме до цієї роботи.','Якщо в умові є строк, залиште час на перевірку; інакше оберіть зручний час.']}))
   const latest=await session(credential,signal);if(latest.userId!==s.userId||latest.sessionId!==s.sessionId)return fail('session_changed',401)
   return{userId:s.userId,items,gradeSummary:grades.gradeSummary||[],truncated:study.truncated||grades.truncated,advisoryOnly:true as const,notice:'Це підказки для планування за доступними завданнями, не нові вимоги викладача й не автоматичне оцінювання.'}
  },
  async materialContent(credential:string,input:{scope:AuthenticatedAssistantReadScope;materialId:string},signal?:AbortSignal){
   const r=await resolve(credential,input,signal),chunks=[r.rights.body],extract=d.extractFileText||extractCloudMaterialText
   let total=0,truncated=r.rights.attachments.length>CLOUD_MATERIAL_LIMITS.files
   for(const f of r.rights.attachments.slice(0,CLOUD_MATERIAL_LIMITS.files)){
    abort(signal)
    const path=f.storage_path||f.path,size=f.size??f.file_size,name=f.name||f.file_name,mimeType=f.mime_type||f.mime
    if(typeof path!=='string'||!new RegExp(`^[a-f\\d-]{36}/[a-f\\d-]{36}/[a-f\\d-]{36}\\.[a-z\\d]{1,5}$`,'i').test(path)||typeof name!=='string'||name.length>180||typeof mimeType!=='string'||!Number.isSafeInteger(size)||size<1)return fail('material_file_invalid',422)
    if(size>CLOUD_MATERIAL_LIMITS.fileBytes||total+size>CLOUD_MATERIAL_LIMITS.totalBytes){truncated=true;continue}
    total+=size
    const descriptor:AssistantStorageReadDescriptor={bucket:r.kind==='study'?'xelay-study-materials':'xelay-teaching-files',path,size}
    let bytes:Uint8Array
    if(d.readStorageFile)bytes=await d.readStorageFile(descriptor,signal)
    else{if(!r.client.storage)return fail('material_file_unavailable',503);const file=await r.client.storage.from(descriptor.bucket).download(path);if(file.error||!file.data||file.data.size!==size)return fail('material_file_unavailable',503);bytes=new Uint8Array(await file.data.arrayBuffer())}
    abort(signal);if(!(bytes instanceof Uint8Array)||bytes.byteLength!==size)return fail('material_file_changed',409)
    const content=await extract(bytes,{name,mimeType});chunks.push(`${name}\n${content.text}`);truncated ||= content.truncated
   }
   const bounded=boundedMaterialText(chunks.join('\n\n'));truncated ||= bounded.truncated
   if(!bounded.text.trim())return fail('material_text_unavailable',422)
   await assertMaterialRights(credential,{...input,rightsVersion:r.rights.rightsVersion},signal)
   const sourcePath=r.material.sourcePath||`/groups/${r.material.groupId}?tab=materials`
   return{userId:r.s.userId,allowAi:true as const,text:bounded.text,title:r.rights.title.slice(0,240),rightsVersion:r.rights.rightsVersion,sources:[{id:input.materialId,title:r.rights.title.slice(0,240),path:sourcePath}],truncated}
  },
 }
}
