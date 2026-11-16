import {useRef,useState} from 'react'
import {ArrowRight,ArrowUpRight,BookOpen,Check,ChevronDown,Layers3,Loader2,ShieldCheck,Sparkles} from 'lucide-react'
import {CheckoutLegalConsent} from '../LegalLinks'
import {createStudentPlanCheckout,openHostedCheckout,type BillingConfiguration} from '../../lib/billing'
import {getStudentPlanFeatures,STUDENT_PLANS,type StudentPlanId} from '../../lib/studentPlans'
import './studentSubscriptionCatalogue.css'

const PRESENTATION = {
 start: {
  number:'01',eyebrow:'Порядок у твоєму дні',description:'Менше дрібної рутини. Більше часу на своє.',Icon:BookOpen,
  features:['Органайзери та нагадування','Нотатки, закладки й фокус-таймер','Пошук у чатах і відкладені повідомлення','Оформлення профілю, статті й опитування','Особистий план підготовки'],
 },
 plus: {
  number:'02',eyebrow:'Практика, яка дає результат',description:'Розбирай складне. Повторюй те, що справді потрібно.',Icon:Layers3,
  features:['Усе зі Старт','Картки та інтервали повторення','Власні тести, імпорт і експорт','Повторення помилок із поясненнями','Історія спроб і прогрес за темами'],
 },
 max: {
  number:'03',eyebrow:'Твоя особиста навчальна студія',description:'Від власного конспекту до розуміння — з помічником поруч.',Icon:Sparkles,
  features:['Усе з Плюс','Навчальний ШІ з твоїми джерелами','PDF-студія, цитати та великі роботи','План сесії й сценарії балів','Збережені версії та експорт робіт'],
 },
} as const

