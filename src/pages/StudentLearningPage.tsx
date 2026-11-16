import {lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState} from 'react'
import {ArrowRight,BookOpen,CalendarDays,ChevronDown,Cloud,Layers3,Loader2,RefreshCw,ShieldCheck,Sparkles,Stars} from 'lucide-react'
import {useAuth} from '../context/AuthContext'
import {AuthModal} from '../components/AuthModal'
import {supabase} from '../lib/supabase'
import {createMaxTutorProductionClient,type ProductionMaxStatus} from '../lib/maxTutorProductionClient'
import {ProductionMaxTutorAssistant} from '../components/student/ProductionMaxTutorAssistant'
import {StudentLearningGuide} from '../components/student/StudentLearningGuide'
import type {StudentPlanId} from '../lib/studentPlans'
import './studentLearningPage.css'
const MaxLearningStudio=lazy(()=>import('../components/student/MaxLearningStudio'))
const StudentDeskTools=lazy(()=>import('../components/student/StudentDeskTools'))
const StudyWorkbench=lazy(()=>import('../components/student/StudyWorkbench'))
const StudentPracticeLab=lazy(()=>import('../components/student/StudentPracticeLab'))
type LearningTab='tools'|'prepare'|'practice'|'max'
const LEARNING_TABS=[{id:'tools',label:'Мої інструменти',icon:BookOpen},{id:'prepare',label:'Підготовка',icon:CalendarDays},{id:'practice',label:'Власна практика',icon:Layers3},{id:'max',label:'Студія Макс',icon:Sparkles}]as const
function LearningSectionTabs({tab,onSelect,secondary=false}:{tab:LearningTab;onSelect:(tab:LearningTab)=>void;secondary?:boolean}){return <nav className="slp-tabs" aria-label="Мої навчальні інструменти">{LEARNING_TABS.filter(item=>!secondary||item.id!=='max').map(item=><button key={item.id} aria-current={tab===item.id?'page':undefined} onClick={()=>onSelect(item.id)}><item.icon size={16}/>{item.label}</button>)}</nav>}
// Used only to discard stale UI results; server signature/session verification remains authoritative.
function credentialSessionId(token:string):string|undefined{try{const value=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).session_id;return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)?value:undefined}catch{return undefined}}

