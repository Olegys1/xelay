// Offline PostgreSQL simulation only: no Auth/Storage HTTP, provider or cloud.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const migration = await readFile(new URL('../../supabase/migrations/202610030016_group_trial.sql', import.meta.url), 'utf8')
const first = (result) => result.rows[0]
const denied = (work) => assert.rejects(work, (error) => error.code === '42501')
const constraintDenied = (work) => assert.rejects(work, (error) => error.code === '23514')
const filePath = (groupId, userId) => `${groupId}/${userId}/${randomUUID()}.png`
const lesson = (subject = 'Synthetic trial lesson') => JSON.stringify([{
  weekday: 1, starts_at: '09:00', ends_at: '10:00', subject, lesson_type: 'lecture',
  location: '', online_url: '', online_url_secondary: '', valid_from: '2026-10-05',
  valid_until: '2026-10-31', week_pattern: 'every', week_anchor_date: null, lesson_number: 1,
}])

async function makeHarness(options = {}) {
  const fixture = await createFixture(options)
  const { db, asUser } = fixture
  const users = Object.fromEntries(['reviewer', 'ordinary', 'deputy', 'outsider', 'pending'].map((name) => [name, randomUUID()]))
  for (const id of Object.values(users)) await fixture.seedUser(id)
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [users.reviewer])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [users.reviewer])
  const university = randomUUID(), unit = randomUUID()
  await db.query("insert into universities(id,name,slug) values($1,'Synthetic trial university',$2)", [university, `trial-${university}`])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Synthetic faculty',$3,'faculty')", [unit, university, `trial-${unit}`])

  const approvedRequest = async ({ name = `Trial ${randomUUID()}`, specialty = 'Synthetic trial program' } = {}) => {
    const representative = randomUUID(), request = randomUUID()
    await fixture.seedUser(representative)
    await db.query(`insert into class_representative_requests(
      id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,
      telegram_username,status,reviewed_by,reviewed_at)
      values($1,$2,'Synthetic representative',$3,$4,$5,$6,'trial_fixture','approved',$7,now())`,
    [request, representative, university, unit, specialty, name, users.reviewer])
    return { representative, request, name, specialty }
  }
  const createGroup = async (options) => {
    const context = await approvedRequest(options)
    const group = first(await asUser(context.representative, 'select xelay_create_study_group($1) as id', [context.request])).id
    return { ...context, group }
  }
  const addMember = async (context, userId, status = 'accepted') => {
    await db.query(`insert into study_group_members(group_id,user_id,status,invited_by,accepted_at)
      values($1,$2,$3,$4,case when $3='accepted' then now() else null end)`,
    [context.group, userId, status, context.representative])
  }
  const status = async (context, userId = context.representative) => first(await asUser(userId,
    'select xelay_group_billing_status($1) as value', [context.group])).value
  const trial = async (context) => first(await db.query('select * from group_trial_entitlements where group_id=$1', [context.group]))
  // Only the synthetic database owner changes dates to simulate seven days
  // passing. No client/service role, trigger disable or seven-day wait is used.
  const expire = async (context) => db.query(`with moment as (select clock_timestamp()-interval '8 days' as starts)
    update group_trial_entitlements set started_at=moment.starts,
      expires_at=moment.starts+interval '168 hours' from moment where group_id=$1`, [context.group])
  const service = (sql, params = []) => asUser(null, sql, params, { role: 'service_role', aal: 'aal1' })
  const order = async (context, mode = 'live') => first(await service(
    "select xelay_create_billing_order($1,'group',$2,$3,$4) as value",
    [context.representative, mode, `trial-${randomUUID()}`, context.group])).value
  const event = async (payment, eventStatus = 'Approved', fingerprint = randomUUID().replaceAll('-', '').repeat(2)) => first(await service(
    "select xelay_apply_billing_event($1,$2,$3,$4,750,'UAH') as value",
    [payment.order_reference, payment.mode, fingerprint, eventStatus])).value
  return { ...fixture, users, university, unit, approvedRequest, createGroup, addMember, status, trial, expire, service, order, event }
}

