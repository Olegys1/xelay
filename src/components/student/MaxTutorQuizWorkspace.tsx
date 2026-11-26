import {useEffect,useRef,useState,type KeyboardEvent} from 'react'
import {ArrowLeft,ArrowRight,Check,CheckCheck,ChevronLeft,ChevronRight,Cloud,Grid2X2,LayoutList,Loader2,Maximize2,Minimize2,ShieldCheck,Target,X} from 'lucide-react'
import {answerTutorQuestion,submitTutorQuestion,type TutorProgress,type TutorRun} from '../../lib/maxTutor'
import {checkTutorQuizWorkspace,tutorQuizWorkspaceQuestions,tutorQuizWorkspaceSummary} from '../../lib/maxTutorQuizWorkspace'
import './maxTutorQuizWorkspace.css'

export type MaxTutorQuizSaveState={saving?:boolean;error?:string}
export type MaxTutorQuizWorkspaceProps={open:boolean;run:TutorRun;questionIds?:readonly string[];enabled:boolean;saveState?:MaxTutorQuizSaveState;title?:string;onClose:()=>void;onProgress:(update:(progress:TutorProgress)=>TutorProgress)=>void;onFinish?:()=>void}

/** Personal Max practice only. Closing never submits an official test or discards answers. */
export function MaxTutorQuizWorkspace(props:MaxTutorQuizWorkspaceProps){
 if(!props.open)return null
 return <OpenQuizWorkspace key={props.run.id+':'+(props.questionIds?.join('|')||'all')} {...props}/>
}

