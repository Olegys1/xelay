import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createTeacherBackendFixture } from './helpers/teacherBackendFixture.mjs'
const migration = '20261119091302_admin_purchase_alerts.sql'

test('real payments enqueue one private receipt; retries, refunds and access boundaries preserve entitlements and grades', { timeout: 120000 }, async t => {
 const fx = await createTeacherBackendFixture(); t.after(() => fx.close())
 const { db, ids } = fx
 await fx.serviceCall('xelay_student_audience_assign', [ids.studentA, 'student', 'Synthetic student purchase check'])
 const historic = await fx.createPaidTeacher('teacher_start')
 await db.exec(await fx.readMigration(migration))
 const receipts = () => db.query('select * from xelay_admin_notifications.purchases order by created_at,order_id').then(x => x.rows)
 assert.equal((await receipts()).length, 0, 'no backfill spam')
 const grades = (await db.query('select to_jsonb(g) data from teaching_grades g order by id')).rows
 const gifts = (await db.query('select to_jsonb(g) data from birthday_gifts g order by id')).rows
 const paid = []
 for (const plan of ['teacher_start','teacher_plus','teacher_max','start','plus','max']) {
  const order = plan.startsWith('teacher_') ? await fx.createOrder(plan) : await fx.serviceCall('xelay_create_student_plan_order', [ids.studentA,'live','xelay_'+randomUUID(),plan])
  await fx.applyPayment(order)
  await fx.applyPayment(order)
  paid.push(order)
 }
 assert.equal((await receipts()).length, 6)
 const testOrder = await fx.createOrder('teacher_plus', ids.colleague, 'test')
 await fx.applyPayment(testOrder)
 const declined = await fx.createOrder('teacher_start', ids.otherTeacher)
 await fx.applyPayment(declined, 'Declined')
 assert.equal((await receipts()).length, 6, 'test and declined orders are not purchases')
 const grants = (await db.query('select to_jsonb(g) data from xelay_teacher_private.grants g order by id')).rows
 for (const name of ['xelay_claim_admin_purchase_alert','xelay_admin_purchase_alert_delivery_context','xelay_finish_admin_purchase_alert']) {
  const args = name.includes('finish') ? [randomUUID(),'sent',null,null] : name.includes('context') ? [randomUUID()] : []
  await assert.rejects(fx.ownerCall(name,args,ids.studentA), e => e.code === '42501')
 }
 for (const role of ['anon','authenticated','service_role']) {
  await db.exec('set role '+role)
  try { await assert.rejects(db.query('select * from xelay_admin_notifications.purchases'), e => e.code==='42501') }
  finally { await db.exec('reset role') }
 }
 let first = await fx.serviceCall('xelay_claim_admin_purchase_alert')
 assert.ok(first.lease_token);assert.equal(first.plan_id,'teacher_start')
 assert.equal(first.order_id, paid[0].id);assert.equal(first.amount,199)
 assert.equal(await fx.serviceCall('xelay_claim_admin_purchase_alert'), null, 'concurrent invocation cannot lease another message')
 assert.equal(await fx.serviceCall('xelay_finish_admin_purchase_alert',[randomUUID(),'sent',null,null]), false)
 await assert.rejects(fx.serviceCall('xelay_finish_admin_purchase_alert',[first.lease_token,'failed','PRIVATE provider text',null]),e=>e.code==='22023')
 assert.equal(await fx.serviceCall('xelay_finish_admin_purchase_alert',[first.lease_token,'failed','telegram_rate_limited',900]), true)
 assert.equal(await fx.serviceCall('xelay_claim_admin_purchase_alert'),null,'persist Retry-After across worker restarts')
 await db.query("update xelay_admin_notifications.purchases set next_attempt_at=clock_timestamp()-interval '1 minute' where order_id=$1",[first.order_id])
 first=await fx.serviceCall('xelay_claim_admin_purchase_alert')
 assert.equal(await fx.serviceCall('xelay_finish_admin_purchase_alert',[first.lease_token,'sent',null,null]),true)
 assert.equal(await fx.serviceCall('xelay_finish_admin_purchase_alert',[first.lease_token,'sent',null,null]),false)
 const next=await fx.serviceCall('xelay_claim_admin_purchase_alert')
 await fx.applyPayment(paid[1],'Refunded')
 assert.equal(await fx.serviceCall('xelay_admin_purchase_alert_delivery_context',[next.lease_token]),null,'refund is rechecked immediately before sending')
 await fx.serviceCall('xelay_finish_admin_purchase_alert',[next.lease_token,'skipped',null,null])
 const lease=await fx.serviceCall('xelay_claim_admin_purchase_alert')
 await db.query("update xelay_admin_notifications.purchases set lease_until=clock_timestamp()-interval '1 second' where lease_token=$1",[lease.lease_token])
 assert.equal(await fx.serviceCall('xelay_finish_admin_purchase_alert',[lease.lease_token,'sent',null,null]),false,'expired token cannot finalize delivery')
 const retry=await fx.serviceCall('xelay_claim_admin_purchase_alert')
 assert.equal(retry.order_id,lease.order_id);assert.notEqual(retry.lease_token,lease.lease_token)
 assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g order by id')).rows,grades)
 assert.deepEqual((await db.query('select to_jsonb(g) data from birthday_gifts g order by id')).rows,gifts)
 const after=(await db.query('select to_jsonb(g) data from xelay_teacher_private.grants g order by id')).rows
 assert.deepEqual(after.filter(x=>x.data.order_id!==paid[1].id),grants.filter(x=>x.data.order_id!==paid[1].id),'only the explicit refund changed a paid grant')
 assert.ok(after.some(x=>x.data.order_id===historic.id))
})
