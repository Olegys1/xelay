import { randomUUID } from 'node:crypto'
import { BillingError, billingConfiguration, signature } from './billing.js'
import { legalMerchant } from '../src/lib/legal.js'
import { SUPPORT_MAX_KOPIYKAS, SUPPORT_MIN_KOPIYKAS, SUPPORT_ORDER_REFERENCE, validSupportAmount } from '../src/lib/teamSupport.js'

export function publicSupportConfiguration() {
  const config = billingConfiguration()
  return {
    mode: config.mode,
    checkoutAvailable: config.checkoutAvailable && legalMerchant.ready
      && process.env.TEAM_SUPPORT_ENABLED === 'true',
    minKopiykas: SUPPORT_MIN_KOPIYKAS,
    maxKopiykas: SUPPORT_MAX_KOPIYKAS,
    automaticRenewal: false,
  }
}

export function newSupportReference() { return `xelay_support_${randomUUID()}` }

export function signedSupportCheckout(order: any, email?: string) {
  const config = billingConfiguration()
  const date = Math.floor(new Date(order.created_at).getTime() / 1000)
  if (!publicSupportConfiguration().checkoutAvailable) throw new BillingError(503, 'Підтримку через оплату ще не підключено.')
  if (!SUPPORT_ORDER_REFERENCE.test(order.order_reference) || !Number.isFinite(date)
    || !validSupportAmount(order.amount_kopiykas) || order.currency !== 'UAH'
    || order.mode !== config.mode || order.status !== 'pending') {
    throw new BillingError(409, 'Не вдалося підготувати платіж. Перевірте попередню оплату.')
  }
  const amount = order.amount_kopiykas / 100
  const name = 'Добровільна підтримка розвитку Xelay'
  const fields: Record<string, string | number | string[] | number[]> = {
    merchantAccount: config.merchant, merchantAuthType: 'SimpleSignature',
    merchantDomainName: config.domain, merchantTransactionType: 'AUTO',
    merchantTransactionSecureType: 'AUTO', apiVersion: 1,
    orderReference: order.order_reference, orderDate: date, amount, currency: 'UAH',
    productName: [name], productCount: [1], productPrice: [amount], language: 'UA',
    orderTimeout: 3600, orderLifetime: 3600, regularMode: 'none',
    serviceUrl: `${config.origin}/api/billing/webhook`,
    returnUrl: `${config.origin}/api/billing/return?orderReference=${encodeURIComponent(order.order_reference)}`,
    merchantSignature: signature([config.merchant, config.domain, order.order_reference, date, amount, 'UAH', name, 1, amount], config.secret),
  }
  if (email) fields.clientEmail = email
  return { action: 'https://secure.wayforpay.com/pay', fields }
}
