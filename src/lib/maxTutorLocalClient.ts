import {normalizeTutorScope,tutorQuizResult,validateTutorRequest,type MaxTutorRequest,type MaxTutorScope,type MaxTutorTransport,type TutorMode,type TutorRun,type TutorSource} from './maxTutor'

export const MAX_TUTOR_LOCAL_MODELS=['gpt-6.1-sol','gpt-5.4-mini','gpt-5.4'] as const
export type MaxTutorLocalModel=typeof MAX_TUTOR_LOCAL_MODELS[number]
export type MaxTutorLocalStatus={status:'ready';connected:boolean;model:MaxTutorLocalModel;scope:MaxTutorScope;csrfToken:string;budget:{limitUsd:number;spentUsd:number;reservedUsd:number;remainingUsd:number};models:{id:MaxTutorLocalModel;label:string}[];localOnly:true;estimatedAccounting:true}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const fields=(v:Record<string,unknown>,names:string[])=>Object.keys(v).length===names.length&&names.every(k=>Object.prototype.hasOwnProperty.call(v,k))
const model=(v:unknown):v is MaxTutorLocalModel=>MAX_TUTOR_LOCAL_MODELS.some(m=>m===v)
const finite=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0
const MESSAGES:Record<string,string>={not_configured:'Спочатку підключи модель у локальних налаштуваннях.',quota_exhausted:'Локальний ліміт витрат вичерпано. Нових платних запитів не надсилаємо.',pending:'Цей запит ще виконується. Дочекайся результату без повторного надсилання.',conflict:'Цей запит уже використано. Створи новий розбір.',refused:'Модель не змогла безпечно опрацювати цей матеріал. Зміни запит або джерело.',cancelled:'Запит зупинено. Збережені матеріали залишилися.',timeout:'Модель не встигла відповісти. Перевір ліміт перед повторною спробою.',invalid_request:'Перевір запит і обрані власні джерела.',identity_changed:'Локальну сесію змінено. Онови підключення.',forbidden:'Ця дія недоступна в поточній локальній сесії.',generation_failed:'Не вдалося отримати відповідь моделі. Перевір підключення і доступний ліміт.'}
export class MaxTutorLocalClientError extends Error{constructor(public code:string){super(MESSAGES[code]||'Не вдалося виконати локальний запит. Збережені матеріали не змінено.');this.name='MaxTutorLocalClientError'}}
export function parseMaxTutorLocalStatus(value:unknown):MaxTutorLocalStatus{
 if(!object(value)||!fields(value,['status','connected','model','scope','csrfToken','budget','models','localOnly','estimatedAccounting'])||value.status!=='ready'||typeof value.connected!=='boolean'||!model(value.model)||value.localOnly!==true||value.estimatedAccounting!==true)throw new MaxTutorLocalClientError('invalid_response')
 const scope=normalizeTutorScope(value.scope),budget=value.budget
 if(!scope||typeof value.csrfToken!=='string'||!/^[A-Za-z0-9_-]{24,160}$/.test(value.csrfToken)||!object(budget)||!fields(budget,['limitUsd','spentUsd','reservedUsd','remainingUsd'])||![budget.limitUsd,budget.spentUsd,budget.reservedUsd,budget.remainingUsd].every(finite)||Number(budget.limitUsd)>6||!Array.isArray(value.models)||value.models.length<1||value.models.length>3)throw new MaxTutorLocalClientError('invalid_response')
 const models=value.models.map(item=>{if(!object(item)||!fields(item,['id','label'])||!model(item.id)||typeof item.label!=='string'||!item.label.trim()||item.label.length>80||/[<>\u0000-\u001f]/.test(item.label))throw new MaxTutorLocalClientError('invalid_response');return {id:item.id,label:item.label}})
 if(new Set(models.map(m=>m.id)).size!==models.length||!models.some(m=>m.id===value.model))throw new MaxTutorLocalClientError('invalid_response')
 return {status:'ready',connected:value.connected,model:value.model,scope,csrfToken:value.csrfToken,budget:budget as MaxTutorLocalStatus['budget'],models,localOnly:true,estimatedAccounting:true}
}
async function readJson(response:Response,maximum=600_000):Promise<unknown>{
 if(response.redirected||!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type')||'')||!response.body)throw new MaxTutorLocalClientError('invalid_response')
 const declared=response.headers.get('content-length');if(declared&&(!/^\d+$/.test(declared)||Number(declared)>maximum))throw new MaxTutorLocalClientError('invalid_response')
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>maximum)throw new MaxTutorLocalClientError('invalid_response');chunks.push(part.value)}}finally{void reader.cancel().catch(()=>{});reader.releaseLock()}
 const result=new Uint8Array(size);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result))}catch{throw new MaxTutorLocalClientError('invalid_response')}
}
/** The loopback server is the sole provider client. Secrets never belong to a tutor transport or browser storage. */
export function createMaxTutorLocalClient(fetcher:typeof fetch=fetch){
 let current:MaxTutorLocalStatus|null=null
 async function request(path:'status'|'configure'|'disconnect'|'run',body?:unknown,signal?:AbortSignal){
  if(path!=='status'&&!current)throw new MaxTutorLocalClientError('identity_changed')
  let response:Response;try{response=await fetcher(`/api/local-max/${path}`,{method:path==='status'?'GET':'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{Accept:'application/json',...(path==='status'?{}:{'Content-Type':'application/json','X-Xelay-CSRF':current!.csrfToken})},...(path==='status'?{}:{body:JSON.stringify(body)}),signal})}catch(error){if(signal?.aborted)throw new MaxTutorLocalClientError('cancelled');throw new MaxTutorLocalClientError('unavailable')}
  let data:unknown;try{data=await readJson(response,path==='run'?600_000:8_000)}catch(error){if(error instanceof MaxTutorLocalClientError)throw error;throw new MaxTutorLocalClientError(signal?.aborted?'cancelled':'unavailable')}
  if(!response.ok||!object(data)||data.status!=='ready')throw new MaxTutorLocalClientError(object(data)&&typeof data.status==='string'?data.status:'unavailable')
  return data
 }
 return {
  async status(signal?:AbortSignal){current=parseMaxTutorLocalStatus(await request('status',undefined,signal));return current},
  async configure(value:{apiKey:string;model:MaxTutorLocalModel;limitUsd:number},signal?:AbortSignal){if(typeof value.apiKey!=='string'||value.apiKey.length<1||value.apiKey.length>300||/\s/.test(value.apiKey)||!model(value.model)||!Number.isFinite(value.limitUsd)||value.limitUsd<.1||value.limitUsd>6)throw new MaxTutorLocalClientError('invalid_request');current=parseMaxTutorLocalStatus(await request('configure',{apiKey:value.apiKey,model:value.model,limitUsd:value.limitUsd},signal));return current},
  async disconnect(signal?:AbortSignal){current=parseMaxTutorLocalStatus(await request('disconnect',{},signal));return current},
  transport:((raw,{signal})=>{const input=validateTutorRequest(raw);if(!current?.connected)throw new MaxTutorLocalClientError('not_configured');return request('run',input,signal).then(data=>{if(!object(data)||!['status','bundle','replayed'].every(k=>Object.prototype.hasOwnProperty.call(data,k))||Object.keys(data).length!==3||typeof data.replayed!=='boolean')throw new MaxTutorLocalClientError('invalid_response');return data.bundle})}) as MaxTutorTransport,
 }
}

export type TutorLocalDraft={version:1;prompt:string;note:string;mode:TutorMode;selected:string[];completedRuns:string[]}
export function parseTutorLocalDraft(raw:string|null):TutorLocalDraft{
 const empty:TutorLocalDraft={version:1,prompt:'',note:'',mode:'explain',selected:[],completedRuns:[]};if(!raw||raw.length>32_000)return empty
 try{const value=JSON.parse(raw);if(!object(value)||!fields(value,['version','prompt','note','mode','selected','completedRuns'])||value.version!==1||typeof value.prompt!=='string'||value.prompt.length>2400||typeof value.note!=='string'||value.note.length>12000||!['explain','quiz','cards','plan','math'].includes(String(value.mode))||!Array.isArray(value.selected)||value.selected.length>3||value.selected.some(id=>typeof id!=='string'||id.length>110)||!Array.isArray(value.completedRuns)||value.completedRuns.length>12||value.completedRuns.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id)))return empty;return {version:1,prompt:value.prompt,note:value.note,mode:value.mode as TutorMode,selected:[...new Set(value.selected)] as string[],completedRuns:[...new Set(value.completedRuns)] as string[]}}catch{return empty}
}
/** Capture ids may contain punctuation. Request-local sequential IDs are unambiguous and do not disclose storage identifiers. */
export function makeTutorOwnSources(note:string,captures:readonly {id:string;sourceTitle:string;quote:string;page:number|null}[],selected:readonly string[]):TutorSource[]{
 const sources:TutorSource[]=[];if(note.trim())sources.push({id:'own-note',title:'Моя навчальна нотатка',text:note.trim(),page:null,kind:'own_note'});for(const capture of captures.filter(c=>selected.includes(c.id)))sources.push({id:`excerpt-${sources.length+1}`,title:capture.sourceTitle,text:capture.quote,page:capture.page,kind:'own_excerpt'});return sources
}
/** Recognize explicit creation requests only in the user's prompt, never in uploaded source content. */
export function inferTutorLocalMode(prompt:string,fallback:TutorMode):TutorMode{
 const text=prompt.trim().slice(0,2400).replace(/\s+/g,' ')
 // Explicit explanation and negation take precedence over nouns mentioned as subject matter.
 const opening=text.replace(/^(?:будь ласка|пожалуйста|please)[,\s]+/iu,'')
 if(/^(?:(?:чи\s+)?(?:можеш|можете|можешь|можна|можно|can you|could you)\s+(?:(?:мені|мне|будь ласка|пожалуйста)\s+)?)?(?:поясни(?:ти|ть|те)?|поясніть|объясни(?:ть|те)?|розкажи|розкажіть|расскажи|расскажите|скажи|explain|tell me|що таке|что такое|як |как |why |what is )/iu.test(opening))return 'explain'
 const sentences=text.split(/[.!?\n]+/).filter(part=>!/(?:не\s+(?:треба|потріб|нужно|делай|створ|зроб|создав|роби)|без\s+(?:тест|карт|план)|do not|don't)/iu.test(part))
 const create='(?:створи|створити|зроби|зробити|підготуй|згенеруй|сделай|создай|сгенерируй|подготовь|generate|create|make)'
 for(const part of sentences){
  if(new RegExp(create+'[^.!?\\n]{0,70}(?:тест|вікторин|викторин|quiz|practice test)','iu').test(part))return 'quiz'
  if(new RegExp(create+'[^.!?\\n]{0,70}(?:картк|карточк|flashcards)','iu').test(part))return 'cards'
  if(new RegExp('(?:'+create+'|склади|составь|build)[^.!?\\n]{0,70}(?:план|plan)','iu').test(part))return 'plan'
  if(/^(?:\s*)(?:розв[’'ʼ]?яжи|розв[’'ʼ]?язати|реши|решить|solve)\s/iu.test(part))return 'math'
 }
 return fallback
}
/** Explicit personal follow-up only: verified choices from this generated training, never another block or official test. */
export function buildTutorPersonalFollowUp(run:TutorRun,next:TutorMode):string{
 const start:Record<TutorMode,string>={cards:'Створи картки для повторення за цими самими обраними джерелами й допоможи розібрати мої помилки.',quiz:'Створи новий особистий тренувальний тест за цими самими обраними джерелами з увагою до моїх помилок.',explain:'Поясни матеріал цих самих обраних джерел і чому мій вибір у тренуванні відрізняється від них.',plan:'Склади реалістичний план підготовки за цими самими обраними джерелами.',math:'Розв’яжи навчальну задачу за цими самими обраними джерелами з поясненням кроків.'}
 const introduction=start[next]
 if(run.demo||!['explain','quiz','cards'].includes(next)||run.bundle.questions.length===0)return introduction
 const result=tutorQuizResult(run.bundle,run.progress)
 if(result.answered===0)return introduction
 const clip=(text:string,maximum:number)=>text.replace(/\s+/g,' ').trim().slice(0,maximum)
 const details=result.mistakes.slice(0,3).map((id,index)=>{
  const question=run.bundle.questions.find(q=>q.id===id)!,chosen=run.progress.answers[id]
  return `Помилка ${index+1}. Запитання: ${clip(question.text,180)}\nМоя перевірена відповідь: ${clip(question.options[chosen],180)}\nВідповідь за згенерованим ключем: ${clip(question.options[question.correctIndex],180)}`
 })
 const warning='Це мій особистий тест, створений моделлю, не офіційне оцінювання. Перевір згенерований ключ за обраними джерелами: модель може помилятися. Поясни логіку мого вибору та виправлення, а не лише повторюй ключ.'
 return [introduction,`Результат за згенерованим ключем: ${result.correct} правильних із ${result.total} запитань; перевірено ${result.answered}.`,...details,warning].join('\n\n').slice(0,2400)
}

/** A context snapshot is created only by an explicit source/follow-up action, never by viewing history. */
export type TutorSelectedContextAction={type:'follow_up';request:MaxTutorRequest}|{type:'generated'|'history'|'clear'}
export function advanceTutorSelectedContext(current:TutorSource[]|null,action:TutorSelectedContextAction):TutorSource[]|null{
 if(action.type==='clear')return null
 if(action.type==='follow_up')return validateTutorRequest(action.request).sources.map(source=>({...source}))
 return current
}
