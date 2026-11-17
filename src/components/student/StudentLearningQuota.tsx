import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {ArrowLeft,ArrowUpRight,CalendarDays,Coins,Info,Loader2,Plus,X} from 'lucide-react'
import './studentLearningQuota.css'

export function quotaPercent(limit:number,remaining:number){
 if(!Number.isFinite(limit)||limit<=0||!Number.isFinite(remaining))return 0
 return Math.floor(Math.max(0,Math.min(1,remaining/limit))*100)
}

export interface StudentLearningCredits {
 balanceCredits:number
 reservedCredits?:number
 debtCredits?:number
 packages:readonly {id:string;credits:number;priceUah:number}[]
 checkoutAvailable:boolean
 eligible:boolean
 mode:'test'|'live'|'disabled'
 loading?:boolean
 error?:string
 onRefresh?:()=>void
 notice?:string
 checkingPayment?:boolean
 onCheckPayment?:()=>void
 /** Opens the same server-verified hosted checkout used for subscriptions. */
 onPurchase:(packageId:string)=>Promise<void>
}

const creditNumber=(value:number)=>new Intl.NumberFormat('uk-UA',{maximumFractionDigits:3}).format(Number.isFinite(value)?Math.max(0,value):0)

/** Displays loaded balances. Only an explicit, consented purchase invokes checkout. */
export function StudentLearningQuota({budget,resetsAt,canGenerate=true,credits,onOpen,initialOpen=false}:{budget:{limitUsd:number;remainingUsd:number};resetsAt?:string|null;canGenerate?:boolean;credits?:StudentLearningCredits;onOpen?:()=>void;initialOpen?:boolean}){
 const percent=quotaPercent(budget.limitUsd,budget.remainingUsd),[open,setOpen]=useState(initialOpen),[position,setPosition]=useState({left:12,top:12,width:292})
 const [buying,setBuying]=useState(false),[selected,setSelected]=useState(''),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('')
 const purchaseLock=useRef(false),mounted=useRef(true)
 const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null),closeButton=useRef<HTMLButtonElement>(null),purchaseBack=useRef<HTMLButtonElement>(null),titleId=useId()
 const resetDate=resetsAt?new Date(resetsAt):null
 const resetLabel=resetDate&&Number.isFinite(resetDate.getTime())?new Intl.DateTimeFormat('uk-UA',{day:'numeric',month:'long',timeZone:'Europe/Kyiv'}).format(resetDate):''
 const packages=credits?.packages.filter(item=>typeof item.id==='string'&&item.id.length>0&&Number.isFinite(item.credits)&&item.credits>0&&Number.isFinite(item.priceUah)&&item.priceUah>0)??[]
 const chosen=packages.find(item=>item.id===selected),purchaseAvailable=!!credits?.eligible&&!credits.loading&&!credits.error&&credits.checkoutAvailable&&credits.mode!=='disabled'&&packages.length>0
 function close(restoreFocus=true){setOpen(false);setBuying(false);setAccepted(false);setError('');if(restoreFocus&&trigger.current?.isConnected&&trigger.current.getClientRects().length)trigger.current.focus({preventScroll:true})}
 function showPackages(){setBuying(true);setSelected(packages[0]?.id??'');setAccepted(false);setError('')}
 async function purchase(){
  if(!purchaseAvailable||!chosen||!accepted||purchaseLock.current||!credits)return
  purchaseLock.current=true;setBusy(true);setError('')
  try{await credits.onPurchase(chosen.id)}catch(reason){if(mounted.current)setError(reason instanceof Error?reason.message:'Не вдалося підготувати оплату. Спробуй ще раз.')}
  finally{purchaseLock.current=false;if(mounted.current)setBusy(false)}
 }
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[])
 useLayoutEffect(()=>{
  if(!open)return
  const place=()=>{
   const button=trigger.current,content=panel.current;if(!button||!content)return
   const rect=button.getBoundingClientRect(),rail=button.closest('header,aside')?.getBoundingClientRect(),width=Math.min(292,window.innerWidth-24),height=Math.min(content.getBoundingClientRect().height,window.innerHeight-24)
   setPosition({left:window.innerWidth<768?12:Math.max(12,Math.min((rail?.right??rect.right)+12,window.innerWidth-width-12)),top:Math.max(12,Math.min(rect.bottom-height,window.innerHeight-height-12)),width})
  }
  place();window.addEventListener('resize',place)
  return()=>window.removeEventListener('resize',place)
 },[open,percent,resetLabel,canGenerate,buying,error,busy,credits?.balanceCredits,credits?.checkoutAvailable,credits?.eligible,credits?.loading,credits?.error,credits?.notice,credits?.checkingPayment])
 useLayoutEffect(()=>{if(open)closeButton.current?.focus({preventScroll:true})},[open])
 useLayoutEffect(()=>{if(open&&buying)purchaseBack.current?.focus({preventScroll:true})},[open,buying])
 useEffect(()=>{
  if(!open)return
  const outside=(event:PointerEvent)=>{const target=event.target as Node|null;if(target&&!panel.current?.contains(target)&&!trigger.current?.contains(target))close(false)}
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();close()}}
  document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape)
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape)}
 },[open])
 return <><button ref={trigger} type="button" className={`slq-button${percent<=10?' is-low':''}`} aria-label={`Ліміти ШІ: залишилось ${percent}%`} aria-expanded={open} aria-haspopup="dialog" title={`Ліміти ШІ · ${percent}% залишилось`} onClick={()=>{if(open)close(false);else{setOpen(true);onOpen?.()}}}><svg viewBox="0 0 44 44" fill="none" aria-hidden="true"><circle className="slq-track" cx="22" cy="22" r="18"/><circle className="slq-value" cx="22" cy="22" r="18" pathLength="100" strokeDasharray={`${percent} 100`} transform="rotate(-90 22 22)"/></svg><span>{percent}<small>%</small></span>{!!credits&&credits.balanceCredits>0&&<i className="slq-credit-dot" aria-hidden="true"/>}</button>
 {open&&createPortal(<div ref={panel} className="slq-panel" role="dialog" aria-modal="false" aria-labelledby={titleId} aria-busy={busy||undefined} style={position}><header><span>Твій навчальний простір</span><button ref={closeButton} type="button" onClick={()=>close()} aria-label="Закрити ліміти"><X size={16}/></button></header><h2 id={titleId}>{buying?'Додаткові кредити':'Ліміти ШІ'}</h2>{buying&&credits?<>
 <button ref={purchaseBack} type="button" className="slq-back" onClick={()=>{setBuying(false);setAccepted(false);setError('');closeButton.current?.focus({preventScroll:true})}} disabled={busy}><ArrowLeft size={14}/>До лімітів</button>
 <p className="slq-credit-copy">Ще трохи простору для розмов і підготовки. Спочатку витрачається ліміт Макса, потім — придбані кредити.</p>
 <fieldset className="slq-packages" disabled={busy||!purchaseAvailable}><legend>Обери пакет</legend>{packages.map(item=><label key={item.id} className={selected===item.id?'is-selected':''}><input type="radio" name={`${titleId}-package`} value={item.id} checked={selected===item.id} onChange={()=>{setSelected(item.id);setAccepted(false);setError('')}}/><span><strong>{creditNumber(item.credits)}</strong><small>кредитів</small></span><b>{creditNumber(item.priceUah)} грн</b></label>)}</fieldset>
 <p className="slq-credit-note">Кредити не згорають. Для використання потрібен активний Макс. Витрата залежить від обсягу запиту й відповіді; це не фіксована кількість повідомлень.</p>
 <label className="slq-consent"><input type="checkbox" checked={accepted} disabled={busy||!purchaseAvailable} onChange={event=>setAccepted(event.target.checked)}/><span>Погоджуюся з <a href="/terms" target="_blank" rel="noopener noreferrer">умовами послуг</a> і <a href="/refund-policy" target="_blank" rel="noopener noreferrer">правилами повернення</a>.</span></label>
 <button type="button" className="slq-purchase" onClick={()=>void purchase()} disabled={busy||!purchaseAvailable||!chosen||!accepted}>{busy?<Loader2 size={15} className="slq-spin"/>:<ArrowUpRight size={15}/>}<span>{busy?'Готуємо оплату…':credits.mode==='test'?'Перейти до тестової оплати':chosen?`Оплатити ${creditNumber(chosen.priceUah)} грн`:'Обери пакет'}</span></button>
 {!purchaseAvailable&&<p className="slq-credit-note" role="status">{!credits.eligible?'Докупка доступна з активним Максом.':'Докупка кредитів тимчасово недоступна.'}</p>}
 {error&&<p className="slq-error" role="alert">{error}</p>}
 <p className="slq-credit-note slq-payment-note">Разова оплата через WayForPay, без автоматичних списань. <a href="/contacts" target="_blank" rel="noopener noreferrer">Реквізити продавця</a></p>
 </>:<><div className="slq-remaining"><strong>{percent}<small>%</small></strong><span>залишилось у поточному періоді</span></div><div className="slq-meter" role="meter" aria-label="Залишок ліміту ШІ" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><i style={{width:`${percent}%`}}/></div>{resetLabel&&<p className="slq-reset"><CalendarDays size={15}/><span>Наступний період — <strong>{resetLabel}</strong></span></p>}{credits&&<div className="slq-wallet"><div><Coins size={16}/><span>Додаткові кредити</span><strong>{credits.loading?'…':creditNumber(credits.balanceCredits)}</strong></div>{credits.notice&&<p role="status">{credits.notice}</p>}{credits.onCheckPayment&&<button type="button" onClick={credits.onCheckPayment} disabled={credits.checkingPayment}>{credits.checkingPayment?'Перевіряємо оплату…':'Перевірити статус оплати'}</button>}{!!credits.reservedCredits&&credits.reservedCredits>0&&<p>{creditNumber(credits.reservedCredits)} — у запитах, що виконуються</p>}{!!credits.debtCredits&&credits.debtCredits>0&&<p>Повернення попередньої покупки: {creditNumber(credits.debtCredits)} кредитів буде враховано з наступного поповнення.</p>}<button type="button" onClick={showPackages} disabled={!purchaseAvailable}><Plus size={14}/>Докупити кредити</button>{credits.loading?<p role="status">Оновлюємо баланс…</p>:credits.error?<p role="alert">Не вдалося оновити баланс.{credits.onRefresh&&<button type="button" className="slq-refresh" onClick={credits.onRefresh}>Спробувати ще раз</button>}</p>:!purchaseAvailable&&<p>{!credits.eligible?'Доступно з активним Максом.':'Докупка тимчасово недоступна.'}</p>}</div>}<p className="slq-explanation"><Info size={15}/><span>{!canGenerate?'Нові запити зараз недоступні. Збережені відповіді та результати залишаються у твоєму просторі.':'Розмови, тести, картки й плани використовують спільний ліміт. Залишок оновлюється після роботи помічника.'}</span></p></>}</div>,document.body)}
 </>
}
