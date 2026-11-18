import {authenticateRequest,billingConfiguration,BillingError,enforceSameOrigin,newOrderReference,privateResponse,requestBody,sendError,signedCheckout} from '../../server/billing.js'
import {aiCreditPackage,publicAiCreditPackages} from '../../server/student-learning/aiCreditPrices.js'
import {studentPlansEnabled} from '../../server/student-learning/studentPlanPrices.js'
import {legalMerchant} from '../../src/lib/legal.js'
import {AI_CREDIT_TERMS_VERSION} from '../../src/lib/aiCreditTerms.js'

export default async function handler(req:any,res:any){
 privateResponse(res)
 if(!['GET','POST'].includes(req.method)){res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Метод не підтримується.'})}
 try{
  const config=billingConfiguration(),enabled=studentPlansEnabled(),auth=await authenticateRequest(req,req.method==='GET')
  if(req.method==='GET'){
   const common={checkoutAvailable:enabled&&config.checkoutAvailable&&legalMerchant.ready,mode:config.mode,packages:publicAiCreditPackages()}
   if(!auth||!enabled)return res.status(200).json({...common,eligible:false,wallet:null,orders:[]})
   const {data,error}=await auth.service.rpc('xelay_max_credit_status',{p_user_id:auth.user.id})
   if(error||!data)throw new BillingError(503,'Не вдалося перевірити додаткові кредити. Спробуйте пізніше.')
   return res.status(200).json({...common,...data})
  }
  enforceSameOrigin(req)
  if(!enabled||!config.checkoutAvailable||!legalMerchant.ready)throw new BillingError(503,'Оплату кредитів ще не активовано.')
  const body=requestBody(req)
  if(Object.keys(body).some(key=>!['packageId','acceptedTerms','termsVersion','recurring'].includes(key))||!aiCreditPackage(body.packageId)||body.recurring===true)throw new BillingError(400,'Оберіть доступний пакет кредитів.')
  if(body.acceptedTerms!==true||body.termsVersion!==AI_CREDIT_TERMS_VERSION)throw new BillingError(400,'Ознайомтеся з умовами та правилами повернення перед оплатою.')
  const {data:order,error}=await auth!.service.rpc('xelay_create_max_credit_order',{p_user_id:auth!.user.id,p_mode:config.mode,p_order_reference:newOrderReference().replace(/^xelay_/,'xtop_'),p_package_id:body.packageId,p_terms_version:AI_CREDIT_TERMS_VERSION})
  if(error||!order){
   if(error?.message.includes('CHECKOUT_RATE_LIMIT'))throw new BillingError(429,'Забагато спроб оплати. Спробуйте через годину.')
   if(error?.message.includes('MAX_CREDITS_MAX_REQUIRED'))throw new BillingError(403,'Для використання додаткових кредитів потрібен активний Макс.')
   throw new BillingError(409,'Не вдалося підготувати оплату кредитів. Оновіть сторінку та спробуйте ще раз.')
  }
  const checkout = signedCheckout(order, auth!.user, { kind: 'credits', packageId: body.packageId, termsVersion: AI_CREDIT_TERMS_VERSION })
  return res.status(200).json({checkout,mode:config.mode,orderReference:order.order_reference})
 }catch(error){return sendError(res,error)}
}
