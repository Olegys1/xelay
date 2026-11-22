import React from 'react'
import {createRoot} from 'react-dom/client'
import '../src/index.css'
import {DeanWorkspace} from '../src/pages/DeanWorkspacePage'
const group='00000000-0000-4000-8000-000000000001',user='00000000-0000-4000-8000-000000000002'
const sample={students:[{id:'example-student',name:'Приклад · Студент',group:'Навчальна група'}],events:[1,2,3].flatMap(day=>[1,2].map(period=>({id:`lesson-${day}-${period}`,course:period===1?'Економічна теорія':'Страховий захист бізнесу',activity:period===1?'lecture':'practice',teacher:'Приклад · Викладач',teacherIds:['example-teacher'],studentIds:['example-student'],day,period,weeks:[1,2]}))),metadata:{},blockers:[]}
type Draft={id:string;title:string;revision:number;document:unknown;approved_revision:number|null;published_revision:number|null}
const saved=JSON.parse(sessionStorage.getItem('dean-synthetic-drafts')??'[]') as Draft[]
async function rpc<T>(action:string,payload:Record<string,unknown>={}):Promise<T>{
 let result:unknown
 const draft=saved.find(d=>d.id===payload.id)
 if(action==='catalog')result={admin:true,groups:[{id:group,name:'Навчальна група · вигадана',members:[{id:user,name:'Приклад · Студент',username:'example-student'}]}]}
 else if(action==='list')result=saved
 else if(action==='load')result=draft
 else if(action==='create'){result={id:crypto.randomUUID(),title:payload.title,document:payload.document,revision:1,approved_revision:null,published_revision:null};saved.push(result as Draft)}
 else if(action==='save'&&draft){draft.document=payload.document;draft.revision++;draft.approved_revision=null;result=draft}
 else if(action==='review')result={passed:true,lessons:12,attendances:12}
 else if(action==='approve'&&draft){draft.approved_revision=draft.revision;result=draft}
 else if(action==='publish'&&draft){if(draft.approved_revision!==draft.revision)throw Error('Потрібне погодження');draft.published_revision=draft.revision;result=draft}
 else throw Error('Невідома дія прикладу')
 sessionStorage.setItem('dean-synthetic-drafts',JSON.stringify(saved));return structuredClone(result) as T
}
function download(){const url=URL.createObjectURL(new Blob([JSON.stringify(sample)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='dean-example.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)}
createRoot(document.getElementById('root')!).render(<React.StrictMode><div className="p-4 text-center text-sm">Локальна перевірка · тільки вигадані дані · робочу базу відключено. <button className="underline" onClick={download}>Завантажити приклад</button></div><DeanWorkspace rpc={rpc}/></React.StrictMode>)
