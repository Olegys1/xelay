import { supabase } from './supabase'

export type BillingCheckoutMode = 'test' | 'live' | 'disabled'

export interface BillingConfiguration {
  checkoutAvailable: boolean
  mode: BillingCheckoutMode
  groupLicenseAvailable?: boolean
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
}

export interface CheckoutResponse {
  mode: 'test' | 'live'
  checkout: {
    action: string
    fields: Record<string, string | number | Array<string | number>>
  }
}

/** Payment secrets and the price are set by the server, never by this client. */
async function billingRequest<T>(path: string, options: RequestInit = {}, requireSession = true): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession()
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
    body: JSON.stringify({ product: 'participant', recurring: false }),
  })
}

export async function createGroupCheckout(groupId: string): Promise<CheckoutResponse> {
  return billingRequest<CheckoutResponse>('/api/billing/checkout', {
    method: 'POST', body: JSON.stringify({ product: 'group', groupId, recurring: false }),
  })
}

export async function reconcilePayment(orderReference: string): Promise<{ checked: boolean; retryAfter: number }> {
  return billingRequest('/api/billing/reconcile', {
    method: 'POST', body: JSON.stringify({ orderReference }),
  })
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
