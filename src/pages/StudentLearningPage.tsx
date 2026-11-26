import {lazy,Suspense,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {ArrowRight,BookOpen,CalendarDays,Layers3,Loader2,Menu,RefreshCw,Sparkles,Stars,UserRound,X} from 'lucide-react'
import {useAuth} from '../context/AuthContext'
import {AuthModal} from '../components/AuthModal'
import {supabase} from '../lib/supabase'
import {createMaxTutorProductionClient,type ProductionMaxStatus} from '../lib/maxTutorProductionClient'
import {ProductionMaxTutorAssistant} from '../components/student/ProductionMaxTutorAssistant'
import {StudentLearningGuide} from '../components/student/StudentLearningGuide'
import {XelayLogo} from '../components/XelayLogo'
import type {StudentPlanId} from '../lib/studentPlans'
import './studentLearningPage.css'
const MaxLearningStudio=lazy(()=>import('../components/student/MaxLearningStudio'))
const StudentDeskTools=lazy(()=>import('../components/student/StudentDeskTools'))
const StudyWorkbench=lazy(()=>import('../components/student/StudyWorkbench'))
const StudentPracticeLab=lazy(()=>import('../components/student/StudentPracticeLab'))
type LearningTab='tools'|'prepare'|'practice'|'max'
const LEARNING_TABS=[{id:'tools',label:'Мої інструменти',icon:BookOpen},{id:'prepare',label:'Підготовка',icon:CalendarDays},{id:'practice',label:'Власна практика',icon:Layers3},{id:'max',label:'Студія Макс',icon:Sparkles}]as const
function LearningSectionTabs({tab,onSelect}:{tab:LearningTab;onSelect:(tab:LearningTab)=>void}){return <section className="slp-section-navigation" aria-label="Додаткові навчальні інструменти"><details open={tab!=='max'}><summary><Layers3 size={15}/>Особисті інструменти<span>+</span></summary><nav className="slp-tabs" aria-label="Мої навчальні інструменти">{LEARNING_TABS.filter(item=>item.id!=='max').map(item=><button type="button" key={item.id} aria-current={tab===item.id?'page':undefined} onClick={()=>onSelect(item.id)}><item.icon size={16}/>{item.label}</button>)}</nav></details></section>}
function LearningSectionGuide({guideId,target}:{guideId:string;target:HTMLElement|null}){const guide=<StudentLearningGuide guideId={guideId}/>;return target?createPortal(<div className="slp-section-guide">{guide}</div>,target):guide}
/** The isolated preview has no app header; the full app reuses its single existing header. */
function LearningFallbackRail({onTarget,onControlsTarget,onQuotaTarget,profileDisplayName}:{onTarget:(target:HTMLDivElement|null)=>void;onControlsTarget:(target:HTMLDivElement|null)=>void;onQuotaTarget:(target:HTMLDivElement|null)=>void;profileDisplayName?:string}){
 const [open,setOpen]=useState(false)
 return <aside className="slp-local-rail" data-open={open} aria-label="Меню навчального простору"><div className="slp-local-brand"><a href="/" aria-label="На головну Xelay"><XelayLogo className="h-10 w-[100px]"/></a><button type="button" aria-controls="slp-local-navigation" aria-expanded={open} aria-label={open?'Закрити меню навчання':'Відкрити меню навчання'} onClick={()=>setOpen(value=>!value)}>{open?<X size={20}/>:<Menu size={20}/>}</button></div><div className="slp-local-rail-body" id="slp-local-navigation"><nav className="slp-local-links" aria-label="Платформа Xelay"><a href="/groups">Групи</a><a href="/messages">Чати</a><a href="/search">Пошук</a><a href="/?notifications=1">Сповіщення</a></nav><div className="slp-local-navigation-target" ref={onTarget}/><div className="slp-local-bottom"><a href="/support">Підтримати команду<ArrowRight size={14}/></a><a href="/subscription">Моя підписка<ArrowRight size={14}/></a><div className="slp-local-controls" ref={onControlsTarget}/><div className="slp-local-account"><div className="slp-local-quota" ref={onQuotaTarget}/><a className="slp-local-profile" href="/profile"><span><UserRound size={18}/></span><strong>{profileDisplayName||'Мій профіль'}<small>Особистий акаунт</small></strong></a></div></div></div></aside>
}
// Used only to discard stale UI results; server signature/session verification remains authoritative.
function credentialSessionId(token:string):string|undefined{try{const value=JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).session_id;return typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)?value:undefined}catch{return undefined}}

