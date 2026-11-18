import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

// Synthetic identities/merchant only. A network call is a test failure.
const native = createRequire(import.meta.url)
const plain = value => JSON.parse(JSON.stringify(value))
function load(path, imports = {}, environment = {}) {
  const module = { exports: {} }
  const source = readFileSync(new URL('../' + path, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, URL, Date, Number, Math, JSON, process: { env: environment },
    fetch() { assert.fail('No real provider or database request is permitted') },
    require(name) { if (Object.hasOwn(imports, name)) return imports[name]; if (name.startsWith('node:')) return native(name); throw Error('Unexpected import: ' + name) },
  })
  return module.exports
}
const userId = '81000000-0000-4000-8000-000000000001'
const reference = 'xelay_81000000-0000-4000-8000-000000000002'
const environment = { BILLING_MODE: 'test', VERCEL_ENV: 'development', BILLING_TEST_ISOLATED: 'true', TEACHER_PLANS_ENABLED: 'true', STUDENT_PLANS_ENABLED: 'true',
  XELAY_PUBLIC_URL: 'https://teacher-payments.invalid', WAYFORPAY_MERCHANT_ACCOUNT: 'test_teacher_fixture', WAYFORPAY_SECRET_KEY: 'synthetic-local-signing-secret',
  WAYFORPAY_MERCHANT_DOMAIN: 'teacher-payments.invalid', SUPABASE_URL: 'https://teacher-db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-fixture-key', BILLING_CHECKOUT_ENABLED: 'true' }
function fixture(options = {}) {
  const env = { ...environment, ...options.env }
  const calls = [], teachers = load('server/teacher-learning/teacherPlanPrices.ts', {}, env)
  const students = load('server/student-learning/studentPlanPrices.ts', {}, env)
  const order = { id: 'owned-test-order', user_id: userId, product: 'participant', group_id: null, mode: 'test', amount: 499, currency: 'UAH', student_plan_id: null,
    teacher_plan_id: 'teacher_plus', status: 'pending', created_at: new Date().toISOString(), order_reference: reference, ...options.order }
  const service = { async rpc(name, args) { calls.push({ name, args: plain(args) }); return { data: options.denied ? null : order, error: options.denied ? { message: options.denied } : null } },
    from(table) { calls.push({ table }); const query = { update(values) { calls.push({ consent: plain(values) }); return query }, eq() { return query }, select() { return query }, order() { return query }, limit() { return query },
      async single() { return { data: options.consentFailed ? null : { id: order.id }, error: null } }, then(resolve) { resolve({ data: [order], error: null }) } }; return query },
  }
  const userClient = { async rpc(name) { calls.push({ status: name }); return { data: name === 'xelay_teacher_workspace_status'
    ? { audience: options.audience ?? 'teacher', planId: 'teacher_plus', startsAt: '2026-11-17T12:00:00Z', expiresAt: '2026-12-17T12:00:00Z' }
    : name === 'xelay_student_workspace_status' ? { audience: options.studentAudience ?? options.audience ?? 'teacher', planId: 'free' } : { participant: null }, error: options.statusError ? { message: 'unavailable' } : null } } }
  const adapter = { createClient(_url, _key, config) { return config?.global ? userClient : { ...service, auth: { async getUser(token) { return { data: { user: token === 'synthetic-token' ? { id: userId, email: 'teacher@example.invalid' } : null }, error: null } } } } } }
  const billing = load('server/billing.ts', { '@supabase/supabase-js': adapter, '../src/lib/legal.js': { legalMerchant: { ready: true } }, '../src/lib/teamSupport.js': { SUPPORT_ORDER_REFERENCE: /^xelay_support_/ },
    './student-learning/studentPlanPrices.js': students, './student-learning/aiCreditPrices.js': load('server/student-learning/aiCreditPrices.ts'), './teacher-learning/teacherPlanPrices.js': teachers }, env)
  const imports = { '../../server/billing.js': billing, '../../src/lib/legal.js': { legalMerchant: { ready: true }, LEGAL_TERMS_VERSION: 'fixture-current' }, '../../server/student-learning/studentPlanPrices.js': students, '../../server/teacher-learning/teacherPlanPrices.js': teachers,
    '../../server/student-learning/aiCreditPrices.js': load('server/student-learning/aiCreditPrices.ts'), '../../src/lib/aiCreditTerms.js': { AI_CREDIT_TERMS_VERSION: 'fixture-credit-terms' } }
  const checkout = load('api/billing/checkout.ts', imports, env).default
  const credits = load('api/billing/credits.ts', imports, env).default
  const status = load('api/billing/status.ts', imports, env).default
  async function call(body = {}, overrides = {}, handler = checkout) {
    const req = { method: handler === status ? 'GET' : 'POST', headers: { origin: env.XELAY_PUBLIC_URL, authorization: 'Bearer synthetic-token' }, body, ...overrides }
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, status(code) { this.statusCode = code; return this }, json(value) { this.body = plain(value); return this } }
    await handler(req, res); return res
  }
  return { env, teachers, billing, calls, order, call, status, credits }
}
const purchase = { product: 'participant', teacherPlanId: 'teacher_plus', recurring: false, acceptedTerms: true, termsVersion: 'fixture-current' }

