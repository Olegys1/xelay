import test from'node:test'
import assert from'node:assert/strict'
import{createHash,randomUUID}from'node:crypto'
import{createTeacherBackendFixture,teacherPlanMigration}from'./helpers/teacherBackendFixture.mjs'
import { createTeacherArchiveFixture } from './helpers/teacherArchiveFixture.mjs'
const hash=x=>createHash('sha256').update(x).digest('hex')

test('audited seven-day teacher trial preserves student access, payments and archived results', { timeout: 120000 }, async t => {
 const fx = await createTeacherArchiveFixture(); t.after(() => fx.close())
 const { db, ids } = fx
 await db.exec(await fx.readMigration('20261118105000_teacher_entitlement_free_status.sql'))
 await db.exec(await fx.readMigration('20261118113915_teacher_trial_access.sql'))
 // The course owner is a real dual-role student for this isolated scenario.
 await db.query("update xelay_student_private.audiences set audience='student' where user_id=$1", [ids.owner])
 const state = () => fx.ownerCall('xelay_teacher_workspace_status')
 assert.equal((await state()).planId, 'free')
 const base = async () => (await db.query(`select jsonb_build_object(
   'studentGrants', (select jsonb_agg(to_jsonb(s)) from xelay_student_private.grants s),
   'payments', (select jsonb_agg(to_jsonb(o)) from billing_orders o),
   'identity', (select audience from xelay_student_private.audiences where user_id=$1)
 ) as data`, [ids.owner])).rows[0].data
 const before = await base()
 const reference = randomUUID()
 const trialSql = `insert into xelay_teacher_private.grants
  (user_id,plan_id,source,trial_reference,issued_by,reason,valid_from,valid_until)
  values($1,'teacher_max','trial',$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '7 days') returning id`
 // Use one timestamp so the seven-day maximum cannot be exceeded by microseconds.
 const exactTrialSql = trialSql.replaceAll('clock_timestamp()', 'statement_timestamp()')
 for (const who of [ids.studentA, ids.owner]) {
  await assert.rejects(fx.asUser(who, exactTrialSql, [ids.owner, reference, ids.admin, 'Synthetic trial verification']), e => e.code === '42501')
 }
 await assert.rejects(db.query(exactTrialSql, [ids.owner, reference, ids.admin, null]), e => e.code === '23514')
 await assert.rejects(db.query(exactTrialSql.replace("interval '7 days'", "interval '8 days'"), [ids.owner, reference, ids.admin, 'Synthetic trial verification']), e => e.code === '23514')
 const trial = (await db.query(exactTrialSql, [ids.owner, reference, ids.admin, 'Synthetic trial verification'])).rows[0].id
 await db.query('insert into xelay_teacher_private.periods(grant_id,valid_from,valid_until) select id,valid_from,valid_until from xelay_teacher_private.grants where id=$1', [trial])
 assert.equal((await state()).planId, 'teacher_max'); assert.equal((await state()).canGenerate, true)
 assert.equal((await state()).budget.limitMicros, 8000000)
 assert.deepEqual(await base(), before)
 await assert.rejects(fx.serviceCall('xelay_create_teacher_plan_order', [ids.owner, 'live', 'xelay_'+randomUUID(), 'teacher_max']), e => e.code === '42501')

 const { definition } = await fx.createTest()
 await fx.complete(ids.studentA, definition.id, { correctCount: 1 })
 await fx.publishOriginal(definition.id)
 const gradeBefore = await fx.grade(definition.id)
 const attemptBefore = (await fx.testDetail(ids.studentA, definition.id)).attempt
 const archived = await fx.archiveSet(definition.id, true)
 assert.ok(archived.archivedAt)
 await db.query('update xelay_teacher_private.grants set revoked_at=clock_timestamp() where id=$1', [trial])
 assert.equal((await state()).planId, 'free')
 assert.equal((await fx.archiveSet(definition.id, false, archived.version)).archivedAt, null)
 assert.deepEqual(await fx.grade(definition.id), gradeBefore)
 assert.deepEqual((await fx.testDetail(ids.studentA, definition.id)).attempt, attemptBefore)
 assert.deepEqual(await base(), before)
 // Expiry alone also removes trial access without a scheduled job.
 await db.query('update xelay_teacher_private.grants set revoked_at=null where id=$1', [trial])
 await db.query("update xelay_teacher_private.periods set valid_from=clock_timestamp()-interval '8 days',valid_until=clock_timestamp()-interval '1 day' where grant_id=$1", [trial])
 assert.equal((await state()).planId, 'free')
})

