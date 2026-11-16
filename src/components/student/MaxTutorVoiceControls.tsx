import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {Mic,Pause,Play,Square,Volume2,X} from 'lucide-react'
import {createTutorDictation,createTutorNarrator,emptyTutorDictationState,emptyTutorNarrationState,getTutorBrowserMedia,MAX_TUTOR_DICTATION_CHARACTERS,type TutorBrowserVoice,type TutorDictationState,type TutorNarrationState} from '../../lib/maxTutorMedia'
import './maxTutorVoiceControls.css'

export type MaxTutorVoiceControlsProps={
 ownerKey:string
 text?:string
 narrationText?:string
 narrationKind?:'answer'|'dialogue'
 disabled?:boolean
 variant?:'composer'|'default'
 onDictation?:(text:string)=>void
}

/** Real browser speech only. Mounting this component never asks for microphone access. */
export function MaxTutorVoiceControls(props:MaxTutorVoiceControlsProps){return <ScopedTutorVoiceControls key={props.ownerKey} {...props}/>}
function ScopedTutorVoiceControls({ownerKey,text='',narrationText,narrationKind='answer',disabled=false,variant='default',onDictation}:MaxTutorVoiceControlsProps){
 const [capabilities,setCapabilities]=useState(()=>({dictation:false,speech:false})),[panel,setPanel]=useState<'mic'|'audio'|null>(null),[consent,setConsent]=useState(false)
 const [dictation,setDictation]=useState<TutorDictationState>(emptyTutorDictationState),[narration,setNarration]=useState<TutorNarrationState>(emptyTutorNarrationState),[voices,setVoices]=useState<TutorBrowserVoice[]>([]),[voiceId,setVoiceId]=useState('')
 const [position,setPosition]=useState({left:12,top:12,width:320})
 const dictationRef=useRef<ReturnType<typeof createTutorDictation>|null>(null),narratorRef=useRef<ReturnType<typeof createTutorNarrator>|null>(null),callback=useRef(onDictation),anchor=useRef<HTMLButtonElement|null>(null),panelRef=useRef<HTMLDivElement|null>(null)
 const micButton=useRef<HTMLButtonElement|null>(null),audioButton=useRef<HTMLButtonElement|null>(null),uid=useId(),titleId=`tutor-media-title-${uid}`,panelId=`tutor-media-panel-${uid}`
 callback.current=onDictation
 const spokenText=narrationText??text,listening=dictation.phase!=='idle',playing=narration.phase==='speaking'||narration.phase==='paused'
 useEffect(()=>{
  let active=true
  const media=ownerKey?getTutorBrowserMedia():{dictation:null,speech:null}
  setCapabilities({dictation:!!media.dictation,speech:!!media.speech})
  const dictationController=createTutorDictation({factory:media.dictation,onUpdate:setDictation,onComplete:value=>{callback.current?.(value);setPanel(null)}})
  const narrationController=createTutorNarrator({speech:media.speech,onUpdate:setNarration})
  dictationRef.current=dictationController;narratorRef.current=narrationController
  const updateVoices=()=>{if(!active)return;try{const values=media.speech?.synthesis.getVoices()||[];setVoices(values.slice(0,200))}catch{setVoices([])}}
  updateVoices();media.speech?.synthesis.addEventListener?.('voiceschanged',updateVoices)
  return()=>{active=false;dictationController.dispose();narrationController.dispose();media.speech?.synthesis.removeEventListener?.('voiceschanged',updateVoices);dictationRef.current=null;narratorRef.current=null}
 },[ownerKey])
 useEffect(()=>{if(disabled){dictationRef.current?.cancel();narratorRef.current?.stop();setPanel(null)}},[disabled])
 useEffect(()=>{narratorRef.current?.stop();dictationRef.current?.cancel()},[spokenText])
 function close(){dictationRef.current?.cancel();narratorRef.current?.stop();setPanel(null);anchor.current?.focus({preventScroll:true})}
 function open(next:'mic'|'audio',button:HTMLButtonElement|null){
  if(disabled)return
  if(panel===next){close();return}
  dictationRef.current?.cancel();anchor.current=button;setPanel(next)
 }
 useLayoutEffect(()=>{
  if(!panel||!panelRef.current)return
  const place=()=>{
   const button=anchor.current,card=panelRef.current;if(!button||!card)return
   const rect=button.getBoundingClientRect(),width=Math.min(340,Math.max(200,window.innerWidth-24)),height=Math.min(card.getBoundingClientRect().height,window.innerHeight-24)
   const left=Math.max(12,Math.min(rect.left,window.innerWidth-width-12)),above=rect.top-height-10,top=above>=12?above:Math.max(12,Math.min(rect.bottom+10,window.innerHeight-height-12))
   setPosition(old=>old.left===left&&old.top===top&&old.width===width?old:{left,top,width})
  }
  place();panelRef.current.focus({preventScroll:true})
  window.addEventListener('resize',place);window.addEventListener('scroll',place,true)
  const observer=typeof ResizeObserver==='function'?new ResizeObserver(place):null;observer?.observe(panelRef.current)
  return()=>{observer?.disconnect();window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true)}
 },[panel])
 useEffect(()=>{
  if(!panel)return
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close()}}
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!panelRef.current?.contains(event.target)&&!micButton.current?.contains(event.target)&&!audioButton.current?.contains(event.target)){dictationRef.current?.cancel();setPanel(null)}}
  window.addEventListener('keydown',key);window.addEventListener('pointerdown',outside)
  return()=>{window.removeEventListener('keydown',key);window.removeEventListener('pointerdown',outside)}
 },[panel])
 const micTitle=!capabilities.dictation?'Диктування недоступне в цьому браузері':listening?'Завершити диктування':'Надиктувати повідомлення'
 const audioTitle=!capabilities.speech?'Озвучення недоступне в цьому браузері':!spokenText.trim()?'Спочатку отримай текстову відповідь':playing?'Керувати озвученням':narrationKind==='dialogue'?'Прослухати діалог голосом браузера':'Озвучити останню відповідь голосом браузера'
 return <div className={`mtv mtv--${variant}`}>
  {onDictation&&<button ref={micButton} type="button" className={`mtv-icon${listening?' mtv-listening':''}`} aria-label={micTitle} title={micTitle} aria-haspopup="dialog" aria-expanded={panel==='mic'} aria-controls={panel==='mic'?panelId:undefined} disabled={disabled||!capabilities.dictation} onClick={()=>{if(listening)dictationRef.current?.stop();else open('mic',micButton.current)}}>{listening?<Square size={15}/>:<Mic size={17}/>}</button>}
  <button ref={audioButton} type="button" className={`mtv-icon${playing?' mtv-playing':''}`} aria-label={audioTitle} title={audioTitle} aria-haspopup="dialog" aria-expanded={panel==='audio'} aria-controls={panel==='audio'?panelId:undefined} disabled={disabled||!capabilities.speech||!spokenText.trim()} onClick={()=>open('audio',audioButton.current)}><Volume2 size={17}/></button>
  <span className="mtv-sr" role="status" aria-live="polite">{listening?'Мікрофон увімкнено. Натисни завершення диктування, щоб додати текст.':playing?'Озвучення браузером триває.':''}</span>
  {panel&&typeof document!=='undefined'&&createPortal(<div ref={panelRef} id={panelId} className="mtv-panel" style={position} role="dialog" aria-labelledby={titleId} tabIndex={-1}>
   <header><h3 id={titleId}>{panel==='mic'?'Диктування українською':narrationKind==='dialogue'?'Прослухати діалог':'Озвучити відповідь'}</h3><button type="button" className="mtv-close" aria-label="Закрити голосові інструменти" onClick={close}><X size={17}/></button></header>
   {panel==='mic'?<>
    <p>Браузер розпізнає мовлення й додасть текст у поле повідомлення. Це саме по собі не надсилає повідомлення помічнику.</p>
    <p className="mtv-notice">Розпізнавання може передавати аудіо сервісу браузера й потребувати інтернету. Xelay не записує та не завантажує аудіофайл. Мікрофон вмикається лише після твого натискання.</p>
    <label className="mtv-consent"><input type="checkbox" checked={consent} disabled={listening} onChange={event=>setConsent(event.target.checked)}/><span>Дозволяю браузеру розпізнати моє мовлення.</span></label>
    <div className="mtv-actions">{listening?<button type="button" className="mtv-primary" onClick={()=>dictationRef.current?.stop()} disabled={dictation.phase==='stopping'}><Square size={14}/>{dictation.phase==='stopping'?'Завершуємо…':'Завершити й додати текст'}</button>:<button type="button" className="mtv-primary" disabled={!consent||disabled||!capabilities.dictation} onClick={()=>{narratorRef.current?.stop();dictationRef.current?.start(consent)}}><Mic size={15}/>Почати диктування</button>}</div>
    {dictation.transcript&&<p className="mtv-transcript" aria-label="Розпізнаний текст">{dictation.transcript}</p>}
    <small>До {MAX_TUTOR_DICTATION_CHARACTERS} символів і до хвилини за раз. Лише завершені фрагменти додаються до повідомлення.</small>
    {dictation.limitReached&&<p className="mtv-notice" role="status">Досягнуто ліміт довжини. Перевір текст у полі повідомлення.</p>}
    {dictation.error&&<p className="mtv-error" role="alert">{dictation.error}</p>}
   </>:<>
    <p>{narrationKind==='dialogue'?'Текстовий діалог читається доступним голосом браузера.':'Текст відповіді читається доступним голосом браузера.'} Це не створення аудіофайлу чи MP3.</p>
    <label className="mtv-voice-label">Голос браузера<select aria-label="Голос браузера для озвучення" value={voiceId} onChange={event=>{narratorRef.current?.stop();setVoiceId(event.target.value)}}><option value="">Голос пристрою за замовчуванням</option>{voices.map((voice,index)=><option key={`${voice.voiceURI}:${index}`} value={voice.voiceURI}>{voice.name} · {voice.lang}{voice.localService?' · на пристрої':''}</option>)}</select></label>
    <small>Доступні голоси залежать від браузера й пристрою. Для нелокальних голосів текст може обробляти сервіс браузера. Автоматичного відтворення немає.</small>
    <div className="mtv-actions">{narration.phase==='speaking'?<button type="button" onClick={()=>narratorRef.current?.pause()}><Pause size={15}/>Пауза</button>:narration.phase==='paused'?<button type="button" className="mtv-primary" onClick={()=>narratorRef.current?.resume()}><Play size={15}/>Продовжити</button>:<button type="button" className="mtv-primary" disabled={disabled||!spokenText.trim()} onClick={()=>{dictationRef.current?.cancel();const voice=voices.find(value=>value.voiceURI===voiceId)||null;narratorRef.current?.play(spokenText,voice,true)}}><Play size={15}/>Прослухати</button>}{playing&&<button type="button" onClick={()=>narratorRef.current?.stop()}><Square size={14}/>Зупинити</button>}</div>
    {playing&&<small role="status">Фрагмент {narration.chunk} із {narration.total}. Озвучення можна зупинити будь-коли.</small>}
    {narration.error&&<p className="mtv-error" role="alert">{narration.error}</p>}
   </>}
  </div>,document.body)}
 </div>
}
