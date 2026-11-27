import { billingConfiguration, BillingError, signature } from './billing.js'
import { STUDENT_PLAN_PRICES, STUDENT_PLAN_NAMES, paidStudentPlan } from './student-learning/studentPlanPrices.js'
import { TEACHER_PLAN_PRICES, TEACHER_PLAN_NAMES, paidTeacherPlan } from './teacher-learning/teacherPlanPrices.js'

export const WINTER_CAMPAIGN = 'winter-2026'
export const WINTER_COUPON_EXPIRY = '2027-02-28T22:00:00.000Z'
export function validWinterSelection(value: Record<string, unknown>) {
  return (value.audience === 'student' && paidStudentPlan(value.planId) || value.audience === 'teacher' && paidTeacherPlan(value.planId))
    && (value.termMonths === 1 || value.termMonths === 12) && (value.source === 'own' || value.source === 'friend')
    && !(value.source === 'friend' && value.termMonths !== 1)
}

/** Validate the immutable server snapshot again before signing any payable form. */
export function winterOrderPrice(order: any): number | null {
  const teacher = paidTeacherPlan(order?.teacher_plan_id)
  const student = paidStudentPlan(order?.student_plan_id)
  if (teacher === student || order?.winter_campaign !== WINTER_CAMPAIGN || order.product !== 'participant' || order.group_id !== null
    || order.birthday_gift_id != null || order.list_amount != null || order.discount_percent != null || order.discount_expires_at != null
    || order.currency !== 'UAH' || ![1, 12].includes(order.winter_term_months) || !['own', 'friend'].includes(order.winter_source)) return null
  const base = teacher ? TEACHER_PLAN_PRICES[order.teacher_plan_id as keyof typeof TEACHER_PLAN_PRICES] : STUDENT_PLAN_PRICES[order.student_plan_id as keyof typeof STUDENT_PLAN_PRICES]
  const tier = teacher ? String(order.teacher_plan_id).replace('teacher_', '') : order.student_plan_id
  const allowed = order.winter_source === 'friend' ? [10, 15, 20] : order.winter_term_months === 12 ? [10, 15, 20] : tier === 'start' ? [10, 20, 25] : tier === 'plus' ? [10, 15, 20] : [5, 10, 15]
  if (order.winter_source === 'friend' && order.winter_term_months !== 1 || !allowed.includes(order.winter_discount_percent)
    || Number(order.winter_list_amount) !== base * order.winter_term_months || Date.parse(order.winter_coupon_expiry) !== Date.parse(WINTER_COUPON_EXPIRY)) return null
  const expected = Math.round(base * order.winter_term_months * (100 - order.winter_discount_percent)) / 100
  return Number(order.amount) === expected ? expected : null
}

export function signedWinterCheckout(order: any, user: { id: string; email?: string }, selection: Record<string, unknown>, termsVersion: string) {
  const config = billingConfiguration(), price = winterOrderPrice(order)
  const plan = selection.audience === 'teacher' ? order?.teacher_plan_id : order?.student_plan_id
  if (!validWinterSelection(selection) || order?.user_id !== user.id || !['pending', 'declined'].includes(order.status) || order.mode !== config.mode
    || plan !== selection.planId || order.winter_term_months !== selection.termMonths || order.winter_source !== selection.source
    || order.terms_version !== termsVersion || !order.terms_accepted_at || price === null) throw new BillingError(409, 'Замовлення не відповідає обраній пропозиції.')
  if (!config.checkoutAvailable) throw new BillingError(503, 'Оплату ще не активовано.')
  const orderDate = Math.floor(Date.parse(order.created_at) / 1000)
  const expires = Math.min(Date.parse(order.winter_coupon_expiry), Date.parse(order.created_at) + 604800000)
  if (!/^xelay_[a-f0-9-]{36}$/.test(order.order_reference) || !Number.isFinite(orderDate) || expires <= Date.now()) throw new BillingError(409, 'Строк оплати цього замовлення минув.')
  const name = paidTeacherPlan(plan) ? TEACHER_PLAN_NAMES[plan] : STUDENT_PLAN_NAMES[plan as keyof typeof STUDENT_PLAN_NAMES]
  const productName = `Xelay ${name}: ${order.winter_term_months === 12 ? '12 календарних місяців' : 'один місяць'}, без автопродовження`
  const lifetime = Math.floor(expires / 1000) - orderDate
  const fields: Record<string, string | number | string[] | number[]> = {
    merchantAccount: config.merchant, merchantAuthType: 'SimpleSignature', merchantDomainName: config.domain,
    merchantTransactionType: 'AUTO', merchantTransactionSecureType: 'AUTO', apiVersion: 1,
    orderReference: order.order_reference, orderDate, amount: price, currency: 'UAH', productName: [productName], productCount: [1], productPrice: [price],
    language: 'UA', orderTimeout: lifetime, orderLifetime: lifetime, regularMode: 'none',
    serviceUrl: `${config.origin}/api/billing/webhook`, returnUrl: `${config.origin}/api/billing/return?orderReference=${encodeURIComponent(order.order_reference)}`,
    merchantSignature: signature([config.merchant, config.domain, order.order_reference, orderDate, price, 'UAH', productName, 1, price], config.secret),
  }
  if (user.email) fields.clientEmail = user.email
  return { action: 'https://secure.wayforpay.com/pay', fields }
}
