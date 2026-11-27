import { supabase } from './supabase'
import { LEGAL_TERMS_VERSION } from './legal'
import { SUPPORT_TERMS_VERSION } from './teamSupport'
import type { SupporterSummary } from './supporterTiers'
import { WINTER_BENEFITS_TERMS_VERSION } from './aiCreditTerms'

async function winterBillingRequest<T>(options: RequestInit, expectedUserId?: string): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  try { return await billingRequest('/api/billing/winter', { ...options, signal: controller.signal }, true, expectedUserId) }
  catch (error) {
    if (controller.signal.aborted) throw new Error('Не вдалося отримати відповідь. Оновіть статус перед повторною оплатою.')
    throw error
  } finally { clearTimeout(timer) }
}

export interface WinterBillingOffers {
  campaign: 'winter-2026'; expiresAt: string; subscriptionUsed: boolean
  pendingOrder?: (WinterSubscriptionSelection & { orderReference: string; status: 'pending' | 'declined' | 'expired'; expiresAt: string; amount: number; listAmount: number; discountPercent: number; currency: 'UAH' }) | null
  paused: { student: boolean; teacher: boolean }
  monthly: { start: number; plus: number; max: number }; annualPercent: number
  friend: { issuedToken?: string; percent: number; acceptedPercent: number }
  creditBonus: { percent: number; capCredits: number; used: boolean }
}
export interface WinterSubscriptionSelection {
  audience: 'student' | 'teacher'; planId: 'start' | 'plus' | 'max' | TeacherBillingPlanId
  termMonths: 1 | 12; source: 'own' | 'friend'
}
export interface WinterSubscriptionQuote extends WinterSubscriptionSelection {
  listAmount: number; discountPercent: number; amount: number; currency: 'UAH'; expiresAt: string; available: boolean; reason?: string
}
function winterResponseError(): never { throw new Error('Не вдалося прочитати актуальні пропозиції. Оновіть сторінку.') }
const winterRecord = (v: unknown): v is Record<string, unknown> => Boolean(v && typeof v === 'object' && !Array.isArray(v))
const winterFinite = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const winterDate = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v))
function winterSelectionValid(v: Record<string, unknown>) {
  return (v.audience === 'student' && ['start', 'plus', 'max'].includes(String(v.planId)) || v.audience === 'teacher' && ['teacher_start', 'teacher_plus', 'teacher_max'].includes(String(v.planId)))
    && [1, 12].includes(Number(v.termMonths)) && (v.termMonths === 1 || v.termMonths === 12) && ['own', 'friend'].includes(String(v.source)) && !(v.source === 'friend' && v.termMonths !== 1)
}
export async function getWinterBillingOffers(expectedUserId?: string): Promise<WinterBillingOffers> {
  const v = await winterBillingRequest<unknown>({}, expectedUserId)
  if (!winterRecord(v) || v.campaign !== 'winter-2026' || !winterDate(v.expiresAt) || typeof v.subscriptionUsed !== 'boolean'
    || !winterRecord(v.paused) || typeof v.paused.student !== 'boolean' || typeof v.paused.teacher !== 'boolean'
    || !winterRecord(v.monthly) || ![0, 10, 20, 25].includes(v.monthly.start as number) || ![0, 10, 15, 20].includes(v.monthly.plus as number) || ![0, 5, 10, 15].includes(v.monthly.max as number)
    || ![0, 10, 15, 20].includes(v.annualPercent as number) || !winterRecord(v.friend) || ![0, 10, 15, 20].includes(v.friend.percent as number) || ![0, 10, 15, 20].includes(v.friend.acceptedPercent as number)
    || v.friend.issuedToken != null && (typeof v.friend.issuedToken !== 'string' || !/^[a-f0-9]{64}$/.test(v.friend.issuedToken))
    || !winterRecord(v.creditBonus) || ![0, 5, 10].includes(v.creditBonus.percent as number) || ![0, 100, 300].includes(v.creditBonus.capCredits as number) || typeof v.creditBonus.used !== 'boolean') winterResponseError()
  const p = v.pendingOrder
  if (p != null && (!winterRecord(p) || !winterSelectionValid(p) || typeof p.orderReference !== 'string' || !/^xelay_[a-f0-9-]{36}$/.test(p.orderReference)
    || !['pending', 'declined', 'expired'].includes(String(p.status)) || !winterDate(p.expiresAt) || !winterFinite(p.amount) || !winterFinite(p.listAmount) || !winterFinite(p.discountPercent) || Number(p.discountPercent) > 25 || p.currency !== 'UAH')) winterResponseError()
  return v as unknown as WinterBillingOffers
}
export async function quoteWinterSubscription(selection: WinterSubscriptionSelection, expectedUserId?: string): Promise<WinterSubscriptionQuote> {
  const v = await winterBillingRequest<unknown>({ method: 'POST', body: JSON.stringify({ ...selection, action: 'quote' }) }, expectedUserId)
  if (!winterRecord(v) || !winterSelectionValid(v) || ['audience', 'planId', 'termMonths', 'source'].some(key => v[key] !== selection[key as keyof WinterSubscriptionSelection])
    || typeof v.available !== 'boolean' || !winterFinite(v.amount) || !winterFinite(v.listAmount) || !winterFinite(v.discountPercent) || Number(v.discountPercent) > 25 || v.currency !== 'UAH' || !winterDate(v.expiresAt)
    || Math.abs(Math.round(Number(v.listAmount) * (100 - Number(v.discountPercent))) / 100 - Number(v.amount)) > 0.001) winterResponseError()
  return v as unknown as WinterSubscriptionQuote
}
export function createWinterSubscriptionCheckout(selection: WinterSubscriptionSelection & { acceptedTerms: true; termsVersion: string }, expectedUserId?: string): Promise<CheckoutResponse> {
  return winterBillingRequest({ method: 'POST', body: JSON.stringify({ ...selection, action: 'checkout' }) }, expectedUserId)
}
export function issueWinterFriendCoupon(expectedUserId?: string): Promise<{ token: string; percent: number; expiresAt: string }> {
  return winterBillingRequest({ method: 'POST', body: JSON.stringify({ action: 'issue_friend_token', acceptedTerms: true, termsVersion: WINTER_BENEFITS_TERMS_VERSION }) }, expectedUserId)
}
export function acceptWinterFriendCoupon(token: string, expectedUserId?: string): Promise<{ percent: number; expiresAt: string }> {
  return winterBillingRequest({ method: 'POST', body: JSON.stringify({ action: 'accept_friend_token', token, acceptedTerms: true, termsVersion: WINTER_BENEFITS_TERMS_VERSION }) }, expectedUserId)
}

