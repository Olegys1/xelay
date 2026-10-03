// Full local migration chain, synthetic users and events only. No provider charge.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const ids = Object.fromEntries(['admin','otherAdmin','ordinary','deputy','representative','pending','paid'].map((key) => [key, randomUUID()]))
const first = (result) => result.rows[0]
const denied = (work) => assert.rejects(work, (error) => error.code === '42501')

test('full-chain admin MFA, billing and study-group permissions remain enforced', async (t) => {
  const fixture = await createFixture()
  const { db, asUser } = fixture
  const admin = (sql, params = [], aal = 'aal2') => asUser(ids.admin, sql, params, { aal })
  const service = (sql, params = []) => asUser(null, sql, params, { role: 'service_role', aal: 'aal1' })
  try {
    for (const id of Object.values(ids)) await fixture.seedUser(id)
    await db.query("insert into user_roles(user_id,role) values($1,'ADMIN'),($2,'ADMIN')", [ids.admin,ids.otherAdmin])
    const verifiedFactor = first(await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified') returning id", [ids.admin])).id
    await db.query("insert into auth.mfa_factors(user_id,status) values($1,'unverified'),($2,'verified')", [ids.otherAdmin,ids.ordinary])

    await t.test('administrator requires both AAL2 and an own verified factor; raw own role remains available for enrollment', async () => {
      assert.equal(first(await admin('select xelay_is_platform_admin() as allowed', [], 'aal1')).allowed, false)
      assert.equal(first(await admin('select xelay_is_platform_admin() as allowed')).allowed, true)
      assert.equal(first(await asUser(ids.otherAdmin,'select xelay_is_platform_admin() as allowed',[],{aal:'aal2'})).allowed,false)
      assert.equal(first(await asUser(ids.ordinary,'select xelay_is_platform_admin() as allowed',[],{aal:'aal2'})).allowed,false)
      assert.equal(first(await admin("select count(*)::int as count from user_roles where user_id=$1 and role='ADMIN'",[ids.admin],'aal1')).count,1)
      await denied(asUser(null,'select xelay_is_platform_admin()',[],{role:'anon'}))
      await denied(admin('select xelay_admin_grant_participant($1,1,$2)',[ids.ordinary,'Synthetic MFA test'],'aal1'))
      await denied(asUser(ids.otherAdmin,'select xelay_admin_grant_participant($1,1,$2)',[ids.ordinary,'Synthetic MFA test'],{aal:'aal2'}))
      await admin('select xelay_admin_grant_participant($1,1,$2)',[ids.ordinary,'Synthetic MFA test'])
      assert.equal(first(await db.query("select count(*)::int as count from participant_entitlements where user_id=$1 and source='admin_grant'",[ids.ordinary])).count,1)
      await db.query("update auth.mfa_factors set status='unverified' where id=$1",[verifiedFactor])
      assert.equal(first(await admin('select xelay_is_platform_admin() as allowed')).allowed,false)
      await denied(admin('select xelay_admin_billing_overview()'))
      await db.query("update auth.mfa_factors set status='verified' where id=$1",[verifiedFactor])
    })

    await t.test('ordinary users retain own billing status; payment server roles need no AAL2', async () => {
      const status = first(await asUser(ids.ordinary,'select xelay_billing_status() as value')).value
      assert.equal(status.is_premium,true)
      assert.equal(first(await service('select xelay_is_platform_admin() as allowed')).allowed,false)
      await denied(asUser(ids.ordinary,"select xelay_create_billing_order($1,'participant','live','forged-order')",[ids.ordinary]))
      await denied(admin("select xelay_create_billing_order($1,'participant','live','forged-admin-order')",[ids.admin]))
      await denied(asUser(ids.ordinary,"select xelay_apply_billing_event('forged','live',$1,'Approved',100,'UAH')",['a'.repeat(64)]))
      const order = first(await service("select xelay_create_billing_order($1,'participant','live',$2) as value",[ids.paid,`fixture-participant-${randomUUID()}`])).value
      assert.equal(Number(order.amount),100)
      assert.equal(order.currency,'UAH')
      const reused = first(await service("select xelay_create_billing_order($1,'participant','live',$2) as value",[ids.paid,`fixture-reuse-${randomUUID()}`])).value
      assert.equal(reused.id,order.id)
      await assert.rejects(service("select xelay_apply_billing_event($1,'live',$2,'Approved',750,'UAH')",[order.order_reference,'b'.repeat(64)]),/Payment order mismatch/)
      const applied = first(await service("select xelay_apply_billing_event($1,'live',$2,'Approved',100,'UAH') as value",[order.order_reference,'c'.repeat(64)])).value
      assert.equal(applied.duplicate,false)
      const entitlement = first(await db.query("select term_months,revoked_at, valid_until=(((valid_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv') as calendar_month from participant_entitlements where order_id=$1",[order.id]))
      assert.equal(entitlement.term_months,1)
      assert.equal(entitlement.calendar_month,true)
      assert.equal(entitlement.revoked_at,null)
      const duplicate = first(await service("select xelay_apply_billing_event($1,'live',$2,'Approved',100,'UAH') as value",[order.order_reference,'c'.repeat(64)])).value
      assert.equal(duplicate.duplicate,true)
      await service("select xelay_apply_billing_event($1,'live',$2,'Approved',100,'UAH')",[order.order_reference,'d'.repeat(64)])
      assert.equal(first(await db.query('select count(*)::int as count from participant_entitlements where order_id=$1',[order.id])).count,1)
      const ownStatus = first(await asUser(ids.paid,'select xelay_billing_status() as value')).value
      assert.equal(ownStatus.is_premium,true)
      const testOrder = first(await service("select xelay_create_billing_order($1,'participant','test',$2) as value",[ids.pending,`fixture-test-${randomUUID()}`])).value
      await service("select xelay_apply_billing_event($1,'test',$2,'Approved',100,'UAH')",[testOrder.order_reference,'e'.repeat(64)])
      assert.equal(first(await db.query('select count(*)::int as count from participant_entitlements where user_id=$1',[ids.pending])).count,0)
    })

    const university = randomUUID(), unit = randomUUID(), request = randomUUID(), group = randomUUID()
    await db.query("insert into universities(id,name,slug) values($1,'Synthetic MFA university',$2)",[university,`fixture-${university}`])
    await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Synthetic faculty',$3,'faculty')",[unit,university,`fixture-${unit}`])
    await db.query("insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,group_name,telegram_username,status,reviewed_by,reviewed_at) values($1,$2,'Synthetic representative',$3,$4,'Fixture group','fixture_contact','approved',$5,now())",[request,ids.representative,university,unit,ids.admin])
    await db.query("insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,group_name) values($1,$2,$3,$4,$5,'Fixture group')",[group,request,ids.representative,university,unit])
    // The legacy first-group promotion is intentionally removed from this synthetic group.
    await db.query('delete from group_entitlements where group_id=$1',[group])
    await db.exec('update billing_settings set enforce_group_payment=false')
    await db.query("insert into study_group_members(group_id,user_id,status,invited_by,accepted_at) values($1,$2,'accepted',$5,now()),($1,$3,'accepted',$5,now()),($1,$4,'pending',$5,null)",[group,ids.deputy,ids.ordinary,ids.pending,ids.representative])

    await t.test('actual representative can appoint accepted deputy; neither admins nor ordinary/pending members gain academic rights', async () => {
      const repPermissions = first(await asUser(ids.representative,'select xelay_study_group_permissions($1) as permissions',[group])).permissions
      assert.ok(repPermissions.includes('schedule') && repPermissions.includes('homework') && repPermissions.includes('seminars'))
      await denied(admin('select xelay_assign_study_group_deputy($1,$2,array[\'schedule\'])',[group,ids.deputy]))
      await denied(asUser(ids.representative,'select xelay_assign_study_group_deputy($1,$2,array[\'schedule\'])',[group,ids.pending]))
      await asUser(ids.representative,'select xelay_assign_study_group_deputy($1,$2,array[\'schedule\'])',[group,ids.deputy])
      assert.deepEqual(first(await asUser(ids.deputy,'select xelay_study_group_permissions($1) as permissions',[group])).permissions,['schedule'])
      assert.deepEqual(first(await asUser(ids.ordinary,'select xelay_study_group_permissions($1) as permissions',[group])).permissions,[])
      assert.deepEqual(first(await asUser(ids.pending,'select xelay_study_group_permissions($1) as permissions',[group])).permissions,[])
      const elevated = first(await admin('select xelay_study_group_permissions($1) as permissions',[group])).permissions
      for (const permission of ['schedule','homework','seminars','seminar_resources']) assert.equal(elevated.includes(permission),false)
      const lesson = [{weekday:1,starts_at:'09:00',ends_at:'10:00',subject:'Synthetic lesson',lesson_type:'lecture',location:'',online_url:'',online_url_secondary:'',valid_from:'2026-10-05',valid_until:'2026-10-31',week_pattern:'every',week_anchor_date:null,lesson_number:1}]
      await denied(asUser(ids.ordinary,'select xelay_import_study_group_timetable($1,$2::jsonb)',[group,JSON.stringify(lesson)]))
      await denied(admin('select xelay_import_study_group_timetable($1,$2::jsonb)',[group,JSON.stringify(lesson)]))
      // Simulate the passage of the new group's free week in the isolated DB.
      // Both dates retain the exact168-hour interval; application roles cannot reset them.
      await db.query("update group_trial_entitlements set started_at=now()-interval '192 hours',expires_at=now()-interval '24 hours' where group_id=$1",[group])
      await db.exec('update billing_settings set enforce_group_payment=true')
      await assert.rejects(asUser(ids.deputy,'select xelay_import_study_group_timetable($1,$2::jsonb)',[group,JSON.stringify(lesson)]),/GROUP_LICENSE_REQUIRED/)
    })

    await t.test('annual payment preserves 750 UAH/12 months, idempotency and deputy schedule edit with active license', async () => {
      await assert.rejects(service("select xelay_create_billing_order($1,'group','live',$2,$3)",[ids.deputy,`fixture-wrong-rep-${randomUUID()}`,group]),/Group representative required/)
      const order = first(await service("select xelay_create_billing_order($1,'group','live',$2,$3) as value",[ids.representative,`fixture-group-${randomUUID()}`,group])).value
      assert.equal(Number(order.amount),750)
      assert.equal(order.group_term_months,12)
      await service("select xelay_apply_billing_event($1,'live',$2,'Approved',750,'UAH')",[order.order_reference,'f'.repeat(64)])
      await service("select xelay_apply_billing_event($1,'live',$2,'Approved',750,'UAH')",[order.order_reference,'f'.repeat(64)])
      const entitlement = first(await db.query("select count(*)::int as count,bool_and(term_months=12 and valid_until=(((valid_from at time zone 'Europe/Kyiv')+interval '1 year') at time zone 'Europe/Kyiv')) as annual from group_annual_entitlements where order_id=$1",[order.id]))
      assert.equal(entitlement.count,1)
      assert.equal(entitlement.annual,true)
      const status = first(await asUser(ids.ordinary,'select xelay_group_billing_status($1) as value',[group])).value
      assert.equal(status.is_active,true)
      assert.equal(status.price,750)
      assert.equal(status.billing_period_months,12)
      const lesson = [{weekday:1,starts_at:'09:00',ends_at:'10:00',subject:'Synthetic lesson',lesson_type:'lecture',location:'',valid_from:'2026-10-05',valid_until:'2026-10-31',week_pattern:'every',lesson_number:1}]
      assert.equal(first(await asUser(ids.deputy,'select xelay_import_study_group_timetable($1,$2::jsonb) as count',[group,JSON.stringify(lesson)])).count,1)
      const schedule = first(await db.query('select id,created_by from study_group_schedule where group_id=$1',[group]))
      assert.equal(schedule.created_by,ids.deputy)
      await denied(asUser(ids.deputy,"insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,'2026-10-05','Unauthorized homework',$3)",[group,schedule.id,ids.deputy]))
      await asUser(ids.representative,"insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,'2026-10-05','Representative homework',$3)",[group,schedule.id,ids.representative])
      await db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[group,ids.deputy])
      assert.deepEqual(first(await asUser(ids.deputy,'select xelay_study_group_permissions($1) as permissions',[group])).permissions,[])
      await denied(asUser(ids.deputy,'select xelay_import_study_group_timetable($1,$2::jsonb)',[group,JSON.stringify(lesson)]))
      await service("select xelay_apply_billing_event($1,'live',$2,'Refunded',750,'UAH')",[order.order_reference,'0'.repeat(64)])
      assert.equal(first(await asUser(ids.representative,'select xelay_group_billing_status($1) as value',[group])).value.is_active,false)
      await assert.rejects(asUser(ids.representative,'select xelay_import_study_group_timetable($1,$2::jsonb)',[group,JSON.stringify(lesson)]),/GROUP_LICENSE_REQUIRED/)
    })
  } finally {
    await fixture.close()
  }
})