test('new study-group trials are server timed, member scoped and expire to read-only', async (t) => {
  const h = await makeHarness()
  const { db, asUser, users } = h
  t.after(() => h.close())
  await db.exec('update billing_settings set enforce_group_payment=false')
  let context

  await t.test('new approved group receives exactly 168 server hours and no lifetime or participant grant', async () => {
    const before = first(await db.query('select clock_timestamp() as value')).value
    context = await h.createGroup()
    const after = first(await db.query('select clock_timestamp() as value')).value
    const stored = first(await db.query(`select isfinite(started_at) and isfinite(expires_at) as finite,
      extract(epoch from (expires_at-started_at))::integer as seconds,
      started_at >= $2::timestamptz-interval '1 millisecond'
        and started_at <= $3::timestamptz+interval '1 millisecond' as server_generated
      from group_trial_entitlements where group_id=$1`, [context.group, before, after]))
    assert.deepEqual(stored, { finite: true, seconds: 604800, server_generated: true })
    assert.equal(first(await db.query('select count(*)::integer as count from group_entitlements where group_id=$1', [context.group])).count, 0)
    assert.equal(first(await db.query('select count(*)::integer as count from participant_entitlements where user_id=$1', [context.representative])).count, 0)
    const state = await h.status(context)
    assert.equal(state.source, 'trial')
    assert.equal(state.trial_days, 7)
    assert.equal(state.trial_used, true)
    assert.equal(state.is_active, true)
    assert.equal(state.can_edit, true)
    assert.equal(state.can_participate, true)
    assert.equal(state.enforcement_enabled, true)
    assert.equal(state.is_lifetime, false)
    assert.equal(state.price, 750)
    assert.equal(state.billing_period_months, 12)
    assert.ok(Number(state.remaining_seconds) > 0 && Number(state.remaining_seconds) <= 604800)
    assert.ok(new Date(state.server_now) >= new Date(state.trial_started_at))
    assert.equal(first(await db.query("select count(*)::integer as count from pg_trigger where tgrelid='study_groups'::regclass and tgname='study_group_first_license'")).count, 0)
  })

  await t.test('client and service cannot insert, reset or delete trial fields; billing status does not disclose to outsiders', async () => {
    const original = await h.trial(context)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      const user = role === 'authenticated' ? context.representative : null
      const options = { role }
      await denied(asUser(user, "update group_trial_entitlements set expires_at='infinity' where group_id=$1", [context.group], options))
      await denied(asUser(user, 'delete from group_trial_entitlements where group_id=$1', [context.group], options))
      await denied(asUser(user, `insert into group_trial_entitlements(group_id,started_at,expires_at)
        values($1,clock_timestamp(),clock_timestamp()+interval '168 hours')`, [context.group], options))
    }
    await denied(asUser(context.representative, 'select * from group_trial_entitlements'))
    assert.equal(first(await h.service('select count(*)::integer as count from group_trial_entitlements where group_id=$1', [context.group])).count, 1)
    await denied(asUser(users.outsider, 'select xelay_group_billing_status($1)', [context.group]))
    await denied(asUser(null, 'select xelay_group_billing_status($1)', [context.group], { role: 'anon' }))
    assert.deepEqual(await h.trial(context), original)
    for (const signature of ['xelay_guard_group_trial_immutable()', 'xelay_claim_group_trial()',
      'xelay_claim_first_group_license()', 'xelay_group_write_access(uuid)', 'xelay_group_enforcement_required(uuid)']) {
      const privileges = first(await db.query(`select has_function_privilege('authenticated',$1,'EXECUTE') as client,
        has_function_privilege('anon',$1,'EXECUTE') as anon,
        has_function_privilege('service_role',$1,'EXECUTE') as service`, [signature]))
      assert.deepEqual(privileges, { client: false, anon: false, service: false })
    }
  })

  await t.test('immutable trigger still rejects authenticated and service UPDATE if a column grant is accidentally restored', async () => {
    const original = await h.trial(context)
    await db.exec(`grant update(started_at,expires_at) on group_trial_entitlements to authenticated,service_role;
      create policy fixture_trial_update on group_trial_entitlements for update to authenticated using(true) with check(true);
      create policy fixture_trial_select on group_trial_entitlements for select to authenticated using(true);
      grant select on group_trial_entitlements to authenticated;`)
    try {
      for (const role of ['authenticated', 'service_role']) {
        await denied(asUser(role === 'authenticated' ? context.representative : null,
          "update group_trial_entitlements set started_at=started_at+interval '1 day',expires_at=expires_at+interval '1 day' where group_id=$1",
          [context.group], { role }))
      }
      assert.deepEqual(await h.trial(context), original)
    } finally {
      await db.exec(`drop policy fixture_trial_update on group_trial_entitlements;
        drop policy fixture_trial_select on group_trial_entitlements;
        revoke update(started_at,expires_at) on group_trial_entitlements from authenticated,service_role;
        revoke select on group_trial_entitlements from authenticated;`)
    }
  })

  await t.test('trusted fixture maintenance cannot store nonfinite dates or change the seven-day duration', async () => {
    const original = await h.trial(context)
    await constraintDenied(db.query("update group_trial_entitlements set expires_at=expires_at+interval '1 hour' where group_id=$1", [context.group]))
    await constraintDenied(db.query("update group_trial_entitlements set started_at='infinity',expires_at='infinity' where group_id=$1", [context.group]))
    assert.deepEqual(await h.trial(context), original)
  })

  await t.test('accepted deputy retains exactly appointed academic permissions; trial does not promote ordinary, pending or admin-only users', async () => {
    await h.addMember(context, users.deputy)
    await h.addMember(context, users.ordinary)
    await h.addMember(context, users.pending, 'pending')
    await asUser(context.representative, "select xelay_assign_study_group_deputy($1,$2,array['schedule'])", [context.group, users.deputy])
    assert.deepEqual(first(await asUser(users.deputy, 'select xelay_study_group_permissions($1) as value', [context.group])).value, ['schedule'])
    assert.deepEqual(first(await asUser(users.ordinary, 'select xelay_study_group_permissions($1) as value', [context.group])).value, [])
    assert.deepEqual(first(await asUser(users.pending, 'select xelay_study_group_permissions($1) as value', [context.group])).value, [])
    const adminPermissions = first(await asUser(users.reviewer, 'select xelay_study_group_permissions($1) as value', [context.group], { aal: 'aal2' })).value
    for (const permission of ['schedule', 'homework', 'seminars', 'seminar_resources']) assert.equal(adminPermissions.includes(permission), false)
    for (const user of [users.ordinary, users.pending, users.outsider]) {
      await denied(asUser(user, 'select xelay_import_study_group_timetable($1,$2::jsonb)', [context.group, lesson()]))
    }
    await denied(asUser(users.ordinary, "select xelay_assign_study_group_deputy($1,$2,array['homework'])", [context.group, users.deputy]))
    assert.equal(first(await asUser(users.deputy, 'select xelay_import_study_group_timetable($1,$2::jsonb) as count', [context.group, lesson()])).count, 1)
    const schedule = first(await db.query('select id,created_by from study_group_schedule where group_id=$1', [context.group]))
    assert.equal(schedule.created_by, users.deputy)
    await denied(asUser(users.deputy, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
      values($1,$2,'2026-10-05','Unauthorized deputy homework',$3)`, [context.group, schedule.id, users.deputy]))
    await asUser(context.representative, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
      values($1,$2,'2026-10-05','Retained trial homework',$3)`, [context.group, schedule.id, context.representative])
    const allowed = first(await asUser(users.deputy, `select xelay_can_upload_timetable_image($1) as timetable,
      xelay_can_upload_homework_file($2) as homework,xelay_can_upload_seminar_file($3) as seminar`,
    [filePath(context.group, users.deputy), filePath(context.group, users.deputy), filePath(context.group, users.deputy)]))
    assert.deepEqual(allowed, { timetable: true, homework: false, seminar: false })
    const otherGroup = await h.createGroup()
    await h.addMember(otherGroup, users.deputy)
    await denied(asUser(users.deputy, 'select xelay_import_study_group_timetable($1,$2::jsonb)', [otherGroup.group, lesson()]))
    assert.equal(first(await asUser(users.deputy, 'select xelay_can_upload_timetable_image($1) as allowed', [filePath(otherGroup.group, users.deputy)])).allowed, false)
    assert.equal((await h.status(context, users.ordinary)).can_edit, false)
    assert.equal((await h.status(context, users.ordinary)).can_participate, true)
    const date = first(await db.query("select to_char(current_date+8,'YYYY-MM-DD') as date,extract(isodow from current_date+8)::integer as weekday"))
    const subject = first(await asUser(context.representative, "select xelay_save_seminar_subject($1,null,'Synthetic trial seminar') as id", [context.group])).id
    const seminarSchedule = first(await asUser(context.representative,
      "select xelay_save_seminar_schedule($1,null,$2,$3,'11:00','12:00',$4::date,$4::date) as id",
      [context.group, subject, date.weekday, date.date])).id
    context.seminar = first(await asUser(context.representative,
      "select xelay_save_seminar($1,null,$2,$3::date,'Synthetic trial seminar','','questions',$4::jsonb,'[]'::jsonb) as id",
      [context.group, seminarSchedule, date.date, JSON.stringify([{ body: 'Synthetic discussion question', primary_capacity: 2 }])])).id
    context.question = first(await db.query('select id from study_group_seminar_questions where seminar_id=$1', [context.seminar])).id
    context.comment = first(await asUser(users.ordinary, "select xelay_add_seminar_comment($1,'Retained trial comment') as id", [context.seminar])).id
    await asUser(users.ordinary, "select xelay_reserve_seminar($1,'primary',$2)", [context.seminar, context.question])
    await denied(asUser(users.ordinary, "select xelay_save_seminar_subject($1,null,'Unauthorized member management')", [context.group]))
    await denied(asUser(users.deputy, "select xelay_save_seminar_subject($1,null,'Unauthorized schedule deputy management')", [context.group]))
  })

  await t.test('access expires against the current server clock even inside an older open transaction', async () => {
    const original = await h.trial(context)
    await db.exec('begin')
    try {
      // Separate coarse fixture clock ticks; no seven-day wait or time mock.
      await new Promise((resolve) => setTimeout(resolve, 5))
      await db.query(`with moment as (select clock_timestamp()-interval '1 microsecond' as cutoff)
        update group_trial_entitlements set started_at=moment.cutoff-interval '168 hours',
          expires_at=moment.cutoff from moment where group_id=$1`, [context.group])
      const clocks = first(await db.query(`select expires_at>now() as after_transaction_start,
        expires_at<clock_timestamp() as before_current_clock,xelay_group_has_access($1) as active
        from group_trial_entitlements where group_id=$1`, [context.group]))
      assert.deepEqual(clocks, { after_transaction_start: true, before_current_clock: true, active: false })
      assert.equal((await h.status(context)).can_participate, false)
    } finally {
      await db.exec('rollback')
    }
    assert.deepEqual(await h.trial(context), original)
  })

  await t.test('expiry overrides the old false payment switch and preserves readable content while denying INSERT, UPDATE, DELETE and uploads', async () => {
    await h.expire(context)
    await db.exec('update billing_settings set enforce_group_payment=false')
    const state = await h.status(context)
    assert.equal(state.is_active, false)
    assert.equal(state.payment_required, true)
    assert.equal(state.enforcement_enabled, true)
    assert.equal(state.can_edit, false)
    assert.equal(state.can_participate, false)
    assert.equal(state.trial_used, true)
    assert.equal(Number(state.remaining_seconds), 0)
    assert.deepEqual(first(await db.query('select xelay_group_enforcement_required($1) as enforced,xelay_group_write_access($1) as writable', [context.group])), { enforced: true, writable: false })
    for (const user of [context.representative, users.deputy]) {
      await denied(asUser(user, 'select xelay_import_study_group_timetable($1,$2::jsonb)', [context.group, lesson('Denied after expiry')]))
    }
    const retained = first(await db.query(`select s.id as schedule_id,h.id as homework_id from study_group_schedule s
      join study_group_homework h on h.schedule_item_id=s.id where s.group_id=$1`, [context.group]))
    await denied(asUser(context.representative, "update study_group_schedule set subject='Expired edit' where id=$1", [retained.schedule_id]))
    await denied(asUser(context.representative, 'delete from study_group_schedule where id=$1', [retained.schedule_id]))
    await denied(asUser(context.representative, "update study_group_homework set body='Expired edit' where id=$1", [retained.homework_id]))
    await denied(asUser(context.representative, 'delete from study_group_homework where id=$1', [retained.homework_id]))
    const files = first(await asUser(context.representative, `select xelay_can_edit_homework_resources($1) as homework_edit,
      xelay_can_upload_homework_file($2) as homework,xelay_can_upload_seminar_file($3) as seminar,
      xelay_can_upload_timetable_image($4) as timetable`,
    [context.group, filePath(context.group, context.representative), filePath(context.group, context.representative), filePath(context.group, context.representative)]))
    assert.deepEqual(files, { homework_edit: false, homework: false, seminar: false, timetable: false })
    await denied(asUser(context.representative, "select xelay_save_seminar_subject($1,null,'Expired subject')", [context.group]))
    await denied(asUser(users.ordinary, "select xelay_add_seminar_comment($1,'Denied after expiry')", [context.seminar]))
    await denied(asUser(users.ordinary, "select xelay_update_seminar_comment($1,'Denied edit')", [context.comment]))
    await denied(asUser(users.ordinary, "select xelay_reserve_seminar($1,'supplement',$2)", [context.seminar, context.question]))
    await denied(asUser(users.ordinary, 'select xelay_cancel_seminar_reservation($1)', [context.seminar]))
    assert.equal(first(await asUser(users.ordinary, 'select count(*)::integer as count from study_group_schedule where group_id=$1', [context.group])).count, 1)
    assert.equal(first(await asUser(users.ordinary, 'select body from study_group_homework where id=$1', [retained.homework_id])).body, 'Retained trial homework')
    assert.equal(first(await asUser(users.ordinary, 'select body from study_group_seminar_comments where id=$1', [context.comment])).body, 'Retained trial comment')
    assert.equal(first(await db.query('select count(*)::integer as count from study_group_seminar_reservations where seminar_id=$1', [context.seminar])).count, 1)
    assert.equal(first(await db.query('select count(*)::integer as count from study_group_members where group_id=$1', [context.group])).count, 4)
  })

  await t.test('repeat creation, duplicate logical identity and migration retries cannot restart an existing expired trial', async () => {
    const expired = await h.trial(context)
    assert.equal(first(await asUser(context.representative, 'select xelay_create_study_group($1) as id', [context.request])).id, context.group)
    await denied(asUser(context.representative, 'delete from study_groups where id=$1', [context.group]))
    await denied(asUser(context.representative, `insert into study_groups(
      representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
      values($1,$2,$3,$4,$5,$6)`, [context.request, context.representative, h.university, h.unit, context.specialty, context.name]))
    const duplicate = await h.approvedRequest({ name: ` ${context.name.toUpperCase()} `, specialty: ` ${context.specialty.toUpperCase()} ` })
    await assert.rejects(asUser(duplicate.representative, 'select xelay_create_study_group($1)', [duplicate.request]), (error) => error.code === '23505')
    await db.exec(migration)
    await db.exec(migration)
    assert.deepEqual(await h.trial(context), expired)
    assert.equal((await h.status(context)).is_active, false)
    assert.equal(first(await db.query('select count(*)::integer as count from study_groups where representative_request_id=$1', [duplicate.request])).count, 0)
    assert.equal(first(await db.query("select count(*)::integer as count from pg_trigger where tgrelid='study_groups'::regclass and tgname='study_group_trial_license'")).count, 1)
    // Policy is per new group ID, not a global once-per-person fingerprint.
    // Privileged deletion/recreation of synthetic rows is not a client path.
  })

  await t.test('a live manual annual payment restores an expired group without deleting its data', async () => {
    const payment = await h.order(context)
    assert.equal(Number(payment.amount), 750)
    assert.equal(payment.group_term_months, 12)
    await h.event(payment)
    assert.equal((await h.status(context)).source, 'payment')
    assert.equal((await h.status(context)).is_active, true)
    assert.equal(first(await asUser(context.representative, 'select xelay_import_study_group_timetable($1,$2::jsonb) as count', [context.group, lesson('Restored paid lesson')])).count, 1)
    assert.equal(first(await db.query('select count(*)::integer as count from study_group_homework where group_id=$1', [context.group])).count, 1)
  })
})

