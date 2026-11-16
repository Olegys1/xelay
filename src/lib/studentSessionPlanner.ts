export type PersonalExam = {id:string;subject:string;date:string;topics:string[];remainingMinutes:number;priority:'normal'|'high'}
export type RevisionSession = {id:string;examId:string;subject:string;date:string;minutes:number;topic:string}
export type SessionPlannerState = {version:1;dailyMinutes:number;exams:PersonalExam[];completed:string[];completedSessions?:RevisionSession[]}
export const SESSION_PLANNER_KEY='xelay:local-student-session-planner:synthetic:v1'
const dayMs=86_400_000
export function validSessionDay(value:unknown):value is string {return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T12:00:00Z'))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value}
export function shiftSessionDay(day:string,offset:number):string {if(!validSessionDay(day)||!Number.isInteger(offset)||Math.abs(offset)>3650)throw new Error('Некоректна дата');return new Date(Date.parse(day+'T12:00:00Z')+offset*dayMs).toISOString().slice(0,10)}
const safeId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,60}$/.test(value)&&!['constructor','prototype','__proto__'].includes(value)
const cleanText=(value:unknown,max:number)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,max):''
export function normalizePersonalExam(value:unknown):PersonalExam|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const v=value as Record<string,unknown>
 if(!safeId(v.id)||!validSessionDay(v.date)||typeof v.remainingMinutes!=='number'||!Number.isSafeInteger(v.remainingMinutes)||v.remainingMinutes<0||v.remainingMinutes>10000)return null
 const subject=cleanText(v.subject,100);if(!subject)return null
 const topics=Array.isArray(v.topics)?[...new Set(v.topics.map(x=>cleanText(x,100)).filter(Boolean))].slice(0,20):[]
 return {id:v.id,subject,date:v.date,topics,remainingMinutes:v.remainingMinutes,priority:v.priority==='high'?'high':'normal'}
}
/** A completion records the actual planned minutes, so later date changes cannot invent more work. */
export function normalizeRevisionSession(value:unknown,exams:readonly PersonalExam[]):RevisionSession|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const v=value as Record<string,unknown>
 if(!safeId(v.examId)||!exams.some(e=>e.id===v.examId)||!validSessionDay(v.date)||v.id!==`${v.examId}:${v.date}`||!Number.isSafeInteger(v.minutes)||Number(v.minutes)<1||Number(v.minutes)>240)return null
 const subject=cleanText(v.subject,100),topic=cleanText(v.topic,100);if(!subject||!topic)return null
 return {id:v.id as string,examId:v.examId,subject,date:v.date,minutes:Number(v.minutes),topic}
}
function completionSnapshots(state:SessionPlannerState):RevisionSession[] {
 const marked=new Set(state.completed),seen=new Set<string>(),result:RevisionSession[]=[]
 for(const raw of (state.completedSessions||[]).slice(0,400)){const snapshot=normalizeRevisionSession(raw,state.exams);if(snapshot&&marked.has(snapshot.id)&&!seen.has(snapshot.id)){seen.add(snapshot.id);result.push(snapshot)}}
 return result
}
export function initialSessionPlanner(today:string,empty=false):SessionPlannerState {
 if(empty)return {version:1,dailyMinutes:60,exams:[],completed:[],completedSessions:[]}
 return {version:1,dailyMinutes:60,completed:[],completedSessions:[],exams:[
  {id:'exam-micro',subject:'Мікроекономіка',date:shiftSessionDay(today,8),topics:['Попит і пропозиція','Рівновага','Еластичність'],remainingMinutes:150,priority:'high'},
  {id:'exam-management',subject:'Менеджмент',date:shiftSessionDay(today,12),topics:['Функції менеджменту','Комунікація','Мотивація'],remainingMinutes:180,priority:'normal'},
  {id:'exam-statistics',subject:'Статистика',date:shiftSessionDay(today,15),topics:['Середні величини','Дисперсія','Кореляція'],remainingMinutes:120,priority:'normal'},
 ]}
}
export function parseSessionPlanner(raw:string|null,today:string,empty=false):SessionPlannerState {
 const fallback=initialSessionPlanner(today,empty);if(!raw||raw.length>100000)return fallback
 try{const v=JSON.parse(raw);if(!v||v.version!==1||!Array.isArray(v.exams))return fallback
 const exams:PersonalExam[]=[];const seen=new Set<string>();for(const item of v.exams.slice(0,20)){const exam=normalizePersonalExam(item);if(exam&&!seen.has(exam.id)){exams.push(exam);seen.add(exam.id)}}
 const knownCompletion=(id:unknown):id is string=>typeof id==='string'&&exams.some(e=>id.startsWith(e.id+':')&&validSessionDay(id.slice(e.id.length+1)))
 const state:SessionPlannerState={version:1,exams,dailyMinutes:Number.isSafeInteger(v.dailyMinutes)?Math.max(15,Math.min(240,v.dailyMinutes)):60,completed:Array.isArray(v.completed)?[...new Set(v.completed.filter(knownCompletion))].slice(0,400) as string[]:[],completedSessions:Array.isArray(v.completedSessions)?v.completedSessions:[]}
 state.completedSessions=completionSnapshots(state)
 return state
 }catch{return fallback}
}
/** Deterministic local allocation. It is a workload estimate, never a grade prediction. */
export function buildRevisionWeek(state:SessionPlannerState,today:string) {
 if(!validSessionDay(today)||!Number.isInteger(state.dailyMinutes)||state.dailyMinutes<15||state.dailyMinutes>240)throw new Error('Перевірте денний час')
 const exams=state.exams.map(normalizePersonalExam).filter((x):x is PersonalExam=>!!x).filter(e=>e.date>today).sort((a,b)=>a.date.localeCompare(b.date)||Number(b.priority==='high')-Number(a.priority==='high')||a.id.localeCompare(b.id))
 const unique=[...new Map(exams.map(e=>[e.id,e])).values()]
 const completed=completionSnapshots(state),completedIds=new Set(completed.map(s=>s.id)),end=shiftSessionDay(today,6)
 const outstanding=new Map(unique.map(e=>[e.id,Math.max(0,e.remainingMinutes-completed.filter(s=>s.examId===e.id).reduce((n,s)=>n+s.minutes,0))]))
 const remaining=new Map(outstanding);const sessions:RevisionSession[]=[]
 for(let day=0;day<7;day++){
  const date=shiftSessionDay(today,day),done=completed.filter(s=>s.date===date);sessions.push(...done);let capacity=Math.max(0,state.dailyMinutes-done.reduce((n,s)=>n+s.minutes,0))
  for(const exam of unique){if(date>=exam.date||capacity<1)continue
   if(completedIds.has(`${exam.id}:${date}`))continue
   const left=remaining.get(exam.id)||0;if(left<=0)continue
   const daysLeft=Math.max(1,Math.round((Date.parse(exam.date+'T12:00:00Z')-Date.parse(date+'T12:00:00Z'))/dayMs))
   const attention=exam.priority==='high'?1.25:1
   const minutes=Math.min(capacity,left,Math.max(5,Math.ceil(left/daysLeft*attention/5)*5));if(minutes<=0)continue
   const topic=exam.topics.length?exam.topics[day%exam.topics.length]:'Повторення й власна практика'
   sessions.push({id:`${exam.id}:${date}`,examId:exam.id,subject:exam.subject,date,minutes,topic});capacity-=minutes;remaining.set(exam.id,left-minutes)
  }
 }
 const overdue=state.exams.filter(e=>validSessionDay(e.date)&&e.date<=today&&e.remainingMinutes>completed.filter(s=>s.examId===e.id).reduce((n,s)=>n+s.minutes,0))
 const availableBefore=(date:string)=>Math.max(0,Math.round((Date.parse(date+'T12:00:00Z')-Date.parse(today+'T12:00:00Z'))/dayMs)*state.dailyMinutes-completed.filter(s=>s.date>=today&&s.date<date).reduce((n,s)=>n+s.minutes,0))
 const warnings=unique.filter(e=>(outstanding.get(e.id)||0)>availableBefore(e.date)).map(e=>`${e.subject}: запланованих хвилин більше, ніж доступно до дати роботи.`)
 // EDF demand prefixes catch combined overload even if each subject alone would fit.
 for(const exam of unique){const prefix=unique.filter(e=>e.date<=exam.date);const demand=prefix.reduce((n,e)=>n+(outstanding.get(e.id)||0),0);if(demand>availableBefore(exam.date)&&!warnings.some(w=>w.startsWith('Разом'))){warnings.push('Разом підготовка не вміщається у доступний час. Змініть обсяг або денний час.');break}}
 if(completed.some(s=>s.date>=today&&s.date<=end&&completed.filter(other=>other.date===s.date).reduce((n,other)=>n+other.minutes,0)>state.dailyMinutes))warnings.push('Уже виконані кроки перевищують новий денний час. Історію збережено, нових кроків на цей день не додаємо.')
 return {sessions,overdue,warnings,totalMinutes:sessions.reduce((n,s)=>n+s.minutes,0),completedCount:sessions.filter(s=>state.completed.includes(s.id)).length}
}
export function gradeGoal(earned:number,remaining:number,target:number,maxTotal:number) {
 if(![earned,remaining,target,maxTotal].every(Number.isFinite)||earned<0||remaining<0||target<0||maxTotal<=0||target>maxTotal||earned+remaining>maxTotal)throw new Error('Перевірте бали: сума вже отриманих і доступних балів не має перевищувати максимум.')
 const needed=Math.max(0,Math.round((target-earned)*100)/100)
 return {needed,achieved:needed===0,possible:needed<=remaining,percent:remaining>0?Math.round(needed/remaining*100):needed===0?0:null}
}
const icsText=(value:string)=>value.replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/;/g,'\\;').replace(/,/g,'\\,')
export function revisionCalendar(sessions:RevisionSession[],today:string) {
 if(!validSessionDay(today)||sessions.length>140)throw new Error('Некоректний календар')
 const lines=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Xelay//Personal revision//UK','CALSCALE:GREGORIAN']
 const stamp=today.replace(/-/g,'')+'T000000Z'
 for(const s of sessions){if(!validSessionDay(s.date)||!safeId(s.examId)||s.id!==`${s.examId}:${s.date}`||!Number.isSafeInteger(s.minutes)||s.minutes<=0||s.minutes>240)throw new Error('Некоректний крок плану')
  lines.push('BEGIN:VEVENT',`UID:${s.examId}-${s.date}@local-study.xelay`,`DTSTAMP:${stamp}`,`DTSTART;VALUE=DATE:${s.date.replace(/-/g,'')}`,`DTEND;VALUE=DATE:${shiftSessionDay(s.date,1).replace(/-/g,'')}`,`SUMMARY:${icsText(cleanText(s.subject,100))} · ${s.minutes} хв`,`DESCRIPTION:${icsText(cleanText(s.topic,200))}`,'END:VEVENT')
 }
 lines.push('END:VCALENDAR');return lines.join('\r\n')+'\r\n'
}