export function StudentLearningPage(){const {authUser,xelayUser,authReadEpoch,authReadBlocked,isLoading,sessionUnavailable,refreshUser}=useAuth();if(sessionUnavailable)return <main className="slp"><div className="slp-warning" role="alert"><p>Не вдалося перевірити вхід. Твої збережені матеріали не змінено.</p><button onClick={()=>void refreshUser()}><RefreshCw size={15}/>Перевірити ще раз</button></div></main>;return <StudentLearningWorkspace key={`${authUser?.id||'guest'}:${authReadEpoch}`} userId={authReadBlocked?null:authUser?.id||null} profileDisplayName={!authReadBlocked&&xelayUser?.id===authUser?.id?xelayUser?.firstName||xelayUser?.name:undefined} authLoading={isLoading||authReadBlocked}/>}
function StudentLearningWorkspace({userId,profileDisplayName,authLoading}:{userId:string|null;profileDisplayName?:string;authLoading:boolean}){
 const [status,setStatus]=useState<ProductionMaxStatus|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),[authOpen,setAuthOpen]=useState(false),[tab,setTab]=useState<'tools'|'prepare'|'practice'|'max'>('max'),alive=useRef(true)
 const client=useMemo(()=>userId?createMaxTutorProductionClient({ownerId:userId,credential:async()=>{const {data,error}=await supabase.auth.getSession();if(error||data.session?.user.id!==userId)return null;return {userId,accessToken:data.session.access_token,sessionId:credentialSessionId(data.session.access_token)}}}):null,[userId])
 useEffect(()=>{alive.current=true;if(!client)return;const abort=new AbortController();setStatus(null);setError('');client.status(abort.signal).then(value=>{if(!abort.signal.aborted)setStatus(value)}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Не вдалося відкрити навчальний простір.')});return()=>{alive.current=false;abort.abort()}},[client,retry])
 const receiveStatus=useCallback((value:ProductionMaxStatus)=>{if(alive.current&&value.scope.userId===userId)setStatus(value)},[userId])
 const plan:StudentPlanId=status?.planId==='max'?'max':status?.planId==='plus'?'plus':'start',paid=!!status&&status.planId!=='free'&&status.audience==='student'
 if(authLoading)return <main className="slp slp-loading" role="status"><Loader2/>Відкриваємо особистий простір…</main>
 if(!userId)return <main className="slp"><div className="slp-guest"><span><Stars size={16}/>Особиста навчальна студія</span><h1>Твої матеріали.<br/><em>Твій наступний крок.</em></h1><p>Увійди, щоб відкрити власні навчальні сесії, практику й інструменти підготовки.</p><button className="slp-primary" onClick={()=>setAuthOpen(true)}>Увійти до Xelay<ArrowRight size={16}/></button></div>{authOpen&&<AuthModal onClose={()=>setAuthOpen(false)}/>}</main>
 return <main className="slp slp-workspace"><header className="slp-intro"><div><span><Stars size={14}/>Xelay · для навчання</span><h1>Мій навчальний простір</h1><p>Матеріали, практика й помічник — під рукою.</p></div><div className="slp-header-actions">{status?.planId==='max'&&tab!=='max'&&<button type="button" className="slp-chat-entry" onClick={()=>setTab('max')}><Sparkles size={15}/>До помічника</button>}<a href="/subscription">Моя підписка<ArrowRight size={15}/></a>{status?.planId==='max'&&<details className="slp-extra-tools"><summary>{tab==='max'?'Інші інструменти':LEARNING_TABS.find(item=>item.id===tab)?.label}<ChevronDown size={15}/></summary><LearningSectionTabs tab={tab} onSelect={setTab} secondary/></details>}</div></header>
 {error&&<div className="slp-warning" role="alert"><p>{error}</p><button onClick={()=>setRetry(n=>n+1)}><RefreshCw size={15}/>Спробувати ще раз</button></div>}
 {!status&&!error&&<div className="slp-loading" role="status"><Loader2/>Перевіряємо доступ до навчальних інструментів…</div>}
 {status&&client&&<><div className="slp-access"><span><ShieldCheck size={15}/>{status.planId==='free'?'Збережені матеріали':`Студентський ${status.planId==='max'?'Макс':status.planId==='plus'?'Плюс':'Старт'}`}</span><span><Cloud size={14}/>Відповіді помічника — у твоєму акаунті</span></div>{status.audience==='unresolved'&&<div className="slp-warning"><p>Тип підписки цього облікового запису ще не підтверджено. Попередні можливості та збережені матеріали залишаються доступними. Звернися до підтримки для підключення нового тарифу.</p></div>}
 {status.planId!=='max'&&<LearningSectionTabs tab={tab} onSelect={setTab}/>}
 <Suspense fallback={<div className="slp-loading" role="status"><Loader2/>Відкриваємо інструмент…</div>}>
 <div hidden={tab!=='max'} inert={tab!=='max'} style={tab==='max'?undefined:{display:'none'}}><MaxLearningStudio plan={status.audience==='student'?plan:'start'} initialTab="overview" production={{scope:status.scope,canEdit:status.planId==='max'&&status.audience==='student',renderTutor:props=><ProductionMaxTutorAssistant status={status} client={client} capturedSources={props.capturedSources} coachAction={props.coachAction} startView={props.startView} profileDisplayName={profileDisplayName} onOpenPreparation={props.onOpenPreparation} onWorkspaceState={props.onWorkspaceState} onStatus={receiveStatus}/>}}/></div>
 {tab==='tools'&&<>{!paid&&<div className="slp-warning"><p>Збережені особисті дані доступні для читання й експорту. Створення та зміни — з активним Старт.</p><a href="/subscription">Можливості підписки</a></div>}<StudentLearningGuide guideId="tools"/><StudentDeskTools storageOwner={userId} emptyStart enabled={paid}/></>}
 {tab==='prepare'&&<><StudentLearningGuide guideId="workspace"/><StudyWorkbench plan={plan} storageOwner={userId} emptyStart enabled={paid}/></>}
 {tab==='practice'&&<>{!(paid&&['plus','max'].includes(status.planId))&&<div className="slp-warning"><p>Власна бібліотека та історія залишаються доступними. Нові тренування й питання — у Плюс і Макс.</p><a href="/subscription">Можливості підписки</a></div>}<StudentLearningGuide guideId="practice"/><StudentPracticeLab plan={paid&&['plus','max'].includes(status.planId)?plan:'start'} storageOwner={userId} emptyStart/></>}

 </Suspense></>}
 </main>
}
