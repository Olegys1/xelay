import {useEffect,useState} from 'react'
import {Gift,LoaderCircle} from 'lucide-react'
import {loadBirthdayDiscount,type BirthdayGift} from '../../lib/birthdayGifts'

/** Own-account only; no amount, recipient or discount is trusted by checkout. */
export function BirthdayDiscountBanner({userId,onChange}:{userId:string;onChange:(id:string|null)=>void}){
 const[snapshot,setSnapshot]=useState<{owner:string;gift:BirthdayGift}|null>(null)
 const[checked,setChecked]=useState(true),[loading,setLoading]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 const gift=snapshot?.owner===userId?snapshot.gift:null
 useEffect(()=>{
  onChange(null);setSnapshot(null);setError('');setChecked(true)
  if(!userId)return
  const controller=new AbortController();let active=true;setLoading(true)
  void loadBirthdayDiscount(userId,controller.signal).then(value=>{if(active&&value)setSnapshot({owner:userId,gift:value})})
   .catch(()=>{if(active)setError('Не вдалося перевірити святкову знижку.')}).finally(()=>{if(active)setLoading(false)})
  return()=>{active=false;controller.abort();onChange(null)}
 },[userId,retry,onChange])
 useEffect(()=>{
  if(!gift||!checked){onChange(null);return}
  const remaining=Date.parse(gift.coupon_expires_at||'')-Date.now()
  if(remaining<=0){onChange(null);setSnapshot(null);return}
  onChange(gift.id)
  const timer=window.setTimeout(()=>{setSnapshot(null);onChange(null)},Math.min(remaining,2147483647))
  return()=>window.clearTimeout(timer)
 },[gift,checked,onChange])
 if(loading)return <p className="mb-4 flex items-center gap-2 text-xs text-muted-foreground" role="status"><LoaderCircle size={14} className="animate-spin motion-reduce:animate-none"/>Перевіряємо святкові пропозиції…</p>
 if(error)return <p className="mb-4 text-xs text-muted-foreground">{error} <button type="button" className="text-primary underline" onClick={()=>setRetry(n=>n+1)}>Повторити</button> Без перевіреної знижки діє звичайна ціна.</p>
 if(!gift)return null
 const until=new Date(gift.coupon_expires_at!).toLocaleString('uk-UA',{timeZone:'Europe/Kyiv',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'})
 return <section className="mb-6 rounded-3xl border border-primary/20 bg-primary/5 p-5" aria-label="Святкова знижка">
  <p className="flex items-center gap-2 font-semibold"><Gift size={19} aria-hidden="true"/>Подарунок до дня народження</p>
  <p className="mt-2 text-sm">Старт −50% · Плюс −30% · Макс −20%</p>
  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Одна оплата одного обраного тарифу. Знижка діє до {until} за Києвом та не додається до інших пропозицій. Після відкриття оплати обраний тариф закріплюється за купоном; повторне відкриття продовжить те саме замовлення.</p>
  <p className="mt-2 text-sm font-medium">До оплати: Старт 74,50 грн · Плюс 279,30 грн · Макс 799,20 грн.</p>
  {gift.coupon_plan_id&&<p className="mt-2 text-sm">Обраний тариф: <strong>{{start:'Старт',plus:'Плюс',max:'Макс'}[gift.coupon_plan_id]}</strong>.</p>}
  <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>Застосувати святкову знижку під час оплати</label>
 </section>
}
