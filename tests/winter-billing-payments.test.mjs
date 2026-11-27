import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { createWinterBillingFixture } from './helpers/winterBillingFixture.mjs'

const native = createRequire(import.meta.url)
function load(file, imports = {}, globals = {}) {
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../' + file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, {
    module, exports: module.exports, Buffer, URL, Date, Number, Math, JSON, AbortController, Response, setTimeout, clearTimeout,
    fetch() { throw Error('External network forbidden') }, ...globals,
    require(name) { if (Object.hasOwn(imports, name)) return imports[name]; if (name.startsWith('node:')) return native(name); throw Error('Unexpected import ' + name) },
  })
  return module.exports
}
const env = { BILLING_MODE: 'live', VERCEL_ENV: 'development', STUDENT_PLANS_ENABLED: 'true', TEACHER_PLANS_ENABLED: 'true', XELAY_PUBLIC_URL: 'https://winter-test.invalid', WAYFORPAY_MERCHANT_ACCOUNT: 'synthetic_winter_merchant', WAYFORPAY_SECRET_KEY: 'synthetic-winter-key', WAYFORPAY_MERCHANT_DOMAIN: 'winter-test.invalid', SUPABASE_URL: 'https://synthetic-winter-db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-role', BILLING_CHECKOUT_ENABLED: 'true', WAYFORPAY_LIVE_APPROVED: 'true' }