export type BillingCheckoutMode = 'test' | 'live' | 'disabled'
export type TeacherBillingPlanId = 'teacher_start' | 'teacher_plus' | 'teacher_max'

export interface BillingConfiguration {
  checkoutAvailable: boolean
  mode: BillingCheckoutMode
  groupLicenseAvailable?: boolean
  groupAccessFree?: boolean
  studentPlansAvailable?:boolean
  studentPlanPrices?:{start:number;plus:number;max:number}
  studentMaxAiBudgetUsd?:number
  studentPlan?:{id:'start'|'plus'|'max';startsAt:string;expiresAt:string}|null
  teacherPlansAvailable?:boolean
  teacherPlanPrices?:Record<TeacherBillingPlanId,number>
  teacherPlan?:{id:TeacherBillingPlanId;startsAt:string;expiresAt:string}|null
  subscriptionAudience?:'student'|'teacher'
  periods?: { participantMonths: number; groupMonths: number; groupTrialDays?: number }
  orders?: BillingOrder[]
}

export interface BillingOrder {
  id: string
  product: 'participant' | 'group'
  group_id: string | null
  order_reference: string
  amount: number
  currency: 'UAH'
  mode: 'test' | 'live'
  status: 'pending' | 'approved' | 'declined' | 'expired' | 'refunded' | 'voided'
  created_at: string
  approved_at: string | null
  student_plan_id?:'start'|'plus'|'max'|null
  teacher_plan_id?:TeacherBillingPlanId|null
}

export interface CheckoutResponse {
  mode: 'test' | 'live'
  checkout: {
    action: string
    fields: Record<string, string | number | Array<string | number>>
  }
}

export interface SupportOrder {
  id: string
  order_reference: string
  amount_kopiykas: number
  currency: 'UAH'
  mode: 'test' | 'live'
  status: BillingOrder['status']
  created_at: string
  approved_at: string | null
}

