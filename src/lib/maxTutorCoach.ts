export type CoachScope={userId:string;sessionId:string}
export type CoachBlock='overview'|'assistant'|'research'|'projects'|'academic'|'session'
export type CoachAction='assistant'|'quiz'|'cards'|'plan'|'research'|'mistakes'|'session'
export type CoachMode='explain'|'quiz'|'cards'|'plan'|'math'
export type CoachEvent=
 |{type:'block';block:CoachBlock}
 |{type:'sources';count:number}
 |{type:'ready';runId:string;mode:CoachMode}
 |{type:'quiz';runId:string;total:number;answered:number;correct:number;weakQuestionIds?:string[]}
 |{type:'project';projectId:string;done:number;total:number}
 |{type:'plan';planId:string;done:number;total:number;dueAt?:number}
export type CoachMessage={id:string;title:string;body:string;action:CoachAction;actionLabel:string;createdAt:number}
export type CoachReminder={id:string;dueAt:number;message:CoachMessage}
export type CoachState={version:1;ownerId:string;sessionId:string;enabled:boolean;pausedUntil:number;lastNudgeAt:number;seen:Record<string,number>;messages:CoachMessage[];reminders:CoachReminder[]}
export const MAX_TUTOR_COACH_EVENT='xelay:max-tutor:aggregate-event:v1'
export const COACH_BLOCKS:Record<CoachBlock,string>={overview:'Моя студія',assistant:'Мій помічник',research:'Джерела',projects:'Великі роботи',academic:'Сценарії балів',session:'Моя сесія'}
const ACTIONS:CoachAction[]=['assistant','quiz','cards','plan','research','mistakes','session']
const MODES:CoachMode[]=['explain','quiz','cards','plan','math']
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const exact=(v:Record<string,unknown>,allowed:string[],required=allowed)=>Object.keys(v).every(k=>allowed.includes(k))&&required.every(k=>Object.prototype.hasOwnProperty.call(v,k))
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)
const integer=(v:unknown,max=1_000_000):v is number=>Number.isSafeInteger(v)&&Number(v)>=0&&Number(v)<=max
const timestamp=(v:unknown):v is number=>integer(v,9_000_000_000_000)
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\u0000-\u001f\u007f]/.test(v)&&!/<\/?[a-z][^>]*>/i.test(v)
const key=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,220}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)
export function normalizeCoachScope(value:unknown):CoachScope|null{if(!object(value)||!exact(value,['userId','sessionId'])||!identifier(value.userId)||!identifier(value.sessionId))return null;return {userId:value.userId,sessionId:value.sessionId}}
export function sameCoachScope(a:unknown,b:unknown):boolean{const x=normalizeCoachScope(a),y=normalizeCoachScope(b);return !!x&&!!y&&x.userId===y.userId&&x.sessionId===y.sessionId}
export function coachStorageKey(scope:CoachScope):string{const s=normalizeCoachScope(scope);if(!s)throw Error('Invalid coach scope');return `xelay:local-max-coach:owner:${s.userId}:v1`}
export function createCoachState(scope:CoachScope):CoachState{const s=normalizeCoachScope(scope);if(!s)throw Error('Invalid coach scope');return {version:1,ownerId:s.userId,sessionId:s.sessionId,enabled:false,pausedUntil:0,lastNudgeAt:0,seen:{},messages:[],reminders:[]}}
export function normalizeCoachEvent(value:unknown):CoachEvent|null{
 if(!object(value))return null
 if(value.type==='block'&&exact(value,['type','block'])&&typeof value.block==='string'&&Object.prototype.hasOwnProperty.call(COACH_BLOCKS,value.block))return {type:'block',block:value.block as CoachBlock}
 if(value.type==='sources'&&exact(value,['type','count'])&&integer(value.count,100))return {type:'sources',count:value.count}
 if(value.type==='ready'&&exact(value,['type','runId','mode'])&&identifier(value.runId)&&MODES.includes(value.mode as CoachMode))return {type:'ready',runId:value.runId,mode:value.mode as CoachMode}
 if(value.type==='quiz'&&exact(value,['type','runId','total','answered','correct','weakQuestionIds'],['type','runId','total','answered','correct'])&&identifier(value.runId)&&integer(value.total,100)&&value.total>0&&integer(value.answered,100)&&value.answered<=value.total&&integer(value.correct,100)&&value.correct<=value.answered){
  if(value.weakQuestionIds!==undefined&&(!Array.isArray(value.weakQuestionIds)||value.weakQuestionIds.length>100||value.weakQuestionIds.some(x=>!identifier(x))||new Set(value.weakQuestionIds).size!==value.weakQuestionIds.length||value.weakQuestionIds.length>value.answered-value.correct))return null
  return {type:'quiz',runId:value.runId,total:value.total,answered:value.answered,correct:value.correct,...(value.weakQuestionIds===undefined?{}:{weakQuestionIds:[...value.weakQuestionIds] as string[]})}
 }
 if((value.type==='project'||value.type==='plan')&&exact(value,value.type==='project'?['type','projectId','done','total']:['type','planId','done','total','dueAt'],value.type==='project'?['type','projectId','done','total']:['type','planId','done','total'])&&identifier(value[value.type==='project'?'projectId':'planId'])&&integer(value.total,200)&&value.total>0&&integer(value.done,200)&&value.done<=value.total){
  if(value.type==='project')return {type:'project',projectId:value.projectId as string,done:value.done,total:value.total}
  if(value.dueAt!==undefined&&!timestamp(value.dueAt))return null
  return {type:'plan',planId:value.planId as string,done:value.done,total:value.total,...(value.dueAt===undefined?{}:{dueAt:value.dueAt as number})}
 }
 return null
}
function parseMessage(value:unknown):CoachMessage|null{if(!object(value)||!exact(value,['id','title','body','action','actionLabel','createdAt'])||!key(value.id)||!text(value.title,160)||!text(value.body,500)||!ACTIONS.includes(value.action as CoachAction)||!text(value.actionLabel,100)||!timestamp(value.createdAt))return null;return {id:value.id,title:value.title,body:value.body,action:value.action as CoachAction,actionLabel:value.actionLabel,createdAt:value.createdAt}}
export function parseCoachState(raw:string|null,scope:CoachScope,now=Date.now()):CoachState{
 const empty=createCoachState(scope);if(!raw||raw.length>50000||!timestamp(now))return empty
 try{const v:unknown=JSON.parse(raw);if(!object(v)||!exact(v,['version','ownerId','sessionId','enabled','pausedUntil','lastNudgeAt','seen','messages','reminders'])||v.version!==1||v.ownerId!==scope.userId||v.sessionId!==scope.sessionId||typeof v.enabled!=='boolean'||!timestamp(v.pausedUntil)||v.pausedUntil>now+24*60*60*1000||!timestamp(v.lastNudgeAt)||v.lastNudgeAt>now+60000||!object(v.seen)||Object.keys(v.seen).length>80||!Array.isArray(v.messages)||v.messages.length>4||!Array.isArray(v.reminders)||v.reminders.length>6)return empty
 const seen:Record<string,number>={};for(const [k,t]of Object.entries(v.seen))if(key(k)&&timestamp(t)&&t<=now+60000)seen[k]=t
 const messages:CoachMessage[]=[];for(const value of v.messages){const m=parseMessage(value);if(m&&m.createdAt<=now+60000&&m.createdAt>=now-24*60*60*1000&&!messages.some(x=>x.id===m.id))messages.push(m)}
 const reminders:CoachReminder[]=[];for(const item of v.reminders){if(!object(item)||!exact(item,['id','dueAt','message'])||!key(item.id)||!timestamp(item.dueAt)||item.dueAt>now+7*24*60*60*1000||item.dueAt<now-24*60*60*1000)continue;const m=parseMessage(item.message);if(m&&!reminders.some(x=>x.id===item.id))reminders.push({id:item.id,dueAt:item.dueAt,message:m})}
 return {...empty,enabled:v.enabled,pausedUntil:v.pausedUntil,lastNudgeAt:v.lastNudgeAt,seen,messages:v.enabled?messages:[],reminders:v.enabled?reminders:[]}
 }catch{return empty}
}
export function storeCoachState(state:CoachState):string{return JSON.stringify(state)}
export function setCoachEnabled(state:CoachState,enabled:boolean):CoachState{return {...state,enabled,pausedUntil:0,messages:enabled?state.messages:[],reminders:enabled?state.reminders:[]}}
export function pauseCoach(state:CoachState,now=Date.now(),minutes=60):CoachState{if(!timestamp(now)||!integer(minutes,1440))return state;return {...state,pausedUntil:now+minutes*60000,messages:[]}}
export function dismissCoachMessage(state:CoachState,id:string):CoachState{return {...state,messages:state.messages.filter(m=>m.id!==id)}}
export function snoozeCoachMessage(state:CoachState,id:string,now=Date.now(),minutes=10):CoachState{
 if(!state.enabled||!timestamp(now)||!integer(minutes,1440)||minutes<1)return state
 const message=state.messages.find(m=>m.id===id);if(!message)return state
 return {...state,messages:state.messages.filter(m=>m.id!==id),reminders:[...state.reminders.filter(r=>r.id!==id),{id,dueAt:now+minutes*60000,message}].slice(-6)}
}
function remember(state:CoachState,id:string,now:number):CoachState{const seen=Object.fromEntries([...Object.entries(state.seen).filter(([k])=>k!==id),[id,now]].sort((a,b)=>Number(a[1])-Number(b[1])).slice(-80));return {...state,seen}}
function enqueue(state:CoachState,message:CoachMessage,now:number,important=false):CoachState{
 if(!state.enabled||state.pausedUntil>now||state.seen[message.id]!==undefined||!important&&state.lastNudgeAt>0&&now-state.lastNudgeAt<90000)return state
 const next=remember(state,message.id,now),messages=[...next.messages.filter(m=>m.id!==message.id),message].slice(-4)
 return {...next,messages,lastNudgeAt:important?state.lastNudgeAt:now}
}
function pruneMessages(state:CoachState,keep:(id:string)=>boolean):CoachState{const messages=state.messages.filter(m=>keep(m.id)),reminders=state.reminders.filter(r=>keep(r.id));return messages.length===state.messages.length&&reminders.length===state.reminders.length?state:{...state,messages,reminders}}
const tips:Record<CoachBlock,{title:string;body:string;action:CoachAction;actionLabel:string}>={
 overview:{title:'Помічник може йти поруч.',body:'Обери власний матеріал у «Джерелах», а потім попроси пояснення, тест або картки. Текст надсилається моделі лише після твого запиту.',action:'research',actionLabel:'До власних джерел'},
 assistant:{title:'Твоя мета визначає наступний крок.',body:'Попроси створити тест за вибраним матеріалом. Після відповідей тут з’явиться підсумок, а складні запитання можна буде повторити.',action:'quiz',actionLabel:'Підготувати тест'},
 research:{title:'З джерела — у власне розуміння.',body:'Збережи потрібну виписку з номером сторінки й обери її для помічника. Перегляд сторінки сам по собі не передає текст моделі.',action:'assistant',actionLabel:'До помічника'},
 projects:{title:'Розклади велику роботу на кроки.',body:'Помічник може допомогти з планом за матеріалом, який ти сам обереш. Чернетки, версії й джерела залишаються під твоїм керуванням.',action:'plan',actionLabel:'Підготувати план'},
 academic:{title:'Сценарій допомагає порівняти припущення.',body:'Це твоя особиста модель балів, а не оцінка викладача. Для підготовки до складного предмета можна створити власне тренування.',action:'quiz',actionLabel:'До власної практики'},
 session:{title:'Невеликий крок легше виконати сьогодні.',body:'Звір обсяг підготовки з доступним часом. Можна попросити помічника скласти план за вибраними матеріалами.',action:'plan',actionLabel:'Підготувати план'},
}
export function reduceCoachEvent(state:CoachState,raw:unknown,now=Date.now()):CoachState{
 const e=normalizeCoachEvent(raw);if(!e||!timestamp(now)||!state.enabled)return state
 const emit=(id:string,title:string,body:string,action:CoachAction,actionLabel:string,important=false)=>enqueue(state,{id,title,body,action,actionLabel,createdAt:now},now,important)
 if(e.type==='block'){const t=tips[e.block];return emit(`block:${e.block}`,t.title,t.body,t.action,t.actionLabel)}
 if(e.type==='sources'){state=pruneMessages(state,id=>!id.startsWith('sources:')||id===`sources:${e.count}`);if(!e.count)return state;return emit(`sources:${e.count}`,'Матеріал уже в твоїй добірці.',`У добірці виписок: ${e.count}. Обери потрібні в помічнику та вкажи, що зробити: пояснення, тест, картки чи план. Без твого запиту нічого не надсилається.`, 'assistant','Обрати матеріал')}
 if(e.type==='ready'){const titles:Record<CoachMode,string>={explain:'Пояснення готове.',quiz:'Твій тренувальний тест готовий.',cards:'Картки для повторення готові.',plan:'План підготовки готовий.',math:'Розбір задачі готовий.'};const actions:Record<CoachMode,CoachAction>={explain:'assistant',quiz:'quiz',cards:'cards',plan:'plan',math:'assistant'};return emit(`ready:${e.runId}:${e.mode}`,titles[e.mode],'Відкрий створений матеріал і звір важливі твердження з джерелами. Результат особистого тренування не потрапляє до журналу викладача.',actions[e.mode],'Відкрити матеріал',true)}
 if(e.type==='quiz'){
  const currentId=e.answered===e.total?`quiz:${e.runId}:done:${e.correct}`:`quiz:${e.runId}:partial:${e.answered}`;state=pruneMessages(state,id=>!id.startsWith(`quiz:${e.runId}:`)||id===currentId)
  if(!e.answered)return state
  if(e.answered===e.total){const wrong=e.total-e.correct;return emit(`quiz:${e.runId}:done:${e.correct}`,wrong?'Тест завершено. Розберімо результат.':'Тест пройдено без помилок.',`Правильно ${e.correct} із ${e.total}. ${wrong?`Запитань для повторення: ${wrong}. У розборі є пояснення відповідей і посилання на джерела.`:'Можна закріпити матеріал картками або повернутися до джерел.'}`,wrong?'mistakes':'cards',wrong?'Розібрати помилки':'До карток',true)}
  if(e.answered-e.correct>0&&e.answered>=2)return emit(`quiz:${e.runId}:partial:${e.answered}`,'Є запитання, до яких варто повернутися.',`Опрацьовано ${e.answered} із ${e.total}, правильно ${e.correct}. Продовжуй у своєму темпі: після завершення можна повторити тільки помилки.`, 'quiz','Продовжити тест')
  return state
 }
 if(e.type==='project'){if(e.done!==e.total)return state;return emit(`project:${e.projectId}:done`,'Позначені кроки роботи завершено.',`Виконано ${e.done} із ${e.total} позначених кроків. Перед здачею звір текст, посилання та вимоги викладача. Ця позначка не означає перевірку якості роботи.`, 'research','Звірити джерела')}
 if(e.type==='plan'){
  const prefix=`plan:${e.planId}:due:`;if(e.done===e.total)state=pruneMessages(state,id=>!id.startsWith(prefix))
  if(e.done===e.total)return emit(`plan:${e.planId}:done`,'Кроки цього плану виконано.',`Ти позначив ${e.done} із ${e.total} кроків. Короткий тест допоможе перевірити, що саме вдалося запам’ятати.`, 'quiz','Перевірити себе',true)
  if(e.dueAt!==undefined){const id=`plan:${e.planId}:due:${e.done}:${e.total}`;if(e.dueAt>now+7*24*60*60*1000||state.seen[id]!==undefined)return state;const message:CoachMessage={id,title:'Час повернутися до свого плану.',body:`У плані позначено ${e.done} із ${e.total} кроків. Відкрий його й обери наступну невелику дію. Нагадування працює, поки цей простір відкритий.`,action:e.planId.startsWith('session-')?'session':'plan',actionLabel:'Відкрити план',createdAt:now};const existing=state.reminders.find(r=>r.id===id),dueAt=existing?Math.min(existing.dueAt,e.dueAt):e.dueAt;return advanceCoach({...state,reminders:[...state.reminders.filter(r=>!r.id.startsWith(prefix)),{id,dueAt,message}].slice(-6)},now)}
 }
 return state
}
export function advanceCoach(state:CoachState,now=Date.now()):CoachState{
 if(!timestamp(now)||!state.enabled||state.pausedUntil>now)return state
 const due=state.reminders.filter(r=>r.dueAt<=now);if(!due.length)return state
 let next:CoachState={...state,reminders:state.reminders.filter(r=>r.dueAt>now)}
 for(const reminder of due){const seen={...next.seen};delete seen[reminder.id];next=enqueue({...next,seen},{...reminder.message,createdAt:now},now,true)}
 return next
}
/** Only typed aggregate events, scoped to this local owner/session. No source text or page inspection. */
export function sendMaxTutorCoachEvent(scope:unknown,event:unknown):boolean{const safe=normalizeCoachScope(scope),e=normalizeCoachEvent(event);if(!safe||!e||typeof window==='undefined'||typeof CustomEvent!=='function')return false;window.dispatchEvent(new CustomEvent(MAX_TUTOR_COACH_EVENT,{detail:{scope:safe,event:e}}));return true}
