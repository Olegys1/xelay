import { authenticateRequest, billingConfiguration, BillingError, enforceSameOrigin, newOrderReference, privateResponse, requestBody, sendError, signedCheckout } from '../../server/billing.js'
import { LEGAL_TERMS_VERSION, legalMerchant } from '../../src/lib/legal.js'
import {paidStudentPlan,studentPlansEnabled} from '../../server/student-learning/studentPlanPrices.js'
import {paidTeacherPlan,teacherPlansEnabled} from '../../server/teacher-learning/teacherPlanPrices.js'

export default async function handler(req: any, res: any) {
  privateResponse(res)
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Метод не підтримується.' }) }
  try {
    const body = requestBody(req)
    const product = body.product ?? body.plan
    if (product === 'group') throw new BillingError(409, 'Навчальні групи тепер безкоштовні. Оплата не потрібна.')
    const config = billingConfiguration()
    if (!config.checkoutAvailable) throw new BillingError(503, 'Оплату ще не активовано. Ми повідомимо, коли покупки стануть доступними.')
    if (!legalMerchant.ready) throw new BillingError(503, 'Оплата ще не підключена.')
    enforceSameOrigin(req)
    const auth = await authenticateRequest(req)
    if (body.acceptedTerms !== true || body.termsVersion !== LEGAL_TERMS_VERSION) {
      throw new BillingError(400, 'Ознайомтеся з чинними умовами та правилами повернення і підтвердьте згоду перед оплатою.')
    }
    if (product !== 'participant') throw new BillingError(400, 'Оберіть доступний тариф.')
    if (body.recurring === true) throw new BillingError(400, 'Автоматичне продовження поки не підключено.')
    if (body.groupId != null) throw new BillingError(400, 'Підписка «Учасник» не потребує вибору групи.')
    const teacherPlan=body.teacherPlanId
    if(teacherPlan!==undefined){
      if(!teacherPlansEnabled())throw new BillingError(503,'Викладацькі тарифи ще готуються до запуску.')
      if(!paidTeacherPlan(teacherPlan)||body.studentPlanId!==undefined||body.birthdayGiftId!==undefined||body.discountPercent!==undefined||body.couponCode!==undefined)throw new BillingError(400,'Оберіть один викладацький тариф. Суму визначає Xelay.')
      const {data:order,error}=await auth!.service.rpc('xelay_create_teacher_plan_order',{
        p_user_id:auth!.user.id,p_mode:config.mode,p_order_reference:newOrderReference(),p_plan_id:teacherPlan,
      })
      if(error||!order){
        if(error?.message.includes('CHECKOUT_RATE_LIMIT'))throw new BillingError(429,'Забагато спроб оплати. Спробуйте через годину.')
        throw new BillingError(403,'Цей тариф доступний для підтвердженого викладацького акаунта. Перевірте профіль.')
      }
      const checkout=signedCheckout(order,auth!.user.email)
      const {data:consent,error:consentError}=await auth!.service.from('billing_orders')
        .update({terms_version:LEGAL_TERMS_VERSION,terms_accepted_at:new Date().toISOString()})
        .eq('id',order.id).eq('user_id',auth!.user.id).eq('status','pending').select('id').single()
      if(consentError||!consent)throw new BillingError(409,'Не вдалося підготувати замовлення. Перевірте попередню оплату або спробуйте пізніше.')
      return res.status(200).json({checkout,mode:config.mode,orderReference:order.order_reference})
    }
    const studentPlan=body.studentPlanId
    let teacherLegacy=false
    if(studentPlansEnabled()&&studentPlan===undefined){
      const audience=await auth!.userClient.rpc('xelay_student_workspace_status')
      if(audience.error)throw new BillingError(503,'Не вдалося перевірити тип підписки. Спробуйте пізніше.')
      teacherLegacy=audience.data?.audience==='teacher'
    }
    if(studentPlansEnabled()&&!teacherLegacy&&!paidStudentPlan(studentPlan))throw new BillingError(400,'Оберіть Старт, Плюс або Макс.')
    if(!studentPlansEnabled()&&studentPlan!==undefined)throw new BillingError(503,'Нові тарифи ще готуються до запуску.')
    const useStudentPlan=studentPlansEnabled()&&!teacherLegacy
    const birthdayGiftId=body.birthdayGiftId
    if(birthdayGiftId!==undefined&&(!useStudentPlan||typeof birthdayGiftId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(birthdayGiftId)))throw new BillingError(400,'Оберіть доступну святкову знижку.')
    if(body.discountPercent!==undefined||body.couponCode!==undefined)throw new BillingError(400,'Суму та знижку визначає Xelay.')
    const { data: order, error } = await auth!.service.rpc(birthdayGiftId?'xelay_create_discounted_student_plan_order':useStudentPlan?'xelay_create_student_plan_order':'xelay_create_billing_order', useStudentPlan?{
      p_user_id:auth!.user.id,p_mode:config.mode,p_order_reference:newOrderReference(),p_plan_id:studentPlan,
      ...(birthdayGiftId?{p_gift_id:birthdayGiftId}:{}),
    }:{
      p_user_id: auth!.user.id, p_product: product, p_mode: config.mode,
      p_order_reference: newOrderReference(), p_group_id: null,
    })
    if (error || !order) {
      if(error?.message.includes('BIRTHDAY_DISCOUNT_PLAN_LOCKED'))throw new BillingError(409,'Святкову знижку вже закріплено за іншим тарифом. Поверніться до обраного замовлення.')
      if(error?.message.includes('BIRTHDAY_DISCOUNT_UNAVAILABLE'))throw new BillingError(409,'Святкова знижка вже використана або строк її дії минув. Оновіть сторінку.')
      if (error?.message.includes('PARTICIPANT_LIFETIME_ACCESS')) throw new BillingError(409, 'У вас уже є безстрокова підписка «Учасник».')
      if (error?.message.includes('CHECKOUT_RATE_LIMIT')) throw new BillingError(429, 'Забагато спроб оплати. Спробуйте через годину.')
      throw new BillingError(403, 'Не вдалося створити замовлення. Перевірте профіль і повторіть спробу.')
    }
    // Prepare the validated participant form before recording consent.
    const checkout = signedCheckout(order, auth!.user.email)
    const { data: consent, error: consentError } = await auth!.service.from('billing_orders')
      .update({ terms_version: LEGAL_TERMS_VERSION, terms_accepted_at: new Date().toISOString() })
      .eq('id', order.id).eq('user_id', auth!.user.id).eq('status', 'pending').select('id').single()
    if (consentError || !consent) throw new BillingError(409, 'Не вдалося підготувати замовлення. Перевірте попередню оплату або спробуйте пізніше.')
    return res.status(200).json({ checkout, mode: config.mode, orderReference: order.order_reference })
  } catch (error) { return sendError(res, error) }
}
