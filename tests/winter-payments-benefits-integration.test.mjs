import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createTeacherBackendFixture, teacherPlanMigration } from './helpers/teacherBackendFixture.mjs'
const hash = v => createHash('sha256').update(v).digest('hex')

test('real winter benefits plus payments: annual quotas, pause, bonus spending and refund share one protected ledger', { timeout: 180000 }, async t => {
  const f = await createTeacherBackendFixture({ applyTeacher: false }); t.after(() => f.close())
  const { db, ids } = f, user = ids.studentA, teacher = ids.owner
  for (const name of ['20261116161046_student_max_tutor_chat.sql', '20261116165652_student_max_study_formats.sql', '20261117070036_student_max_topic_generation.sql',
    '20261117105257_student_max_ai_credits.sql', '20261126154456_student_plus_ai_access.sql', teacherPlanMigration,
    '20261118105000_teacher_entitlement_free_status.sql', '20261118113915_teacher_trial_access.sql',
    '20261119103433_teacher_assistant_conversation.sql', '20261119110945_teacher_assistant_insights_reminders.sql', '20261126200041_winter_advent_private_progress.sql']) await db.exec((await f.readMigration(name)).replaceAll('\r', ''))
  await db.exec('alter table auth.users add column if not exists is_anonymous boolean default false')
  for (const name of ['20261127111625_winter_benefits_and_promotional_balance.sql', '20261127111754_winter_billing_offers.sql']) await db.exec((await f.readMigration(name)).replaceAll('\r', ''))
  await db.exec(`create or replace function public.xelay_private_winter_clock()returns timestamptz language sql volatile set search_path=''as $$select current_setting('test.winter.clock')::timestamptz$$`)
  const clock = v => db.query("select set_config('test.winter.clock',$1,false)", [v])
  await clock('2026-12-31T12:00:00Z')
  const claim = (who, day) => f.serviceCall('xelay_winter_advent', [who, f.sessions[who], day])
  const benefits = (who, action = null) => f.serviceCall('xelay_winter_benefits', [who, f.sessions[who], action])
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows
  const winterOrder = (who, audience, plan, months = 1) => f.serviceCall('xelay_winter_subscription_order', [who, audience, plan, months, 'own', 'live', 'xelay_' + randomUUID(), '2026-11-27.1'])
  const paid = async (who, plan) => {
    const isTeacher = plan.startsWith('teacher_')
    await f.serviceCall('xelay_student_audience_assign', [who, isTeacher ? 'teacher' : 'student', 'Synthetic real winter integration'])
    const o = await f.serviceCall(isTeacher ? 'xelay_create_teacher_plan_order' : 'xelay_create_student_plan_order', [who, 'live', 'xelay_' + randomUUID(), plan]); await f.applyPayment(o)
    const sch = isTeacher ? 'xelay_teacher_private' : 'xelay_student_private', periods = isTeacher ? 'periods' : 'grant_periods'
    await db.query(`update ${sch}.${periods} p set valid_from='2026-11-01',valid_until='2027-03-15'from ${sch}.grants g where p.grant_id=g.id and g.order_id=$1`, [o.id])
    return o
  }
  const oldPaid = await paid(user, 'max'); const oldTeacher = await paid(teacher, 'teacher_plus')
  await t.test('annual twelve months queue after paid coverage; each month has a separate original allowance identity', async () => {
    await claim(user, 29); await claim(teacher, 29)
    for (const [who, audience, plan] of [[user, 'student', 'max'], [teacher, 'teacher', 'teacher_plus']]) {
      const o = await winterOrder(who, audience, plan, 12); await f.applyPayment(o); await f.applyPayment(o)
      const sch = audience === 'student' ? 'xelay_student_private' : 'xelay_teacher_private', periods = audience === 'student' ? 'grant_periods' : 'periods'
      const all = await rows(`select g.id,g.order_cycle,p.valid_from,p.valid_until from ${sch}.grants g join ${sch}.${periods} p on p.grant_id=g.id where g.order_id=$1 order by g.order_cycle`, [o.id])
      assert.equal(all.length, 12); assert.equal(new Set(all.map(x => x.id)).size, 12)
      for (let i = 1; i < all.length; i++) assert.equal(String(all[i].valid_from), String(all[i - 1].valid_until))
      if (audience === 'student') {
        for (const p of all) {
          const window = (await rows('select * from xelay_student_private.max_budget_window($1,$2::timestamptz+interval\'1 minute\')', [who, p.valid_from]))[0]
          assert.equal(window.grant_id, p.id); assert.equal(window.cycle, 0)
        }
      }
      await f.applyPayment(o, 'Refunded'); await f.applyPayment(o)
      assert.equal((await rows(`select count(*)::int n from ${sch}.grants where order_id=$1 and revoked_at is null`, [o.id]))[0].n, 0)
    }
    assert.equal((await rows('select revoked_at is null ok from xelay_student_private.grants where order_id=$1', [oldPaid.id]))[0].ok, true)
    assert.equal((await rows('select revoked_at is null ok from xelay_teacher_private.grants where order_id=$1', [oldTeacher.id]))[0].ok, true)
  })
  await t.test('credit purchase bonus is independent of advent activation; exact base→promo→paid settlement and refunds', async () => {
    await claim(user, 11); await claim(user, 21)
    await clock('2027-02-28T21:50:00Z')
    const topup = await f.serviceCall('xelay_create_max_credit_order', [user, 'live', 'xtop_' + randomUUID(), 'credits_3000', '2026-11-17.1'])
    const event = (status, id = randomUUID()) => f.serviceCall('xelay_apply_max_credit_event', [topup.order_reference, 'live', hash(id), status, topup.amount, 'UAH'])
    await clock('2027-02-28T22:10:00Z'); await event('Approved', 'approved'); await event('Approved', 'approved')
    assert.equal((await benefits(user)).promo.availableCredits, 300)
    const ent = await f.ownerCall('xelay_student_workspace_status', [], user)
    const window = (await rows('select * from xelay_student_private.max_budget_window($1,clock_timestamp())', [user]))[0]
    await db.query('insert into xelay_student_private.period_usage(user_id,grant_id,cycle,spent_micros)values($1,$2,$3,$4)on conflict(user_id,grant_id,cycle)do update set spent_micros=excluded.spent_micros', [user, window.grant_id, window.cycle, ent.budget.limitMicros])
    const request = { requestId: 'winter-purchase-bonus-integrated', mode: 'chat', prompt: 'Привіт', sources: [] }, fingerprint = hash(JSON.stringify(request))
    const hold = await f.serviceCall('xelay_max_ai_reserve', [user, hash(f.sessions[user]), request.requestId, fingerprint, 25000, ent.budget.limitMicros, request])
    await f.serviceCall('xelay_max_ai_finish', [user, hash(f.sessions[user]), request.requestId, fingerprint, hold.reservationId, 15000, null, request])
    await f.serviceCall('xelay_max_ai_finish', [user, hash(f.sessions[user]), request.requestId, fingerprint, hold.reservationId, 15000, null, request])
    assert.equal((await benefits(user)).promo.availableCredits, 285)
    const wallet = (await rows('select * from xelay_student_private.credit_wallets where user_id=$1', [user]))[0]
    assert.equal(Number(wallet.granted_micros), 3000000); assert.equal(Number(wallet.spent_micros), 0)
    await event('Refunded'); await event('Approved')
    const after = await benefits(user); assert.equal(after.promo.availableCredits, 0); assert.equal(after.promo.spentCredits, 15)
    assert.equal(Number((await rows('select granted_micros from xelay_student_private.credit_wallets where user_id=$1', [user]))[0].granted_micros), 0)
    assert.equal((await f.ownerCall('xelay_student_workspace_status', [], user)).budget.spentMicros, ent.budget.limitMicros)
  })
  await t.test('real pause blocks all checkout and ordinary pending approvals preserve both future time and used budget', async () => {
    await clock('2026-12-31T12:00:00Z'); await claim(teacher, 7); await clock('2027-01-02T12:00:00Z')
    const pending = await f.serviceCall('xelay_create_teacher_plan_order', [teacher, 'live', 'xelay_' + randomUUID(), 'teacher_max'])
    const paidGrant = (await rows('select id from xelay_teacher_private.grants where order_id=$1', [oldTeacher.id]))[0].id
    await db.query('insert into xelay_teacher_private.usage(user_id,grant_id,spent_micros)values($1,$2,10000)', [teacher, paidGrant])
    const paused = await benefits(teacher, { action: 'redeem', day: 7, audience: 'teacher' })
    const pauseUntil = paused.subscriptions.teacher.pausedUntil
    await assert.rejects(f.serviceCall('xelay_create_teacher_plan_order', [teacher, 'live', 'xelay_' + randomUUID(), 'teacher_plus']), /PAUSED/)
    await assert.rejects(winterOrder(teacher, 'teacher', 'teacher_plus', 12), /PAUSED/)
    await f.applyPayment(pending)
    const starts = (await rows('select min(p.valid_from)at from xelay_teacher_private.grants g join xelay_teacher_private.periods p on p.grant_id=g.id where g.order_id=$1', [pending.id]))[0].at
    assert.ok(Date.parse(starts) >= Date.parse(pauseUntil))
    assert.equal(Number((await rows('select spent_micros from xelay_teacher_private.usage where grant_id=$1', [paidGrant]))[0].spent_micros), 10000)
    await f.applyPayment(pending, 'Refunded')
    assert.equal(Number((await rows('select spent_micros from xelay_teacher_private.usage where grant_id=$1', [paidGrant]))[0].spent_micros), 10000)
    await benefits(teacher, { action: 'resume', audience: 'teacher' })
    assert.equal((await f.ownerCall('xelay_teacher_workspace_status', [], teacher)).planId, 'teacher_plus')
  })
  await t.test('gifted real Max keeps ordinary purchased credits, while its winter bonus never silently activates calendar credits', async () => {
    const who = ids.studentB
    await clock('2026-12-31T12:00:00Z')
    await f.serviceCall('xelay_student_audience_assign', [who, 'student', 'Synthetic gifted Max credit customer'])
    await f.serviceCall('xelay_student_plan_grant', [who, 'max', new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000 * 20).toISOString(), 'synthetic-gifted-max-preserved'])
    for (const day of [1, 11, 21]) await claim(who, day)
    const o = await f.serviceCall('xelay_create_max_credit_order', [who, 'live', 'xtop_' + randomUUID(), 'credits_1000', '2026-11-17.1'])
    const event = () => f.serviceCall('xelay_apply_max_credit_event', [o.order_reference, 'live', hash('gifted-max-purchase-approved'), 'Approved', o.amount, 'UAH'])
    await event(); await event()
    assert.equal(Number((await rows('select granted_micros from xelay_student_private.credit_wallets where user_id=$1', [who]))[0].granted_micros), 1000000)
    const state = await benefits(who)
    assert.equal(state.promo.usable, false); assert.equal(state.promo.activatedAt, null)
    assert.equal((await f.ownerCall('xelay_student_workspace_status', [], who)).planId, 'max')
    assert.equal((await rows('select count(*)::int n from xelay_winter_private.purchase_bonuses where user_id=$1', [who]))[0].n, 1)
  })
  await t.test('confirmed credit-order expiry releases its unused bonus; contradictory old payment never steals the next bonus', async () => {
    const who = ids.colleague
    await clock('2026-12-31T12:00:00Z')
    await f.serviceCall('xelay_student_audience_assign', [who, 'student', 'Synthetic expired credit bonus recovery'])
    await f.serviceCall('xelay_student_plan_grant', [who, 'max', new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000 * 20).toISOString(), 'synthetic-expired-credit-max'])
    await claim(who, 11)
    const make = pack => f.serviceCall('xelay_create_max_credit_order', [who, 'live', 'xtop_' + randomUUID(), pack, '2026-11-17.1'])
    const event = (o, status) => f.serviceCall('xelay_apply_max_credit_event', [o.order_reference, 'live', hash(o.id + status), status, o.amount, 'UAH'])
    const first = await make('credits_1000'); await event(first, 'Expired')
    assert.equal((await rows('select count(*)::int n from xelay_winter_payment_private.credit_bonuses where user_id=$1', [who]))[0].n, 0)
    await claim(who, 21); const second = await make('credits_3000')
    await event(first, 'Approved'); await event(second, 'Approved'); await event(second, 'Approved')
    assert.equal(Number((await rows('select granted_micros from xelay_student_private.credit_wallets where user_id=$1', [who]))[0].granted_micros), 4000000)
    const bonuses = await rows('select source_ref,micros from xelay_winter_private.purchase_bonuses where user_id=$1', [who])
    assert.equal(bonuses.length, 1); assert.equal(bonuses[0].source_ref, 'winter-order:' + second.id); assert.equal(Number(bonuses[0].micros), 300000)
  })
  await t.test('ordinary topup without winter claims remains unchanged', async () => {
    const who = ids.admin
    await f.serviceCall('xelay_student_audience_assign', [who, 'student', 'Synthetic ordinary credit regression'])
    await f.serviceCall('xelay_student_plan_grant', [who, 'max', new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 86400000 * 20).toISOString(), 'synthetic-ordinary-credit-max'])
    const o = await f.serviceCall('xelay_create_max_credit_order', [who, 'live', 'xtop_' + randomUUID(), 'credits_1000', '2026-11-17.1'])
    await f.serviceCall('xelay_apply_max_credit_event', [o.order_reference, 'live', hash('ordinary-topup-regression'), 'Approved', o.amount, 'UAH'])
    assert.equal(Number((await rows('select granted_micros from xelay_student_private.credit_wallets where user_id=$1', [who]))[0].granted_micros), 1000000)
    assert.equal((await rows('select count(*)::int n from xelay_winter_private.purchase_bonuses where user_id=$1', [who]))[0].n, 0)
    assert.equal((await rows('select count(*)::int n from xelay_winter_payment_private.credit_bonuses where user_id=$1', [who]))[0].n, 0)
  })
})
