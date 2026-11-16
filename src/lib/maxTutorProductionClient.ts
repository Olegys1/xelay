import {normalizeTutorScope,validateTutorBundle,validateTutorRequest,type MaxTutorScope,type MaxTutorRequest,type TutorProgress,type TutorRun,type TutorState} from './maxTutor'

export type ProductionMaxStatus={status:'ready';scope:MaxTutorScope;audience:'student'|'teacher'|'unresolved';planId:'free'|'start'|'plus'|'max';canGenerate:boolean;canEdit:boolean;available:boolean;model:string;budget:{limitUsd:number;spentUsd:number;reservedUsd:number;remainingUsd:number};localOnly:false;budgetPeriod:'utc_calendar_month';budgetResetsAt:string}
export type ProductionTutorRun=TutorRun&{revision:number}
export type ProductionTutorHistory={scope:MaxTutorScope;runs:ProductionTutorRun[];activeRunId:string}
export type ProductionCredential={userId:string;accessToken:string;sessionId?:string}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const fields=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.prototype.hasOwnProperty.call(v,k))
const validId=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0
const messages:Record<string,string>={signed_out:'Увійди до Xelay, щоб відкрити особистий навчальний простір.',forbidden:'Ця дія недоступна для поточного облікового запису.',identity_changed:'Обліковий запис змінився. Відкрий навчальний простір ще раз.',quota_exhausted:'Ліміт ШІ цього періоду вичерпано. Збережені матеріали залишаються доступними.',pending:'Запит уже виконується. Дочекайся результату.',conflict:'Цей матеріал змінено в іншій вкладці. Онови збережений стан перед продовженням.',unavailable:'Навчальний сервіс тимчасово недоступний. Спробуй пізніше.',invalid_response:'Не вдалося перевірити відповідь сервера. Попередні матеріали залишилися на пристрої.',invalid_request:'Перевір запит і обраний навчальний текст.',generation_failed:'Модель не завершила відповідь. Перевір доступний ліміт перед новою спробою.',refused:'Не вдалося безпечно опрацювати цей матеріал. Уточни навчальне завдання.',timeout:'Модель не встигла відповісти. Перевір збережений стан перед новою спробою.',cancelled:'Запит зупинено.'}
export class MaxTutorProductionError extends Error{constructor(public code:string,public currentRun?:ProductionTutorRun){super(messages[code]||messages.unavailable);this.name='MaxTutorProductionError'}}
const fail=():never=>{throw new MaxTutorProductionError('invalid_response')}
function ownerScope(value:unknown,ownerId:string){const scope=normalizeTutorScope(value);if(!scope||scope.userId!==ownerId)throw new MaxTutorProductionError('identity_changed');return scope}
export function parseProductionMaxStatus(value:unknown,ownerId:string):ProductionMaxStatus{
 if(!object(value)||!fields(value,['status','scope','audience','planId','canGenerate','canEdit','available','model','budget','localOnly','budgetPeriod','budgetResetsAt'])||value.status!=='ready'||value.localOnly!==false||value.budgetPeriod!=='utc_calendar_month'||typeof value.budgetResetsAt!=='string'||!Number.isFinite(Date.parse(value.budgetResetsAt))||!['student','teacher','unresolved'].includes(String(value.audience))||!['free','start','plus','max'].includes(String(value.planId))||typeof value.canGenerate!=='boolean'||typeof value.canEdit!=='boolean'||typeof value.available!=='boolean'||typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value.model)||!object(value.budget)||!fields(value.budget,['limitUsd','spentUsd','reservedUsd','remainingUsd'])||!Object.values(value.budget).every(finite)||Number(value.budget.limitUsd)>6||Number(value.budget.remainingUsd)>Number(value.budget.limitUsd)+.000001)return fail()
 if(value.canGenerate&&(value.audience!=='student'||value.planId!=='max'||value.available!==true))return fail()
 return {...value,scope:ownerScope(value.scope,ownerId)} as ProductionMaxStatus
}
export function validateProductionProgress(raw:unknown,run:Pick<TutorRun,'bundle'>):TutorProgress{
 if(!object(raw)||!fields(raw,['answers','submitted','cardRatings','doneTasks'])||!object(raw.answers)||!object(raw.cardRatings)||!Array.isArray(raw.submitted)||!Array.isArray(raw.doneTasks))return fail()
 const answers:Record<string,number>={},ratings:Record<string,'known'|'repeat'>={},questions=new Map(run.bundle.questions.map(q=>[q.id,q])),cards=new Set(run.bundle.cards.map(c=>c.id)),tasks=new Set(run.bundle.plan.flatMap(p=>p.tasks.map((_,i)=>p.id+':'+i)))
 for(const [id,value]of Object.entries(raw.answers)){const q=questions.get(id);if(!q||!integer(value)||value>=q.options.length)return fail();answers[id]=value}
 if(raw.submitted.length>questions.size||new Set(raw.submitted).size!==raw.submitted.length||raw.submitted.some(id=>typeof id!=='string'||!questions.has(id)||answers[id]===undefined)||raw.doneTasks.length>tasks.size||new Set(raw.doneTasks).size!==raw.doneTasks.length||raw.doneTasks.some(id=>typeof id!=='string'||!tasks.has(id)))return fail()
 for(const [id,value]of Object.entries(raw.cardRatings)){if(!cards.has(id)||!['known','repeat'].includes(String(value)))return fail();ratings[id]=value as 'known'|'repeat'}
 return {answers,submitted:[...raw.submitted] as string[],cardRatings:ratings,doneTasks:[...raw.doneTasks] as string[]}
}
export function parseProductionTutorRun(value:unknown):ProductionTutorRun{
 if(!object(value)||!fields(value,['id','createdAt','demo','request','bundle','progress','revision'])||!validId(value.id)||value.demo!==false||typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||!integer(value.revision))return fail()
 try{const request=validateTutorRequest(value.request);if(request.requestId!==value.id)return fail();const bundle=validateTutorBundle(value.bundle,request);return {id:value.id,createdAt:value.createdAt,demo:false,request,bundle,progress:validateProductionProgress(value.progress,{bundle}),revision:value.revision}}catch{return fail()}
}
export function parseProductionTutorHistory(value:unknown,ownerId:string):ProductionTutorHistory{
 if(!object(value)||!fields(value,['status','scope','runs','activeRunId'])||value.status!=='ready'||!Array.isArray(value.runs)||value.runs.length>12||typeof value.activeRunId!=='string')return fail()
 const scope=ownerScope(value.scope,ownerId),runs=value.runs.map(parseProductionTutorRun);if(new Set(runs.map(r=>r.id)).size!==runs.length||value.activeRunId&&!runs.some(r=>r.id===value.activeRunId))return fail()
 return {scope,runs,activeRunId:value.activeRunId||runs[0]?.id||''}
}
export function productionTutorState(history:ProductionTutorHistory):TutorState{return {version:1,runs:history.runs.map(({revision:_,...run})=>run),activeRunId:history.activeRunId}}
export type ProductionProgressPending={revision:number;progress:TutorProgress}
/** Rebase only additive matching progress; never replace another device's answer or unchecked state. */
export function productionProgressExtends(current:TutorProgress,next:TutorProgress):boolean{return Object.entries(current.answers).every(([id,value])=>next.answers[id]===value)&&current.submitted.every(id=>next.submitted.includes(id))&&Object.entries(current.cardRatings).every(([id,value])=>next.cardRatings[id]===value)&&current.doneTasks.every(id=>next.doneTasks.includes(id))}
export function restoreProductionProgress(history:ProductionTutorHistory,raw:string|null){
 const state=productionTutorState(history),pending:Record<string,ProductionProgressPending>={};let conflict=false
 if(!raw||raw.length>100_000)return {state,pending,conflict}
 let value:unknown;try{value=JSON.parse(raw)}catch{return {state,pending,conflict}}
 if(!object(value)||!fields(value,['version','ownerId','items'])||value.version!==1||value.ownerId!==history.scope.userId||!object(value.items)||Object.keys(value.items).length>12)return {state,pending,conflict}
 for(const [id,item]of Object.entries(value.items)){
  if(!validId(id)||!object(item)||!fields(item,['revision','progress'])||!integer(item.revision))continue
  const run=state.runs.find(r=>r.id===id),server=history.runs.find(r=>r.id===id)
  if(!run||!server){pending[id]={revision:item.revision,progress:item.progress as TutorProgress};conflict=true;continue}
  try{const progress=validateProductionProgress(item.progress,run);if(progressSignature(progress)===progressSignature(server.progress))continue;const rebase=item.revision!==server.revision&&productionProgressExtends(server.progress,progress);pending[id]={revision:rebase?server.revision:item.revision,progress};run.progress=progress;if(item.revision!==server.revision&&!rebase)conflict=true}catch{}
 }
 return {state,pending,conflict}
}
const progressSignature=(p:TutorProgress)=>JSON.stringify({answers:Object.fromEntries(Object.entries(p.answers).sort()),submitted:[...p.submitted].sort(),cardRatings:Object.fromEntries(Object.entries(p.cardRatings).sort()),doneTasks:[...p.doneTasks].sort()})
export {progressSignature as productionProgressSignature}
async function responseJson(response:Response):Promise<unknown>{
 if(response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||!response.body)return fail()
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2_000_000)return fail();chunks.push(part.value)}}finally{void reader.cancel().catch(()=>{});reader.releaseLock()}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{return fail()}
}
export function createMaxTutorProductionClient(options:{ownerId:string;credential:()=>Promise<ProductionCredential|null>;fetcher?:typeof fetch}){
 if(!validId(options.ownerId))throw new MaxTutorProductionError('signed_out')
 const fetcher=options.fetcher||fetch
 async function requestUnsafe(action:'status'|'history'|'generate'|'progress',body?:unknown,signal?:AbortSignal){
  const credential=await options.credential();if(!credential||credential.userId!==options.ownerId||typeof credential.accessToken!=='string'||!credential.accessToken||/[\r\n\s]/.test(credential.accessToken))throw new MaxTutorProductionError('signed_out')
  const response=await fetcher('/api/student-learning?action='+action,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credential.accessToken,Accept:'application/json',...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal,credentials:'omit',cache:'no-store',redirect:'error'})
  const value=await responseJson(response)
  const current=await options.credential();if(!current||current.userId!==credential.userId||credential.sessionId!==current.sessionId)throw new MaxTutorProductionError('identity_changed')
  if(object(value)&&value.scope&&credential.sessionId&&ownerScope(value.scope,options.ownerId).sessionId!==credential.sessionId)throw new MaxTutorProductionError('identity_changed')
  if(!response.ok||!object(value)||value.status!=='ready'){let run:ProductionTutorRun|undefined;try{if(object(value)&&value.run)run=parseProductionTutorRun(value.run)}catch{};throw new MaxTutorProductionError(object(value)&&typeof value.status==='string'?value.status:'unavailable',run)}
  return value
 }
 async function request(action:'status'|'history'|'generate'|'progress',body?:unknown,signal?:AbortSignal){try{return await requestUnsafe(action,body,signal)}catch(error){if(error instanceof MaxTutorProductionError)throw error;throw new MaxTutorProductionError(signal?.aborted?'cancelled':'unavailable')}}
 return {
  async status(signal?:AbortSignal){return parseProductionMaxStatus(await request('status',undefined,signal),options.ownerId)},
  async history(signal?:AbortSignal){return parseProductionTutorHistory(await request('history',undefined,signal),options.ownerId)},
  async generate(raw:MaxTutorRequest,signal?:AbortSignal){const expected=validateTutorRequest(raw),value=await request('generate',expected,signal);if(!object(value)||!fields(value,['status','bundle','replayed','run'])||typeof value.replayed!=='boolean')return fail();const run=parseProductionTutorRun(value.run);if(JSON.stringify(run.request)!==JSON.stringify(expected)||JSON.stringify(run.bundle)!==JSON.stringify(validateTutorBundle(value.bundle,expected)))return fail();return {run,replayed:value.replayed}},
  async progress(run:ProductionTutorRun,progress:TutorProgress,signal?:AbortSignal){const safe=validateProductionProgress(progress,run),value=await request('progress',{runId:run.id,progress:safe,expectedRevision:run.revision},signal);if(!object(value)||!fields(value,['status','run']))return fail();const result=parseProductionTutorRun(value.run);if(result.id!==run.id||result.revision<run.revision||JSON.stringify(result.request)!==JSON.stringify(run.request))return fail();return result},
 }
}
