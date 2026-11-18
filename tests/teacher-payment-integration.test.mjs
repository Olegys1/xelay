import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import { createTeacherBackendFixture } from './helpers/teacherBackendFixture.mjs'

const native = createRequire(import.meta.url)
function load(path, imports, environment) {
  const module = { exports: {} }
  const compiled = ts.transpileModule(readFileSync(new URL('../' + path, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(compiled, { module, exports: module.exports, Buffer, URL, Date, Number, Math, JSON, process: { env: environment },
    fetch() { assert.fail('No external payment, database or provider call is permitted') },
    require(name) { if (Object.hasOwn(imports, name)) return imports[name]; if (name.startsWith('node:')) return native(name); throw Error('Unexpected import ' + name) },
  })
  return module.exports
}

test('teacher checkout → real signature validation → real SQL callback → fresh access, without payment traffic', { timeout: 120000 }, async t => {
  const fx = await createTeacherBackendFixture()
  try {
  const environment = { ...fx.environment, TEACHER_PLANS_ENABLED: 'true', STUDENT_PLANS_ENABLED: 'true', BILLING_MODE: 'live', VERCEL_ENV: 'development',
    XELAY_PUBLIC_URL: 'https://teacher-payments.invalid', WAYFORPAY_MERCHANT_ACCOUNT: 'synthetic_teacher_merchant', WAYFORPAY_SECRET_KEY: 'synthetic-local-hmac-secret',
    WAYFORPAY_MERCHANT_DOMAIN: 'teacher-payments.invalid', BILLING_CHECKOUT_ENABLED: 'true', WAYFORPAY_LIVE_APPROVED: 'true' }
  const rpcArguments = { xelay_create_teacher_plan_order: ['p_user_id', 'p_mode', 'p_order_reference', 'p_plan_id'],
    xelay_apply_billing_event: ['p_reference', 'p_mode', 'p_fingerprint', 'p_status', 'p_amount', 'p_currency', 'p_fee'],
    xelay_teacher_workspace_status: [], xelay_student_workspace_status: [], xelay_billing_status: [] }
  const rows = async (sql, args = []) => (await fx.db.query(sql, args)).rows
  function query(table) {
    assert.equal(table, 'billing_orders')
    const safe = new Set(['id', 'user_id', 'status', 'product', 'group_id', 'order_reference', 'amount', 'currency', 'mode', 'created_at', 'approved_at', 'student_plan_id', 'teacher_plan_id', 'terms_version', 'terms_accepted_at'])
    const identifier = value => { assert.ok(safe.has(value), value); return value }
    let columns = '*', update, conditions = [], ordering = '', maximum = ''
    async function execute() {
      const args = []
      let sql = update ? 'update public.billing_orders set ' + Object.entries(update).map(([key, value]) => { args.push(value); return `${identifier(key)}=$${args.length}` }).join(',')
        : 'select ' + (columns === '*' ? '*' : columns.split(',').map(identifier).join(',')) + ' from public.billing_orders'
      const where = conditions.map(([key, value]) => { args.push(value); return `${identifier(key)}=$${args.length}` })
      if (where.length) sql += ' where ' + where.join(' and ')
      sql += update ? ' returning ' + columns : ordering + maximum
      return { data: await rows(sql, args), error: null }
    }
    const builder = { update(value) { update = value; return builder }, select(value) { columns = value; return builder }, eq(key, value) { conditions.push([key, value]); return builder },
      order(key, { ascending = true } = {}) { ordering = ` order by ${identifier(key)} ${ascending ? 'asc' : 'desc'}`; return builder }, limit(value) { assert.ok(value === 20); maximum = ' limit 20'; return builder },
      async single() { const result = await execute(); assert.equal(result.data.length, 1); return { data: result.data[0], error: null } },
      then(resolve, reject) { return execute().then(resolve, reject) } }
    return builder
  }
  const adapter = { createClient(url, key, options = {}) {
    const original = fx.clientFactory(url, key, options)
    const service = key === environment.SUPABASE_SERVICE_ROLE_KEY
    let user = fx.ids.owner
    const token = options.global?.headers?.Authorization?.replace(/^Bearer /, '')
    if (token) user = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub
    return { auth: original.auth, from: query, async rpc(name, args = {}) {
      const names = rpcArguments[name]; assert.ok(names, name)
      try { return { data: await (service ? fx.serviceCall(name, names.map(n => args[n] ?? null)) : fx.ownerCall(name, names.map(n => args[n] ?? null), user)), error: null } }
      catch (error) { return { data: null, error: { message: error.message, code: error.code } } }
    } }
  } }
  const teachers = load('server/teacher-learning/teacherPlanPrices.ts', {}, environment)
  const students = load('server/student-learning/studentPlanPrices.ts', {}, environment)
  const legal = { legalMerchant: { ready: true }, LEGAL_TERMS_VERSION: 'synthetic-current-terms' }
  const billing = load('server/billing.ts', { '@supabase/supabase-js': adapter, '../src/lib/legal.js': legal, '../src/lib/teamSupport.js': { SUPPORT_ORDER_REFERENCE: /^xelay_support_/ },
    './student-learning/studentPlanPrices.js': students, './student-learning/aiCreditPrices.js': load('server/student-learning/aiCreditPrices.ts', {}, environment), './teacher-learning/teacherPlanPrices.js': teachers }, environment)
  const imports = { '../../server/billing.js': billing, '../../src/lib/legal.js': legal, '../../server/student-learning/studentPlanPrices.js': students, '../../server/teacher-learning/teacherPlanPrices.js': teachers,
    '../../src/lib/teamSupport.js': { SUPPORT_ORDER_REFERENCE: /^xelay_support_/ }, '../../server/student-learning/aiCreditPrices.js': load('server/student-learning/aiCreditPrices.ts', {}, environment) }
  const handlers = Object.fromEntries(['checkout', 'status', 'webhook', 'return'].map(name => [name, load(`api/billing/${name}.ts`, imports, environment).default]))
  async function call(handler, body = {}, { user = fx.ids.owner, method = handler === 'status' ? 'GET' : 'POST', query = {} } = {}) {
    const response = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, status(value) { this.statusCode = value; return this }, json(value) { this.body = value; return this }, end() { return this } }
    await handlers[handler]({ method, body, query, headers: { origin: environment.XELAY_PUBLIC_URL, ...(user ? { authorization: 'Bearer ' + fx.token(user) } : {}) } }, response)
    return response
  }
  function callback(order, status = 'Approved', changes = {}) {
    const value = { merchantAccount: environment.WAYFORPAY_MERCHANT_ACCOUNT, orderReference: order.orderReference, amount: order.checkout.fields.amount,
      currency: 'UAH', authCode: 'SYNTHETIC', cardPan: '411111******1111', transactionStatus: status, reasonCode: 1100, ...changes }
    value.merchantSignature = billing.signature(['merchantAccount', 'orderReference', 'amount', 'currency', 'authCode', 'cardPan', 'transactionStatus', 'reasonCode'].map(k => value[k]), environment.WAYFORPAY_SECRET_KEY)
    return value
  }
  const activity = (await rows('insert into public.teaching_activities(course_id,group_id,title,activity_date,max_points)values($1,$2,$3,current_date,10)returning id', [fx.ids.course, fx.groups[0], 'Synthetic previously published activity']))[0].id
  let entry = (await rows('select id from public.teaching_entries where course_id=$1 and group_id=$2 and user_id=$3', [fx.ids.course, fx.groups[0], fx.ids.studentA]))[0]?.id
  if (!entry) entry = (await rows('insert into public.teaching_entries(course_id,group_id,user_id,full_name)values($1,$2,$3,$4)returning id', [fx.ids.course, fx.groups[0], fx.ids.studentA, 'Synthetic student']))[0].id
  await rows('insert into public.teaching_grades(course_id,group_id,activity_id,entry_id,draft_score,published_score,published_at,updated_by)values($1,$2,$3,$4,8,8,now(),$5)', [fx.ids.course, fx.groups[0], activity, entry, fx.ids.owner])
  const initialGrades = JSON.stringify(await rows('select * from public.teaching_grades order by id'))
  assert.equal(JSON.parse(initialGrades).length, 1, 'Preservation must be exercised with a real published grade')
    for (const [teacherPlanId, price] of Object.entries({ teacher_start: 199, teacher_plus: 499, teacher_max: 999 })) {
      await t.test(`${teacherPlanId}: exact signed amount, browser return grants nothing, duplicate callback grants once`, async () => {
        const result = await call('checkout', { product: 'participant', teacherPlanId, recurring: false, acceptedTerms: true, termsVersion: legal.LEGAL_TERMS_VERSION })
        assert.equal(result.statusCode, 200, JSON.stringify(result.body)); const order = result.body
        assert.equal(order.checkout.fields.amount, price)
        const before = (await rows('select count(*)::int n from xelay_teacher_private.grants'))[0].n
        const returned = await call('return', {}, { query: { orderReference: order.orderReference } }); assert.equal(returned.statusCode, 303)
        assert.equal((await rows('select count(*)::int n from xelay_teacher_private.grants'))[0].n, before)
        const paid = callback(order)
        assert.equal((await call('webhook', paid, { user: null })).statusCode, 200)
        assert.equal((await call('webhook', paid, { user: null })).statusCode, 200)
        assert.equal((await rows('select count(*)::int n from xelay_teacher_private.grants'))[0].n, before + 1)
        const status = await call('status'); assert.equal(status.statusCode, 200, JSON.stringify(status.body))
        assert.equal(status.body.teacherPlan.id, teacherPlanId); assert.equal(status.body.subscriptionAudience, 'teacher')
        const foreign = await call('status', {}, { user: fx.ids.otherTeacher }); assert.equal(foreign.statusCode, 200)
        assert.equal(foreign.body.orders.some(o => o.order_reference === order.orderReference), false); assert.equal(foreign.body.teacherPlan, null)
      })
    }
    await t.test('wrong signatures/amount and student identities cannot grant teacher access; prior grades remain intact', async () => {
      const result = await call('checkout', { product: 'participant', teacherPlanId: 'teacher_max', acceptedTerms: true, termsVersion: legal.LEGAL_TERMS_VERSION })
      assert.equal(result.statusCode, 200); const order = result.body
      const forged = callback(order); forged.amount = 1
      assert.equal((await call('webhook', forged, { user: null })).statusCode, 403)
      assert.equal((await call('webhook', callback(order, 'Approved', { amount: 1 }), { user: null })).statusCode, 409)
      await fx.serviceCall('xelay_student_audience_assign', [fx.ids.studentA, 'student', 'Synthetic student account'])
      const wrong = await call('checkout', { product: 'participant', teacherPlanId: 'teacher_max', acceptedTerms: true, termsVersion: legal.LEGAL_TERMS_VERSION }, { user: fx.ids.studentA })
      assert.equal(wrong.statusCode, 403)
      assert.equal(JSON.stringify(await rows('select * from public.teaching_grades order by id')), initialGrades)
    })
  } finally { await fx.close() }
})
