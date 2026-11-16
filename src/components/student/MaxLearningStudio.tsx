import {lazy,Suspense,useCallback,useEffect,useRef,useState} from 'react'
import {ArrowRight,BookOpenCheck,BookMarked,Check,CircleDot,FilePenLine,GitBranch,GraduationCap,Layers3,LockKeyhole,MoveUpRight,PanelLeft,Quote,ShieldCheck,Stars,X} from 'lucide-react'
import {MAX_STUDIO_INBOX_KEY,normalizeMaxCapture,parseMaxInbox,type MaxStudioCapture} from '../../lib/maxStudio'
import {StudentLearningGuide} from './StudentLearningGuide'
import type {ReactNode} from 'react'
import type {MaxTutorScope} from '../../lib/maxTutor'
import type {MaxTutorCoachAction} from './MaxTutorAssistant'
import type {StudentPlanId} from '../../lib/studentPlans'
import type {MaxTutorLocalStatus} from '../../lib/maxTutorLocalClient'
import {sendMaxTutorCoachEvent,type CoachAction} from '../../lib/maxTutorCoach'
import './maxLearningStudio.css'
const MaxResearchStudio=lazy(()=>import('./MaxResearchStudio'))
const MaxCourseworkStudio=lazy(()=>import('./MaxCourseworkStudio'))
const MaxAcademicStudio=lazy(()=>import('./MaxAcademicStudio'))
const StudentSessionPlanner=lazy(()=>import('./StudentSessionPlanner'))
const MaxTutorAssistant=lazy(()=>import('./MaxTutorAssistant'))
const LocalMaxTutorAssistant=lazy(()=>import('./MaxTutorAssistant').then(module=>({default:module.LocalMaxTutorAssistant})))
const MaxTutorCoach=lazy(()=>import('./MaxTutorCoach'))
type StudioTab='overview'|'assistant'|'research'|'projects'|'academic'|'session'
const NAV:{id:StudioTab;label:string;description:string;icon:typeof Stars}[]=[
 {id:'overview',label:'Моя студія',description:'Один простір, повний процес',icon:Stars},
 {id:'assistant',label:'Мій помічник',description:'Пояснення, практика та план',icon:Stars},
 {id:'research',label:'Джерела',description:'PDF, пошук і точні цитати',icon:BookMarked},
 {id:'projects',label:'Великі роботи',description:'Структура, джерела, версії',icon:FilePenLine},
 {id:'academic',label:'Сценарії балів',description:'Побачити наслідки рішень',icon:GitBranch},
 {id:'session',label:'Моя сесія',description:'Предмети й навантаження',icon:GraduationCap},
]
function readInbox(storageKey:string){try{return parseMaxInbox(localStorage.getItem(storageKey))}catch{return []}}
export type ProductionStudio={scope:MaxTutorScope;canEdit:boolean;renderTutor:(props:{capturedSources:readonly MaxStudioCapture[];coachAction?:MaxTutorCoachAction})=>ReactNode}
export default function MaxLearningStudio({plan='max',localTutor=false,initialTab='overview',production}:{plan?:StudentPlanId;localTutor?:boolean;initialTab?:StudioTab;production?:ProductionStudio}){
 const storageOwner=production?.scope.userId,storageKey=storageOwner?MAX_STUDIO_INBOX_KEY+':owner:'+storageOwner:MAX_STUDIO_INBOX_KEY
 const [tab,setTab]=useState<StudioTab>(initialTab),[inbox,setInbox]=useState<MaxStudioCapture[]>(()=>readInbox(storageKey)),[notice,setNotice]=useState(''),[storageError,setStorageError]=useState(false)
 const [connection,setConnection]=useState<MaxTutorLocalStatus|null>(null),[coachAction,setCoachAction]=useState<{id:string;type:Exclude<CoachAction,'research'|'session'>}|undefined>()
 const enabled=plan==='max'&&(!production||production.canEdit),latest=useRef(inbox);latest.current=inbox
 const scope=production?.scope||connection?.scope
 const actOnCoach=useCallback((action:CoachAction)=>{if(action==='research'||action==='session'){setTab(action);return}setTab('assistant');setCoachAction({id:crypto.randomUUID(),type:action})},[])
 const projectProgress=useCallback((event:{projectId:string;done:number;total:number})=>{if(scope&&enabled)sendMaxTutorCoachEvent(scope,{type:'project',...event})},[scope?.userId,scope?.sessionId,enabled])
 const planProgress=useCallback((event:{planId:string;done:number;total:number;dueAt?:number})=>{if(scope&&enabled)sendMaxTutorCoachEvent(scope,{type:'plan',...event})},[scope?.userId,scope?.sessionId,enabled])
 useEffect(()=>{if(scope&&enabled)sendMaxTutorCoachEvent(scope,{type:'sources',count:inbox.length})},[scope?.userId,scope?.sessionId,enabled,inbox.length])
 useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(inbox));setStorageError(false)}catch{setStorageError(true)}},[inbox])
 useEffect(()=>{const flush=()=>{try{localStorage.setItem(storageKey,JSON.stringify(latest.current))}catch{}};window.addEventListener('pagehide',flush);return()=>{flush();window.removeEventListener('pagehide',flush)}},[])
 function capture(value:MaxStudioCapture){if(!enabled)return;const safe=normalizeMaxCapture(value);if(!safe){setNotice('Не вдалося додати цей фрагмент. Перевірте назву та текст.');return}setInbox(items=>[...items.filter(item=>item.id!==safe.id),safe].slice(-100));setTab('projects');setNotice('Цитату передано до «Великих робіт». Додай її до джерел потрібної роботи.')}
 return <section className="mls" aria-label="Студія Макс"><header className="mls-header"><div className="mls-wordmark"><span><Stars size={18}/></span><strong>Студія<em>Макс</em></strong></div><div className="mls-header-caption">Твій особистий навчальний простір</div><span className="mls-private"><ShieldCheck size={13}/>Особисте</span></header>
 <div className="mls-layout"><aside className="mls-sidebar"><span className="mls-sidebar-title">Повний цикл підготовки</span><nav aria-label="Розділи Студії Макс">{NAV.map(item=><button key={item.id} className={tab===item.id?'active':''} aria-current={tab===item.id?'page':undefined} onClick={()=>{setTab(item.id);setNotice('')}}><item.icon size={17}/><span>{item.label}<small>{item.description}</small></span>{item.id==='projects'&&!!inbox.length&&<b>{inbox.length}</b>}</button>)}</nav><div className="mls-sidebar-note"><CircleDot size={17}/><p>Не просто зберегти матеріал.<br/><strong>Перетворити його на готову роботу.</strong></p></div><div className="mls-sidebar-bottom"><Layers3 size={14}/><span>Усі інструменти «Плюс» також включені</span></div></aside>
 <div className="mls-body"><StudentLearningGuide guideId={tab==='overview'?'max':tab==='projects'?'coursework':tab}/><div className="mls-breadcrumb"><span>Студія Макс</span><i>/</i><strong>{NAV.find(n=>n.id===tab)?.label}</strong></div>{!enabled&&<div className="mls-lock"><LockKeyhole size={16}/><span>Переглядай збережене й експортуй власні матеріали. Створення нових матеріалів доступне з активним «Макс».</span></div>}
 {(notice||storageError)&&<div className="mls-notice" role="status"><Quote size={16}/><span>{storageError?'Пам’ять пристрою недоступна. Не закривайте важливі незбережені матеріали; використайте їх експорт.':notice}</span><button onClick={()=>setNotice('')} aria-label="Закрити повідомлення студії"><X size={14}/></button></div>}
 <Suspense fallback={<div className="mls-loading" role="status"><span/>Відкриваємо інструмент…</div>}>
 {tab==='overview'&&<div className="mls-overview"><div className="mls-hero"><div><span className="mls-kicker"><Stars size={13}/> Від першого джерела — до захисту</span><h1>Місце для роботи,<br/><em>якою пишаєшся.</em></h1><p>Читай, відбирай головне, збирай аргументи й пиши. Твої джерела, чернетки та рішення працюють разом.</p><button onClick={()=>setTab('research')}>Відкрити навчальну студію<ArrowRight size={16}/></button></div><div className="mls-hero-art" aria-hidden="true"><span className="mls-art-orbit"/><div className="mls-art-paper"><i/><b/><b/><b/><em><Quote size={16}/>Сторінка → цитата → робота</em><b/><b/><span><Check size={12}/>Джерело збережене</span></div><span className="mls-art-stamp"><BookOpenCheck size={28}/></span></div></div>
 <div className="mls-path"><span>Твій робочий процес</span><div>{[{label:'Дослідити',desc:'Знайти потрібне в PDF',icon:BookMarked,tab:'research'},{label:'Сформувати',desc:'Зібрати структуру та джерела',icon:FilePenLine,tab:'projects'},{label:'Порівняти',desc:'Перевірити власні сценарії',icon:GitBranch,tab:'academic'}].map((item,index)=><button key={item.tab} onClick={()=>setTab(item.tab as StudioTab)}><span>{String(index+1).padStart(2,'0')}</span><item.icon size={20}/><strong>{item.label}<small>{item.desc}</small></strong><ArrowRight size={15}/></button>)}</div></div>
 <div className="mls-workflows"><button className="mls-workflow mls-workflow--research" onClick={()=>setTab('research')}><div><BookMarked size={24}/><MoveUpRight size={15}/></div><span>Читати з думкою про результат</span><h2>Особиста бібліотека.<br/>Пошук. Цитати.</h2><p>Завантаж власний PDF, збережи сторінку й передай вибраний фрагмент у роботу з точним посиланням.</p><b>Дослідити джерело<ArrowRight size={15}/></b></button><button className="mls-workflow mls-workflow--projects" onClick={()=>setTab('projects')}><div><FilePenLine size={24}/><MoveUpRight size={15}/></div><span>Велика робота без розсипаних файлів</span><h2>Курсова, звіт<br/>або дослідження.</h2><p>Структура, текст, список джерел, контрольні точки й версії. Повертайся до попереднього стану та експортуй результат.</p><b>Відкрити роботу<ArrowRight size={15}/></b></button></div>
 <div className="mls-bottom-tools"><button onClick={()=>setTab('academic')}><span><GitBranch size={21}/></span><div><strong>Три предмети. Кілька можливих результатів.</strong><p>Зміни припущення для майбутніх робіт і порівняй, що це дасть за твоїми правилами.</p></div><ArrowRight size={17}/></button><button onClick={()=>setTab('session')}><span><GraduationCap size={21}/></span><div><strong>Підготовка, яка вміщається в тиждень.</strong><p>Дати, пріоритети й реальний доступний час — в одному плані.</p></div><ArrowRight size={17}/></button></div>
 <footer className="mls-overview-foot"><ShieldCheck size={15}/><span>Твої матеріали залишаються особистими. Особисті інструменти зберігаються на цьому пристрої; сесії помічника — у Xelay. Оцінки в журналі не змінюються.</span></footer></div>}
 {production?<div hidden={tab!=='assistant'} inert={tab!=='assistant'} style={tab==='assistant'?undefined:{display:'none'}}>{production.renderTutor({capturedSources:inbox,coachAction})}</div>:localTutor?<div hidden={tab!=='assistant'} inert={tab!=='assistant'} style={tab==='assistant'?undefined:{display:'none'}}><LocalMaxTutorAssistant enabled={enabled} capturedSources={inbox} onConnection={setConnection} coachAction={coachAction}/></div>:tab==='assistant'&&<MaxTutorAssistant enabled={enabled} capturedSources={inbox}/>}
 {tab==='research'&&<MaxResearchStudio enabled={enabled} onCapture={capture} storageOwner={storageOwner} emptyStart={!!production}/>}
 {tab==='projects'&&<MaxCourseworkStudio enabled={enabled} capturedSources={inbox} onProgress={projectProgress} storageOwner={storageOwner} emptyStart={!!production}/>}
 {tab==='academic'&&<MaxAcademicStudio enabled={enabled} storageOwner={storageOwner} emptyStart={!!production}/>}
 {tab==='session'&&<StudentSessionPlanner plan={plan} onProgress={planProgress} storageOwner={storageOwner} emptyStart={!!production}/>}
 </Suspense></div></div>{(localTutor||production)&&scope&&<Suspense fallback={null}><MaxTutorCoach enabled={enabled} scope={scope} currentBlock={tab} onAction={actOnCoach}/></Suspense>}</section>
}
