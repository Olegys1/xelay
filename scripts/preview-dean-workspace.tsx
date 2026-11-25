import React from 'react'
import {createRoot} from 'react-dom/client'
import '../src/index.css'
import {parseDeanSource} from '../src/lib/deanWorkspace'
import {DeanWorkspace} from '../src/pages/DeanWorkspacePage'
const group='00000000-0000-4000-8000-000000000001',user='00000000-0000-4000-8000-000000000002'
const courses=[['Економічна теорія','lecture','Викладач 01'],['Страховий захист бізнесу','practice','Викладач 02'],['Аналітика даних','lab','Викладач 03'],['Маркетинг','seminar','Викладач 04']] as const
const sample={students:[{id:'example-student',name:'Студент 01',group:'Навчальна група'}],events:[1,2,3,4,5].flatMap(day=>[1,2].map(period=>{const [course,activity,teacher]=courses[(day+period-2)%courses.length];return {id:`lesson-${day}-${period}`,course,activity,teacher,teacherIds:[teacher],studentIds:['example-student'],room:'101',day,period,weeks:Array.from({length:17},(_,i)=>i+1)}})),metadata:{},blockers:[],rooms:[{id:'101',capacity:30,computer:true,disabled:false,allowedPrograms:[],blockedSlots:[],note:''}]}

type Draft={id:string;title:string;revision:number;document:unknown;approved_revision:number|null;published_revision:number|null}
async function mountPreview(){
const response=await fetch('/__dean-original.json',{cache:'no-store'})
if(!response.ok)throw Error('Не вдалося відкрити локальний розклад.')
const original=await response.json() as {title:string;source:unknown}|null
const readOnlyMessage='Це перегляд збереженого розкладу. Розрахунок і збереження доступні в робочому кабінеті Xelay.'
let main=JSON.parse(sessionStorage.getItem('dean-preview-main')??'null')
const saved=(original?[{id:'00000000-0000-4000-8000-000000000004',title:original.title,revision:1,document:{source:parseDeanSource(original.source),mapping:{},monday:'',rows:[]},approved_revision:null,published_revision:null}]:JSON.parse(sessionStorage.getItem('dean-design-preview-v2')??'[]')) as Draft[]
if(!saved.length)saved.push({id:'00000000-0000-4000-8000-000000000003',title:'Демонстраційний розклад',revision:1,document:{source:sample,mapping:{},monday:'',rows:[]},approved_revision:null,published_revision:null})
async function rpc<T>(action:string,payload:Record<string,unknown>={}):Promise<T>{
 if(original&&!['catalog','list','load','main'].includes(action))throw Error(readOnlyMessage)
 let result:unknown
 const draft=saved.find(d=>d.id===payload.id)
 if(action==='teacher_catalog')return [] as any
  if(action==='catalog')result={admin:true,groups:original?[]:[{id:group,name:'Навчальна група · вигадана',members:[{id:user,name:'Студент 01',username:'example-student'}]}]}
 else if(action==='list')result=saved
 else if(action==='load')result=draft
 else if(action==='main')result={canSelect:!original,main:original?{draft_id:saved[0].id,title:saved[0].title,revision:1,version:1,document:saved[0].document,selected_at:new Date().toISOString()}:main}
 else if(action==='make_main'&&draft){main={draft_id:draft.id,title:draft.title,revision:draft.revision,version:(main?.version??0)+1,document:structuredClone(draft.document),selected_at:new Date().toISOString()};sessionStorage.setItem('dean-preview-main',JSON.stringify(main));result=main}
 else if(action==='fork'&&draft){result={...structuredClone(draft),id:crypto.randomUUID(),title:draft.title+' · робоча копія',revision:1,approved_revision:null,published_revision:null};saved.unshift(result as Draft)}
 else if(action==='create'){result={id:crypto.randomUUID(),title:payload.title,document:payload.document,revision:1,approved_revision:null,published_revision:null};saved.push(result as Draft)}
 else if(action==='save'&&draft){draft.document=payload.document;draft.revision++;draft.approved_revision=null;result=draft}
 else if(action==='review')result={passed:true,lessons:12,attendances:12}
 else if(action==='approve'&&draft){draft.approved_revision=draft.revision;result=draft}
 else if(action==='publish'&&draft){if(draft.approved_revision!==draft.revision)throw Error('Потрібне погодження');draft.published_revision=draft.revision;result=draft}
 else throw Error('Невідома дія прикладу')
 if(!original)sessionStorage.setItem('dean-design-preview-v2',JSON.stringify(saved));return structuredClone(result) as T
}
const jobs:any[]=[]
const plannerApi={
 async server(body:Record<string,unknown>){
  if(original)throw Error(readOnlyMessage)
  if(body.action!=='calculate')throw Error('Створення доступів вимкнено в локальному прикладі.')
  const draft=saved.find(d=>d.id===body.draftId)!
  const doc=structuredClone(draft.document) as any
  doc.source=doc.planningSource??doc.source;delete doc.planningSource
  const events=doc.source.events.map((e:any)=>({...e,day:e.day===1?2:e.day===2?1:e.day}))
  const changes=events.filter((e:any,i:number)=>e.day!==doc.source.events[i].day).map((e:any)=>({id:e.id,course:e.course,teacher:e.teacher,from:[doc.source.events.find((x:any)=>x.id===e.id).day,e.period],to:[e.day,e.period]}))
  const job={id:crypto.randomUUID(),state:'done',created_at:new Date().toISOString(),result:{note:'Демонстраційний результат на вигаданих даних.',options:[{changes,report:{metrics:{studentGaps:0,conflicts:0,teacherGaps:0}},document:{...doc,source:{...doc.source,events},settings:body.settings}}]}}
  jobs.unshift(job);return {job:job.id}
 },
 async online(action:string,payload:Record<string,unknown>={}){
  if(action==='jobs')return structuredClone(jobs)
  if(action==='staff_list')return []
  const job=jobs.find(j=>j.id===payload.id)
  if(action==='result')return structuredClone(job)
  if(action==='apply'&&job){return rpc('create',{title:'Новий демонстраційний варіант',document:job.result.options[Number(payload.option)].document})}
  throw Error('Дія недоступна в локальному прикладі.')
 }
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><div style={{padding:'8px 16px',textAlign:'center',fontSize:11,background:'#efe8df',color:'#7b6957'}}>{original?'Збережений розклад 3 курсу. Локальний перегляд без змін оригіналу.':'Локальний перегляд. Вигадані дані, робочу базу відключено.'}</div><DeanWorkspace rpc={rpc} plannerApi={plannerApi}/></React.StrictMode>)
}
void mountPreview().catch(()=>{document.getElementById('root')!.textContent='Не вдалося відкрити локальний розклад. Оновіть сторінку.'})
