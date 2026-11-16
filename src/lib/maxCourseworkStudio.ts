import type {MaxStudioCapture} from './maxStudio'

export type CourseworkKind='coursework'|'report'|'presentation'
export type CourseworkSection={id:string;title:string;body:string}
export type CourseworkSource={id:string;number:number;title:string;author:string;year:string;url:string;quote:string;page:number|null;captureId:string|null}
export type CourseworkMilestone={id:string;title:string;due:string;done:boolean}
export type CourseworkVersion={id:string;label:string;createdAt:string;sections:CourseworkSection[];sources:CourseworkSource[];milestones:CourseworkMilestone[]}
export type CourseworkProject={id:string;title:string;kind:CourseworkKind;subject:string;deadline:string;sections:CourseworkSection[];sources:CourseworkSource[];milestones:CourseworkMilestone[];versions:CourseworkVersion[];updatedAt:string}
export type CourseworkState={version:1;projects:CourseworkProject[];selectedId:string}
export const COURSEWORK_STORAGE_KEY='xelay:local-max-coursework:synthetic:v1'
export const COURSEWORK_LIMITS=Object.freeze({projects:6,sections:16,sectionCharacters:12000,projectCharacters:100000,sources:60,milestones:24,versions:8,storageCharacters:1800000})
const object=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v))
const id=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(v)&&!['constructor','prototype','__proto__'].includes(v)
const text=(v:unknown,max:number,empty=false):v is string=>typeof v==='string'&&v.length<=max&&(empty||!!v.trim())&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)
export const validCourseworkDay=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v
const instant=(v:unknown):v is string=>typeof v==='string'&&/Z$/.test(v)&&Number.isFinite(Date.parse(v))
const copy=<T,>(v:T):T=>JSON.parse(JSON.stringify(v))
export function courseworkUrl(value:string):string|null {if(value==='')return '';if(!text(value,2000)||/[\u0000-\u0020\u007f]/.test(value.trim()))return null;try{const u=new URL(value.trim());return ['https:','http:'].includes(u.protocol)&&u.hostname&&!u.username&&!u.password?u.href:null}catch{return null}}
export function courseworkWordCount(body:string):number{return body.trim()?body.trim().split(/\s+/u).filter(Boolean).length:0}
export const COURSEWORK_TEMPLATES:Readonly<Record<CourseworkKind,readonly string[]>>=Object.freeze({coursework:['Вступ','Теоретична основа','Аналіз і власні результати','Висновки'],report:['Мета роботи','Метод і матеріали','Результати','Висновки'],presentation:['Головна думка','Проблема','Аргументи й приклади','Рішення','Що далі']})
export function createCourseworkProject(projectId:string,title:string,kind:CourseworkKind,today:string,now=new Date().toISOString()):CourseworkProject {
 if(!id(projectId)||!text(title,160)||!['coursework','report','presentation'].includes(kind)||!validCourseworkDay(today)||!instant(now))throw Error('Перевірте назву та дату проєкту.')
 return {id:projectId,title:title.trim(),kind,subject:'',deadline:today,sections:COURSEWORK_TEMPLATES[kind].map((title,index)=>({id:`section-${index+1}`,title,body:''})),sources:[],milestones:[],versions:[],updatedAt:now}
}
export function initialCourseworkState(today:string,empty=false):CourseworkState {
 if(empty)return {version:1,projects:[],selectedId:''}
 const p=createCourseworkProject('example-coursework','Як організувати навчальну інформацію','coursework',today,`${today}T09:00:00.000Z`)
 p.subject='Дослідницький практикум';p.sections[0].body='Мета цієї навчальної роботи — дослідити, як розпорошення розкладу, завдань і матеріалів впливає на підготовку студентів.\n\nВласні спостереження показують: пошук інформації іноді забирає більше часу, ніж початок самої роботи [1].'
 p.sections[1].body='У цьому розділі зберемо поняття, які потрібні для аналізу: інформаційне навантаження, єдина точка доступу та особиста організація.\n\nДля кожного поняття варто знайти джерело, записати сторінку та пояснити тезу власними словами.'
 p.sections[2].body='Тут з’являться власні спостереження, приклади та порівняння. Спробуйте додати цитату з дослідницької полиці до бібліографії, а потім вставити посилання в текст.'
 p.sources=[{id:'source-observations',number:1,title:'Власні навчальні спостереження — демонстраційний запис',author:'Автор навчального прикладу',year:today.slice(0,4),url:'',quote:'Приклад для демонстрації робочого процесу; не зовнішнє наукове джерело.',page:null,captureId:null}]
 p.milestones=[{id:'milestone-outline',title:'Затвердити мету й структуру',due:today,done:true},{id:'milestone-sources',title:'Зібрати й прочитати джерела',due:today,done:false},{id:'milestone-draft',title:'Підготувати першу чернетку',due:today,done:false}]
 return {version:1,projects:[p],selectedId:p.id}
}
function sections(value:unknown):CourseworkSection[] {
 if(!Array.isArray(value)||!value.length||value.length>COURSEWORK_LIMITS.sections)throw Error('Некоректна структура роботи.')
 const seen=new Set<string>();let characters=0
 return value.map(v=>{if(!object(v)||!id(v.id)||seen.has(v.id)||!text(v.title,120)||!text(v.body,COURSEWORK_LIMITS.sectionCharacters,true))throw Error('Перевірте розділи роботи.');seen.add(v.id);characters+=v.body.length;if(characters>COURSEWORK_LIMITS.projectCharacters)throw Error('Завеликий текст проєкту.');return {id:v.id,title:v.title,body:v.body}})
}
export function normalizeCourseworkSource(v:unknown):CourseworkSource {
 if(!object(v)||!id(v.id)||!Number.isSafeInteger(v.number)||Number(v.number)<1||Number(v.number)>10000||!text(v.title,250)||!text(v.author,160,true)||!text(v.year,20,true)||!text(v.url,2000,true)||!text(v.quote,12000,true)||!(v.page===null||Number.isSafeInteger(v.page)&&Number(v.page)>0&&Number(v.page)<=10000)||!(v.captureId===null||id(v.captureId)))throw Error('Перевірте дані джерела.')
 const url=courseworkUrl(v.url);if(url===null)throw Error('Посилання має починатися з https:// або http:// та не містити пароля.')
 return {id:v.id,number:Number(v.number),title:v.title.trim(),author:v.author.trim(),year:v.year.trim(),url,quote:v.quote,page:v.page===null?null:Number(v.page),captureId:v.captureId as string|null}
}
function sources(value:unknown):CourseworkSource[]{if(!Array.isArray(value)||value.length>COURSEWORK_LIMITS.sources)throw Error('Забагато джерел.');const ids=new Set<string>(),numbers=new Set<number>(),captures=new Set<string>();return value.map(v=>{const s=normalizeCourseworkSource(v);if(ids.has(s.id)||numbers.has(s.number)||s.captureId&&captures.has(s.captureId))throw Error('Джерело повторюється.');ids.add(s.id);numbers.add(s.number);if(s.captureId)captures.add(s.captureId);return s})}
function milestones(value:unknown):CourseworkMilestone[]{if(!Array.isArray(value)||value.length>COURSEWORK_LIMITS.milestones)throw Error('Забагато кроків.');const seen=new Set<string>();return value.map(v=>{if(!object(v)||!id(v.id)||seen.has(v.id)||!text(v.title,180)||!validCourseworkDay(v.due)||typeof v.done!=='boolean')throw Error('Перевірте кроки роботи.');seen.add(v.id);return {id:v.id,title:v.title,due:v.due,done:v.done}})}
export function normalizeCourseworkProject(v:unknown):CourseworkProject {
 if(!object(v)||!id(v.id)||!text(v.title,160)||!['coursework','report','presentation'].includes(String(v.kind))||!text(v.subject,100,true)||!validCourseworkDay(v.deadline)||!instant(v.updatedAt)||!Array.isArray(v.versions)||v.versions.length>COURSEWORK_LIMITS.versions)throw Error('Некоректні дані проєкту.')
 const seen=new Set<string>();const versions=v.versions.map(raw=>{if(!object(raw)||!id(raw.id)||seen.has(raw.id)||!text(raw.label,120)||!instant(raw.createdAt))throw Error('Некоректна версія.');seen.add(raw.id);return {id:raw.id,label:raw.label,createdAt:raw.createdAt,sections:sections(raw.sections),sources:sources(raw.sources),milestones:milestones(raw.milestones)}})
 return {id:v.id,title:v.title,kind:v.kind as CourseworkKind,subject:v.subject,deadline:v.deadline,updatedAt:v.updatedAt,sections:sections(v.sections),sources:sources(v.sources),milestones:milestones(v.milestones),versions}
}
export function parseCourseworkState(raw:string|null,today:string,empty=false):CourseworkState {
 if(!raw||raw.length>3000000)return initialCourseworkState(today,empty)
 try {const v:unknown=JSON.parse(raw);if(!object(v)||v.version!==1||!Array.isArray(v.projects)||v.projects.length>COURSEWORK_LIMITS.projects)return initialCourseworkState(today,empty);const projects=v.projects.map(normalizeCourseworkProject);if(new Set(projects.map(p=>p.id)).size!==projects.length)return initialCourseworkState(today,empty);return {version:1,projects,selectedId:typeof v.selectedId==='string'&&projects.some(p=>p.id===v.selectedId)?v.selectedId:projects[0]?.id||''}}catch{return initialCourseworkState(today,empty)}
}
export function addCourseworkSource(project:CourseworkProject,source:Omit<CourseworkSource,'number'>):CourseworkProject {
 if(source.captureId&&project.sources.some(s=>s.captureId===source.captureId))return project
 if(project.sources.some(s=>s.id===source.id))throw Error('Джерело з таким ідентифікатором уже існує.')
 if(project.sources.length>=COURSEWORK_LIMITS.sources)throw Error('У проєкті можна зберегти до 60 джерел.')
 const number=Math.max(0,...project.sources.map(s=>s.number))+1
 return {...project,sources:[...project.sources,normalizeCourseworkSource({...source,number})]}
}
export function attachCourseworkCapture(project:CourseworkProject,capture:MaxStudioCapture):CourseworkProject {
 if(!id(capture.id)||!text(capture.sourceTitle,250)||!text(capture.quote,6000)||!text(capture.note,4000,true)||!instant(capture.createdAt)||!(capture.page===null||Number.isSafeInteger(capture.page)&&capture.page>0&&capture.page<=10000))throw Error('Не вдалося прочитати фрагмент джерела.')
 if(project.sources.some(s=>s.captureId===capture.id))return project
 let index=1;while(project.sources.some(s=>s.id===`capture-${index}-${capture.id.slice(0,60)}`))index++
 return addCourseworkSource(project,{id:`capture-${index}-${capture.id.slice(0,60)}`,title:capture.sourceTitle,author:'',year:'',url:'',quote:capture.quote+(capture.note?`\n\nМоя нотатка: ${capture.note}`:''),page:capture.page,captureId:capture.id})
}
export function insertCourseworkCitation(project:CourseworkProject,sectionId:string,sourceId:string):CourseworkProject {
 const source=project.sources.find(s=>s.id===sourceId),section=project.sections.find(s=>s.id===sectionId);if(!source||!section)throw Error('Оберіть розділ і джерело.')
 const suffix=`${section.body.trim()?' ':''}[${source.number}${source.page===null?'':`, с. ${source.page}`}]`
 if(section.body.length+suffix.length>COURSEWORK_LIMITS.sectionCharacters)throw Error('Розділ досяг обмеження довжини.')
 return {...project,sections:project.sections.map(s=>s.id===sectionId?{...s,body:s.body+suffix}:s)}
}
export function removeCourseworkSource(project:CourseworkProject,sourceId:string):CourseworkProject {
 const source=project.sources.find(s=>s.id===sourceId);if(!source)return project
 const used=new RegExp(`\\[${source.number}(?:\\]|,)`)
 if(project.sections.some(s=>used.test(s.body)))throw Error('Спочатку приберіть посилання на це джерело з тексту. Нумерація інших джерел залишиться.')
 return {...project,sources:project.sources.filter(s=>s.id!==sourceId)}
}
export function saveCourseworkVersion(project:CourseworkProject,versionId:string,label:string,now:string):CourseworkProject {
 if(!id(versionId)||!text(label,120)||!instant(now)||project.versions.some(v=>v.id===versionId))throw Error('Перевірте назву версії.')
 const version:CourseworkVersion={id:versionId,label:label.trim(),createdAt:now,sections:copy(project.sections),sources:copy(project.sources),milestones:copy(project.milestones)}
 return {...project,versions:[version,...project.versions].slice(0,COURSEWORK_LIMITS.versions),updatedAt:now}
}
export function restoreCourseworkVersion(project:CourseworkProject,versionId:string,backupId:string,now:string):CourseworkProject {
 const version=project.versions.find(v=>v.id===versionId);if(!version)throw Error('Цю версію не знайдено.')
 const backed=saveCourseworkVersion(project,backupId,'Перед відновленням версії',now)
 return {...backed,sections:copy(version.sections),sources:copy(version.sources),milestones:copy(version.milestones)}
}
export function prepareCourseworkStorage(state:CourseworkState) {
 const safe:CourseworkState={...state,projects:state.projects.map(normalizeCourseworkProject)};let dropped=0,json=JSON.stringify(safe)
 while(json.length>COURSEWORK_LIMITS.storageCharacters){const candidates=safe.projects.filter(p=>p.versions.length).sort((a,b)=>a.versions[a.versions.length-1].createdAt.localeCompare(b.versions[b.versions.length-1].createdAt));if(!candidates.length)throw Error('Сховище пристрою заповнюється. Завантажте повну копію робіт.');candidates[0].versions.pop();dropped++;json=JSON.stringify(safe)}
 return {json,dropped,retainedVersions:Object.fromEntries(safe.projects.map(p=>[p.id,p.versions.map(v=>v.id)]))}
}
export function courseworkBibliography(project:CourseworkProject):string[] {return [...project.sources].sort((a,b)=>a.number-b.number).map(s=>`${s.number}. ${[s.author,s.title,s.year].filter(Boolean).join('. ')}${s.page===null?'':`. Сторінка фрагмента: ${s.page}`}${s.url?`. ${s.url}`:''}`)}
const html=(text:string)=>text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
export function exportCoursework(project:CourseworkProject,format:'markdown'|'html'|'json'):string {
 const safe=normalizeCourseworkProject(project)
 if(format==='json')return JSON.stringify({format:'xelay-coursework-v1',project:safe},null,2)
 const bibliography=courseworkBibliography(safe)
 if(format==='markdown')return `# ${safe.title}\n\n${safe.subject}\n\n${safe.sections.map(s=>`## ${s.title}\n\n${s.body}`).join('\n\n')}\n\n## Джерела\n\n${bibliography.join('\n\n')}\n`
 return `<!doctype html><html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${html(safe.title)}</title><style>body{font:17px/1.7 Georgia,serif;max-width:820px;margin:50px auto;padding:0 24px;color:#292126}h1{font-size:38px;line-height:1.2}h2{margin-top:34px;font-size:24px}p{white-space:pre-wrap;overflow-wrap:anywhere}li{margin:12px 0;font-size:15px}</style></head><body><h1>${html(safe.title)}</h1><p>${html(safe.subject)}</p>${safe.sections.map(s=>`<section><h2>${html(s.title)}</h2><p>${html(s.body)}</p></section>`).join('')}<h2>Джерела</h2><ol>${bibliography.map(line=>`<li value="${Number(line.split('.')[0])}">${html(line.replace(/^\d+\. /,''))}</li>`).join('')}</ol></body></html>`
}