function assertPurchaseMismatch(response, calls) {
  assert.equal(response.statusCode, 409, JSON.stringify(response.body))
  assert.deepEqual(Object.keys(response.body), ['error'])
  assert.equal(calls.some(call => call.consent), false)
}

test('legacy checkout cannot sign a valid but unrelated student or teacher Max order', async () => {
  const legacy = { product: 'participant', acceptedTerms: true, termsVersion: 'fixture-current' }
  for (const row of [{ teacher_plan_id: null, student_plan_id: 'max' }, { teacher_plan_id: 'teacher_max' }]) {
    for (const enabled of ['false', 'true']) {
      const f = fixture({ env: { STUDENT_PLANS_ENABLED: enabled }, order: { ...row, amount: 999 } })
      assertPurchaseMismatch(await f.call(legacy), f.calls)
      assert.ok(f.calls.some(call => call.name === 'xelay_create_billing_order'))
    }
  }
})

test('signing matches the exact audience and tier even when two tiers cost 999 UAH', async () => {
  const studentMax = { teacher_plan_id: null, student_plan_id: 'max', amount: 999 }
  const teacherMax = { teacher_plan_id: 'teacher_max', amount: 999 }
  const student = { ...purchase, teacherPlanId: undefined, studentPlanId: 'max' }
  for (const [request, order] of [[purchase, teacherMax], [{ ...purchase, teacherPlanId: 'teacher_max' }, studentMax],
    [student, teacherMax], [student, { ...studentMax, student_plan_id: 'plus', amount: 399 }], [purchase, { user_id: 'other-owner' }], [purchase, { status: 'approved' }]]) {
    const f = fixture({ order })
    assertPurchaseMismatch(await f.call(request), f.calls)
  }
})

test('ordinary student purchases and birthday offers only reuse the matching coupon choice', async () => {
  const gift = 'aa000000-0000-4000-8000-000000000001'
  const full = { teacher_plan_id: null, student_plan_id: 'plus', amount: 399 }
  const discounted = { ...full, birthday_gift_id: gift, list_amount: 399, discount_percent: 30, amount: 279.30,
    discount_expires_at: new Date(Date.now() + 3 * 86400000).toISOString() }
  const student = { ...purchase, teacherPlanId: undefined, studentPlanId: 'plus' }
  for (const [request, order] of [[student, discounted], [{ ...student, birthdayGiftId: gift }, full],
    [{ ...student, birthdayGiftId: userId }, discounted]]) {
    const f = fixture({ order })
    assertPurchaseMismatch(await f.call(request), f.calls)
  }
  const retry = fixture({ order: discounted })
  const result = await retry.call({ ...student, birthdayGiftId: gift.toUpperCase() })
  assert.equal(result.statusCode, 200, JSON.stringify(result.body))
  assert.equal(result.body.checkout.fields.amount, 279.30)
  assert.equal(result.body.orderReference, reference)
})