function OpenQuizWorkspace({run,questionIds,enabled,saveState,title,onClose,onProgress,onFinish}:MaxTutorQuizWorkspaceProps){
 const questions=tutorQuizWorkspaceQuestions(run.bundle,questionIds),summary=tutorQuizWorkspaceSummary(run.bundle,run.progress,questionIds)
 const [view,setView]=useState<'all'|'single'>('all'),[activeId,setActiveId]=useState(()=>summary.remaining[0]||questions[0]?.id||''),[nativeFullscreen,setNativeFullscreen]=useState(false),[fullscreenNotice,setFullscreenNotice]=useState('')
 const dialog=useRef<HTMLDialogElement>(null),shell=useRef<HTMLDivElement>(null),main=useRef<HTMLElement>(null),result=useRef<HTMLElement>(null),cards=useRef(new Map<string,HTMLElement>()),returned=useRef<HTMLElement|null>(null),finished=useRef(false),closeRef=useRef(onClose)
 closeRef.current=onClose
 const active=questions.find(question=>question.id===activeId)||questions[0],activeIndex=questions.findIndex(question=>question.id===active?.id),visible=view==='all'?questions:active?[active]:[]
 const label=title||run.bundle.title
 useEffect(()=>{
  const modal=dialog.current,screen=shell.current
  if(!modal)return
  const previous=document.activeElement as HTMLElement|null
  returned.current=previous&&typeof previous.focus==='function'?previous:null
  const scrollStyle=document.documentElement?.style,previousOverflow=scrollStyle?.overflow
  if(scrollStyle)scrollStyle.overflow='hidden'
  if(!modal.open)modal.showModal()
  modal.querySelector<HTMLElement>('[data-quiz-autofocus]')?.focus()
  const fullscreenChanged=()=>setNativeFullscreen(document.fullscreenElement===screen)
  document.addEventListener('fullscreenchange',fullscreenChanged)
  return()=>{
   document.removeEventListener('fullscreenchange',fullscreenChanged)
   if(document.fullscreenElement===screen&&typeof document.exitFullscreen==='function')void document.exitFullscreen().catch(()=>{})
   modal.close()
   if(scrollStyle?.overflow==='hidden')scrollStyle.overflow=previousOverflow||''
   if(returned.current?.isConnected)returned.current.focus({preventScroll:true})
  }
 },[])
 function close(){closeRef.current()}
 function trap(event:KeyboardEvent<HTMLDialogElement>){
  if(event.key==='Escape'){event.preventDefault();close();return}
  if(event.key!=='Tab')return
  const elements=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex="0"]')||[]).filter(element=>element.getClientRects().length>0)
  const first=elements[0],last=elements[elements.length-1]
  if(!first){event.preventDefault();dialog.current?.focus();return}
  if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus()}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus()}
 }
 function focusQuestion(id:string){
  setActiveId(id)
  requestAnimationFrame(()=>{const card=cards.current.get(id);if(!card)return;card.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});card.querySelector<HTMLElement>('h2')?.focus({preventScroll:true})})
 }
 function switchView(next:'all'|'single'){setView(next);if(next==='single')requestAnimationFrame(()=>main.current?.scrollTo({top:0,behavior:'auto'}))}
 function select(id:string,index:number){if(enabled)onProgress(progress=>answerTutorQuestion(progress,run.bundle,id,index))}
 function check(id:string){if(enabled)onProgress(progress=>submitTutorQuestion(progress,run.bundle,id))}
 function checkAll(){if(enabled)onProgress(progress=>checkTutorQuizWorkspace(progress,run.bundle,questionIds))}
 function finish(){
  if(!summary.complete)return
  if(enabled&&!finished.current){finished.current=true;onFinish?.()}
  result.current?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'})
  result.current?.focus({preventScroll:true})
 }
 async function fullscreen(){
  const screen=shell.current
  if(!screen)return
  try{
   if(document.fullscreenElement===screen){await document.exitFullscreen();return}
   if(typeof screen.requestFullscreen!=='function')throw Error('unsupported')
   // Fullscreen requires a user gesture and cannot target a dialog element.
   await screen.requestFullscreen({navigationUI:'hide'});setFullscreenNotice('')
  }catch{setFullscreenNotice('У цьому браузері залишаємо зручний режим на всю вкладку.')}
 }
 return <dialog ref={dialog} className="mqq-dialog" aria-label={`Тест: ${label}`} tabIndex={-1} data-max-quiz-workspace="true" onCancel={event=>{event.preventDefault();close()}} onKeyDown={trap}>
  <div ref={shell} className="mqq-shell">
   <header className="mqq-header"><button type="button" className="mqq-back" aria-label="До підготовки" data-quiz-autofocus="true" onClick={close}><ArrowLeft size={18}/><span>До підготовки</span></button><div className="mqq-heading"><span><Target size={14}/>Особистий тест</span><h1>{label}</h1></div><button type="button" className="mqq-fullscreen" aria-label={nativeFullscreen?'Вийти з повного екрана':'Відкрити тест на весь екран'} onClick={()=>void fullscreen()}>{nativeFullscreen?<Minimize2 size={17}/>:<Maximize2 size={17}/>}<span>{nativeFullscreen?'Згорнути':'На весь екран'}</span></button><button type="button" className="mqq-close" aria-label="Закрити вікно тесту" onClick={close}><X size={20}/></button></header>
   <div className="mqq-toolbar"><div className="mqq-view" role="group" aria-label="Вигляд тесту"><button type="button" aria-pressed={view==='all'} onClick={()=>switchView('all')}><LayoutList size={15}/>Усі запитання</button><button type="button" aria-pressed={view==='single'} onClick={()=>switchView('single')}><Grid2X2 size={15}/>По одному</button></div><span className={`mqq-save ${saveState?.error?'is-error':''}`} role="status">{saveState?.error?<ShieldCheck size={14}/>:saveState?.saving?<Loader2 size={14}/>:<Cloud size={14}/>}<span>{saveState?.error?'Є незбережені відповіді':saveState?.saving?'Зберігаємо відповіді…':saveState?'Збереження в Xelay підключено':'Відповіді залишаються в цій розмові'}</span></span></div>
   {saveState?.error&&<div className="mqq-save-warning" role="alert"><strong>Не закривай вкладку, поки відповіді не збережено.</strong><p>{saveState.error}</p><button type="button" onClick={close}>Повернутися до відновлення збереження<ArrowRight size={14}/></button></div>}
   {fullscreenNotice&&<p className="mqq-fullscreen-notice" role="status">{fullscreenNotice}</p>}
   <div className="mqq-layout">
    <aside className="mqq-sidebar" aria-label="Огляд запитань"><div className="mqq-progress-heading"><strong>{summary.checked}<small>/{summary.total}</small></strong><span>перевірено</span></div><progress aria-label="Перевірені відповіді" max={Math.max(1,summary.total)} value={summary.checked}/><nav className="mqq-map" aria-label="Перейти до запитання">{questions.map((question,index)=>{const checked=run.progress.submitted.includes(question.id),selected=run.progress.answers[question.id]!==undefined;return <button type="button" key={question.id} className={checked?'is-checked':selected?'is-selected':''} aria-current={question.id===active?.id?'location':undefined} aria-label={`Запитання ${index+1}: ${checked?'перевірено':selected?'відповідь обрана':'без відповіді'}`} onClick={()=>focusQuestion(question.id)}>{index+1}{checked&&<Check size={10}/>}</button>})}</nav><div className="mqq-legend"><span><i className="is-selected"/>Відповідь обрана</span><span><i className="is-checked"/>Перевірено</span></div><p>Можна відповідати в довільному порядку й повертатися до попередніх запитань.</p></aside>
    <main ref={main} className="mqq-main" tabIndex={-1}>
     <div className="mqq-content" data-quiz-view={view}><div className="mqq-intro"><span>Твій простір для практики</span><h2>{view==='all'?'Увесь тест перед тобою.':'Одне запитання — вся увага.'}</h2><p>{summary.total} запитань · {summary.selected} відповідей обрано · перевіряй кожну окремо або всі разом.</p></div>
      {!questions.length&&<div className="mqq-empty" role="status">У цьому тренуванні немає доступних запитань. Повернись до плану або чату.</div>}
      {visible.map(question=>{const index=questions.findIndex(item=>item.id===question.id),checked=run.progress.submitted.includes(question.id),answer=run.progress.answers[question.id],source=question.sourceId?run.request.sources.find(item=>item.id===question.sourceId):undefined;return <section className="mqq-question" key={question.id} ref={node=>{if(node)cards.current.set(question.id,node);else cards.current.delete(question.id)}} data-quiz-question={question.id}><div className="mqq-question-label"><span>Запитання {index+1}</span>{checked?<small className={answer===question.correctIndex?'is-correct':'is-wrong'}><Check size={12}/>{answer===question.correctIndex?'Правильно':'Варто повторити'}</small>:answer!==undefined?<small>Відповідь обрана</small>:<small>Ще без відповіді</small>}</div><h2 tabIndex={-1}>{question.text}</h2><div className="mqq-options" role="group" aria-label={`Варіанти відповіді на запитання ${index+1}`}>{question.options.map((option,at)=><button type="button" key={at} disabled={!enabled||checked} aria-pressed={answer===at} className={`${answer===at?'is-selected':''} ${checked&&question.correctIndex===at?'is-correct':''} ${checked&&answer===at&&question.correctIndex!==at?'is-wrong':''}`} onClick={()=>select(question.id,at)}><span>{String.fromCharCode(65+at)}</span><span>{option}</span>{checked&&question.correctIndex===at&&<Check size={17}/>}</button>)}</div>{checked?<div className={`mqq-explanation ${answer===question.correctIndex?'is-correct':''}`} role="status"><strong>{answer===question.correctIndex?'Так, правильно.':'Розберімо відповідь.'}</strong><p>{question.explanation}</p>{source&&<small>{source.title}{source.page?` · с. ${source.page}`:''}</small>}</div>:<button type="button" className="mqq-check" disabled={!enabled||answer===undefined} onClick={()=>check(question.id)}>Перевірити відповідь<Check size={15}/></button>}</section>})}
      {view==='single'&&active&&<div className="mqq-single-nav"><button type="button" disabled={activeIndex<=0} onClick={()=>focusQuestion(questions[activeIndex-1].id)}><ChevronLeft size={16}/>Попереднє</button><span>{activeIndex+1}/{questions.length}</span><button type="button" disabled={activeIndex>=questions.length-1} onClick={()=>focusQuestion(questions[activeIndex+1].id)}>Наступне<ChevronRight size={16}/></button></div>}
      {summary.complete&&<section ref={result} className="mqq-result" aria-label="Підсумок особистого тесту" tabIndex={-1}><span className="mqq-result-icon"><CheckCheck size={26}/></span><div><span>Тренування перевірено</span><h2>{summary.correct} із {summary.total} правильно</h2><p>{summary.correct===summary.total?'Упевнено рухаєшся далі. Повернися до плану або продовжуй розмову з Максом.':`${summary.wrong.length} запитань варто повторити. Пояснення залишаються під відповідями — розбери їх у своєму темпі.`}</p><small>Особисте тренування за ключем ШІ. Оцінки в журналі не змінюються.</small></div></section>}
      <p className="mqq-context">{run.request.sources.length?'Практика за обраними тобою матеріалами.':'Практика за темою на основі загальних знань.'} Ключ ШІ варто звіряти з навчальними джерелами.</p>
     </div>
    </main>
   </div>
   <footer className="mqq-footer"><span>{summary.selected}/{summary.total} відповідей обрано <em>·</em> {summary.checked} перевірено</span><div>{summary.complete?<button type="button" className="mqq-primary" onClick={finish}>Показати підсумок<CheckCheck size={16}/></button>:<button type="button" className="mqq-primary" disabled={!enabled||summary.selected===summary.checked} onClick={checkAll}>Перевірити обрані відповіді<Check size={16}/></button>}<button type="button" onClick={close}>Повернутися<ArrowRight size={16}/></button></div></footer>
  </div>
 </dialog>
}
