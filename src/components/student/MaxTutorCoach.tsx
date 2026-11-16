import {useEffect,useRef,useState} from 'react'
import {Bell,BookOpen,ChevronDown,Clock3,Eye,Layers3,Pause,Settings2,ShieldCheck,Sparkles,X} from 'lucide-react'
import {COACH_BLOCKS,MAX_TUTOR_COACH_EVENT,advanceCoach,coachStorageKey,dismissCoachMessage,normalizeCoachScope,pauseCoach,parseCoachState,reduceCoachEvent,sameCoachScope,setCoachEnabled,snoozeCoachMessage,storeCoachState,type CoachAction,type CoachBlock,type CoachScope,type CoachState} from '../../lib/maxTutorCoach'
import './maxTutorCoach.css'
export type MaxTutorCoachProps={enabled?:boolean;scope?:CoachScope;currentBlock:CoachBlock;onAction:(action:CoachAction)=>void}
export function MaxTutorCoach({enabled=true,scope,currentBlock,onAction}:MaxTutorCoachProps){
 const safe=normalizeCoachScope(scope)
 if(!enabled||!safe)return null
 return <ScopedMaxTutorCoach key={`${safe.userId}:${safe.sessionId}`} scope={safe} currentBlock={currentBlock} onAction={onAction}/>
}
function ScopedMaxTutorCoach({scope,currentBlock,onAction}:{scope:CoachScope;currentBlock:CoachBlock;onAction:(action:CoachAction)=>void}){
 const key=coachStorageKey(scope),[state,setState]=useState<CoachState>(()=>{try{return parseCoachState(localStorage.getItem(key),scope)}catch{return parseCoachState(null,scope)}}),[settings,setSettings]=useState(false),[collapsed,setCollapsed]=useState(false),[announcement,setAnnouncement]=useState(''),[storageFailed,setStorageFailed]=useState(false)
 const latest=useRef(state),announced=useRef('');latest.current=state
 const now=Date.now(),paused=state.pausedUntil>now,message=!settings&&!collapsed&&!paused?state.messages[state.messages.length-1]:undefined
 useEffect(()=>{try{localStorage.setItem(key,storeCoachState(state));setStorageFailed(false)}catch{setStorageFailed(true)}},[key,state])
 useEffect(()=>{const flush=()=>{try{localStorage.setItem(key,storeCoachState(latest.current))}catch{}};window.addEventListener('pagehide',flush);return()=>{flush();window.removeEventListener('pagehide',flush)}},[key])
 useEffect(()=>{const receive=(event:Event)=>{const detail=(event as CustomEvent).detail;if(!detail||typeof detail!=='object'||Object.keys(detail).some(k=>!['scope','event'].includes(k))||!sameCoachScope(detail.scope,scope))return;setState(s=>reduceCoachEvent(s,detail.event))};window.addEventListener(MAX_TUTOR_COACH_EVENT,receive);return()=>window.removeEventListener(MAX_TUTOR_COACH_EVENT,receive)},[scope.userId,scope.sessionId])
 useEffect(()=>{setState(s=>reduceCoachEvent(s,{type:'block',block:currentBlock}))},[currentBlock,state.enabled,scope.userId,scope.sessionId])
 useEffect(()=>{if(!state.enabled)return;const check=()=>setState(s=>advanceCoach(s));const timer=setInterval(check,15000);const wake=()=>{if(document.visibilityState==='visible')check()};document.addEventListener('visibilitychange',wake);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',wake)}},[state.enabled])
 useEffect(()=>{if(!message||announced.current===message.id)return;announced.current=message.id;setAnnouncement(`${message.title} ${message.body}`)},[message?.id])
 function choose(action:CoachAction){if(!message)return;setState(s=>dismissCoachMessage(s,message.id));onAction(action)}
 function setEnabled(value:boolean){setState(s=>setCoachEnabled(s,value));setCollapsed(false)}
 const snooze=()=>{if(message)setState(s=>snoozeCoachMessage(s,message.id))}
 return <aside className="mtc" aria-label="Контекстний помічник Макс" data-max-tutor-coach>
  <span className="mtc-sr" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  {settings&&<section className="mtc-settings" aria-label="Налаштування помічника поруч" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setSettings(false)}}}>
   <header><span className="mtc-symbol"><Sparkles size={18}/></span><div><span>СТУДІЯ МАКС</span><h2>Помічник поруч</h2></div><button type="button" aria-label="Закрити налаштування помічника" onClick={()=>setSettings(false)}><X size={17}/></button></header>
   <p className="mtc-intro">Підказки у потрібний момент — поки ти працюєш у студії.</p>
   <label className="mtc-preference"><span><strong>Підказки за моїми діями</strong><small>Розділ, кількість кроків і результат власного тренування.</small></span><input type="checkbox" checked={state.enabled} onChange={e=>setEnabled(e.target.checked)}/><i aria-hidden="true"/></label>
   <div className="mtc-privacy"><ShieldCheck size={16}/><p>Тексти матеріалів, чернетки та весь екран не читаються автоматично. Джерела для моделі обираєш окремо в помічнику й сам надсилаєш запит.</p></div>
   <div className="mtc-context"><Eye size={15}/><span>Зараз відкрито</span><strong>{COACH_BLOCKS[currentBlock]}</strong></div>
   {state.enabled?<div className="mtc-settings-actions">{paused?<button type="button" onClick={()=>setState(s=>pauseCoach(s,Date.now(),0))}><Bell size={15}/>Відновити підказки</button>:<button type="button" onClick={()=>setState(s=>pauseCoach(s))}><Pause size={15}/>Пауза на годину</button>}<button type="button" onClick={()=>{setCollapsed(false);setSettings(false)}}>До роботи<ChevronDown size={15}/></button></div>:<button type="button" className="mtc-enable" onClick={()=>{setEnabled(true);setSettings(false)}}><Sparkles size={16}/>Увімкнути підказки</button>}
   <footer><Clock3 size={14}/><span>Нагадування працюють, коли цей простір відкритий. Підказки самі не запускають платні запити.</span></footer>
   {storageFailed&&<p className="mtc-storage" role="status">Пам’ять пристрою недоступна. Налаштування діють до закриття цього простору.</p>}
  </section>}
  {message&&state.enabled&&<section key={message.id} className="mtc-card" aria-label={message.title} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();setState(s=>dismissCoachMessage(s,message.id))}}}>
   <div className="mtc-card-top"><span><i/>Автоматична підказка</span><button type="button" aria-label="Закрити цю підказку" onClick={()=>setState(s=>dismissCoachMessage(s,message.id))}><X size={16}/></button></div>
   <div className="mtc-card-body"><span className="mtc-card-icon"><BookOpen size={21}/></span><h2>{message.title}</h2><p>{message.body}</p></div>
   <div className="mtc-card-actions"><button type="button" className="mtc-primary" onClick={()=>choose(message.action)}>{message.actionLabel}<Layers3 size={14}/></button><button type="button" aria-label="Нагадати про цю підказку через десять хвилин" onClick={snooze}><Clock3 size={16}/></button></div>
   <button type="button" className="mtc-collapse" onClick={()=>setCollapsed(true)}><ChevronDown size={13}/>Згорнути підказки</button>
  </section>}
  <div className="mtc-dock"><button type="button" className={`mtc-launch ${state.enabled?'active':''}`} aria-expanded={settings} aria-label="Налаштувати помічника поруч" onClick={()=>setSettings(v=>!v)}><span className="mtc-launch-symbol"><Sparkles size={18}/></span><span><strong>Помічник поруч</strong><small>{!state.enabled?'Увімкни, коли зручно':paused?'Підказки на паузі':collapsed?'Підказки згорнуто':'Працюємо у твоєму темпі'}</small></span>{state.enabled&&state.messages.length>0&&<b>{state.messages.length}</b>}<Settings2 size={15}/></button>{state.enabled&&collapsed&&!!state.messages.length&&!settings&&<button className="mtc-expand" type="button" aria-label="Розгорнути підказки" onClick={()=>setCollapsed(false)}><Bell size={17}/></button>}</div>
 </aside>
}
export default MaxTutorCoach
