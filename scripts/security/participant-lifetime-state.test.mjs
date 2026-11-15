import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

async function loadModule(path, imports = {}, globals = {}) {
  const source = await readFile(new URL('../../' + path, import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  const module = { exports: {} }
  runInNewContext(code, { module, exports: module.exports, require(name) { assert.ok(name in imports, name); return imports[name] }, ...globals })
  return module.exports
}

const { parseParticipantStatus, currentParticipantStatus } = await loadModule('src/lib/billingState.ts')
const expiry = '2026-11-30T12:00:00.000Z'
const expiryTime = Date.parse(expiry)
const finite = {
  is_premium: true, expires_at: expiry, emoji_status: '🎓', status_text: 'Xelay',
  search_unlimited: true, search_limit: 3, search_used: 0,
  connection_limit: 3, connection_used: 0, connection_unlimited: true,
  connection_remaining: 3, connection_resets_at: expiry,
}
const lifetime = { ...finite, is_lifetime: true, expires_at: null }

test('an explicit lifetime subscription preserves participant features past any calendar date', () => {
  const status = parseParticipantStatus(lifetime, expiryTime)
  assert.equal(status.isPremium, true)
  assert.equal(status.isLifetime, true)
  assert.equal(status.expiresAt, null)
  assert.equal(status.emojiStatus, '🎓')
  assert.equal(status.textStatus, 'Xelay')
  assert.equal(currentParticipantStatus(status, Date.parse('2100-01-01')), status)
})

test('finite legacy access stops at expiry, and ambiguous lifetime payloads fail closed', () => {
  for (const status of [finite, { ...finite, is_lifetime: false }]) {
    const active = parseParticipantStatus(status, expiryTime - 1)
    assert.equal(active.isPremium, true)
    assert.equal(active.isLifetime, false)
    assert.equal(currentParticipantStatus(active, expiryTime).isPremium, false)
    assert.equal(parseParticipantStatus(status, expiryTime).emojiStatus, null)
  }
  for (const invalid of [
    { ...finite, expires_at: null },
    { ...finite, is_lifetime: true },
    { ...lifetime, is_premium: false },
    { ...lifetime, is_lifetime: 'true' },
    { ...lifetime, expires_at: undefined },
  ]) assert.throws(() => parseParticipantStatus(invalid), /Invalid/)
  const revoked = parseParticipantStatus({ ...lifetime, is_premium: false, is_lifetime: false }, expiryTime)
  assert.equal(revoked.isPremium, false)
  assert.equal(revoked.isLifetime, false)
  assert.equal(revoked.textStatus, null)
})

test('a lifetime participant sees their status and does not see the renewal form', async () => {
  let status = parseParticipantStatus(lifetime)
  const empty = () => null
  const { SubscriptionPage } = await loadModule('src/pages/SubscriptionPage.tsx', {
    react: React, 'react/jsx-runtime': jsxRuntime,
    '@tanstack/react-router': { useNavigate: () => empty },
    'lucide-react': new Proxy({}, { get: () => empty }),
    '../components/AuthModal': { AuthModal: empty },
    '../components/LegalLinks': { CheckoutLegalConsent: () => React.createElement('div', { 'data-checkout-terms': true }) },
    '../components/GroupPricingDetails': { GroupPricingDetails: empty },
    '../components/ParticipantWelcome': { ParticipantWelcome: empty },
    '../components/halloween/HalloweenPumpkin': { HalloweenPumpkin: empty },
    '../components/ParticipantStatusEmoji': { ParticipantStatusEmojis: empty },
    '../context/AuthContext': { useAuth: () => ({ authUser: { id: 'participant' } }) },
    '../context/BillingContext': { useBilling: () => status },
    '../lib/billing': { returnedPaymentReference: () => null },
    '../lib/legal': { legalMerchant: { ready: true } },
    './premium.css': {},
  }, { window: { location: { search: '' } }, URLSearchParams })
  const render = () => renderToStaticMarkup(React.createElement(SubscriptionPage))
  const html = render()
  assert.match(html, /Безстрокова підписка/)
  assert.doesNotMatch(html, /data-checkout-terms|грн \/ місяць|Захищена сторінка оплати/)
  status = parseParticipantStatus(finite, expiryTime - 1)
  const monthly = render()
  assert.match(monthly, /Підписка активна до/)
  assert.match(monthly, /data-checkout-terms/)
})

test('checkout translates the server lifetime denial into a friendly conflict without preparing a payment form', async () => {
  class BillingError extends Error {
    constructor(status, message) { super(message); this.status = status }
  }
  const { default: checkout } = await loadModule('api/billing/checkout.ts', {
    '../../server/billing.js': {
      BillingError, privateResponse() {}, enforceSameOrigin() {},
      billingConfiguration: () => ({ checkoutAvailable: true, mode: 'live' }),
      requestBody: req => req.body, newOrderReference: () => 'test-order',
      authenticateRequest: async () => ({ user: { id: 'participant' }, service: {
        rpc: async () => ({ error: { message: 'PARTICIPANT_LIFETIME_ACCESS' } }),
      } }),
      sendError: (_res, error) => error,
      signedCheckout() { assert.fail('A denied lifetime checkout must not prepare payment fields') },
    },
    '../../src/lib/legal.js': { LEGAL_TERMS_VERSION: 'test-version', legalMerchant: { ready: true } },
  })
  const error = await checkout({ method: 'POST', body: { product: 'participant', acceptedTerms: true, termsVersion: 'test-version' } }, {})
  assert.equal(error.status, 409)
  assert.match(error.message, /безстрокова підписка/)
})
