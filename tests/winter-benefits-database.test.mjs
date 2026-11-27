import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createTeacherBackendFixture, teacherPlanMigration } from './helpers/teacherBackendFixture.mjs'

const read = async name => (await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')).replaceAll('\r', '')
const hash = value => createHash('sha256').update(value).digest('hex')
export const winterBenefitsMigration = '20261127111625_winter_benefits_and_promotional_balance.sql'
export async function winterBenefitsFixture() {
  const f = await createTeacherBackendFixture({ applyTeacher: false })
  try {
    for (const name of ['20261116161046_student_max_tutor_chat.sql', '20261116165652_student_max_study_formats.sql', '20261117070036_student_max_topic_generation.sql',
      '20261117105257_student_max_ai_credits.sql', '20261126154456_student_plus_ai_access.sql', teacherPlanMigration,
      '20261118105000_teacher_entitlement_free_status.sql', '20261118113915_teacher_trial_access.sql',
      '20261119103433_teacher_assistant_conversation.sql', '20261119110945_teacher_assistant_insights_reminders.sql',
      '20261126200041_winter_advent_private_progress.sql']) await f.db.exec(await read(name))
    await f.db.exec('alter table auth.users add column if not exists is_anonymous boolean default false')
    await f.db.exec(await read(winterBenefitsMigration))
    await f.db.exec(`create or replace function public.xelay_private_winter_clock() returns timestamptz language sql volatile set search_path=''as $$select current_setting('test.winter.clock')::timestamptz$$`)
    const clock = value => f.db.query("select set_config('test.winter.clock',$1,false)", [value])
    await clock('2026-12-31T12:00:00Z')
    const call = (user, action = null) => f.serviceCall('xelay_winter_benefits', [user, f.sessions[user], action])
    const claim = (user, day) => f.serviceCall('xelay_winter_advent', [user, f.sessions[user], day])
    const paid = async (user, plan) => {
      const teacher = plan.startsWith('teacher_')
      await f.serviceCall('xelay_student_audience_assign', [user, teacher ? 'teacher' : 'student', 'Synthetic winter campaign recipient'])
      const order = await f.serviceCall(teacher ? 'xelay_create_teacher_plan_order' : 'xelay_create_student_plan_order', [user, 'live', 'xelay_' + randomUUID(), plan])
      await f.applyPayment(order)
      // Explicit synthetic long-lived coverage permits December/January boundary
      // tests regardless of the wall clock. It is not a production grant operation.
      const schema = teacher ? 'xelay_teacher_private' : 'xelay_student_private', periods = teacher ? 'periods' : 'grant_periods'
      await f.db.query(`update ${schema}.${periods} p set valid_from='2026-11-01',valid_until='2027-03-15' from ${schema}.grants g where p.grant_id=g.id and g.order_id=$1`, [order.id])
      return order
    }
    return { ...f, clock, call, claim, paid }
  } catch (error) { await f.close(); throw error }
}

test('winter gifts preserve paid quota identities and enforce private, paid, single-use ownership', { timeout: 180000 }, async t => {
  const f = await winterBenefitsFixture(); t.after(() => f.close())
  const user = f.ids.studentA, teacher = f.ids.owner, other = f.ids.studentB
  const studentOrder = await f.paid(user, 'plus'),teacherOrder = await f.paid(teacher, 'teacher_start')
  const q = async (sql, args = []) => (await f.db.query(sql, args)).rows
  await t.test('browser roles cannot call private helpers or mint credits, and session mismatch is denied', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await f.db.exec('set role ' + role)
      try { await assert.rejects(f.db.query('select * from xelay_winter_private.wallets'), e => e.code === '42501') }
      finally { await f.db.exec('reset role') }
    }
    await assert.rejects(f.ownerCall('xelay_winter_benefits', [user, f.sessions[user], null], user), e => e.code === '42501')
    await assert.rejects(f.serviceCall('xelay_winter_benefits', [user, f.sessions[teacher], null]), e => e.code === '42501')
    await assert.rejects(f.call(user, { action: 'redeem', day: 2, audience: 'student' }), e => e.code === 'PT409')
    await assert.rejects(f.call(user, { action: 'activate_credits', credits: 10000 }), e => e.code === '22023' || e.code === 'PT409')
  })
  await t.test('collecting is not spending; activation is paid-only, one-time, with automatic later claims', async () => {
    await f.claim(user, 1); await f.claim(other, 1)
    assert.equal((await f.call(user)).promo.availableCredits, 0)
    await assert.rejects(f.call(other, { action: 'activate_credits' }), /PAID_PLAN_REQUIRED/)
    const first = await f.call(user, { action: 'activate_credits' })
    assert.equal(first.promo.availableCredits, 50)
    assert.equal((await f.call(user, { action: 'activate_credits' })).promo.activatedAt, first.promo.activatedAt)
    await f.claim(user, 15); await f.claim(user, 31); await f.claim(user, 31)
    assert.equal((await f.call(user)).promo.availableCredits, 150)
    assert.equal((await q('select count(*)::int n from xelay_winter_private.wallets where user_id=$1', [user]))[0].n, 1)
  })
  await t.test('extension changes time only; retries, other audiences and unpaid claims cannot duplicate it', async () => {
    await f.claim(user, 2)
    const before = await q('select g.id,p.valid_until from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id where g.order_id=$1', [studentOrder.id])
    await f.call(user, { action: 'redeem', day: 2, audience: 'student' })
    const after = await q('select g.id,p.valid_until from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id where g.order_id=$1', [studentOrder.id])
    assert.equal(after.length, before.length); assert.equal(after[0].id, before[0].id)
    assert.equal(Date.parse(after[0].valid_until) - Date.parse(before[0].valid_until), 86400000)
    await f.call(user, { action: 'redeem', day: 2, audience: 'student' })
    assert.deepEqual(await q('select g.id,p.valid_until from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id where g.order_id=$1', [studentOrder.id]), after)
    await assert.rejects(f.call(user, { action: 'redeem', day: 2, audience: 'teacher' }), /ALREADY_REDEEMED/)
  })
  await t.test('short Max overlays keep original Plus and teacher Start allowances', async () => {
    for (const [who, audience] of [[user, 'student'], [teacher, 'teacher']]) { await f.claim(who, 4); await f.call(who, { action: 'redeem', day: 4, audience }) }
    const student = await f.ownerCall('xelay_student_workspace_status', [], user), teaching = await f.ownerCall('xelay_teacher_workspace_status', [], teacher)
    assert.equal(student.planId, 'max'); assert.equal(student.budget.limitMicros, 3000000)
    assert.equal(teaching.planId, 'teacher_max'); assert.equal(teaching.budget.limitMicros, 1000000)
    await f.claim(user, 7)
    await assert.rejects(f.call(user, { action: 'redeem', day: 7, audience: 'student' }), /UPGRADE_ACTIVE/)
  })
  await t.test('pause cuts paid access, preserves remaining seconds and usage, and early resume restores exact time', async () => {
    await f.clock('2027-01-02T12:00:00Z')
    const before = await q('select p.valid_from,p.valid_until from xelay_student_private.grant_periods p join xelay_student_private.grants g on g.id=p.grant_id where g.user_id=$1 order by p.valid_from', [user])
    const paused = await f.call(user, { action: 'redeem', day: 7, audience: 'student' })
    assert.equal(Date.parse(paused.subscriptions.student.pausedUntil), Date.parse('2027-01-04T12:00:00Z'))
    assert.equal((await f.ownerCall('xelay_student_workspace_status', [], user)).planId, 'free')
    assert.equal((await q('select public.xelay_has_participant_access($1) ok', [user]))[0].ok, false)
    assert.equal(paused.promo.usable, false)
    await assert.rejects(f.serviceCall('xelay_create_student_plan_order', [user, 'live', 'xelay_' + randomUUID(), 'max']), /SUBSCRIPTION_PAUSED/)
    await f.clock('2027-01-03T12:00:00Z'); await f.call(user, { action: 'resume', audience: 'student' })
    const after = await q('select p.valid_from,p.valid_until from xelay_student_private.grant_periods p join xelay_student_private.grants g on g.id=p.grant_id where g.user_id=$1 order by p.valid_from', [user])
    assert.equal(Date.parse(after.at(-1).valid_until) - Date.parse(before.at(-1).valid_until), 86400000)
    assert.equal((await f.call(user)).promo.availableCredits, 150)
    assert.equal((await f.ownerCall('xelay_student_workspace_status', [], user)).budget.limitMicros, 3000000)
  })
  await t.test('teacher promotional spending and stale settlement share the same bounded ledger without resetting the paid grant',async()=>{
    await f.clock('2026-12-31T12:00:00Z');await f.claim(teacher,1);await f.claim(teacher,15);await f.call(teacher,{action:'activate_credits'})
    const g=(await q('select id from xelay_teacher_private.grants where order_id=$1',[teacherOrder.id]))[0].id
    await f.db.query('insert into xelay_teacher_private.usage(user_id,grant_id,spent_micros)values($1,$2,1000000)on conflict(user_id,grant_id)do update set spent_micros=1000000',[teacher,g])
    const request=()=>({requestId:randomUUID(),kind:'chat',courseId:'',groupIds:[],prompt:'Привіт!',consent:true})
    const reserve=async r=>{const c=await f.ownerCall('xelay_teacher_ai_context',[r],teacher);return f.serviceCall('xelay_teacher_ai_reserve',[teacher,hash(f.sessions[teacher]),r,hash(JSON.stringify(r)),c.contextHash,50000])}
    const r=request(),hold=await reserve(r);assert.equal(hold.state,'reserved');assert.equal((await f.call(teacher)).promo.reservedCredits,50)
    await f.serviceCall('xelay_teacher_ai_finish',[teacher,hash(f.sessions[teacher]),r.requestId,hash(JSON.stringify(r)),hold.reservationId,20000,null])
    await f.serviceCall('xelay_teacher_ai_finish',[teacher,hash(f.sessions[teacher]),r.requestId,hash(JSON.stringify(r)),hold.reservationId,20000,null])
    assert.equal((await f.call(teacher)).promo.availableCredits,80)
    const stale=request();assert.equal((await reserve(stale)).state,'reserved')
    await f.db.query("update xelay_teacher_private.requests set created_at=clock_timestamp()-interval'3 minutes'where user_id=$1 and id=$2",[teacher,stale.requestId])
    assert.equal((await reserve(request())).state,'denied');assert.equal((await f.call(teacher)).promo.availableCredits,30)
    const spent=(await q('select spent_micros,reserved_micros from xelay_teacher_private.usage where user_id=$1 and grant_id=$2',[teacher,g]))[0]
    assert.equal(Number(spent.spent_micros),1000000);assert.equal(Number(spent.reserved_micros),0)
    await f.clock('2027-01-03T12:00:00Z')
  })
  await t.test('bonus credits settle after base, before purchased credits, and cannot spend twice', async () => {
    const entitlement = await f.ownerCall('xelay_student_workspace_status', [], user)
    const window = (await q('select * from xelay_student_private.max_budget_window($1,clock_timestamp())', [user]))[0]
    await f.db.query('insert into xelay_student_private.period_usage(user_id,grant_id,cycle,spent_micros)values($1,$2,$3,3000000)on conflict(user_id,grant_id,cycle)do update set spent_micros=3000000', [user, window.grant_id, window.cycle])
    const request = { requestId: 'winter-credit-test', mode: 'chat', prompt: 'Привіт', sources: [] }, fingerprint = hash(JSON.stringify(request))
    const hold = await f.serviceCall('xelay_max_ai_reserve', [user, hash(f.sessions[user]), request.requestId, fingerprint, 25000, entitlement.budget.limitMicros, request])
    assert.equal(hold.state, 'reserved'); assert.equal((await f.call(user)).promo.reservedCredits, 25)
    await f.serviceCall('xelay_max_ai_finish', [user, hash(f.sessions[user]), request.requestId, fingerprint, hold.reservationId, 15000, null, request])
    await f.serviceCall('xelay_max_ai_finish', [user, hash(f.sessions[user]), request.requestId, fingerprint, hold.reservationId, 15000, null, request])
    const state = await f.call(user); assert.equal(state.promo.spentCredits, 15); assert.equal(state.promo.availableCredits, 135)
    assert.equal((await f.ownerCall('xelay_student_workspace_status', [], user)).budget.spentMicros, 3000000)
    await f.db.exec('begin')
    try{
      await f.clock('2026-12-31T12:00:00Z')
      await f.db.query('update xelay_student_private.credit_wallets set granted_micros=1000000 where user_id=$1',[user])
      const blocked={...request,requestId:'plus-overlay-purchased-block'}
      assert.equal((await f.ownerCall('xelay_student_workspace_status',[],user)).planId,'max')
      assert.equal((await f.serviceCall('xelay_max_ai_reserve',[user,hash(f.sessions[user]),blocked.requestId,hash(JSON.stringify(blocked)),200000,3000000,blocked])).state,'denied','Plus overlay cannot spend purchased Max wallet')
      await f.db.query('update xelay_winter_private.wallets set spent_micros=105000 where user_id=$1',[user])
      const compact={...request,requestId:'remaining-45-compact'},compactHash=hash(JSON.stringify(compact))
      const compactHold=await f.serviceCall('xelay_max_ai_reserve',[user,hash(f.sessions[user]),compact.requestId,compactHash,39600,3000000,compact])
      assert.equal(compactHold.state,'reserved')
      await f.serviceCall('xelay_max_ai_finish',[user,hash(f.sessions[user]),compact.requestId,compactHash,compactHold.reservationId,6000,null,compact])
      const tooSmall={...request,requestId:'remaining-39-denied'}
      assert.equal((await f.serviceCall('xelay_max_ai_reserve',[user,hash(f.sessions[user]),tooSmall.requestId,hash(JSON.stringify(tooSmall)),39600,3000000,tooSmall])).state,'denied')
    }finally{await f.db.exec('rollback')}
  })
  await t.test('calendar activation deadline never expires activated credits; refund freezes access without reissuing', async () => {
    await f.clock('2027-02-01T00:00:00Z')
    assert.equal((await f.call(user)).promo.availableCredits, 135)
    await assert.rejects(f.call(other, { action: 'activate_credits' }), /ACTIVATION_ENDED/)
    await f.db.query("update billing_orders set status='refunded'where id=$1", [studentOrder.id])
    assert.equal((await f.call(user)).promo.usable, false)
    assert.equal((await f.call(user)).promo.spentCredits, 15)
    await f.db.query("update billing_orders set status='refunded'where id=$1",[teacherOrder.id])
    assert.equal((await f.call(teacher)).promo.usable,false);assert.equal((await f.call(teacher)).promo.spentCredits,70)
  })
})