test('group trial billing retains remaining free time, manual annual renewal and refund isolation', async (t) => {
  const h = await makeHarness()
  const { db, asUser } = h
  t.after(() => h.close())
  const context = await h.createGroup()
  const original = await h.trial(context)
  let firstOrder, renewal

  await t.test('750 UAH live year starts at the remaining trial floor and duplicate events grant one year only', async () => {
    await denied(asUser(context.representative, "select xelay_create_billing_order($1,'group','live',$2,$3)", [context.representative, `forged-${randomUUID()}`, context.group]))
    firstOrder = await h.order(context)
    assert.equal(Number(firstOrder.amount), 750)
    assert.equal(firstOrder.currency, 'UAH')
    assert.equal(firstOrder.group_term_months, 12)
    const fingerprint = 'a'.repeat(64)
    assert.equal((await h.event(firstOrder, 'Approved', fingerprint)).duplicate, false)
    assert.equal((await h.event(firstOrder, 'Approved', fingerprint)).duplicate, true)
    await h.event(firstOrder, 'Approved', 'b'.repeat(64))
    assert.deepEqual(first(await db.query(`select count(*)::integer as count,
      bool_and(a.valid_from=t.expires_at) as after_trial,
      bool_and(a.term_months=12 and a.valid_until=(((a.valid_from at time zone 'Europe/Kyiv')+interval '1 year') at time zone 'Europe/Kyiv')) as full_year
      from group_annual_entitlements a join group_trial_entitlements t using(group_id) where a.order_id=$1`, [firstOrder.id])),
    { count: 1, after_trial: true, full_year: true })
    const state = await h.status(context)
    assert.equal(state.source, 'payment')
    assert.equal(state.can_renew, true)
    assert.equal(state.is_lifetime, false)
    assert.deepEqual(await h.trial(context), original)
  })

  await t.test('second manually purchased year starts after the queued first paid year', async () => {
    renewal = await h.order(context)
    assert.notEqual(renewal.id, firstOrder.id)
    await h.event(renewal)
    assert.equal(first(await db.query(`select second.valid_from=first.valid_until as contiguous
      from group_annual_entitlements first join group_annual_entitlements second on second.group_id=first.group_id
      where first.order_id=$1 and second.order_id=$2`, [firstOrder.id, renewal.id])).contiguous, true)
    assert.deepEqual(await h.trial(context), original)
  })

  await t.test('refund reflows remaining paid year no earlier than trial expiry and never revokes the unexpired trial', async () => {
    await h.event(firstOrder, 'Refunded')
    assert.equal(first(await db.query('select revoked_at is not null as revoked from group_annual_entitlements where order_id=$1', [firstOrder.id])).revoked, true)
    assert.equal(first(await db.query(`select a.valid_from=t.expires_at as trial_floor
      from group_annual_entitlements a join group_trial_entitlements t using(group_id) where a.order_id=$1`, [renewal.id])).trial_floor, true)
    await h.event(renewal, 'Refunded')
    const state = await h.status(context)
    assert.equal(state.is_active, true)
    assert.equal(state.source, 'trial')
    assert.equal(state.can_participate, true)
    assert.deepEqual(await h.trial(context), original)
    assert.equal(first(await db.query('select count(*)::integer as count from group_annual_entitlements where group_id=$1 and revoked_at is null', [context.group])).count, 0)
  })

  await t.test('approved test-mode payment does not grant a year or alter the existing trial', async () => {
    const payment = await h.order(context, 'test')
    await h.event(payment)
    assert.equal(first(await db.query('select count(*)::integer as count from group_annual_entitlements where order_id=$1', [payment.id])).count, 0)
    assert.equal(first(await db.query('select count(*)::integer as count from group_entitlements where order_id=$1', [payment.id])).count, 0)
    assert.deepEqual(await h.trial(context), original)
    assert.equal((await h.status(context)).source, 'trial')
  })
})

