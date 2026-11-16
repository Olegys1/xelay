import {useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties} from 'react'
import {createPortal} from 'react-dom'
import {ArrowRight,BookMarked,Check,ChevronRight,FilePenLine,Layers3,Leaf,Orbit,ShieldCheck,Sparkles,Stars,Target,X} from 'lucide-react'
import type {StudentPlanId} from '../../lib/studentPlans'
import './studentPurchaseCelebration.css'

export const PURCHASE_PREVIEW_STEPS=['Твій простір','Нові можливості','Час спробувати'] as const
export const PURCHASE_PREVIEW_PARTICLES=24
const themes={
 start:{name:'Старт',eyebrow:'Для твого щоденного ритму',heading:'Усе починається\nз твого кроку.',description:'Менше розсипаних справ. Більше місця для важливого.',features:['Свій порядок','Власний стиль','Час у фокусі'],icon:Leaf},
 plus:{name:'Плюс',eyebrow:'Від першої спроби — до впевненості',heading:'Знання, які\nзалишаються з тобою.',description:'Спробувати. Помилитися. Розібратися. І наступного разу — краще.',features:['Власна практика','Розумне повторення','Видимий прогрес'],icon:Layers3},
 max:{name:'Макс',eyebrow:'Твоя особиста навчальна студія',heading:'Думай ширше.\nСтворюй більше.',description:'Джерела, ідеї та великі роботи — в одному особистому просторі.',features:['Досліджувати','Створювати','Зростати'],icon:Stars},
} as const
const particles=Array.from({length:PURCHASE_PREVIEW_PARTICLES},(_,i)=>({angle:i*137.5,radius:70+i%5*20,delay:i%7*.09,size:i%3===0?5:3}))
type Props={plan:StudentPlanId;onClose:()=>void;onContinue?:()=>void;confirmedPayment?:boolean}
export default function StudentPurchaseCelebration({plan,onClose,onContinue,confirmedPayment=false}:Props){
 const safePlan:StudentPlanId=Object.prototype.hasOwnProperty.call(themes,plan)?plan:'start',theme=themes[safePlan],Icon=theme.icon
 const [phase,setPhase]=useState(0),[reduced,setReduced]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches)
 const [host]=useState(()=>{const node=document.createElement('div');node.className='spc-portal';return node})
 const dialog=useRef<HTMLElement>(null),close=useRef(onClose);close.current=onClose
 const titleId=useId(),descriptionId=useId(),timersRef=useRef<ReturnType<typeof setTimeout>[]>([])
 function finishAnimation(){timersRef.current.forEach(clearTimeout);timersRef.current=[];setPhase(2)}
 useLayoutEffect(()=>{
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:null,overflow=document.body.style.overflow
  const siblings=Array.from(document.body.children).filter((el):el is HTMLElement=>el instanceof HTMLElement&&el!==host).map(el=>({el,inert:el.inert}))
  document.body.appendChild(host);siblings.forEach(({el})=>{el.inert=true});document.body.style.overflow='hidden'
  dialog.current?.querySelector<HTMLButtonElement>('[data-spc-close]')?.focus()
  function keyboard(event:KeyboardEvent){if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close.current();return}if(event.key!=='Tab')return
   const controls=Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]')||[]).filter(el=>el.getClientRects().length>0)
   const first=controls[0],last=controls[controls.length-1];if(!first){event.preventDefault();dialog.current?.focus();return}
   if(event.shiftKey&&(document.activeElement===first||!dialog.current?.contains(document.activeElement))){event.preventDefault();last.focus()}else if(!event.shiftKey&&(document.activeElement===last||!dialog.current?.contains(document.activeElement))){event.preventDefault();first.focus()}
  }
  document.addEventListener('keydown',keyboard,true)
  return()=>{document.removeEventListener('keydown',keyboard,true);siblings.forEach(({el,inert})=>{el.inert=inert});document.body.style.overflow=overflow;host.remove();if(previous?.isConnected&&!previous.closest('[inert]'))previous.focus()}
 },[host])
 useEffect(()=>{
  const media=window.matchMedia('(prefers-reduced-motion: reduce)')
  function change(){timersRef.current.forEach(clearTimeout);timersRef.current=[];setReduced(media.matches);if(media.matches){setPhase(2);return}setPhase(0);timersRef.current=[setTimeout(()=>setPhase(1),900),setTimeout(()=>setPhase(2),3100)]}
  change();media.addEventListener('change',change);return()=>{timersRef.current.forEach(clearTimeout);timersRef.current=[];media.removeEventListener('change',change)}
 },[safePlan])
 return createPortal(<div className={`spc-overlay spc-${safePlan} spc-phase-${phase} ${reduced?'spc-reduced':''}`} onClick={event=>{if(event.target===event.currentTarget)onClose()}}>
  <section ref={dialog} className="spc-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
   <header className="spc-top"><span className="spc-brand">Xelay<i>K N U</i></span><span className="spc-preview"><ShieldCheck size={12}/>{confirmedPayment?'Оплату підтверджено':'Демонстрація анімації · без оплати'}</span><button data-spc-close aria-label={confirmedPayment?'Закрити привітання':'Закрити демонстрацію покупки'} className="spc-close" onClick={onClose}><X size={19}/></button></header>
   <div className="spc-content"><div className="spc-copy"><span className="spc-eyebrow"><Icon size={15}/>{theme.eyebrow}</span><span className="spc-plan-name">{theme.name}<i>Навчальний простір</i></span><h2 id={titleId}>{theme.heading.split('\n').map((line,i)=><span key={line} className={i?'accent':''}>{line}</span>)}</h2><p id={descriptionId}>{theme.description}</p><div className="spc-benefits">{theme.features.map((label,i)=><span key={label} style={{'--benefit':i} as CSSProperties}><Check size={12}/>{label}</span>)}</div><div className="spc-actions"><button className="spc-enter" onClick={onContinue||onClose}>Дослідити {theme.name}<ArrowRight size={17}/></button>{phase<2&&<button className="spc-skip" onClick={finishAnimation}>Пропустити анімацію<ChevronRight size={13}/></button>}</div><p className="spc-disclaimer">{confirmedPayment?'Строк доступу можна перевірити у своєму кабінеті. Обраний тариф оплачено без автоматичного продовження.':'Це перегляд майбутнього оформлення. Платіж не виконується, підписка не активується.'}</p></div>
    <div className="spc-scene" aria-hidden="true"><div className="spc-scene-grid"/><div className="spc-glow"/>
     <div className="spc-particles">{particles.map((p,i)=><i key={i} style={{'--angle':p.angle+'deg','--radius':p.radius+'px','--delay':p.delay+'s','--size':p.size+'px'} as CSSProperties}/>)}</div>
     {safePlan==='start'?<div className="spc-start-scene"><div className="spc-start-orbit"/><div className="spc-focus-dial"><svg viewBox="0 0 180 180"><circle className="track" cx="90" cy="90" r="75"/><circle className="progress" cx="90" cy="90" r="75"/></svg><span><Leaf size={33}/><strong>Свій ритм</strong><small>Крок за кроком</small></span></div><div className="spc-floating-note"><Check size={14}/><span>Важливе — під рукою</span></div><div className="spc-checklist"><i/><b><Check size={12}/>Зібрати думки</b><b><Check size={12}/>Знайти свій темп</b><b><span/>Почати сьогодні</b></div></div>
      :safePlan==='plus'?<div className="spc-plus-scene"><div className="spc-plus-orbit"/><div className="spc-study-card spc-card-back"><BookMarked size={22}/><span>ЗРОЗУМІТИ</span><strong>Кожна спроба<br/>додає впевненості.</strong><i/><i/><i/></div><div className="spc-study-card spc-card-front"><Layers3 size={25}/><span>ЗАКРІПИТИ</span><strong>У твоєму темпі.<br/>За твоїми темами.</strong><div className="spc-card-answer"><Check size={14}/>Тепер зрозуміло</div></div><div className="spc-progress-pill"><Target size={17}/><span>Ще один крок уперед</span><Sparkles size={14}/></div><div className="spc-spark spc-spark-one">✦</div><div className="spc-spark spc-spark-two">✧</div></div>
      :<div className="spc-max-scene"><div className="spc-max-orbit spc-max-orbit-one"/><div className="spc-max-orbit spc-max-orbit-two"/><div className="spc-max-orbit spc-max-orbit-three"/><div className="spc-max-core"><div className="spc-core-sheen"/><Stars size={43}/><strong>Макс</strong><span>ОСОБИСТА СТУДІЯ</span></div><div className="spc-studio-node spc-node-source"><BookMarked size={19}/><span>Джерело</span></div><div className="spc-studio-node spc-node-project"><FilePenLine size={19}/><span>Власна робота</span></div><div className="spc-studio-node spc-node-growth"><Orbit size={19}/><span>Нові можливості</span></div><div className="spc-max-arc"/></div>}
    </div></div>
   <footer className="spc-bottom"><div className="spc-sequence" aria-hidden="true">{PURCHASE_PREVIEW_STEPS.map((label,i)=><span key={label} className={phase>=i?'active':''}><b>{phase>i?<Check size={11}/>:`0${i+1}`}</b>{label}{i<2&&<i/>}</span>)}</div><span className="spc-live" role="status" aria-live="polite">{phase===2?'Перегляд готовий — можеш дослідити простір.':'Готуємо візуальний перегляд…'}</span></footer>
  </section>
 </div>,host)
}