test('winter paid time, Max conversion and financial callbacks preserve pauses and other benefits',{timeout:180000},async t=>{
 const f=await winterBenefitsFixture();t.after(()=>f.close());const user=f.ids.studentA,teacher=f.ids.owner
 const order=await f.paid(user,'max');await f.paid(teacher,'teacher_plus')
 const q=async(sql,args=[])=>(await f.db.query(sql,args)).rows
 for(const day of[1,4,7,16,21])await f.claim(user,day)
 const before=(await f.ownerCall('xelay_student_workspace_status',[],user)).budget
 const converted=await f.call(user,{action:'redeem',day:4,audience:'student'})
 assert.equal(converted.benefits.find(b=>b.day===4).convertedToExtension,true)
 assert.deepEqual((await f.ownerCall('xelay_student_workspace_status',[],user)).budget,before)
 const pending=await f.serviceCall('xelay_create_student_plan_order',[user,'live','xelay_'+randomUUID(),'plus'])
 await f.call(user,{action:'redeem',day:7,audience:'student'})
 const until=(await f.call(user)).subscriptions.student.pausedUntil
 await f.applyPayment(pending)
 const future=(await q('select p.valid_from,p.valid_until from xelay_student_private.grant_periods p join xelay_student_private.grants g on g.id=p.grant_id where g.order_id=$1',[pending.id]))[0]
 assert.ok(Date.parse(future.valid_from)>=Date.parse(until));assert.equal((await f.ownerCall('xelay_student_workspace_status',[],user)).planId,'free')
 await f.applyPayment(order,'Refunded')
 const reflow=(await q('select p.valid_from from xelay_student_private.grant_periods p join xelay_student_private.grants g on g.id=p.grant_id where g.order_id=$1',[pending.id]))[0]
 assert.ok(Date.parse(reflow.valid_from)>=Date.parse(until),'refund cannot pull a future paid grant into the active pause')
 await f.call(user,{action:'resume',audience:'student'})
 assert.equal((await f.call(user)).subscriptions.student.pausedUntil,null,'immediate resume is valid')
 // An after-January purchase bonus stays permanent, but does not activate expired calendar credits.
 await f.clock('2027-02-10T12:00:00Z')
 const source='winter-order:'+randomUUID();await f.db.query('select xelay_winter_private.award_purchase_bonus($1,$2,300000)',[user,source])
 const bonus=await f.call(user);assert.equal(bonus.promo.purchaseBonusCredits,300);assert.equal(bonus.promo.activatedAt,null)
 await f.db.query('select xelay_winter_private.revoke_purchase_bonus($1,$2)',[user,source]);assert.equal((await f.call(user)).promo.availableCredits,0)
})