test('migration 016 leaves legacy groups and existing grants unchanged without a trial backfill', async (t) => {
  const h = await makeHarness({ through: '202610030015' })
  const { db } = h
  t.after(() => h.close())
  await db.exec('update billing_settings set first_free_group_claimed=true,enforce_group_payment=false')
  const unlicensed = await h.createGroup()
  const free = await h.createGroup()
  const admin = await h.createGroup()
  const annual = await h.createGroup()
  const paidLifetime = await h.createGroup()
  await db.query("insert into group_entitlements(group_id,source) values($1,'free'),($2,'admin_grant')", [free.group, admin.group])
  const yearOrder = await h.order(annual)
  await h.event(yearOrder)
  // Reproduce a pre-annual lifetime checkout. It is not a new 750/year order.
  const oldOrder = first(await db.query(`insert into billing_orders(user_id,product,group_id,order_reference,amount,mode,group_term_months)
    values($1,'group',$2,$3,750,'live',null) returning *`, [paidLifetime.representative, paidLifetime.group, `legacy-${randomUUID()}`]))
  await h.event(oldOrder)
  const grantsBefore = (await db.query('select * from group_entitlements order by group_id')).rows
  const annualBefore = (await db.query('select * from group_annual_entitlements order by id')).rows
  const claimedBefore = first(await db.query('select first_free_group_claimed from billing_settings where singleton')).first_free_group_claimed

  await t.test('existing free, admin, lifetime and annual grants survive two migration applications byte-for-byte as rows', async () => {
    await db.exec(migration)
    await db.exec(migration)
    assert.deepEqual((await db.query('select * from group_entitlements order by group_id')).rows, grantsBefore)
    assert.deepEqual((await db.query('select * from group_annual_entitlements order by id')).rows, annualBefore)
    assert.equal(first(await db.query('select first_free_group_claimed from billing_settings where singleton')).first_free_group_claimed, claimedBefore)
    assert.equal(first(await db.query('select count(*)::integer as count from group_trial_entitlements')).count, 0)
    for (const context of [free, admin, annual, paidLifetime]) {
      const state = await h.status(context)
      assert.equal(state.is_active, true)
      assert.equal(state.trial_used, false)
      assert.equal(state.trial_started_at, null)
      assert.equal(state.trial_expires_at, null)
    }
    assert.equal((await h.status(free)).source, 'free')
    assert.equal((await h.status(admin)).source, 'admin_grant')
    assert.equal((await h.status(paidLifetime)).is_lifetime, true)
    assert.equal((await h.status(annual)).is_lifetime, false)
  })

  await t.test('historical false payment switch remains effective only for an old unlicensed group; no lazy trial can begin', async () => {
    const state = await h.status(unlicensed)
    assert.equal(state.is_active, false)
    assert.equal(state.trial_used, false)
    assert.equal(state.enforcement_enabled, false)
    assert.equal(state.can_edit, true)
    assert.equal(state.can_participate, true)
    assert.equal(first(await h.asUser(unlicensed.representative, 'select xelay_create_study_group($1) as id', [unlicensed.request])).id, unlicensed.group)
    assert.equal(first(await db.query('select count(*)::integer as count from group_trial_entitlements where group_id=$1', [unlicensed.group])).count, 0)
    await db.exec('update billing_settings set enforce_group_payment=true')
    assert.equal((await h.status(unlicensed)).can_edit, false)
    for (const context of [free, admin, annual, paidLifetime]) assert.equal((await h.status(context)).is_active, true)
    const newGroup = await h.createGroup()
    assert.equal((await h.status(newGroup)).source, 'trial')
    assert.equal((await h.status(newGroup)).trial_used, true)
    assert.equal(first(await db.query('select count(*)::integer as count from group_trial_entitlements')).count, 1)
  })
})