test('teacher payment, immutable billing identity and atomic paid-month budgets use real PostgreSQL',{timeout:120000},async t=>{
 const fx=await createTeacherBackendFixture({applyTeacher:false});t.after(()=>fx.close())
 const {db,ids}=fx
 const oldGiftId=randomUUID(),oldNoticeId=randomUUID()
 await db.query("insert into public.notifications(id,recipient_id,actor_id,actor_name,type,message,is_read)values($1,$2,$3,'Xelay','birthday_gift','Вигаданий раніше подарований місяць.',false)",[oldNoticeId,ids.studentA,ids.admin])
 await db.query("insert into public.birthday_gifts(id,recipient_id,greeting_name,gift_year,notification_id,offered_by,offered_at)values($1,$2,'',2026,$3,$4,clock_timestamp())",[oldGiftId,ids.studentA,oldNoticeId,ids.admin])
 await fx.ownerCall('xelay_claim_birthday_gift',[oldGiftId],ids.studentA)
 const originalOid=(await db.query("select 'public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)'::regprocedure::oid n")).rows[0].n
 const legacyOrder = user => fx.serviceCall('xelay_create_billing_order', [user, 'participant', 'live', 'xelay_' + randomUUID(), null])
 const studentOrder = user => fx.serviceCall('xelay_create_student_plan_order', [user, 'live', 'xelay_' + randomUUID(), 'max'])
 const historicStudentOrder = await studentOrder(ids.outsider)
 const gradesBefore=(await db.query('select to_jsonb(g)v from public.teaching_grades g order by id')).rows
 const giftsBefore=(await db.query('select to_jsonb(g)v from public.birthday_gifts g order by id')).rows
 const migration = await fx.readMigration(teacherPlanMigration)
 const checkoutSignatures = ['public.xelay_create_billing_order(uuid,text,text,text,uuid)', 'public.xelay_create_student_plan_order(uuid,text,text,text)']
 await t.test('an unrecognized pending-order query rolls back the whole migration', async () => {
  for (const signature of checkoutSignatures) {
   const { definition } = (await db.query('select pg_get_functiondef($1::regprocedure) as definition', [signature])).rows[0]
   const drift = definition.replace("and status='pending'", "and status = 'pending'")
   assert.notEqual(drift, definition)
   await db.exec('begin')
   try {
    await db.exec(drift)
    await assert.rejects(db.exec(migration), error => error.message === 'PENDING_ORDER_CHECKOUT_DRIFT: ' + signature)
   } finally {
    await db.exec('rollback')
   }
   assert.equal((await db.query("select to_regnamespace('xelay_teacher_private') as teacher_schema")).rows[0].teacher_schema, null)
  }
 })
 await db.exec(migration)
 for(const key of ['owner','colleague','otherTeacher'])await fx.serviceCall('xelay_student_audience_assign',[ids[key],'teacher','Synthetic teacher plan identity'])
 await fx.serviceCall('xelay_student_audience_assign',[ids.studentA,'student','Synthetic original student identity'])
 const state=(user=ids.owner)=>fx.ownerCall('xelay_teacher_workspace_status',[],user)
 await t.test('cold student status, unresolved and inactive teachers return free; paid state and execution rights survive the repair', async () => {
  await assert.rejects(state(ids.studentA), error => error.code === '55000')
  const paid = await fx.createPaidTeacher('teacher_plus', ids.colleague)
  const previousPaidState = await state(ids.colleague)
  assert.equal(previousPaidState.planId, 'teacher_plus')
  const functionSettings = async () => (await db.query(`
   select oid::text, proowner, proacl::text, proconfig, prosecdef, provolatile, proparallel, proisstrict
   from pg_proc where oid='xelay_teacher_private.entitlement(uuid)'::regprocedure`)).rows[0]
  const previousSettings = await functionSettings()
  const fix = await fx.readMigration('20261118105000_teacher_entitlement_free_status.sql')
  await db.exec(fix)

  const expectFree = async (user, audience) => assert.deepEqual(await state(user), {
   userId: user, audience, planId: 'free', canGenerate: false, canEdit: false,
   startsAt: null, expiresAt: null, budgetPeriod: 'subscription_month',
   budget: { limitMicros: 0, spentMicros: 0, reservedMicros: 0 }, allowedModes: [],
  })
  await expectFree(ids.studentA, 'student') // First call to the repaired function.
  await expectFree(ids.outsider, 'unresolved')
  await expectFree(ids.owner, 'teacher')
  assert.deepEqual(await state(ids.colleague), previousPaidState)
  assert.deepEqual(await functionSettings(), previousSettings)
  await assert.rejects(fx.asUser(ids.studentA, 'select xelay_teacher_private.entitlement($1)', [ids.colleague]), error => error.code === '42501')

  // A formerly verified teacher can still have paid time, but cannot use it
  // during a lapse in current teaching access.
  await db.exec('begin')
  try {
   await db.query('delete from public.teacher_verification_requests where user_id=$1', [ids.colleague])
   assert.equal((await db.query('select public.xelay_teaching_has_current_access($1) as active', [ids.colleague])).rows[0].active, false)
   await expectFree(ids.colleague, 'teacher')
  } finally {
   await db.exec('rollback')
  }
  assert.deepEqual(await state(ids.colleague), previousPaidState)
  await fx.applyPayment(paid, 'Refunded')
  // A different installed body must be left for inspection.
  await assert.rejects(db.exec(fix), error => error.message === 'TEACHER_ENTITLEMENT_STATUS_DRIFT')
  await db.exec('rollback')
  assert.deepEqual(await functionSettings(), previousSettings)
 })
 const request=(kind='questions',extra={})=>({requestId:randomUUID(),kind,courseId:ids.course,groupIds:[fx.groups[0]],prompt:'Підготуйте навчальні запитання за темою.',consent:true,questionCount:2,...extra})
 const reserve=async(r,who=ids.owner)=>{
  const context=await fx.ownerCall('xelay_teacher_ai_context',[r],who)
  return fx.serviceCall('xelay_teacher_ai_reserve',[who,hash(fx.sessions[who]),r,hash(JSON.stringify(r)),context.contextHash,50000])
 }
 const finish=(r,reservation,charge=1000,bundle=null,who=ids.owner)=>fx.serviceCall('xelay_teacher_ai_finish',[who,hash(fx.sessions[who]),r.requestId,hash(JSON.stringify(r)),reservation.reservationId,charge,bundle])
 let firstStart,plus,max
 await t.test('DDL preserves old callback OID, all grades, gifts and closed private grants',async()=>{
  assert.equal((await db.query("select 'public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)'::regprocedure::oid n")).rows[0].n,originalOid)
  assert.deepEqual((await db.query('select to_jsonb(g)v from public.teaching_grades g order by id')).rows,gradesBefore)
  assert.deepEqual((await db.query('select to_jsonb(g)v from public.birthday_gifts g order by id')).rows,giftsBefore)
  assert.equal(giftsBefore.length,1);assert.ok(giftsBefore[0].v.entitlement_id,'legacy gifted month is real and claimed')
  await assert.rejects(fx.ownerCall('xelay_create_teacher_plan_order',[ids.owner,'live','xelay_'+randomUUID(),'teacher_max']),e=>e.code==='42501')
  await assert.rejects(fx.asUser(ids.owner,'select*from xelay_teacher_private.grants'),e=>e.code==='42501')
  assert.equal((await state()).planId,'free')
 })
 await t.test('pending teacher, student and legacy orders only resume for their original product', async () => {
  const pendingTeacher = await fx.createOrder('teacher_max', ids.colleague)
  const teacherLegacy = await legacyOrder(ids.colleague)
  const studentLegacy = await legacyOrder(ids.outsider)
  for (const [pending, legacy] of [[pendingTeacher, teacherLegacy], [historicStudentOrder, studentLegacy]]) {
   assert.notEqual(legacy.id, pending.id)
   assert.notEqual(legacy.order_reference, pending.order_reference)
   assert.equal(Number(pending.amount), 999)
   assert.equal(Number(legacy.amount), 100)
   assert.equal(legacy.teacher_plan_id, null)
   assert.equal(legacy.student_plan_id, null)
  }
  assert.equal((await fx.createOrder('teacher_max', ids.colleague)).id, pendingTeacher.id)
  assert.equal((await studentOrder(ids.outsider)).id, historicStudentOrder.id)
  await fx.createOrder('teacher_plus', ids.colleague)
  assert.equal((await legacyOrder(ids.colleague)).id, teacherLegacy.id)
  assert.equal((await legacyOrder(ids.outsider)).id, studentLegacy.id)
 })
 await t.test('three canonical prices issue matching separate teacher grants exactly once',async()=>{
  firstStart=await fx.createOrder('teacher_start');assert.equal(Number(firstStart.amount),199)
  assert.equal((await fx.createOrder('teacher_start')).id,firstStart.id)
  await fx.applyPayment(firstStart);await fx.applyPayment(firstStart)
  assert.equal((await state()).planId,'teacher_start');assert.equal((await state()).budget.limitMicros,1000000)
  plus=await fx.createPaidTeacher('teacher_plus');assert.equal(Number(plus.amount),499);assert.equal((await state()).budget.limitMicros,4000000)
  max=await fx.createPaidTeacher('teacher_max');assert.equal(Number(max.amount),999);assert.equal((await state()).budget.limitMicros,8000000)
  assert.equal((await db.query('select count(*)::int n from xelay_teacher_private.grants where user_id=$1',[ids.owner])).rows[0].n,3)
  assert.equal((await db.query('select count(*)::int n from public.participant_entitlements where order_id=any($1::uuid[])',[[firstStart.id,plus.id,max.id]])).rows[0].n,0,'teacher purchases do not mint student participant grants')
  await assert.rejects(db.query("update billing_orders set teacher_plan_id='teacher_plus'where id=$1",[max.id]),e=>e.code==='42501')
  await assert.rejects(fx.applyPayment(max,'Approved',{amount:199}),e=>e.code==='22023')
 })
 await t.test('test payments never grant rights and initial students cannot become paid teachers by adding a teacher role',async()=>{
  const order=await fx.createOrder('teacher_max',ids.colleague,'test');await fx.applyPayment(order);assert.equal((await state(ids.colleague)).planId,'free')
  await assert.rejects(fx.createOrder('teacher_max',ids.studentA),e=>e.code==='42501')
  assert.equal((await db.query('select audience from xelay_student_private.audiences where user_id=$1',[ids.studentA])).rows[0].audience,'student')
  await assert.rejects(fx.serviceCall('xelay_student_audience_assign',[ids.studentA,'teacher','Forbidden audience switch']),e=>e.code==='PT409')
 })
 await t.test('unresolved legacy verified teachers can purchase; unresolved original student profiles with added verification cannot',async()=>{
  await db.query('delete from xelay_student_private.audiences where user_id=$1',[ids.otherTeacher])
  const order=await fx.createOrder('teacher_start',ids.otherTeacher);assert.equal((await state(ids.otherTeacher)).audience,'unresolved')
  await fx.applyPayment(order);await fx.applyPayment(order)
  assert.equal((await state(ids.otherTeacher)).audience,'teacher');assert.equal((await state(ids.otherTeacher)).planId,'teacher_start')
  const profile=(await db.query('select university_id,academic_unit_id from profiles where id=$1',[ids.studentB])).rows[0]
  await db.query("insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,position,status,reviewed_at,contact_telegram)values($1,'Synthetic dual-role student',$2,$3,'Synthetic department','Synthetic lecturer','approved',clock_timestamp(),'synthetic_teacher')",[ids.studentB,profile.university_id,profile.academic_unit_id])
  assert.equal((await db.query('select xelay_teaching_has_current_access($1)v',[ids.studentB])).rows[0].v,true,'added verified teaching role is real')
  assert.equal((await db.query('select account_type from profiles where id=$1',[ids.studentB])).rows[0].account_type,'student')
  await assert.rejects(fx.createOrder('teacher_start',ids.studentB),error=>error.code==='42501')
  assert.equal((await db.query('select count(*)::int n from xelay_student_private.audiences where user_id=$1',[ids.studentB])).rows[0].n,0)
 })
 await t.test('current reservation, replay, concurrency and forged context/cap are server-authoritative',async()=>{
  const r=request(),a=await reserve(r);assert.equal(a.state,'reserved');assert.equal((await reserve(r)).state,'pending')
  assert.equal((await reserve(request())).state,'pending');await finish(r,a)
  assert.equal((await reserve(r)).state,'failed')
  const before=(await state()).budget;assert.equal(before.spentMicros,1000);assert.equal(before.reservedMicros,0)
  await assert.rejects(fx.serviceCall('xelay_teacher_ai_reserve',[ids.owner,hash(fx.sessions[ids.owner]),request(),hash('f'),hash('forged'),50000]),e=>e.code==='PT409')
  await assert.rejects(fx.serviceCall('xelay_teacher_ai_reserve',[ids.owner,hash(fx.sessions[ids.owner]),request(),hash('f'),hash('ctx'),1]),e=>e.code==='22023')
  await assert.rejects(fx.serviceCall('xelay_teacher_ai_reserve',[ids.owner,hash('forged-session'),request(),hash('f'),hash('ctx'),50000]),e=>e.code==='42501')
  assert.deepEqual((await state()).budget,before)
 })
 await t.test('paid month crosses calendar boundaries without a fresh allowance; exhaustion and unknown reservations are charged safely',async()=>{
  const active=(await db.query('select id from xelay_teacher_private.grants where order_id=$1',[max.id])).rows[0].id
  const usageBefore=(await state()).budget
  // Keep this paid month active on every day of the test runner's month. The
  // former fixed 26th-of-month end silently expired after November 25.
  await db.query("update xelay_teacher_private.periods set valid_from=clock_timestamp()-interval'1 month'+interval'1 day',valid_until=clock_timestamp()+interval'1 day'where grant_id=$1",[active])
  assert.equal((await db.query("select bool_and(valid_from<clock_timestamp() and valid_until>clock_timestamp() and date_trunc('month',valid_from)<date_trunc('month',valid_until)) as valid from xelay_teacher_private.periods where grant_id=$1",[active])).rows[0].valid,true)
  assert.deepEqual((await state()).budget,usageBefore)
  await db.query('update xelay_teacher_private.usage set spent_micros=7950000 where user_id=$1 and grant_id=$2',[ids.owner,active])
  const r=request(),held=await reserve(r);assert.equal(held.state,'reserved');assert.equal((await state()).canGenerate,false)
  await finish(r,held,50000);assert.equal((await reserve(request())).state,'denied')
  await db.query('update xelay_teacher_private.usage set spent_micros=1000 where user_id=$1 and grant_id=$2',[ids.owner,active])
  const stale=request(),heldStale=await reserve(stale);await db.query("update xelay_teacher_private.requests set created_at=clock_timestamp()-interval'3 minutes'where user_id=$1 and id=$2",[ids.owner,stale.requestId])
  const next=request(),heldNext=await reserve(next);assert.equal(heldNext.state,'reserved');assert.equal((await state()).budget.spentMicros,51000)
  assert.equal((await reserve(stale)).state,'failed');await finish(next,heldNext)
  await finish(stale,heldStale,1);assert.equal((await state()).budget.spentMicros,52000,'late completion cannot refund or double-charge the conservative stale settlement')
 })
 await t.test('refund revokes only its own teacher period and preserves carried paid time and legacy student checkout',async()=>{
  await fx.applyPayment(max,'Refunded');assert.equal((await state()).planId,'teacher_plus')
  await fx.applyPayment(max,'Approved');assert.equal((await state()).planId,'teacher_plus','late approval never resurrects refunded order')
  const student=await fx.serviceCall('xelay_create_student_plan_order',[ids.studentA,'live','xelay_'+randomUUID(),'start']);await fx.applyPayment(student)
  assert.equal((await fx.serviceCall('xelay_student_workspace_entitlement',[ids.studentA])).planId,'start')
  assert.equal((await db.query('select count(*)::int n from xelay_teacher_private.grants where user_id=$1',[ids.studentA])).rows[0].n,0)
  assert.deepEqual((await db.query('select to_jsonb(g)v from public.birthday_gifts g where id=$1',[oldGiftId])).rows,giftsBefore)
 })
 await t.test('previous student birthday coupons still charge the approved discounted amount and redeem exactly once',async()=>{
  await fx.ownerCall('xelay_admin_offer_birthday_gift',[ids.studentB,''],ids.admin)
  const gift=(await db.query('select*from birthday_gifts where recipient_id=$1',[ids.studentB])).rows[0];assert.equal(gift.gift_kind,'discount_coupon')
  const discountedOrder = () => fx.serviceCall('xelay_create_discounted_student_plan_order', [ids.studentB, 'live', 'xelay_' + randomUUID(), 'plus', gift.id])
  const regularOrder = () => fx.serviceCall('xelay_create_student_plan_order', [ids.studentB, 'live', 'xelay_' + randomUUID(), 'plus'])
  const order = await discountedOrder()
  const regular = await regularOrder()
  assert.equal(Number(order.amount), 279.3)
  assert.equal(Number(regular.amount), 399)
  assert.equal(order.birthday_gift_id, gift.id)
  assert.equal(regular.birthday_gift_id, null)
  assert.notEqual(regular.order_reference, order.order_reference)
  assert.equal((await regularOrder()).id, regular.id)
  assert.equal((await discountedOrder()).id, order.id)
  await fx.applyPayment(regular)
  assert.equal((await db.query('select coupon_redeemed_at from public.birthday_gifts where id=$1', [gift.id])).rows[0].coupon_redeemed_at, null)
  await fx.applyPayment(order);await fx.applyPayment(order)
  const after=(await db.query('select*from birthday_gifts where id=$1',[gift.id])).rows[0];assert.equal(after.coupon_order_id,order.id);assert.ok(after.coupon_redeemed_at)
  assert.equal((await db.query('select count(*)::int n from xelay_student_private.grants where order_id=$1',[order.id])).rows[0].n,1)
  assert.equal((await db.query('select count(*)::int n from xelay_teacher_private.grants where user_id=$1',[ids.studentB])).rows[0].n,0)
 })
})