test('existing gifts retain time and identity; a gifted Max purchase does not require calendar activation',{timeout:180000},async t=>{
 const f=await winterBenefitsFixture();t.after(()=>f.close());const paidUser=f.ids.studentA,giftUser=f.ids.studentB
 await f.paid(paidUser,'max');await f.serviceCall('xelay_student_audience_assign',[giftUser,'student','Synthetic gifted account'])
 const insertGift=async(user,from,until)=>{
  const row=(await f.db.query("insert into xelay_student_private.grants(user_id,plan_id,source,reference,valid_from,valid_until)values($1,'max','admin_grant',$2,$3,$4)returning id",[user,'synthetic-gift:'+randomUUID(),from,until])).rows[0]
  await f.db.query('insert into xelay_student_private.grant_periods(grant_id,valid_from,valid_until)values($1,$2,$3)',[row.id,from,until]);return row.id
 }
 const queued=await insertGift(paidUser,'2027-03-15T00:00:00Z','2027-03-22T00:00:00Z')
 await f.claim(paidUser,7);await f.call(paidUser,{action:'redeem',day:7,audience:'student'})
 let period=(await f.db.query('select valid_from,valid_until from xelay_student_private.grant_periods where grant_id=$1',[queued])).rows[0]
 assert.equal(Date.parse(period.valid_from),Date.parse('2027-03-17'));assert.equal(Date.parse(period.valid_until)-Date.parse(period.valid_from),7*86400000)
 await f.call(paidUser,{action:'resume',audience:'student'})
 period=(await f.db.query('select valid_from,valid_until from xelay_student_private.grant_periods where grant_id=$1',[queued])).rows[0]
 assert.equal(Date.parse(period.valid_from),Date.parse('2027-03-15'))
 const gift=await insertGift(giftUser,'2026-11-01','2027-01-15'),before=(await f.db.query('select to_jsonb(g)v from xelay_student_private.grants g where id=$1',[gift])).rows[0].v
 await f.claim(giftUser,1);await f.claim(giftUser,21)
 await f.db.query('select xelay_winter_private.award_purchase_bonus($1,$2,100000)',[giftUser,'winter-order:'+randomUUID()])
 const bank=await f.call(giftUser);assert.equal(bank.promo.purchaseBonusCredits,100);assert.equal(bank.promo.activatedAt,null);assert.equal(bank.promo.usable,false)
 assert.deepEqual((await f.db.query('select to_jsonb(g)v from xelay_student_private.grants g where id=$1',[gift])).rows[0].v,before)
 // A separate active grant must not lose time or get a new cycle through pause.
 await f.call(paidUser,{action:'resume',audience:'student'});await insertGift(paidUser,'2026-12-30','2027-01-05');await f.claim(paidUser,16)
 await assert.rejects(f.call(paidUser,{action:'redeem',day:16,audience:'student'}),/GIFT_ACTIVE/)
 const plusUser=f.ids.outsider;await f.paid(plusUser,'plus')
 await insertGift(plusUser,'2026-11-01','2027-01-15');await f.claim(plusUser,4)
 const giftBefore=(await f.db.query('select to_jsonb(g)v from xelay_student_private.grants g where user_id=$1 order by id',[plusUser])).rows
 await assert.rejects(f.call(plusUser,{action:'redeem',day:4,audience:'student'}),/UPGRADE_GIFT_ACTIVE/)
 const retained=(await f.call(plusUser)).benefits.find(b=>b.day===4)
 assert.equal(retained.status,'available');assert.equal(retained.audience,null)
 assert.deepEqual((await f.db.query('select to_jsonb(g)v from xelay_student_private.grants g where user_id=$1 order by id',[plusUser])).rows,giftBefore)
})
