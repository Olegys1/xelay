import {useCallback,useEffect,useRef,useState} from 'react'
import {openHostedCheckout} from '../../lib/billing'
import {validAiCreditPackageId,validAiCreditReference,type AiCreditStatus,type AiCreditWallet} from '../../lib/maxTutorCredits'
import {type createMaxTutorProductionClient,type ProductionMaxStatus} from '../../lib/maxTutorProductionClient'
import {StudentLearningQuota,type StudentLearningCredits} from './StudentLearningQuota'

type Client=ReturnType<typeof createMaxTutorProductionClient>
type Context={key:string;client:Client;status:ProductionMaxStatus;onStatus?:((status:ProductionMaxStatus)=>void)}
type Props={status:ProductionMaxStatus;client:Client;onStatus?:(status:ProductionMaxStatus)=>void}
function returnedCreditReference(){
 const params=new URLSearchParams(window.location.search),reference=params.get('orderReference')
 return ['return','returned'].includes(params.get('payment')||'')&&validAiCreditReference(reference)?reference:null
}
const walletSignature=(wallet:AiCreditWallet|undefined)=>wallet?`${wallet.balanceCredits}:${wallet.reservedCredits}:${wallet.debtCredits}`:''

/** Loads payment data on demand; a browser return never grants credits. */
export function ProductionMaxQuota(props:Props){return <ProductionMaxQuotaOwner key={`${props.status.scope.userId}:${props.status.scope.sessionId}`} {...props}/>}
function ProductionMaxQuotaOwner({status,client,onStatus}:Props){
 const key=`${status.scope.userId}:${status.scope.sessionId}`
 const [configuration,setConfiguration]=useState<AiCreditStatus|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[checkingPayment,setCheckingPayment]=useState(false)
 const [returnedReference]=useState(returnedCreditReference)
 const current=useRef<Context>({key,client,status,onStatus});current.current={key,client,status,onStatus}
 const alive=useRef(true),controllers=useRef(new Set<AbortController>()),paymentLock=useRef(false)
 const pendingLoad=useRef<{key:string;client:Client;abort:AbortController;token:object;promise:Promise<AiCreditStatus|null>}|null>(null)
 const walletRevision=useRef({signature:walletSignature(status.purchasedCredits),revision:0})
 const signature=walletSignature(status.purchasedCredits)
 if(walletRevision.current.signature!==signature)walletRevision.current={signature,revision:walletRevision.current.revision+1}
 const isCurrent=useCallback((owner:string,ownerClient:Client,abort:AbortController)=>alive.current&&!abort.signal.aborted&&current.current.key===owner&&current.current.client===ownerClient,[])
 useEffect(()=>{
  alive.current=true
  return()=>{alive.current=false;for(const abort of controllers.current)abort.abort();controllers.current.clear();pendingLoad.current=null;paymentLock.current=false}
 },[client,key])
 useEffect(()=>{if(status.purchasedCredits)setConfiguration(previous=>previous?{...previous,wallet:status.purchasedCredits!}:previous)},[signature])

 const load=useCallback((force=false):Promise<AiCreditStatus|null>=>{
  const pending=pendingLoad.current
  if(pending&&pending.key===key&&pending.client===client&&!force)return pending.promise
  if(pending&&force){pending.abort.abort();pendingLoad.current=null}
  const abort=new AbortController(),revision=walletRevision.current.revision,token={}
  controllers.current.add(abort);setLoading(true);setError('')
  const promise:Promise<AiCreditStatus|null>=Promise.resolve().then(async()=>{
   // Register the single-flight promise before a missing client or sync failure can settle it.
   try{
    if(!isCurrent(key,client,abort))return null
    const result=await client.credits.status(abort.signal)
    if(!isCurrent(key,client,abort))return null
    const value=revision===walletRevision.current.revision?result:{...result,wallet:current.current.status.purchasedCredits??result.wallet}
    setConfiguration(value);return value
   }catch{if(isCurrent(key,client,abort))setError('Не вдалося оновити баланс. Спробуй ще раз.');return null}
   finally{controllers.current.delete(abort);if(pendingLoad.current?.token===token){pendingLoad.current=null;if(isCurrent(key,client,abort))setLoading(false)}}
  })
  pendingLoad.current={key,client,abort,token,promise};return promise
 },[client,key,isCurrent])

 const checkPayment=useCallback(async()=>{
  if(!returnedReference||paymentLock.current)return
  paymentLock.current=true;setCheckingPayment(true);setNotice('Перевіряємо оплату…')
  const abort=new AbortController();controllers.current.add(abort)
  try{
   await client.credits.reconcile(returnedReference,abort.signal)
   if(!isCurrent(key,client,abort))return
   const payments=await load(true)
   if(!isCurrent(key,client,abort))return
   if(!payments){setNotice('Не вдалося перевірити оплату. Онови баланс або перевір статус ще раз.');return}
   const fresh=await client.status(abort.signal)
   if(!isCurrent(key,client,abort))return
   if(fresh.scope.userId!==status.scope.userId||fresh.scope.sessionId!==status.scope.sessionId)throw Error('identity_changed')
   current.current.onStatus?.(fresh)
   if(fresh.purchasedCredits)setConfiguration(previous=>previous?{...previous,wallet:fresh.purchasedCredits!}:previous)
   const order=payments.orders.find(item=>item.order_reference===returnedReference)
   setNotice(!order?'Платіж не знайдено в цьому акаунті. Перевір акаунт або звернися до підтримки.':order.status==='approved'?order.mode==='test'?'Тестову оплату підтверджено. Робочий баланс не змінено.':'Оплату підтверджено. Кредити зараховано.':order.status==='pending'?'Очікуємо підтвердження оплати. Якщо кошти вже списано, перевір статус перед новою покупкою.':order.status==='refunded'?'Оплату повернено. Баланс оновлено.':order.status==='voided'?'Оплату скасовано.':order.status==='expired'?'Строк цього платежу завершився.':'Оплату відхилено. Кредити не зараховані.')
  }catch{if(isCurrent(key,client,abort))setNotice('Не вдалося перевірити оплату. Спробуй перевірити статус ще раз; повторно оплачувати не потрібно.')}
  finally{controllers.current.delete(abort);if(isCurrent(key,client,abort)){paymentLock.current=false;setCheckingPayment(false)}}
 },[client,key,returnedReference,load,isCurrent,status.scope.userId,status.scope.sessionId])
 useEffect(()=>{if(returnedReference)void checkPayment()},[client,key,returnedReference,checkPayment])

 const purchase=useCallback(async(packageId:string)=>{
  const selected=configuration?.packages.find(item=>item.id===packageId)
  if(!configuration?.eligible||!configuration.checkoutAvailable||configuration.mode==='disabled'||!validAiCreditPackageId(packageId)||!selected)throw Error('Докупка кредитів зараз недоступна. Онови баланс і спробуй ще раз.')
  if(configuration.mode==='test'&&!window.confirm('Це тестова оплата без реальних списань і без зарахування робочих кредитів. Продовжити?'))return
  const abort=new AbortController();controllers.current.add(abort)
  try{const result=await client.credits.checkout(packageId,abort.signal);if(!isCurrent(key,client,abort))return;if(result.mode!==configuration.mode||result.checkout.fields.amount!==selected.priceUah||result.checkout.fields.currency!=='UAH')throw Error('Умови оплати змінилися. Онови баланс і перевір пакет перед оплатою.');openHostedCheckout(result.checkout)}
  finally{controllers.current.delete(abort)}
 },[client,key,configuration,isCurrent])

 const wallet=configuration?.wallet??status.purchasedCredits
 const credits:StudentLearningCredits={balanceCredits:wallet?.balanceCredits??0,reservedCredits:wallet?.reservedCredits??0,debtCredits:wallet?.debtCredits??0,packages:configuration?.packages??[],checkoutAvailable:configuration?.checkoutAvailable??false,eligible:configuration?.eligible??(status.audience==='student'&&status.planId==='max'),mode:configuration?.mode??'disabled',loading,error,onRefresh:()=>void load(true),onPurchase:purchase,notice,onCheckPayment:returnedReference?()=>void checkPayment():undefined,checkingPayment}
 return <StudentLearningQuota budget={status.budget} resetsAt={status.budgetResetsAt} canGenerate={status.canGenerate} credits={credits} onOpen={()=>void load()} initialOpen={!!returnedReference}/>
}
