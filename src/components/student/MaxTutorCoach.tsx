import {useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties} from 'react'
import {createPortal} from 'react-dom'
import {Bell,BookOpen,ChevronDown,Clock3,Eye,Layers3,Pause,Settings2,ShieldCheck,Sparkles,X} from 'lucide-react'
import {COACH_BLOCKS,MAX_TUTOR_COACH_EVENT,advanceCoach,coachStorageKey,dismissCoachMessage,normalizeCoachScope,pauseCoach,parseCoachState,reduceCoachEvent,sameCoachScope,setCoachEnabled,snoozeCoachMessage,storeCoachState,type CoachAction,type CoachBlock,type CoachScope,type CoachState} from '../../lib/maxTutorCoach'
import { XelayMini } from '../XelayMini'
import './maxTutorCoach.css'
export type MaxTutorCoachProps={enabled?:boolean;scope?:CoachScope;currentBlock:CoachBlock;onAction:(action:CoachAction)=>void;portalPanels?:boolean;visible?:boolean}
export function MaxTutorCoach({enabled=true,scope,currentBlock,onAction,portalPanels=false,visible=true}:MaxTutorCoachProps){
 const safe=normalizeCoachScope(scope)
 if(!enabled||!safe)return null
 return <ScopedMaxTutorCoach key={`${safe.userId}:${safe.sessionId}`} scope={safe} currentBlock={currentBlock} onAction={onAction} portalPanels={portalPanels} visible={visible}/>
}
function ScopedMaxTutorCoach({scope,currentBlock,onAction,portalPanels,visible}:{scope:CoachScope;currentBlock:CoachBlock;onAction:(action:CoachAction)=>void;portalPanels:boolean;visible:boolean}){
 const key=coachStorageKey(scope),[state,setState]=useState<CoachState>(()=>{try{return parseCoachState(localStorage.getItem(key),scope)}catch{return parseCoachState(null,scope)}}),[settings,setSettings]=useState(false),[collapsed,setCollapsed]=useState(false),[announcement,setAnnouncement]=useState(''),[storageFailed,setStorageFailed]=useState(false)
 const latest=useRef(state),announced=useRef(''),launcher=useRef<HTMLButtonElement>(null),popup=useRef<HTMLDivElement>(null),settingsClose=useRef<HTMLButtonElement>(null),shown=useRef(visible),popupId=useId()
 const [placement,setPlacement]=useState<CSSProperties>({visibility:'hidden'});latest.current=state;shown.current=visible
 const now=Date.now(),paused=state.pausedUntil>now,message=visible&&!settings&&!collapsed&&!paused?state.messages[state.messages.length-1]:undefined
 useEffect(()=>{try{localStorage.setItem(key,storeCoachState(state));setStorageFailed(false)}catch{setStorageFailed(true)}},[key,state])
 useEffect(()=>{const flush=()=>{try{localStorage.setItem(key,storeCoachState(latest.current))}catch{}};window.addEventListener('pagehide',flush);return()=>{flush();window.removeEventListener('pagehide',flush)}},[key])
 useEffect(()=>{const receive=(event:Event)=>{const detail=(event as CustomEvent).detail;if(!detail||typeof detail!=='object'||Object.keys(detail).some(k=>!['scope','event'].includes(k))||!sameCoachScope(detail.scope,scope))return;setState(s=>reduceCoachEvent(s,detail.event))};window.addEventListener(MAX_TUTOR_COACH_EVENT,receive);return()=>window.removeEventListener(MAX_TUTOR_COACH_EVENT,receive)},[scope.userId,scope.sessionId])
 useEffect(()=>{setState(s=>reduceCoachEvent(s,{type:'block',block:currentBlock}))},[currentBlock,state.enabled,scope.userId,scope.sessionId])
 useEffect(()=>{if(!state.enabled)return;const check=()=>setState(s=>advanceCoach(s));const timer=setInterval(check,15000);const wake=()=>{if(document.visibilityState==='visible')check()};document.addEventListener('visibilitychange',wake);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',wake)}},[state.enabled])
 useEffect(()=>{if(!visible||!message||announced.current===message.id)return;announced.current=message.id;setAnnouncement(`${message.title} ${message.body}`)},[message?.id,visible])

 const panelOpen=visible&&(settings||!!message&&state.enabled)
 function restoreFocus(){if(launcher.current?.isConnected)launcher.current.focus({preventScroll:true})}
 function closeFooter(){setSettings(false);setCollapsed(true);restoreFocus()}
 function closeSettings(){if(portalPanels)closeFooter();else setSettings(false)}
 function dismissMessage(){if(message)setState(s=>dismissCoachMessage(s,message.id));if(portalPanels){setCollapsed(true);restoreFocus()}}
 useEffect(()=>{if(!visible){setSettings(false);setCollapsed(true);setAnnouncement('')}},[visible])
 useLayoutEffect(()=>{
  if(!portalPanels||!panelOpen)return
  const place=()=>{
   const anchor=launcher.current;if(!anchor)return
   const rect=anchor.getBoundingClientRect(),viewport=window.visualViewport,width=viewport?.width||window.innerWidth,height=viewport?.height||window.innerHeight,offsetLeft=viewport?.offsetLeft||0,offsetTop=viewport?.offsetTop||0,inset=12
   const panelWidth=Math.min(350,Math.max(0,width-inset*2)),mobile=width<=700
   const desiredLeft=mobile?offsetLeft+inset:rect.right+inset+panelWidth<=offsetLeft+width-inset?rect.right+inset:rect.left
   const left=Math.max(offsetLeft+inset,Math.min(desiredLeft,offsetLeft+width-panelWidth-inset))
   const topLimit=offsetTop+inset,bottomEdge=Math.max(topLimit+44,Math.min(mobile?rect.top-inset:rect.bottom,offsetTop+height-inset)),maxHeight=Math.max(44,Math.min(550,bottomEdge-topLimit))
   const next:CSSProperties={left,top:bottomEdge,maxHeight,width:panelWidth,visibility:'visible',transform:'translateY(-100%)'}
   setPlacement(prior=>prior.left===next.left&&prior.top===next.top&&prior.maxHeight===next.maxHeight&&prior.width===next.width&&prior.visibility===next.visibility?prior:next)
  }
  place();window.addEventListener('resize',place);window.addEventListener('scroll',place,true)
  const viewport=window.visualViewport;viewport?.addEventListener('resize',place);viewport?.addEventListener('scroll',place)
  const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(place);if(launcher.current)observer?.observe(launcher.current)
  return()=>{window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true);viewport?.removeEventListener('resize',place);viewport?.removeEventListener('scroll',place);observer?.disconnect()}
 },[portalPanels,panelOpen,settings])
 useLayoutEffect(()=>{if(portalPanels&&visible&&settings&&placement.visibility==='visible')settingsClose.current?.focus({preventScroll:true})},[portalPanels,visible,settings,placement.visibility])
 useEffect(()=>{
  if(!portalPanels||!panelOpen)return
  const outside=(event:PointerEvent)=>{const target=event.target as Node|null;if(target&&!popup.current?.contains(target)&&!launcher.current?.contains(target))closeFooter()}
  const escape=(event:KeyboardEvent)=>{if(event.key!=='Escape'||event.defaultPrevented)return;const target=event.target as Element|null;if(target?.closest?.('[aria-modal="true"],dialog[open]')&&!popup.current?.contains(target))return;event.preventDefault();closeFooter()}
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',escape)
  return()=>{document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',escape)}
 },[portalPanels,panelOpen])
 function choose(action:CoachAction){if(!message||!shown.current)return;setState(s=>dismissCoachMessage(s,message.id));if(portalPanels)closeFooter();onAction(action)}

 function setEnabled(value:boolean){setState(s=>setCoachEnabled(s,value));setCollapsed(false)}
 const snooze=()=>{if(message)setState(s=>snoozeCoachMessage(s,message.id));if(portalPanels)closeFooter()}
 const panels=<>
  {settings&&<section className="mtc-settings" aria-label="Налаштування помічника поруч" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();closeSettings()}}}>
   <header><span className="mtc-symbol"><XelayMini size={30}/></span><div><span>СТУДІЯ МАКС</span><h2>Xelay Mini поруч</h2></div><button type="button" ref={settingsClose} aria-label="Закрити налаштування помічника" onClick={closeSettings}><X size={17}/></button></header>
   <p className="mtc-intro">Нагадування й підказки під час роботи з помічником.</p>
   <label className="mtc-preference"><span><strong>Підказки за моїми діями</strong><small>Розділ, кількість кроків і результат власного тренування.</small></span><input type="checkbox" checked={state.enabled} onChange={e=>setEnabled(e.target.checked)}/><i aria-hidden="true"/></label>
   <div className="mtc-privacy"><ShieldCheck size={16}/><p>Тексти матеріалів, чернетки та весь екран не читаються автоматично. Джерела для моделі обираєш окремо в помічнику й сам надсилаєш запит.</p></div>
   <div className="mtc-context"><Eye size={15}/><span>Зараз відкрито</span><strong>{COACH_BLOCKS[currentBlock]}</strong></div>
   {state.enabled?<div className="mtc-settings-actions">{paused?<button type="button" onClick={()=>setState(s=>pauseCoach(s,Date.now(),0))}><Bell size={15}/>Відновити підказки</button>:<button type="button" onClick={()=>setState(s=>pauseCoach(s))}><Pause size={15}/>Пауза на годину</button>}<button type="button" onClick={()=>{setCollapsed(false);closeSettings()}}>До роботи<ChevronDown size={15}/></button></div>:<button type="button" className="mtc-enable" onClick={()=>{setEnabled(true);closeSettings()}}><Sparkles size={16}/>Увімкнути підказки</button>}
   <footer><Clock3 size={14}/><span>Нагадування працюють, коли цей простір відкритий. Підказки самі не запускають платні запити.</span></footer>
   {storageFailed&&<p className="mtc-storage" role="status">Пам’ять пристрою недоступна. Налаштування діють до закриття цього простору.</p>}
  </section>}
  {message&&state.enabled&&<section key={message.id} className="mtc-card" aria-label={message.title} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();if(portalPanels)closeFooter();else dismissMessage()}}}>
   <div className="mtc-card-top"><span><i/>Автоматична підказка</span><button type="button" aria-label="Закрити цю підказку" onClick={dismissMessage}><X size={16}/></button></div>
   <div className="mtc-card-body"><span className="mtc-card-icon"><BookOpen size={21}/></span><h2>{message.title}</h2><p>{message.body}</p></div>
   <div className="mtc-card-actions"><button type="button" className="mtc-primary" onClick={()=>choose(message.action)}>{message.actionLabel}<Layers3 size={14}/></button><button type="button" aria-label="Нагадати про цю підказку через десять хвилин" onClick={snooze}><Clock3 size={16}/></button></div>
   <button type="button" className="mtc-collapse" onClick={()=>{setCollapsed(true);if(portalPanels)restoreFocus()}}><ChevronDown size={13}/>Згорнути підказки</button>
  </section>}
 </>
 if(!visible)return null
 return <aside className={portalPanels?'mtc mtc--footer':'mtc'} aria-label="Контекстний помічник Xelay Mini" data-max-tutor-coach>
  <span className="mtc-sr" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
  {portalPanels?(panelOpen&&typeof document!=='undefined'&&createPortal(<div ref={popup} id={popupId} className="mtc mtc-footer-popup" style={placement} role="dialog" aria-modal={false} aria-label={settings?'Налаштування помічника поруч':message?.title}>{panels}</div>,document.body)):panels}
  <div className="mtc-dock"><button ref={launcher} type="button" className={`mtc-launch ${state.enabled?'active':''}`} aria-expanded={portalPanels?panelOpen:settings} aria-controls={portalPanels&&panelOpen?popupId:undefined} aria-label="Налаштувати помічника поруч" onClick={()=>{if(settings){if(portalPanels)closeFooter();else setSettings(false)}else setSettings(true)}}><span className="mtc-launch-symbol"><XelayMini size={28}/></span><span><strong>Xelay Mini поруч</strong><small>{!state.enabled?'Увімкни, коли зручно':paused?'Підказки на паузі':collapsed?'Підказки згорнуто':'Працюємо у твоєму темпі'}</small></span>{state.enabled&&state.messages.length>0&&<b>{state.messages.length}</b>}<Settings2 size={15}/></button>{state.enabled&&collapsed&&!!state.messages.length&&!settings&&<button className="mtc-expand" type="button" aria-label="Розгорнути підказки" onClick={()=>setCollapsed(false)}><Bell size={17}/></button>}</div>
 </aside>
}
export default MaxTutorCoach