test('credit checkout binds the owner, package and version of accepted terms before signing', async () => {
  const body = { packageId: 'credits_1000', termsVersion: 'fixture-credit-terms', acceptedTerms: true }
  const credit = { product: 'ai_credits', teacher_plan_id: null, order_reference: reference.replace('xelay_', 'xtop_'),
    package_id: 'credits_1000', amount: 99, credit_micros: 1000000, terms_version: body.termsVersion }
  const valid = fixture({ order: credit })
  const signed = await valid.call(body, {}, valid.credits)
  assert.equal(signed.statusCode, 200, JSON.stringify(signed.body))
  assert.equal(signed.body.checkout.fields.amount, 99)
  assert.equal(signed.body.orderReference, credit.order_reference)
  for (const change of [{ package_id: 'credits_10000', amount: 749, credit_micros: 10000000 },
    { terms_version: 'outdated' }, { user_id: 'other-owner' }, { status: 'approved' }, { list_amount: 99 },
    { product: 'participant' }, { student_plan_id: 'max' }, { teacher_plan_id: 'teacher_max' }, { birthday_gift_id: userId }]) {
    const f = fixture({ order: { ...credit, ...change } })
    assertPurchaseMismatch(await f.call(body, {}, f.credits), f.calls)
  }
  const wrongType = fixture({ order: credit })
  assertPurchaseMismatch(await wrongType.call(purchase), wrongType.calls)
})

test('all teacher tiers have exact canonical prices and signed one-month checkout fields', async () => {
  const signatures = []
  for (const [teacher_plan_id, amount] of Object.entries({ teacher_start: 199, teacher_plus: 499, teacher_max: 999 })) {
    const f = fixture({ order: { teacher_plan_id, amount } }), result = await f.call({ ...purchase, teacherPlanId: teacher_plan_id, amount: 1, audience: 'teacher', userId: 'attacker' })
    assert.equal(result.statusCode, 200, JSON.stringify(result.body))
    const fields = result.body.checkout.fields
    assert.equal(fields.amount, amount); assert.equal(fields.regularMode, 'none'); assert.equal(fields.currency, 'UAH')
    assert.match(fields.productName[0], /Викладацький/)
    const creation = f.calls.find(c => c.name === 'xelay_create_teacher_plan_order')
    assert.equal(creation.args.p_user_id, userId); assert.equal(creation.args.p_plan_id, teacher_plan_id)
    assert.equal(creation.args.amount, undefined); assert.equal(creation.args.audience, undefined)
    assert.equal(fields.merchantSignature, f.billing.signature([f.env.WAYFORPAY_MERCHANT_ACCOUNT, f.env.WAYFORPAY_MERCHANT_DOMAIN, result.body.orderReference, fields.orderDate, amount, 'UAH', fields.productName[0], 1, amount], f.env.WAYFORPAY_SECRET_KEY))
    assert.ok(f.calls.some(c => c.consent?.terms_version === 'fixture-current'))
    signatures.push(fields.merchantSignature)
  }
  assert.equal(new Set(signatures).size, 3)
})

test('unknown/mixed plans, coupon mixing, recurring and missing consent never create orders', async () => {
  for (const changes of [{ teacherPlanId: 'constructor' }, { teacherPlanId: 'max' }, { teacherPlanId: {} }, { studentPlanId: 'max' }, { birthdayGiftId: userId }, { discountPercent: 20 }, { couponCode: 'X' }, { recurring: true }, { acceptedTerms: false }, { termsVersion: 'old' }, { groupId: userId }]) {
    const f = fixture(), response = await f.call({ ...purchase, ...changes })
    assert.equal(response.statusCode, 400, JSON.stringify(changes)); assert.equal(f.calls.some(c => c.name), false)
  }
})

