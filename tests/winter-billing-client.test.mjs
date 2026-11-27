import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

test('winter billing client rejects mixed response schemas and never sends under a changed account', async () => {
  let user = 'owner-a', response, requests = 0
  const module = { exports: {} }
  const imports = {
    './supabase': { supabase: { auth: { async getSession() { return { data: { session: { user: { id: user }, access_token: 'synthetic-token' } } } } } } },
    './legal': { LEGAL_TERMS_VERSION: 'legacy' }, './teamSupport': { SUPPORT_TERMS_VERSION: 'support' }, './aiCreditTerms': { WINTER_BENEFITS_TERMS_VERSION: '2026-11-27.1' },
  }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/billing.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, AbortController, setTimeout, clearTimeout,
    require(name) { assert.ok(imports[name], name); return imports[name] },
    async fetch(_url, options) { requests++; assert.equal(options.headers.Authorization, 'Bearer synthetic-token'); return { ok: true, headers: { get() { return 'application/json' } }, async json() { return response } } },
  })
  const client = module.exports
  const valid = { campaign: 'winter-2026', expiresAt: '2027-02-28T22:00:00Z', subscriptionUsed: false, pendingOrder: null, paused: { student: false, teacher: false }, monthly: { start: 25, plus: 20, max: 15 }, annualPercent: 20, friend: { percent: 0, acceptedPercent: 0 }, creditBonus: { percent: 10, capCredits: 300, used: false } }
  response = valid; assert.equal((await client.getWinterBillingOffers('owner-a')).monthly.start, 25)
  for (const bad of [null, {}, { ...valid, monthly: null }, { ...valid, friend: [] }, { ...valid, creditBonus: { percent: 1000 } }, { ...valid, pendingOrder: { termMonths: 24 } }]) {
    response = bad; await assert.rejects(client.getWinterBillingOffers('owner-a'), /актуальні пропозиції/)
  }
  const selection = { audience: 'student', planId: 'plus', termMonths: 1, source: 'own' }
  response = { ...selection, available: true, amount: 319.2, listAmount: 399, discountPercent: 20, currency: 'UAH', expiresAt: valid.expiresAt }
  assert.equal((await client.quoteWinterSubscription(selection, 'owner-a')).amount, 319.2)
  for (const changed of [{ amount: 1 }, { planId: 'max' }, { currency: 'USD' }, { available: 'yes' }]) {
    const original = response; response = { ...response, ...changed }; await assert.rejects(client.quoteWinterSubscription(selection, 'owner-a'), /актуальні пропозиції/); response = original
  }
  user = 'owner-b'; const before = requests
  await assert.rejects(client.getWinterBillingOffers('owner-a'), /Акаунт змінився/)
  await assert.rejects(client.createWinterSubscriptionCheckout({ ...selection, acceptedTerms: true, termsVersion: '2026-11-27.1' }, 'owner-a'), /Акаунт змінився/)
  await assert.rejects(client.reconcilePayment('xelay_synthetic', 'owner-a'), /Акаунт змінився/)
  assert.equal(requests, before)
})