test('winter real handler → HMAC checkout → authenticated callback → SQL grants; no real provider contact', { timeout: 180000 }, async t => {
  const fx = await createWinterBillingFixture(); t.after(() => fx.close())
  const { db, ids } = fx; let user = ids.studentA; let authToken = fx.token(user)
  await fx.serviceCall('xelay_student_audience_assign', [user, 'student', 'Synthetic HTTP winter student'])
  await fx.claim(user, [22, 29])
  const args = {
    xelay_winter_billing_request: ['p_user_id', 'p_session_id', 'p_action', 'p_payload'], xelay_winter_billing_offers: ['p_user_id'], xelay_winter_friend_issue: ['p_user_id'], xelay_winter_friend_accept: ['p_user_id', 'p_token'],
    xelay_winter_subscription_quote: ['p_user_id', 'p_audience', 'p_plan', 'p_months', 'p_source'],
    xelay_winter_subscription_order: ['p_user_id', 'p_audience', 'p_plan', 'p_months', 'p_source', 'p_mode', 'p_reference', 'p_terms'],
    xelay_apply_billing_event: ['p_reference', 'p_mode', 'p_fingerprint', 'p_status', 'p_amount', 'p_currency', 'p_fee'],
  }
  const adapter = { createClient() { return { auth: { async getUser(token) { return token === authToken ? { data: { user: { id: user, email: 'fictional@example.test' } }, error: null } : { data: { user: null }, error: { message: 'invalid' } } } }, async rpc(name, values) {
    assert.ok(args[name], 'Unexpected RPC: ' + name)
    try { return { data: await fx.serviceCall(name, args[name].map(k => values[k] ?? null)), error: null } } catch (error) { return { data: null, error } }
  } } } }
  const globals = { process: { env } }, legal = { legalMerchant: { ready: true } }, support = { SUPPORT_ORDER_REFERENCE: /^xelay_support_/ }
  const student = load('server/student-learning/studentPlanPrices.ts', {}, globals), teacher = load('server/teacher-learning/teacherPlanPrices.ts', {}, globals), credits = load('server/student-learning/aiCreditPrices.ts')
  const billing = load('server/billing.ts', { '@supabase/supabase-js': adapter, '../src/lib/legal.js': legal, '../src/lib/teamSupport.js': support, './student-learning/studentPlanPrices.js': student, './teacher-learning/teacherPlanPrices.js': teacher, './student-learning/aiCreditPrices.js': credits }, globals)
  const winter = load('server/winterBilling.ts', { './billing.js': billing, './student-learning/studentPlanPrices.js': student, './teacher-learning/teacherPlanPrices.js': teacher })
  const common = { '../../server/billing.js': billing, '../../server/winterBilling.js': winter, '../../server/student-learning/studentPlanPrices.js': student, '../../server/teacher-learning/teacherPlanPrices.js': teacher, '../../src/lib/legal.js': legal, '../../src/lib/aiCreditTerms.js': { WINTER_BENEFITS_TERMS_VERSION: '2026-11-27.1' } }
  const handler = load('api/billing/winter.ts', common, globals).default, webhook = load('api/billing/webhook.ts', common).default
  async function call(fn = handler, { method = 'POST', body = {}, auth = true, origin = env.XELAY_PUBLIC_URL } = {}) {
    const req = { method, body, headers: { ...(auth ? { authorization: 'Bearer ' + authToken } : {}), origin } }
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, status(v) { this.statusCode = v; return this }, json(v) { this.body = v; return this }, end() {} }
    await fn(req, res); return res
  }
  const selection = { audience: 'student', planId: 'start', termMonths: 12, source: 'own' }, consent = { ...selection, action: 'checkout', acceptedTerms: true, termsVersion: '2026-11-27.1' }
  const payload = (order, status = 'Approved', changes = {}) => {
    const p = { merchantAccount: env.WAYFORPAY_MERCHANT_ACCOUNT, orderReference: order.orderReference, amount: order.checkout.fields.amount, currency: 'UAH', authCode: 'LOCALONLY', cardPan: '411111******1111', transactionStatus: status, reasonCode: status === 'Approved' ? 1100 : 1101, ...changes }
    p.merchantSignature = billing.signature(['merchantAccount', 'orderReference', 'amount', 'currency', 'authCode', 'cardPan', 'transactionStatus', 'reasonCode'].map(k => p[k]), env.WAYFORPAY_SECRET_KEY)
    return p
  }
  let purchase
  await t.test('same origin, owner, strict keys, exact terms and earned quote precede a payable form', async () => {
    assert.equal((await call(handler, { body: consent, auth: false })).statusCode, 401)
    assert.equal((await call(handler, { body: consent, origin: 'https://attacker.invalid' })).statusCode, 403)
    assert.equal((await call(handler, { body: consent, origin: null })).statusCode, 403)
    for (const body of [{ ...consent, amount: 1 }, { ...consent, discountPercent: 99 }, { ...consent, acceptedTerms: false }, { ...consent, termsVersion: 'old' }, { ...consent, planId: 'constructor' }, { ...consent, termMonths: 24 }]) assert.equal((await call(handler, { body })).statusCode, 400)
    const q = await call(handler, { body: { ...selection, action: 'quote' } }); assert.equal(q.statusCode, 200); assert.equal(Number(q.body.amount), 1430.4)
    const response = await call(handler, { body: consent }); assert.equal(response.statusCode, 200); purchase = response.body
    const f = purchase.checkout.fields
    assert.equal(purchase.checkout.action, 'https://secure.wayforpay.com/pay'); assert.equal(f.regularMode, 'none'); assert.match(f.productName[0], /12 календарних місяців/)
    assert.equal(f.merchantSignature, billing.signature([env.WAYFORPAY_MERCHANT_ACCOUNT, env.WAYFORPAY_MERCHANT_DOMAIN, purchase.orderReference, f.orderDate, 1430.4, 'UAH', f.productName[0], 1, 1430.4], env.WAYFORPAY_SECRET_KEY))
    assert.equal((await call(handler, { body: consent })).body.orderReference, purchase.orderReference)
  })
  await t.test('tampered signature, valid signature with wrong amount, and wrong mode cannot activate; duplicates activate once', async () => {
    const forged = payload(purchase); forged.amount = 1
    assert.equal((await call(webhook, { body: forged, auth: false })).statusCode, 403)
    assert.equal((await call(webhook, { body: payload(purchase, 'Approved', { amount: 1 }), auth: false })).statusCode, 409)
    const valid = payload(purchase)
    assert.equal((await call(webhook, { body: valid, auth: false })).statusCode, 200)
    assert.equal((await call(webhook, { body: valid, auth: false })).statusCode, 200)
    assert.equal((await db.query('select count(*)::int n from xelay_student_private.grants g join public.billing_orders o on o.id=g.order_id where o.order_reference=$1', [purchase.orderReference])).rows[0].n, 12)
    assert.equal((await call(webhook, { body: payload(purchase, 'Refunded'), auth: false })).statusCode, 200)
    assert.equal((await call(webhook, { body: valid, auth: false })).statusCode, 200)
    assert.equal((await db.query('select count(*)::int n from xelay_student_private.grants g join public.billing_orders o on o.id=g.order_id where o.order_reference=$1 and g.revoked_at is null', [purchase.orderReference])).rows[0].n, 0)
  })
  await t.test('signer rejects mismatched snapshot, stacked birthday, annual friend and altered percent', async () => {
    const o = (await db.query('select * from public.billing_orders where order_reference=$1', [purchase.orderReference])).rows[0]
    for (const changed of [{ ...o, amount: 1 }, { ...o, birthday_gift_id: ids.owner }, { ...o, winter_source: 'friend' }, { ...o, winter_discount_percent: 99 }, { ...o, teacher_plan_id: 'teacher_max' }]) assert.equal(winter.winterOrderPrice(changed), null)
    assert.throws(() => winter.signedWinterCheckout({ ...o, status: 'pending' }, { id: ids.studentB }, selection, '2026-11-27.1'))
  })
  await t.test('valid user JWT with revoked, expired or foreign session cannot read offers or mutate; stale quote cannot bypass campaign end', async () => {
    const originalToken = authToken, originalSession = fx.sessions[user]
    authToken = ['synthetic-header', Buffer.from(JSON.stringify({ sub: user, session_id: fx.sessions[ids.studentB] })).toString('base64url'), 'signature'].join('.')
    assert.equal((await call(handler, { method: 'GET' })).statusCode, 401)
    authToken = originalToken
    await db.query("update auth.sessions set not_after=clock_timestamp()-interval'1 hour'where id=$1", [originalSession])
    assert.equal((await call(handler, { method: 'GET' })).statusCode, 401)
    await db.query('update auth.sessions set not_after=null where id=$1', [originalSession])
    await db.query('delete from auth.sessions where id=$1', [originalSession])
    assert.equal((await call(handler, { body: { action: 'issue_friend_token', acceptedTerms: true, termsVersion: '2026-11-27.1' } })).statusCode, 401)
    await db.query('insert into auth.sessions(id,user_id)values($1,$2)', [originalSession, user])
    user = ids.studentB; authToken = fx.token(user)
    await fx.serviceCall('xelay_student_audience_assign', [user, 'student', 'Synthetic stale winter quote'])
    await fx.claim(user, [29])
    assert.equal((await call(handler, { body: { ...selection, action: 'quote' } })).body.available, true)
    await db.exec("update xelay_winter_private.test_clock set at='2027-03-01 00:00 Europe/Kyiv'")
    assert.equal((await call(handler, { body: consent })).statusCode, 409)
  })
})

