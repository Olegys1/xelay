// Isolated PostgreSQL and fictional groups only. No provider or production use.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const first = result => result.rows[0]
const migration = await readFile(new URL('supabase/migrations/202610260005_schedule_copy_custom_times.sql', root), 'utf8')

test('custom copy times require signed previews and preserve private Saturday settings, old copies and academic data', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id),provider text,identity_data jsonb default '{}');
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  for (const file of ['202610230003_timetable_teacher_name.sql', '202610230004_schedule_copy_first_shift_order.sql',
    '202610240007_schedule_copy_link_inheritance.sql', '202610240008_schedule_copy_link_repair.sql',
    '202610240009_schedule_copy_link_self_repair.sql', '202610260003_schedule_conference_access.sql']) {
    await db.exec(await readFile(new URL('supabase/migrations/' + file, root), 'utf8'))
  }
  const owner = randomUUID(), deputy = randomUUID(), member = randomUUID(), outsider = randomUUID(), admin = randomUUID()
  const university = randomUUID(), unit = randomUUID(), program = randomUUID()
  await db.query("insert into universities(id,name,slug) values($1,'Custom time fixture',$2)", [university, 'custom-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Custom faculty',$3,'faculty')", [unit, university, 'custom-' + unit])
  await db.query("insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name) values($1,$2,$3,'CUSTOM','Custom program','Custom program')", [program, university, unit])
  const username = id => 'custom_' + id.replaceAll('-', '').slice(0, 16)
  for (const id of [owner, deputy, member, outsider, admin]) await seedUser(id, { username: username(id), university_id: university, academic_unit_id: unit, specialty_id: program, study_year: 1, experience: 'bachelor', categories: ['General'] })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [admin])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [admin])
  const request = randomUUID()
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    select $1,id,full_name,university_id,academic_unit_id,specialty,'CUSTOM-1','custom_fixture','approved',id,now() from profiles where id=$2`, [request, owner])
  const group = first(await asUser(owner, 'select xelay_create_study_group($1) id', [request])).id
  for (const id of [deputy, member]) {
    const invitation = first(await asUser(owner, 'select xelay_invite_to_study_group($1,$2) id', [group, username(id)])).id
    await asUser(id, 'select xelay_respond_study_group_invitation($1,true)', [invitation])
  }
  await asUser(owner, "select xelay_assign_study_group_deputy($1,$2,array['schedule'])", [group, deputy])
  const insert = async (subject, weekday = 1, starts = '14:30', ends = '15:50', targetGroup = group, actor = owner) => first(await asUser(actor,
    `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,teacher_name,online_url,conference_id,conference_access_code,valid_from,valid_until,created_by)
      values($1,$2,$3,$4,$5,'lecture','Custom room','Fictional teacher','https://example.test/join','meeting-123','CaseSensitive0','2026-10-12','2027-12-31',$6) returning id`,
    [targetGroup, weekday, starts, ends, subject, actor])).id
  const a = await insert('Custom source A'), b = await insert('Custom source B', 1, '16:10', '17:30')
  await insert('Single late source', 2, '18:00', '19:00')
  const content = () => db.query(`select 'homework' kind,to_jsonb(t) value from study_group_homework t union all select 'seminar',to_jsonb(t) from study_group_seminars t`).then(result => result.rows)
  const sources = () => db.query('select to_jsonb(s) value from study_group_schedule s where group_id=$1 and weekday between 1 and 5 order by id', [group]).then(result => result.rows)
  const contracts = () => db.query(`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) body,p.proowner,p.proacl::text,p.proconfig
    from pg_proc p where p.oid in('xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)'::regprocedure,
      'xelay_copy_study_group_schedule_sequence(uuid,jsonb,boolean,text)'::regprocedure,
      'xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)'::regprocedure,
      'xelay_copy_study_group_schedule_sequence_with_time_mode(uuid,jsonb,boolean,text,text,jsonb)'::regprocedure,
      'xelay_private_first_shift_projection(jsonb,jsonb)'::regprocedure) order by signature`).then(result => result.rows)
  const initial = { content: await content(), sources: await sources(), contracts: await contracts() }
  await t.test('browser-style CRLF migration input installs without weakening legacy source guards', async () => {
    const pastedMigration = migration.replace(/\r?\n/g, '\r\n')
    assert.ok(pastedMigration.includes('\r\n'))
    await db.exec(pastedMigration)
    assert.deepEqual(await contracts(), initial.contracts)
    assert.ok(first(await db.query("select to_regprocedure('public.xelay_copy_study_group_schedule_sequence_with_custom_times(uuid,jsonb,boolean,text,text,jsonb,text,boolean)') is not null installed")).installed)
  })
  const call = (user, sql, args = [], options = {}) => asUser(user, sql, args, options).then(first).then(row => row.data)
  const settings = (user = owner, targetGroup = group) => call(user, 'select xelay_schedule_copy_settings($1) data', [targetGroup])
  const day = ({ source = '2026-10-12', target = '2026-10-17', preview = true, signature = null, start = '08:30', remember = false, assignments = [], user = owner, mode = 'first_shift', targetGroup = group } = {}) => call(user,
    'select xelay_copy_study_group_schedule_day_with_custom_times($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) data',
    [targetGroup, source, target, preview, signature, mode, JSON.stringify(assignments), start, remember])
  const sequence = (pairs, { preview = true, signature = null, start = '08:30', remember = false, assignments = {}, user = owner } = {}) => call(user,
    'select xelay_copy_study_group_schedule_sequence_with_custom_times($1,$2::jsonb,$3,$4,$5,$6::jsonb,$7,$8) data',
    [group, JSON.stringify(pairs), preview, signature, 'first_shift', JSON.stringify(assignments), start, remember])
  const rowsOn = date => db.query('select * from study_group_schedule where group_id=$1 and valid_from=$2::date and valid_until=$2::date order by starts_at,subject', [group, date]).then(result => result.rows)
  const overrides = (one = '09:00', oneEnd = '10:00', two = '10:15', twoEnd = '11:35') => [
    { source_starts_at: '14:30', source_ends_at: '15:50', target_lesson_number: 1, target_starts_at: one, target_ends_at: oneEnd },
    { source_starts_at: '16:10', source_ends_at: '17:30', target_lesson_number: 2, target_starts_at: two, target_ends_at: twoEnd },
  ]

  await t.test('migration keeps old routines, sources and academic content unchanged and creates no settings', async () => {
    assert.deepEqual(await contracts(), initial.contracts); assert.deepEqual(await sources(), initial.sources); assert.deepEqual(await content(), initial.content)
    assert.deepEqual(await settings(), { first_shift_start: '08:00', revision: 0 })
    assert.equal(first(await db.query('select count(*)::int n from study_group_schedule_copy_settings')).n, 0)
  })
  await t.test('only actual schedule editors may read defaults or call custom copy, with no direct table/helper access', async () => {
    assert.deepEqual(await settings(deputy), { first_shift_start: '08:00', revision: 0 })
    for (const user of [member, outsider, admin]) {
      await assert.rejects(settings(user), /PERMISSION|FORBIDDEN/); await assert.rejects(day({ user }), /PERMISSION|FORBIDDEN/)
      await assert.rejects(asUser(user, 'select * from study_group_schedule_copy_settings'), error => error.code === '42501')
    }
    await assert.rejects(asUser(owner, "select xelay_private_custom_shift_projection('[]','[]','08:00')"), error => error.code === '42501')
    await assert.rejects(asUser(owner, 'select xelay_schedule_copy_settings($1)', [group], { role: 'anon' }), error => error.code === '42501')
  })
  await t.test('08:30 offsets only used slots, preview is read-only even with remember enabled', async () => {
    const approval = await day({ remember: true })
    assert.deepEqual(approval.lessons.map(row => [row.starts_at, row.ends_at]), [['08:30:00', '09:50:00'], ['10:10:00', '11:30:00']])
    assert.equal(approval.first_shift_start, '08:30'); assert.equal(approval.settings_revision, 0)
    assert.equal(approval.slot_assignments[0].target_starts_at, '08:30:00')
    assert.deepEqual(await settings(), { first_shift_start: '08:00', revision: 0 }); assert.equal((await rowsOn('2026-10-17')).length, 0)
    const late = await day({ source: '2026-10-13', target: '2026-10-18', start: '22:00' })
    assert.equal(late.lessons[0].starts_at, '22:00:00'); assert.equal(late.lessons[0].ends_at, '23:20:00')
    await assert.rejects(day({ start: '23:00' }), /CUSTOM_TIMES_INVALID/)
  })
  await t.test('custom intervals are bijective, minute-exact, bounded, complete and non-overlapping', async () => {
    const plan = overrides()
    const approval = await day({ assignments: plan })
    assert.deepEqual(approval.lessons.map(row => [row.starts_at, row.ends_at]), [['09:00:00', '10:00:00'], ['10:15:00', '11:35:00']])
    for (const bad of [plan.slice(0, 1), [plan[0], plan[0]], overrides('09:00', '10:30', '10:15'), overrides('09:00', '08:00'), overrides('24:00'), overrides('9:00'), overrides('09:00:00'),
      [{ ...plan[0], target_ends_at: undefined }, plan[1]], [{ ...plan[0], unknown: true }, plan[1]], [{ ...plan[0], source_starts_at: '14:31' }, plan[1]], [{ ...plan[0], target_lesson_number: 2 }, plan[1]]]) {
      await assert.rejects(day({ assignments: bad }), /CUSTOM_TIMES_INVALID|SLOT_ASSIGNMENTS_INVALID/)
    }
    const lateCustom = await day({ source: '2026-10-13', target: '2026-10-18', start: '23:00', assignments: [
      { source_starts_at: '18:00', source_ends_at: '19:00', target_lesson_number: 1, target_starts_at: '23:00', target_ends_at: '23:45' },
    ] })
    assert.equal(lateCustom.lessons[0].ends_at, '23:45:00')
  })
  await t.test('changed start, per-slot plan, remember flag or missing signature cannot confirm an unreviewed plan', async () => {
    const approval = await day({ assignments: overrides(), remember: true })
    for (const patch of [{ start: '08:00' }, { assignments: overrides('09:10') }, { remember: false }, { signature: null }]) {
      await assert.rejects(day({ preview: false, signature: approval.source_signature, assignments: overrides(), remember: true, ...patch }), /SOURCE_CHANGED/)
    }
    assert.equal((await rowsOn('2026-10-17')).length, 0); assert.equal((await settings()).revision, 0)
  })
  await t.test('successful confirmed Saturday copy stores shared start once; exact retries skip copies without another revision', async () => {
    const approval = await day({ assignments: overrides(), remember: true })
    const done = await day({ preview: false, signature: approval.source_signature, assignments: overrides(), remember: true })
    assert.equal(done.copied, 2); assert.equal(done.settings_revision, 1)
    assert.deepEqual(await settings(deputy), { first_shift_start: '08:30', revision: 1 })
    const replay = await day({ preview: false, signature: approval.source_signature, assignments: overrides(), remember: true })
    assert.equal(replay.copied, 0); assert.equal(replay.skipped, 2); assert.equal(replay.settings_revision, 1)
    const rows = await rowsOn('2026-10-17')
    assert.equal(rows[0].copied_from_schedule_id, a); assert.equal(rows[1].copied_from_schedule_id, b)
    assert.equal(rows[0].conference_access_code, 'CaseSensitive0'); assert.equal(rows[0].teacher_name, 'Fictional teacher'); assert.equal(rows[0].inherit_source_links, true)
  })
  await t.test('source/credential changes invalidate even the remembered retry receipt', async () => {
    const approval = await day({ target: '2026-10-24', remember: true, start: '09:00' })
    await day({ target: '2026-10-24', remember: true, start: '09:00', preview: false, signature: approval.source_signature })
    await asUser(owner, 'update study_group_schedule set conference_access_code=$2 where id=$1', [a, 'FreshCredentials'])
    await assert.rejects(day({ target: '2026-10-24', remember: true, start: '09:00', preview: false, signature: approval.source_signature }), /SOURCE_CHANGED/)
    assert.equal((await rowsOn('2026-10-17'))[0].conference_access_code, 'FreshCredentials')
    assert.equal((await settings()).revision, 2)
  })
  await t.test('settings changed by another editor invalidate an older preview; stale receipt cannot roll them back', async () => {
    const stale = await day({ target: '2026-10-31', remember: true, start: '10:00' })
    const other = await day({ target: '2026-11-07', remember: true, start: '09:30', user: deputy })
    await day({ target: '2026-11-07', remember: true, start: '09:30', user: deputy, preview: false, signature: other.source_signature })
    await assert.rejects(day({ target: '2026-10-31', remember: true, start: '10:00', preview: false, signature: stale.source_signature }), /SOURCE_CHANGED/)
    assert.equal((await settings()).first_shift_start, '09:30'); assert.equal((await rowsOn('2026-10-31')).length, 0)
  })
  await t.test('Sunday or mixed-weekend sequences cannot save the Saturday setting', async () => {
    await assert.rejects(day({ target: '2026-11-01', remember: true }), /CUSTOM_TIMES_INVALID/)
    await assert.rejects(sequence([{ source_date: '2026-10-12', target_date: '2026-11-01' }], { remember: true }), /CUSTOM_TIMES_INVALID/)
    const sunday = await day({ target: '2026-11-01', start: '08:00' })
    await day({ target: '2026-11-01', start: '08:00', preview: false, signature: sunday.source_signature })
    assert.equal((await rowsOn('2026-11-01'))[0].starts_at, '08:00:00'); assert.equal((await settings()).first_shift_start, '09:30')
  })
  await t.test('sequences edit repeated source dates independently by target date, commit atomically and preserve retry idempotency', async () => {
    const pairs = [{ source_date: '2026-10-12', target_date: '2026-11-14' }, { source_date: '2026-10-12', target_date: '2026-11-21' }]
    const assignments = { '2026-11-14': overrides('08:45', '09:45', '10:00', '11:00'), '2026-11-21': overrides('09:00', '10:00', '10:30', '11:50') }
    const approval = await sequence(pairs, { assignments, remember: true, start: '08:45' })
    assert.equal(approval.days[0].lessons[0].starts_at, '08:45:00'); assert.equal(approval.days[1].lessons[0].starts_at, '09:00:00')
    await assert.rejects(sequence(pairs, { assignments: { '2026-10-12': overrides() } }), /SLOT_ASSIGNMENTS_INVALID/)
    const done = await sequence(pairs, { assignments, remember: true, start: '08:45', preview: false, signature: approval.source_signature })
    assert.equal(done.copied, 4); assert.equal((await settings()).first_shift_start, '08:45')
    const replay = await sequence(pairs, { assignments, remember: true, start: '08:45', preview: false, signature: approval.source_signature })
    assert.equal(replay.copied, 0); assert.equal(replay.skipped, 4)
  })
  await t.test('destination conflict after preview rolls back all copies and setting changes, including sequence failures', async () => {
    const pairs = [{ source_date: '2026-10-12', target_date: '2026-11-28' }, { source_date: '2026-10-12', target_date: '2026-12-05' }]
    const approval = await sequence(pairs, { remember: true, start: '10:00' })
    await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,valid_from,valid_until,created_by)
      values($1,6,'10:30','11:00','Conflicting manual lesson','lecture','','2026-12-05','2026-12-05',$2)`, [group, owner])
    const before = await settings()
    await assert.rejects(sequence(pairs, { remember: true, start: '10:00', preview: false, signature: approval.source_signature }), /COPY_CONFLICT/)
    assert.deepEqual(await settings(), before); assert.equal((await rowsOn('2026-11-28')).length, 0)
    assert.equal((await rowsOn('2026-12-05')).length, 1)
  })
  await t.test('old first-shift RPC still starts at 08:00 and original-time RPC remains unchanged despite shared setting', async () => {
    const legacy = await call(owner, 'select xelay_copy_study_group_schedule_day_with_time_mode($1,$2,$3,true,null,$4,$5::jsonb) data', [group, '2026-10-12', '2026-12-12', 'first_shift', '[]'])
    assert.equal(legacy.lessons[0].starts_at, '08:00:00')
    const original = await call(owner, 'select xelay_copy_study_group_schedule_day($1,$2,$3,true,null) data', [group, '2026-10-12', '2026-12-12'])
    assert.equal(original.lessons[0].starts_at, '14:30:00')
    assert.deepEqual(await contracts(), initial.contracts); assert.deepEqual(await content(), initial.content)
  })
  await t.test('failure while persisting the remembered default rolls back already inserted lessons', async () => {
    const approval = await day({ target: '2026-12-19', remember: true, start: '10:15' })
    const before = await settings()
    await db.exec(`create function pg_temp.reject_custom_setting() returns trigger language plpgsql as $$begin raise exception 'Synthetic setting failure';end$$;
      create trigger synthetic_reject_setting before insert or update on study_group_schedule_copy_settings for each row execute function pg_temp.reject_custom_setting();`)
    try {
      await assert.rejects(day({ target: '2026-12-19', remember: true, start: '10:15', preview: false, signature: approval.source_signature }), /Synthetic setting failure/)
      assert.equal((await rowsOn('2026-12-19')).length, 0); assert.deepEqual(await settings(), before)
    } finally { await db.exec('drop trigger synthetic_reject_setting on study_group_schedule_copy_settings') }
  })
})
