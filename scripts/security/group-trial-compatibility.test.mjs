// Offline PostgreSQL compatibility matrix. This never connects to a cloud,
// payment provider, Auth endpoint or real Storage service.
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const migration = await readFile(new URL('../../supabase/migrations/202610030016_group_trial.sql', import.meta.url), 'utf8')
const first = (result) => result.rows[0]
const denied = (work) => assert.rejects(work, (error) => error.code === '42501')
const pathFor = (group, user, bucket = 'xelay-timetable-images') =>
  `${group}/${user}/${randomUUID()}${bucket === 'xelay-timetable-images' ? '.png' : '-fixture.png'}`
const attachment = (path) => JSON.stringify([{ storage_path: path, file_name: 'fixture.png', mime_type: 'image/png', file_size: 100 }])
const lessons = (subject = 'Compatibility lecture') => JSON.stringify([{
  weekday: 1, starts_at: '08:00', ends_at: '09:20', subject, lesson_type: 'lecture',
  location: '', online_url: '', online_url_secondary: '', valid_from: '2026-10-05',
  valid_until: '2026-10-31', week_pattern: 'every', week_anchor_date: null, lesson_number: 1,
}])

async function harness(through) {
  const fixture = await createFixture({ through })
  const { db, asUser } = fixture
  const users = Object.fromEntries(['reviewer', 'ordinary', 'deputy', 'outsider', 'pending'].map((name) => [name, randomUUID()]))
  for (const id of Object.values(users)) await fixture.seedUser(id)
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [users.reviewer])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [users.reviewer])
  const university = randomUUID(), unit = randomUUID()
  await db.query("insert into universities(id,name,slug) values($1,'Compatibility university',$2)", [university, `compat-${university}`])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Compatibility faculty',$3,'faculty')", [unit, university, `compat-${unit}`])
  // Avoid the previous one-off global promotion in the legacy fixture.
  await db.exec('update billing_settings set first_free_group_claimed=true,enforce_group_payment=false')
  const approved = async ({ name = `Compatibility ${randomUUID()}`, specialty = 'Compatibility program' } = {}) => {
    const representative = randomUUID(), request = randomUUID()
    await fixture.seedUser(representative)
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,
      academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
      values($1,$2,'Compatibility representative',$3,$4,$5,$6,'compat_fixture','approved',$7,now())`,
    [request, representative, university, unit, specialty, name, users.reviewer])
    return { representative, request, name, specialty }
  }
  const create = async (options) => {
    const context = await approved(options)
    return { ...context, group: first(await asUser(context.representative, 'select xelay_create_study_group($1) as id', [context.request])).id }
  }
  const add = (context, user, status = 'accepted') => db.query(`insert into study_group_members(group_id,user_id,status,invited_by,accepted_at)
    values($1,$2,$3,$4,case when $3='accepted' then now() else null end)`, [context.group, user, status, context.representative])
  const state = async (context, user = context.representative) => first(await asUser(user, 'select xelay_group_billing_status($1) as value', [context.group])).value
  const trial = async (context) => first(await db.query('select * from group_trial_entitlements where group_id=$1', [context.group]))
  const service = (sql, params) => asUser(null, sql, params, { role: 'service_role' })
  const order = async (context) => first(await service("select xelay_create_billing_order($1,'group','live',$2,$3) as value",
    [context.representative, `compat-${randomUUID()}`, context.group])).value
  const settle = async (payment, status = 'Approved', fingerprint = randomUUID().replaceAll('-', '').repeat(2)) => first(await service(
    "select xelay_apply_billing_event($1,'live',$2,$3,750,'UAH') as value", [payment.order_reference, fingerprint, status])).value
  const expire = (context) => db.query(`with cutoff as(select clock_timestamp()-interval '1 second' as expires)
    update group_trial_entitlements set started_at=cutoff.expires-interval '168 hours',expires_at=cutoff.expires
    from cutoff where group_id=$1`, [context.group])
  const upload = async (context, user, bucket, path = pathFor(context.group, user, bucket)) => {
    // Storage creates a row without asking SELECT to expose a still-unattached
    // upload in the same statement. Verify its existence as the fixture owner.
    await asUser(user, `insert into storage.objects(bucket_id,name,owner,owner_id,metadata)
      values($1,$2,$3::uuid,($3::uuid)::text,'{"size":100,"mimetype":"image/png"}')`, [bucket, path, user])
    return db.query('select name from storage.objects where bucket_id=$1 and name=$2', [bucket, path])
  }
  const deleteObject = async (context, bucket, path) => {
    try { return (await asUser(context.representative, 'delete from storage.objects where bucket_id=$1 and name=$2 returning name', [bucket, path])).rows.length }
    catch (error) { if (error.code === '42501') return 0; throw error }
  }
  return { ...fixture, users, approved, create, add, state, trial, service, order, settle, expire, upload, deleteObject }
}

for (const through of ['202610030003', '202610030015']) {
  test(`trial 016 compatibility with schema through ${through}`, async (t) => {
    const h = await harness(through)
    t.after(() => h.close())
    const { db, asUser, users } = h
    const legacyUnlicensed = await h.create(), legacyLifetime = await h.create(), legacyAnnual = await h.create()
    await db.query("insert into group_entitlements(group_id,source) values($1,'admin_grant')", [legacyLifetime.group])
    await h.settle(await h.order(legacyAnnual))
    const oldLifetime = (await db.query('select * from group_entitlements order by group_id')).rows
    const oldAnnual = (await db.query('select * from group_annual_entitlements order by id')).rows
    let context, schedule, homework, subject, seminarSchedule, seminar, question, comment
    const files = {}

    await t.test('installs without unrelated security migrations and preserves legacy entitlements and access', async () => {
      await db.exec(migration)
      assert.deepEqual((await db.query('select * from group_entitlements order by group_id')).rows, oldLifetime)
      assert.deepEqual((await db.query('select * from group_annual_entitlements order by id')).rows, oldAnnual)
      assert.equal(first(await db.query('select count(*)::integer as count from group_trial_entitlements')).count, 0)
      assert.equal((await h.state(legacyUnlicensed)).can_edit, true)
      assert.equal((await h.state(legacyUnlicensed)).trial_used, false)
      assert.equal((await h.state(legacyLifetime)).is_lifetime, true)
      assert.equal((await h.state(legacyAnnual)).is_active, true)
      if (through === '202610030003') {
        assert.equal(first(await db.query("select to_regprocedure('xelay_private_guard_storage_delete()') is null as no_unrelated_guard")).no_unrelated_guard, true)
      }
    })

    await t.test('a new approved group receives 168 database hours; no client or service can reset the trial', async () => {
      const before = first(await db.query('select clock_timestamp() as value')).value
      context = await h.create()
      const after = first(await db.query('select clock_timestamp() as value')).value
      assert.deepEqual(first(await db.query(`select extract(epoch from(expires_at-started_at))::integer as seconds,
        started_at >= $2::timestamptz and started_at <= $3::timestamptz as server_generated
        from group_trial_entitlements where group_id=$1`, [context.group, before, after])), { seconds: 604800, server_generated: true })
      const stored = await h.trial(context)
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const user = role === 'authenticated' ? context.representative : null
        await denied(asUser(user, "update group_trial_entitlements set started_at=started_at+interval '1 day',expires_at=expires_at+interval '1 day' where group_id=$1", [context.group], { role }))
        await denied(asUser(user, 'delete from group_trial_entitlements where group_id=$1', [context.group], { role }))
        await denied(asUser(user, "insert into group_trial_entitlements values($1,clock_timestamp(),clock_timestamp()+interval '168 hours')", [context.group], { role }))
      }
      assert.deepEqual(await h.trial(context), stored)
      await denied(asUser(users.outsider, 'select xelay_group_billing_status($1)', [context.group]))
      assert.equal((await h.state(context)).source, 'trial')
      assert.equal((await h.state(context)).price, 750)
      assert.equal((await h.state(context)).enforcement_enabled, true)
    })

    await t.test('only the representative and an accepted deputy with the specified permission can write and upload', async () => {
      await h.add(context, users.ordinary)
      await h.add(context, users.deputy)
      await h.add(context, users.pending, 'pending')
      await asUser(context.representative, "select xelay_assign_study_group_deputy($1,$2,array['schedule'])", [context.group, users.deputy])
      for (const user of [users.ordinary, users.pending, users.outsider]) {
        await denied(asUser(user, 'select xelay_import_study_group_timetable($1,$2::jsonb)', [context.group, lessons()]))
        for (const bucket of ['xelay-homework-files', 'xelay-seminar-files', 'xelay-timetable-images']) await denied(h.upload(context, user, bucket))
      }
      assert.equal(first(await asUser(users.deputy, 'select xelay_import_study_group_timetable($1,$2::jsonb) as count', [context.group, lessons()])).count, 1)
      schedule = first(await db.query('select id from study_group_schedule where group_id=$1', [context.group])).id
      await denied(asUser(users.deputy, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
        values($1,$2,'2026-10-05','Forbidden homework',$3)`, [context.group, schedule, users.deputy]))
      await denied(h.upload(context, users.deputy, 'xelay-homework-files'))
      await denied(h.upload(context, users.deputy, 'xelay-seminar-files'))
      assert.equal((await h.upload(context, users.deputy, 'xelay-timetable-images')).rows.length, 1)
      homework = first(await asUser(context.representative, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
        values($1,$2,'2026-10-05','Preserved homework',$3) returning id`, [context.group, schedule, context.representative])).id
      const date = first(await db.query("select to_char(current_date+8,'YYYY-MM-DD') as date,extract(isodow from current_date+8)::integer as weekday"))
      subject = first(await asUser(context.representative, "select xelay_save_seminar_subject($1,null,'Compatibility seminar') as id", [context.group])).id
      seminarSchedule = first(await asUser(context.representative, "select xelay_save_seminar_schedule($1,null,$2,$3,'11:00','12:00',$4::date,$4::date) as id", [context.group, subject, date.weekday, date.date])).id
      seminar = first(await asUser(context.representative, "select xelay_save_seminar($1,null,$2,$3::date,'Compatibility seminar','','questions',$4::jsonb,'[]'::jsonb) as id",
        [context.group, seminarSchedule, date.date, JSON.stringify([{ body: 'Compatibility discussion', primary_capacity: 2 }])])).id
      question = first(await db.query('select id from study_group_seminar_questions where seminar_id=$1', [seminar])).id
      comment = first(await asUser(users.ordinary, "select xelay_add_seminar_comment($1,'Preserved comment') as id", [seminar])).id
      await asUser(users.ordinary, "select xelay_reserve_seminar($1,'primary',$2)", [seminar, question])
      for (const [kind, bucket] of [['homework', 'xelay-homework-files'], ['seminar', 'xelay-seminar-files'], ['timetable', 'xelay-timetable-images']]) {
        files[kind] = pathFor(context.group, context.representative, bucket)
        assert.equal((await h.upload(context, context.representative, bucket, files[kind])).rows.length, 1)
      }
      await asUser(context.representative, 'update study_group_homework set attachments=$2::jsonb where id=$1', [homework, attachment(files.homework)])
      await asUser(context.representative, "select xelay_update_seminar_resources($1,'[]'::jsonb,$2::jsonb)", [seminar, attachment(files.seminar)])
      await asUser(context.representative, "select xelay_set_study_group_timetable_photo($1,$2,'fixture.png','image/png',100)", [context.group, files.timetable])
      files.detachedSeminar = pathFor(context.group, context.representative, 'xelay-seminar-files')
      files.detachedTimetable = pathFor(context.group, context.representative)
      await h.upload(context, context.representative, 'xelay-seminar-files', files.detachedSeminar)
      await h.upload(context, context.representative, 'xelay-timetable-images', files.detachedTimetable)
    })

    await t.test('expiry denies academic insert/update/delete, participation, comments, resource edits and actual Storage uploads while keeping reads', async () => {
      await h.expire(context)
      const state = await h.state(context)
      assert.equal(state.is_active, false)
      assert.equal(state.can_edit, false)
      assert.equal(state.can_participate, false)
      assert.equal(state.enforcement_enabled, true)
      assert.equal(Number(state.remaining_seconds), 0)
      for (const user of [context.representative, users.deputy]) await denied(asUser(user, 'select xelay_import_study_group_timetable($1,$2::jsonb)', [context.group, lessons('Expired import')]))
      for (const [sql, params] of [
        ["update study_group_schedule set subject='Expired edit' where id=$1", [schedule]],
        ['delete from study_group_schedule where id=$1', [schedule]],
        ["insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,'2026-10-12','Expired insert',$3)", [context.group, schedule, context.representative]],
        ["update study_group_homework set body='Expired edit' where id=$1", [homework]],
        ['delete from study_group_homework where id=$1', [homework]],
      ]) await denied(asUser(context.representative, sql, params))
      for (const [sql, params, user = context.representative] of [
        ["select xelay_save_seminar_subject($1,null,'Expired subject')", [context.group]],
        ['select xelay_delete_seminar_subject($1)', [subject]],
        ['select xelay_delete_seminar_schedule($1)', [seminarSchedule]],
        ['select xelay_delete_seminar($1)', [seminar]],
        ["select xelay_update_seminar_resources($1,'[]'::jsonb,'[]'::jsonb)", [seminar]],
        ["select xelay_set_study_group_timetable_photo($1,null,null,null,null)", [context.group]],
        ["select xelay_add_seminar_comment($1,'Expired new comment')", [seminar], users.ordinary],
        ["select xelay_update_seminar_comment($1,'Expired comment edit')", [comment], users.ordinary],
        ['select xelay_delete_seminar_comment($1)', [comment], users.ordinary],
        ["select xelay_reserve_seminar($1,'supplement',$2)", [seminar, question], users.ordinary],
        ['select xelay_cancel_seminar_reservation($1)', [seminar], users.ordinary],
      ]) await denied(asUser(user, sql, params))
      for (const bucket of ['xelay-homework-files', 'xelay-seminar-files', 'xelay-timetable-images']) await denied(h.upload(context, context.representative, bucket))
      assert.equal(first(await asUser(users.ordinary, 'select subject from study_group_schedule where id=$1', [schedule])).subject, 'Compatibility lecture')
      assert.equal(first(await asUser(users.ordinary, 'select body from study_group_homework where id=$1', [homework])).body, 'Preserved homework')
      assert.equal(first(await asUser(users.ordinary, 'select body from study_group_seminar_comments where id=$1', [comment])).body, 'Preserved comment')
      assert.equal((await asUser(users.ordinary, 'select id from study_group_seminar_reservations where seminar_id=$1', [seminar])).rows.length, 1)
      for (const [kind, bucket] of [['homework', 'xelay-homework-files'], ['seminar', 'xelay-seminar-files'], ['timetable', 'xelay-timetable-images']]) {
        assert.equal((await asUser(users.ordinary, 'select name from storage.objects where bucket_id=$1 and name=$2', [bucket, files[kind]])).rows.length, 1)
      }
    })

    await t.test('expiry cannot delete attached files; owners can remove only detached seminar/timetable garbage', async () => {
      for (const [kind, bucket] of [['homework', 'xelay-homework-files'], ['seminar', 'xelay-seminar-files'], ['timetable', 'xelay-timetable-images']]) {
        assert.equal(await h.deleteObject(context, bucket, files[kind]), 0)
        assert.equal(first(await db.query('select count(*)::integer as count from storage.objects where bucket_id=$1 and name=$2', [bucket, files[kind]])).count, 1)
      }
      assert.equal(await h.deleteObject(context, 'xelay-seminar-files', files.detachedSeminar), 1)
      assert.equal(await h.deleteObject(context, 'xelay-timetable-images', files.detachedTimetable), 1)
    })

    await t.test('duplicate group creation and migration retries cannot reset an expired trial', async () => {
      const expired = await h.trial(context)
      assert.equal(first(await asUser(context.representative, 'select xelay_create_study_group($1) as id', [context.request])).id, context.group)
      const duplicate = await h.approved({ name: ` ${context.name.toUpperCase()} `, specialty: ` ${context.specialty.toUpperCase()} ` })
      await assert.rejects(asUser(duplicate.representative, 'select xelay_create_study_group($1)', [duplicate.request]), (error) => error.code === '23505')
      await db.exec(migration)
      assert.deepEqual(await h.trial(context), expired)
      assert.equal((await h.state(context)).is_active, false)
      assert.equal(first(await db.query('select count(*)::integer as count from study_groups where representative_request_id=$1', [duplicate.request])).count, 0)
    })

    await t.test('manual 750 UAH payment after expiry restores writes; early payment and refunds retain exactly the remaining trial and a full year', async () => {
      const payment = await h.order(context)
      assert.equal(Number(payment.amount), 750)
      assert.equal(payment.group_term_months, 12)
      await h.settle(payment)
      assert.equal((await h.state(context)).source, 'payment')
      assert.equal(first(await asUser(users.deputy, 'select xelay_import_study_group_timetable($1,$2::jsonb) as count', [context.group, lessons('Paid lecture')])).count, 1)
      const early = await h.create(), original = await h.trial(early)
      const earlyOrder = await h.order(early), fingerprint = 'c'.repeat(64)
      assert.equal((await h.settle(earlyOrder, 'Approved', fingerprint)).duplicate, false)
      assert.equal((await h.settle(earlyOrder, 'Approved', fingerprint)).duplicate, true)
      assert.deepEqual(first(await db.query(`select count(*)::integer as count,
        bool_and(a.valid_from=t.expires_at) as trial_floor,
        bool_and(a.valid_until=(((a.valid_from at time zone 'Europe/Kyiv')+interval '1 year') at time zone 'Europe/Kyiv')) as full_year
        from group_annual_entitlements a join group_trial_entitlements t using(group_id) where a.order_id=$1`, [earlyOrder.id])),
      { count: 1, trial_floor: true, full_year: true })
      await h.settle(earlyOrder, 'Refunded')
      assert.equal((await h.state(early)).source, 'trial')
      assert.equal((await h.state(early)).is_active, true)
      assert.deepEqual(await h.trial(early), original)
      await h.expire(early)
      assert.equal((await h.state(early)).is_active, false)
      assert.equal((await h.state(early)).can_participate, false)
      assert.deepEqual((await db.query('select * from group_entitlements order by group_id')).rows, oldLifetime)
      assert.equal((await h.state(legacyLifetime)).is_lifetime, true)
      assert.equal((await h.state(legacyAnnual)).is_active, true)
    })
  })
}

test('trial prerequisite failure is atomic and names a real missing contract', async (t) => {
  const h = await harness('202610030003')
  t.after(() => h.close())
  const context = await h.create()
  // Remove a required function only inside this disposable fixture.
  await h.db.exec('drop function xelay_can_upload_timetable_image(text) cascade')
  const before = (await h.db.query("select pg_get_functiondef('xelay_group_has_access(uuid)'::regprocedure) as definition")).rows
  await assert.rejects(h.db.exec(migration), (error) => error.code === 'P0001' && /xelay_can_upload_timetable_image/.test(error.message))
  await h.db.exec('rollback')
  assert.equal(first(await h.db.query("select to_regclass('group_trial_entitlements') is null as untouched")).untouched, true)
  assert.deepEqual((await h.db.query("select pg_get_functiondef('xelay_group_has_access(uuid)'::regprocedure) as definition")).rows, before)
  assert.equal(first(await h.db.query('select count(*)::integer as count from study_groups where id=$1', [context.group])).count, 1)
})