export function StudentLearningPage(){const {authUser,xelayUser,authReadEpoch,authReadBlocked,isLoading,sessionUnavailable,refreshUser}=useAuth();if(sessionUnavailable)return <main className="slp"><div className="slp-warning" role="alert"><p>Не вдалося перевірити вхід. Твої збережені матеріали не змінено.</p><button onClick={()=>void refreshUser()}><RefreshCw size={15}/>Перевірити ще раз</button></div></main>;return <StudentLearningWorkspace key={`${authUser?.id||'guest'}:${authReadEpoch}`} userId={authReadBlocked?null:authUser?.id||null} profileDisplayName={!authReadBlocked&&xelayUser?.id===authUser?.id?xelayUser?.firstName||xelayUser?.name:undefined} authLoading={isLoading||authReadBlocked}/>}
function StudentLearningWorkspace({userId,profileDisplayName,authLoading}:{userId:string|null;profileDisplayName?:string;authLoading:boolean}){
 const [status,setStatus]=useState<ProductionMaxStatus|null>(null),[error,setError]=useState(''),[retry,setRetry]=useState(0),[authOpen,setAuthOpen]=useState(false),[tab,setTab]=useState<'tools'|'prepare'|'practice'|'max'>('max'),alive=useRef(true)
 const [navigationTarget,setNavigationTarget]=useState<HTMLElement|null>(null),[fallbackTarget,setFallbackTarget]=useState<HTMLDivElement|null>(null)
 const [controlsTarget,setControlsTarget]=useState<HTMLElement|null>(null),[quotaTarget,setQuotaTarget]=useState<HTMLElement|null>(null),[fallbackControlsTarget,setFallbackControlsTarget]=useState<HTMLDivElement|null>(null),[fallbackQuotaTarget,setFallbackQuotaTarget]=useState<HTMLDivElement|null>(null)
 useLayoutEffect(()=>{setNavigationTarget(document.getElementById('xelay-learning-navigation'));setControlsTarget(document.getElementById('xelay-learning-controls'));setQuotaTarget(document.getElementById('xelay-learning-quota'))},[])
 const sidebarTarget=navigationTarget||fallbackTarget,controlsHost=controlsTarget||fallbackControlsTarget,quotaHost=quotaTarget||fallbackQuotaTarget,openMax=useCallback(()=>setTab('max'),[])
 const client=useMemo(()=>userId?createMaxTutorProductionClient({ownerId:userId,credential:async()=>{const {data,error}=await supabase.auth.getSession();if(error||data.session?.user.id!==userId)return null;return {userId,accessToken:data.session.access_token,sessionId:credentialSessionId(data.session.access_token)}}}):null,[userId])
 useEffect(()=>{alive.current=true;if(!client)return;const abort=new AbortController();setStatus(null);setError('');client.status(abort.signal).then(value=>{if(!abort.signal.aborted)setStatus(value)}).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Не вдалося відкрити навчальний простір.')});return()=>{alive.current=false;abort.abort()}},[client,retry])
 const receiveStatus=useCallback((value:ProductionMaxStatus)=>{if(alive.current&&value.scope.userId===userId)setStatus(value)},[userId])
 const plan:StudentPlanId=status?.planId==='max'?'max':status?.planId==='plus'?'plus':'start',paid=!!status&&status.planId!=='free'&&status.audience==='student'
 if(authLoading)return <main className="slp slp-loading" role="status"><Loader2/>Відкриваємо особистий простір…</main>
 if(!userId)return <main className="slp"><div className="slp-guest"><span><Stars size={16}/>Особиста навчальна студія</span><h1>Матеріали,<br/><em>практика та ШІ.</em></h1><p>Увійди, щоб відкрити власні навчальні сесії, практику й інструменти підготовки.</p><button className="slp-primary" onClick={()=>setAuthOpen(true)}>Увійти до Xelay<ArrowRight size={16}/></button></div>{authOpen&&<AuthModal onClose={()=>setAuthOpen(false)}/>}</main>
 return <main className={`slp slp-workspace slp-immersive${navigationTarget?'':' slp-with-local-rail'}`} aria-label="Особистий навчальний простір">
 {!navigationTarget&&<LearningFallbackRail onTarget={setFallbackTarget} onControlsTarget={setFallbackControlsTarget} onQuotaTarget={setFallbackQuotaTarget} profileDisplayName={profileDisplayName}/>}
 {sidebarTarget&&createPortal(<LearningSectionTabs tab={tab} onSelect={setTab}/>,sidebarTarget)}
 {tab==='max'?<h1 className="slp-screen-reader-heading">Мій навчальний простір · Макс</h1>:<header className="slp-canvas-header"><div><span>Xelay · особисте</span><h1>{LEARNING_TABS.find(item=>item.id===tab)?.label}</h1></div><button type="button" onClick={openMax}><Sparkles size={15}/>До Макса<ArrowRight size={15}/></button></header>}

 {error&&<div className="slp-warning" role="alert"><p>{error}</p><button onClick={()=>setRetry(n=>n+1)}><RefreshCw size={15}/>Спробувати ще раз</button></div>}
 {!status&&!error&&<div className="slp-loading" role="status"><Loader2/>Перевіряємо доступ до навчальних інструментів…</div>}
 {status&&client&&<>{status.audience==='unresolved'&&<div className="slp-warning"><p>Тип підписки цього облікового запису ще не підтверджено. Попередні можливості та збережені матеріали залишаються доступними. Звернися до підтримки для підключення нового тарифу.</p></div>}
 <div className={`slp-section-canvas ${tab==='max'?'is-chat':'is-tools'}`}>
 <Suspense fallback={<div className="slp-loading" role="status"><Loader2/>Відкриваємо інструмент…</div>}>
 <div className="slp-max-canvas" hidden={tab!=='max'} inert={tab!=='max'} style={tab==='max'?undefined:{display:'none'}}><MaxLearningStudio controlsTarget={controlsHost} navigationTarget={sidebarTarget} onNavigate={openMax} navigationActive={tab==='max'} plan={status.audience==='student'?plan:'start'} initialTab="overview" production={{scope:status.scope,canEdit:['plus','max'].includes(status.planId)&&status.audience==='student',renderTutor:props=><ProductionMaxTutorAssistant quotaTarget={quotaHost} status={status} client={client} capturedSources={props.capturedSources} coachAction={props.coachAction} startView={props.startView} profileDisplayName={profileDisplayName} onOpenPreparation={props.onOpenPreparation} onWorkspaceState={props.onWorkspaceState} onStatus={receiveStatus}/>}}/></div>
 {tab==='tools'&&<>{!paid&&<div className="slp-warning"><p>Збережені особисті дані доступні для читання й експорту. Створювати й редагувати можна з активним тарифом Старт.</p><a href="/subscription">Можливості підписки</a></div>}<LearningSectionGuide guideId="tools" target={controlsHost}/><StudentDeskTools storageOwner={userId} emptyStart enabled={paid}/></>}
 {tab==='prepare'&&<><LearningSectionGuide guideId="workspace" target={controlsHost}/><StudyWorkbench plan={plan} storageOwner={userId} emptyStart enabled={paid}/></>}
 {tab==='practice'&&<>{!(paid&&['plus','max'].includes(status.planId))&&<div className="slp-warning"><p>Власна бібліотека та історія залишаються доступними. Для нових тренувань і питань потрібен Плюс або Макс.</p><a href="/subscription">Можливості підписки</a></div>}<LearningSectionGuide guideId="practice" target={controlsHost}/><StudentPracticeLab plan={paid&&['plus','max'].includes(status.planId)?plan:'start'} storageOwner={userId} emptyStart/></>}

 </Suspense></div></>}
 </main>
}