export function StudentSubscriptionCatalogue({configuration,userId,loading,onLogin,pageHeading=false}:{configuration:BillingConfiguration;userId?:string;loading:boolean;onLogin:()=>void;pageHeading?:boolean}){
 const [selected,setSelected]=useState<StudentPlanId>('max'),[accepted,setAccepted]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),lock=useRef(false),owner=useRef(userId);owner.current=userId
 async function buy(){if(!userId){onLogin();return}if(!accepted||busy||loading||lock.current||!configuration.checkoutAvailable)return;const purchaser=userId;lock.current=true;setBusy(true);setError('');try{if(configuration.mode==='test'&&!window.confirm('Це тестова оплата без активації робочого доступу. Продовжити?'))return;const response=await createStudentPlanCheckout(selected);if(owner.current===purchaser)openHostedCheckout(response.checkout)}catch(e){if(owner.current===purchaser)setError(e instanceof Error?e.message:'Не вдалося підготувати оплату.')}finally{lock.current=false;if(owner.current===purchaser)setBusy(false)}}
 const selectedPlan=STUDENT_PLANS.find(plan=>plan.id===selected)!
 const Heading=pageHeading?'h1':'h2'
 return <section className="ssc" aria-label="Студентські тарифи">
  <header className="ssc-intro">
   <div><span className="ssc-kicker">ТРИ РІВНІ. ОДИН XELAY.</span><Heading>Твій темп.<br/><span>Більше можливостей.</span></Heading></div>
   <p>Обери інструменти під себе: для щоденних справ, власної практики або глибокої роботи з матеріалами.</p>
  </header>
  <div className="ssc-grid">
   {STUDENT_PLANS.map(plan=>{
    const view=PRESENTATION[plan.id],isSelected=selected===plan.id
    return <article key={plan.id} className={`ssc-card ssc-${plan.id} ${isSelected?'selected':''}`} aria-label={`Тариф ${plan.name}`}>
     <div className="ssc-card-top"><span className="ssc-icon"><view.Icon size={21} strokeWidth={1.6}/></span><span className="ssc-edition">{plan.id==='max'?'З НАВЧАЛЬНИМ ШІ':`РІВЕНЬ ${view.number}`}</span></div>
     <div className="ssc-identity"><h3>{plan.name}</h3><p>{view.eyebrow}</p></div>
     <div className="ssc-price"><strong>{configuration.studentPlanPrices?.[plan.id]??plan.monthlyPriceUah}</strong><span>грн<span>/ місяць</span></span></div>
     <p className="ssc-description">{view.description}</p>
     <div className="ssc-scene" aria-hidden="true">
      {plan.id==='start'?<><div className="ssc-scene-label">МІЙ ДЕНЬ<span>Сьогодні</span></div><div className="ssc-scene-task"><span><Check size={11}/></span><i/><small>Готово</small></div><div className="ssc-scene-task"><span/><i/><small>У плані</small></div></>:plan.id==='plus'?<><div className="ssc-scene-label">МОЯ ПРАКТИКА<span>Крок за кроком</span></div><div className="ssc-practice-line"><span>Зрозуміти</span><ArrowRight size={13}/><span>Спробувати</span><ArrowRight size={13}/><strong>Закріпити</strong></div><div className="ssc-practice-bars"><i/><i/><i/><i/><i/><i/><i/></div></>:<><div className="ssc-scene-label"><span className="ssc-ai-dot"/>ПОМІЧНИК ПОРУЧ</div><div className="ssc-agent-flow"><span>Твої матеріали</span><ArrowUpRight size={18}/><strong>Твій результат</strong></div><div className="ssc-agent-caption">Пояснення · Тести · Картки · Плани</div></>}
     </div>
     <ul className="ssc-highlights">{view.features.map(text=><li key={text}><Check size={15}/><span>{text}</span></li>)}</ul>
     <div className={`ssc-plan-note ${plan.id==='max'?'ssc-ai-note':''}`}>{plan.id==='max'?<><Sparkles size={14}/><span>До $6 витрат на модель за місяць</span></>:<><span className="ssc-note-dot"/><span>{plan.id==='start'?'Усі можливості колишнього «Учасника»':'Усі можливості Старт включено'}</span></>}</div>
     <button className="ssc-choice" type="button" aria-pressed={isSelected} onClick={()=>{setSelected(plan.id);setAccepted(false)}}><span>{isSelected?`Обрано ${plan.name}`:`Обрати ${plan.name}`}</span>{isSelected?<Check size={17}/>:<ArrowRight size={17}/>}</button>
     <details className="ssc-details"><summary>Усі можливості<ChevronDown size={16}/></summary><div>{getStudentPlanFeatures(plan.id).filter(feature=>feature.status==='existing'||feature.status==='local').map(feature=><div className="ssc-feature" key={feature.id}><strong>{feature.id==='start_badge'?'Бейдж активної підписки':feature.title}</strong><p>{feature.id==='start_badge'?'Позначка активної підписки поруч із вашим ім’ям.':feature.description.replace(/власних локальних/g,'власних')}</p></div>)}</div></details>
    </article>
   })}
  </div>
  <div className="ssc-free-note"><ShieldCheck size={18}/><p><strong>Основне навчання — завжди безкоштовне.</strong> Розклад, ДЗ, матеріали груп і тести викладачів доступні без підписки. Кожен наступний тариф включає попередній.</p></div>
  <div className="ssc-checkout">
   <div className="ssc-checkout-copy"><span className="ssc-kicker">ТВІЙ ВИБІР</span><div className="ssc-checkout-title"><h3>Обрано: {selectedPlan.name}</h3><span>{configuration.studentPlanPrices?.[selected]??selectedPlan.monthlyPriceUah} грн <small>/ місяць</small></span></div><p>Один календарний місяць. Продовження вручну. Точний початок і строк доступу залежать від уже оплачених періодів.</p><p className="ssc-preserved"><ShieldCheck size={15}/><span>Старі оплати та подаровані можливості зберігаються. Додатковий доступ до викладання не змінює студентський тариф.</span></p></div>
   <div className="ssc-checkout-action"><CheckoutLegalConsent checked={accepted} onChange={setAccepted}/><button type="button" className="ssc-buy" onClick={()=>void buy()} disabled={busy||loading||!!userId&&(!accepted||!configuration.checkoutAvailable)}>{busy?<Loader2 className="animate-spin" size={17}/>:<ArrowRight size={17}/>} {!userId?'Увійти для оформлення':!configuration.checkoutAvailable?'Оплата тимчасово недоступна':configuration.mode==='test'?'Перейти до тестової оплати':`Оформити ${selectedPlan.name}`}</button>{error&&<p className="ssc-error" role="alert">{error}</p>}</div>
  </div>
  <footer className="ssc-footnote"><ShieldCheck size={16}/><p>ШІ працює лише з текстом, який ти обираєш і дозволяєш передати. Його відповіді потрібно звіряти з джерелами. Ліміт моделі враховує запити й відповіді; після вичерпання нові запити зупиняються до наступного періоду без додаткового списання. Особисті інструменти з позначкою збереження на пристрої не синхронізуються між пристроями.</p></footer>
 </section>
}