export interface SupportConfiguration {
  checkoutAvailable: boolean
  mode: BillingCheckoutMode
  minKopiykas: number
  maxKopiykas: number
  orders: SupportOrder[]
  supporter?: SupporterSummary | null
}

export function getSupportConfiguration(): Promise<SupportConfiguration> {
  return billingRequest('/api/billing/support', {}, false)
}

export function createSupportCheckout(amountKopiykas: number): Promise<CheckoutResponse> {
  return billingRequest('/api/billing/support', {
    method: 'POST', body: JSON.stringify({ amountKopiykas, recurring: false, acceptedTerms: true, termsVersion: SUPPORT_TERMS_VERSION }),
  })
}

/** Payment secrets and the price are set by the server, never by this client. */
async function billingRequest<T>(path: string, options: RequestInit = {}, requireSession = true, expectedUserId?: string): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
  if (expectedUserId && session?.user.id !== expectedUserId) throw new Error('Акаунт змінився. Оновіть сторінку перед продовженням.')
  if (requireSession && !session) throw new Error('Увійдіть до акаунта, щоб керувати підпискою.')

  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(session ? { Authorization: `Bearer ${session.access_token}` } : {}),
      ...options.headers,
    },
  })

  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('Оплата ще не підключена. Спробуйте пізніше.')
  }
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(typeof payload?.error === 'string' ? payload.error : 'Не вдалося підготувати оплату. Спробуйте ще раз.')
  }
  return payload as T
}

export async function getBillingConfiguration(): Promise<BillingConfiguration> {
  return billingRequest<BillingConfiguration>('/api/billing/status', {}, false)
}

export async function createParticipantCheckout(): Promise<CheckoutResponse> {
  return billingRequest<CheckoutResponse>('/api/billing/checkout', {
    method: 'POST',
    body: JSON.stringify({ product: 'participant', recurring: false, acceptedTerms: true, termsVersion: LEGAL_TERMS_VERSION }),
  })
}

export async function createStudentPlanCheckout(studentPlanId:'start'|'plus'|'max',birthdayGiftId?:string):Promise<CheckoutResponse>{
  return billingRequest<CheckoutResponse>('/api/billing/checkout',{method:'POST',body:JSON.stringify({product:'participant',studentPlanId,...(birthdayGiftId?{birthdayGiftId}:{}),recurring:false,acceptedTerms:true,termsVersion:LEGAL_TERMS_VERSION})})
}

export async function createTeacherPlanCheckout(teacherPlanId:TeacherBillingPlanId):Promise<CheckoutResponse>{
  return billingRequest<CheckoutResponse>('/api/billing/checkout',{method:'POST',body:JSON.stringify({product:'participant',teacherPlanId,recurring:false,acceptedTerms:true,termsVersion:LEGAL_TERMS_VERSION})})
}

export async function reconcilePayment(orderReference: string, expectedUserId?: string): Promise<{ checked: boolean; retryAfter: number }> {
  return billingRequest('/api/billing/reconcile', {
    method: 'POST', body: JSON.stringify({ orderReference }),
  }, true, expectedUserId)
}

export function returnedPaymentReference() {
  const params = new URLSearchParams(window.location.search)
  const reference = params.get('orderReference')
  return ['return', 'returned'].includes(params.get('payment') || '') && reference && /^xelay_[a-zA-Z0-9_-]{1,90}$/.test(reference)
    ? reference : null
}

/** Use WayForPay's hosted form: card details never pass through Xelay. */
export function openHostedCheckout(checkout: CheckoutResponse['checkout']) {
  if (checkout.action !== 'https://secure.wayforpay.com/pay' || !checkout.fields || typeof checkout.fields !== 'object') {
    throw new Error('Не вдалося відкрити захищену сторінку оплати.')
  }

  const form = document.createElement('form')
  form.method = 'POST'
  form.action = checkout.action
  form.style.display = 'none'
  for (const [name, value] of Object.entries(checkout.fields)) {
    const values = Array.isArray(value) ? value : [value]
    for (const item of values) {
      if (typeof item !== 'string' && typeof item !== 'number') throw new Error('Некоректні дані оплати. Спробуйте пізніше.')
      const input = document.createElement('input')
      input.type = 'hidden'
      input.name = Array.isArray(value) ? `${name.replace(/\[\]$/, '')}[]` : name
      input.value = String(item)
      form.appendChild(input)
    }
  }
  document.body.appendChild(form)
  form.submit()
  form.remove()
}
