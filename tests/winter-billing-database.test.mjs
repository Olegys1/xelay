import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createWinterBillingFixture } from './helpers/winterBillingFixture.mjs'


test('winter coupons and annual periods use real local SQL, fictional accounts and no provider requests', { timeout: 180000 }, async t => {
  const fx = await createWinterBillingFixture(); t.after(() => fx.close())
  const { db, ids } = fx, student = ids.studentA, teacher = ids.owner, recipient = ids.studentB
  await fx.serviceCall('xelay_student_audience_assign', [student, 'student', 'Synthetic winter payment identity'])
  await fx.serviceCall('xelay_student_audience_assign', [recipient, 'student', 'Synthetic winter recipient identity'])
  await fx.claim(student, [3, 12, 22, 29]); await fx.claim(teacher, [27, 29]); await fx.claim(ids.outsider, [5, 18, 28])
  let annual
  await t.test('unearned / wrong audience / missing consent / injected selection fail; one reservation under retries', async () => {
    assert.equal((await fx.quote(student, 'student', 'plus')).available, false)
    await assert.rejects(fx.order(student, 'student', 'plus'))
    await assert.rejects(fx.order(student, 'teacher', 'teacher_start'))
    await assert.rejects(fx.serviceCall('xelay_winter_subscription_order', [student, 'student', 'start', 1, 'own', 'live', 'xelay_' + randomUUID(), 'wrong']))
    const attempts = await Promise.all([fx.order(student, 'student', 'start', 12), fx.order(student, 'student', 'start', 12)])
    assert.equal(attempts[0].id, attempts[1].id); annual = attempts[0]
    assert.equal(Number(annual.amount), 1430.4); assert.equal(annual.winter_discount_percent, 20)
    const offers = await fx.serviceCall('xelay_winter_billing_offers', [student])
    assert.equal(offers.subscriptionUsed, false); assert.equal(offers.pendingOrder.orderReference, annual.order_reference); assert.equal(Number(offers.pendingOrder.amount), 1430.4)
    await assert.rejects(fx.order(student, 'student', 'start', 1))
    await assert.rejects(db.query('update public.billing_orders set winter_discount_percent=25 where id=$1', [annual.id]))
    await assert.rejects(fx.applyPayment(annual, 'Approved', { amount: 1 }))
  })
  await t.test('annual paid order gives twelve anchored months, no overlap, stable duplicate callback', async () => {
    await db.exec("update xelay_winter_private.test_clock set at='2027-01-31 10:30 Europe/Kyiv'")
    await fx.applyPayment(annual); await fx.applyPayment(annual)
    const periods = (await db.query(`select g.order_cycle,p.valid_from,p.valid_until from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id where g.order_id=$1 order by g.order_cycle`, [annual.id])).rows
    assert.equal(periods.length, 12)
    for (let i = 0; i < periods.length; i++) {
      assert.equal(periods[i].order_cycle, i)
      if (i) assert.equal(String(periods[i].valid_from), String(periods[i - 1].valid_until))
    }
    const dates = (await db.query(`select (min(p.valid_from)at time zone'Europe/Kyiv')::text first,(max(p.valid_until)at time zone'Europe/Kyiv')::text last from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id where g.order_id=$1`, [annual.id])).rows[0]
    assert.equal(dates.first, '2027-01-31 10:30:00'); assert.equal(dates.last, '2028-01-31 10:30:00')
    const march = (await db.query(`select(p.valid_until at time zone'Europe/Kyiv')::text last from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id where g.order_id=$1 and g.order_cycle=1`, [annual.id])).rows[0]
    assert.equal(march.last, '2027-03-31 10:30:00')
    await fx.applyPayment(annual, 'Refunded'); await fx.applyPayment(annual)
    assert.equal((await db.query('select count(*)::int n from xelay_student_private.grants where order_id=$1 and revoked_at is null', [annual.id])).rows[0].n, 0)
  })
  await t.test('friend token is manual, cannot self-redeem, transfer twice or stack with an own coupon', async () => {
    const token = await fx.serviceCall('xelay_winter_friend_issue', [ids.outsider])
    assert.equal(token.percent, 20)
    await assert.rejects(fx.serviceCall('xelay_winter_friend_accept', [ids.outsider, token.token]))
    await fx.serviceCall('xelay_winter_friend_accept', [recipient, token.token])
    await assert.rejects(fx.serviceCall('xelay_winter_friend_accept', [student, token.token]))
    const o = await fx.order(recipient, 'student', 'plus', 1, 'friend')
    assert.equal(Number(o.amount), 319.2); await fx.applyPayment(o)
    await fx.claim(recipient, [24]); await assert.rejects(fx.order(recipient, 'student', 'plus'))
    await assert.rejects(fx.order(recipient, 'student', 'plus', 12, 'friend'))
  })
  await t.test('first issued friend code and discount stay immutable after later claims, before and after acceptance', async () => {
    await fx.claim(teacher, [5])
    const first = await fx.serviceCall('xelay_winter_friend_issue', [teacher])
    assert.equal(first.percent, 10)
    await fx.claim(teacher, [18, 28])
    const beforeAcceptance = await fx.serviceCall('xelay_winter_friend_issue', [teacher])
    assert.equal(beforeAcceptance.token, first.token); assert.equal(beforeAcceptance.percent, 10)
    const accepted = await fx.serviceCall('xelay_winter_friend_accept', [ids.colleague, first.token])
    assert.equal(accepted.percent, 10)
    const afterAcceptance = await fx.serviceCall('xelay_winter_friend_issue', [teacher])
    assert.equal(afterAcceptance.token, first.token); assert.equal(afterAcceptance.percent, 10)
    assert.equal((await db.query('select count(*)::int n from xelay_winter_payment_private.friends where owner_id=$1', [teacher])).rows[0].n, 1)
  })
  await t.test('teacher annual has twelve distinct grant allowances and refunds every cycle', async () => {
    const o = await fx.order(teacher, 'teacher', 'teacher_max', 12)
    assert.equal(Number(o.amount), 9590.4); await fx.applyPayment(o)
    assert.equal((await db.query('select count(*)::int n from xelay_teacher_private.grants where order_id=$1', [o.id])).rows[0].n, 12)
    await fx.applyPayment(o, 'Refunded')
    assert.equal((await db.query('select count(*)::int n from xelay_teacher_private.grants where order_id=$1 and revoked_at is null', [o.id])).rows[0].n, 0)
  })
  await t.test('authenticated and anonymous roles cannot read tokens or call service payment functions', async () => {
    await assert.rejects(fx.ownerCall('xelay_winter_billing_offers', [student], student))
    await db.exec('set role anon')
    try { await assert.rejects(db.query('select * from xelay_winter_payment_private.friends')) } finally { await db.exec('reset role') }
  })
  await t.test('twelve paid Max allowances select only the current month and preserve gifted time and consumption', async () => {
    const user = ids.outsider
    await fx.serviceCall('xelay_student_audience_assign', [user, 'student', 'Synthetic annual allowance account'])
    await fx.claim(user, [29])
    const gift = await fx.serviceCall('xelay_student_plan_grant', [user, 'plus', '2027-01-31T08:30:00Z', '2027-02-03T08:30:00Z', 'synthetic-preserved-plus-gift'])
    const old = (await db.query("select g.id,to_jsonb(g)original from xelay_student_private.grants g where reference='synthetic-preserved-plus-gift'")).rows[0]
    const o = await fx.order(user, 'student', 'max', 12); await fx.applyPayment(o)
    const windows = (await db.query(`select g.id,g.order_cycle,w.grant_id,w.cycle from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id cross join lateral xelay_student_private.max_budget_window(g.user_id,p.valid_from+interval'1 hour')w where g.order_id=$1 order by g.order_cycle`, [o.id])).rows
    assert.equal(windows.length, 12); assert.equal(new Set(windows.map(x => x.grant_id)).size, 12)
    for (const w of windows) { assert.equal(w.id, w.grant_id); assert.equal(w.cycle, 0) }
    await db.query('insert into xelay_student_private.period_usage(user_id,grant_id,cycle,spent_micros)values($1,$2,0,9999999)', [user, windows[0].id])
    await fx.applyPayment(o)
    assert.equal((await db.query('select spent_micros::text n from xelay_student_private.period_usage where grant_id=$1', [windows[0].id])).rows[0].n, '9999999')
    assert.deepEqual((await db.query('select to_jsonb(g)original from xelay_student_private.grants g where id=$1', [old.id])).rows[0].original, old.original)
    assert.equal((await db.query('select sum(extract(epoch from(valid_until-valid_from)))::integer seconds from xelay_student_private.grant_periods where grant_id=$1', [old.id])).rows[0].seconds, 3 * 86400)
    assert.ok(gift)
  })
  await t.test('pending callback during pause queues every new month after pause; test-mode never issues grants', async () => {
    const user = ids.otherTeacher
    await fx.claim(user, [29])
    await db.query("insert into xelay_winter_private.test_pauses values($1,'teacher','2027-02-07 10:30 Europe/Kyiv')", [user])
    await assert.rejects(fx.order(user, 'teacher', 'teacher_plus', 12))
    await db.query('delete from xelay_winter_private.test_pauses where user_id=$1', [user])
    const o = await fx.order(user, 'teacher', 'teacher_plus', 12)
    await db.query("insert into xelay_winter_private.test_pauses values($1,'teacher','2027-02-07 10:30 Europe/Kyiv')", [user])
    await fx.applyPayment(o)
    const at = (await db.query("select(min(p.valid_from)at time zone'Europe/Kyiv')::text n from xelay_teacher_private.periods p join xelay_teacher_private.grants g on g.id=p.grant_id where g.order_id=$1", [o.id])).rows[0].n
    assert.equal(at, '2027-02-07 10:30:00')
    await fx.claim(ids.colleague, [29])
    const isolated = await fx.order(ids.colleague, 'teacher', 'teacher_plus', 12, 'own', 'test'); await fx.applyPayment(isolated)
    assert.equal((await db.query('select count(*)::int n from xelay_teacher_private.grants where order_id=$1', [isolated.id])).rows[0].n, 0)
    await fx.applyPayment(isolated, 'Refunded')
  })
  await t.test('paid credit bonus chooses the best claimed cap once, survives callback delay and reverses only its own source', async () => {
    const user = ids.outsider
    await fx.serviceCall('xelay_student_plan_grant', [user, 'max', new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000 * 20).toISOString(), 'synthetic-active-credit-buyer'])
    await fx.claim(user, [11, 21])
    await db.exec("update xelay_winter_private.test_clock set at='2027-02-28 23:50 Europe/Kyiv'")
    const order = await fx.serviceCall('xelay_create_max_credit_order', [user, 'live', 'xtop_' + randomUUID(), 'credits_10000', '2026-11-17.1'])
    const apply = (o, status, fingerprint = randomUUID().replaceAll('-', '').padEnd(64, 'a')) => fx.serviceCall('xelay_apply_max_credit_event', [o.order_reference, o.mode, fingerprint, status, o.amount, 'UAH'])
    await db.exec("update xelay_winter_private.test_clock set at='2027-03-01 00:10 Europe/Kyiv'")
    await apply(order, 'Approved'); await apply(order, 'Approved')
    const bonus = (await db.query('select * from xelay_winter_private.test_bonus where user_id=$1', [user])).rows
    assert.equal(bonus.length, 1); assert.equal(Number(bonus[0].micros), 300000); assert.equal(bonus[0].revoked, false)
    const next = await fx.serviceCall('xelay_create_max_credit_order', [user, 'live', 'xtop_' + randomUUID(), 'credits_1000', '2026-11-17.1']); await apply(next, 'Approved')
    assert.equal((await db.query('select count(*)::int n from xelay_winter_private.test_bonus where user_id=$1', [user])).rows[0].n, 1)
    await apply(order, 'Refunded'); await apply(order, 'Approved')
    assert.equal((await db.query('select revoked from xelay_winter_private.test_bonus where user_id=$1', [user])).rows[0].revoked, true)
    assert.equal(Number((await db.query('select granted_micros from xelay_student_private.credit_wallets where user_id=$1', [user])).rows[0].granted_micros), 1000000)
    assert.equal((await fx.quote(user, 'student', 'max')).available, false)
  })
  await t.test('only provider-confirmed expiry unlocks a new payable order; old contradictory approval cannot grant twice', async () => {
    const user = ids.admin
    await db.exec("update xelay_winter_private.test_clock set at='2026-12-31 12:00 Europe/Kyiv'")
    await fx.serviceCall('xelay_student_audience_assign', [user, 'student', 'Synthetic expired checkout recovery'])
    await fx.claim(user, [22, 24])
    const first = await fx.order(user, 'student', 'start')
    await assert.rejects(fx.order(user, 'student', 'plus'))
    await fx.applyPayment(first, 'Expired')
    const offers = await fx.serviceCall('xelay_winter_billing_offers', [user])
    assert.equal(offers.subscriptionUsed, false); assert.equal(offers.pendingOrder, null)
    const second = await fx.order(user, 'student', 'plus'); assert.notEqual(first.id, second.id)
    await assert.rejects(fx.applyPayment(first, 'Approved'), /RESERVATION_REQUIRED/)
    await fx.applyPayment(second)
    await fx.applyPayment(first, 'Refunded')
    assert.equal((await db.query('select count(*)::int n from xelay_student_private.grants where user_id=$1 and revoked_at is null', [user])).rows[0].n, 1)
    assert.equal((await fx.serviceCall('xelay_winter_billing_offers', [user])).subscriptionUsed, true)
  })
})