test('teacher launch fails closed and cannot bypass authenticated identity, origin or database audience restrictions', async () => {
  const off = fixture({ env: { TEACHER_PLANS_ENABLED: 'false' } }); assert.equal((await off.call(purchase)).statusCode, 503); assert.equal(off.calls.some(c => c.name), false)
  for (const headers of [{ origin: 'https://attacker.invalid', authorization: 'Bearer synthetic-token' }, { origin: environment.XELAY_PUBLIC_URL }, { authorization: 'Bearer invalid', origin: environment.XELAY_PUBLIC_URL }]) {
    const f = fixture(), r = await f.call(purchase, { headers }); assert.ok([401, 403].includes(r.statusCode)); assert.equal(f.calls.some(c => c.name), false)
  }
  const denied = fixture({ denied: 'TEACHER_AUDIENCE_REQUIRED' }); assert.equal((await denied.call(purchase)).statusCode, 403)
  const consent = fixture({ consentFailed: true }); assert.equal((await consent.call(purchase)).statusCode, 409)
})

test('tampered prices, student or coupon metadata cannot become a signed teacher checkout', () => {
  for (const order of [{ amount: 1 }, { teacher_plan_id: 'max' }, { student_plan_id: 'max' }, { birthday_gift_id: userId }, { list_amount: 499 }, { discount_percent: 20 }, { discount_expires_at: '2030-01-01T00:00:00Z' }, { currency: 'USD' }, { mode: 'live' }]) {
    const f = fixture({ order }); assert.throws(() => f.billing.signedCheckout(f.order, { id: userId }, { kind: 'teacher', planId: 'teacher_plus' }), error => error instanceof f.billing.BillingError)
  }
})

test('own status exposes authoritative audience and teacher plan; unavailable state cannot silently appear free', async () => {
  const f = fixture(), response = await f.call({}, {}, f.status)
  assert.equal(response.statusCode, 200); assert.equal(response.body.subscriptionAudience, 'teacher')
  assert.equal(response.body.studentPlansAvailable, false); assert.equal(response.body.teacherPlan.id, 'teacher_plus')
  assert.equal(response.body.teacherPlanPrices.teacher_max, 999); assert.equal(response.headers['Cache-Control'], 'no-store')
  const unavailable = fixture({ statusError: true }); assert.equal((await unavailable.call({}, {}, unavailable.status)).statusCode, 503)
  const student = fixture({ audience: 'student' }); assert.equal((await student.call({}, {}, student.status)).body.subscriptionAudience, 'student')
})

test('sales switch is literal true and turning it off preserves callbacks for already opened orders', () => {
  const f = fixture()
  for (const value of [undefined, 'TRUE', '1', 'true ', 'false']) assert.equal(f.teachers.teacherPlansEnabled({ TEACHER_PLANS_ENABLED: value }), false)
  const off = fixture({ env: { TEACHER_PLANS_ENABLED: 'false' } })
  assert.equal(off.billing.publicBillingConfiguration().teacherPlansAvailable, undefined)
  assert.equal(off.billing.billingConfiguration().callbacksAvailable, true)
  assert.equal(off.billing.signedCheckout(off.order, { id: userId }, { kind: 'teacher', planId: 'teacher_plus' }).fields.amount, 499)
})

test('temporary teacher access preserves a student account billing identity and catalogue', async () => {
  const f = fixture({ studentAudience: 'student' })
  const response = await f.call({}, {}, f.status)
  assert.equal(response.statusCode, 200)
  assert.equal(response.body.subscriptionAudience, 'student')
  assert.equal(response.body.studentPlansAvailable, true)
  assert.equal(response.body.teacherPlan.id, 'teacher_plus')
})
