// Actual installed timetable routines in isolated PostgreSQL; synthetic users,
// no network/provider/production account or conference is contacted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const first = result => result.rows[0]
const migration = await readFile(new URL('supabase/migrations/202610260003_schedule_conference_access.sql', root), 'utf8')

test('private meeting identifiers work without a URL across editing, import, weekend/first-shift copies and inherited updates', async t => {
  // News/legal/birthday changes fingerprint unrelated live-only routines. Load
  // the complete shared baseline plus every later timetable migration, without
  // weakening those unrelated production preflights to fit the local fixture.
  const fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id),provider text,identity_data jsonb default '{}');
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  for (const name of ['202610230003_timetable_teacher_name.sql', '202610230004_schedule_copy_first_shift_order.sql',
    '202610240007_schedule_copy_link_inheritance.sql', '202610240008_schedule_copy_link_repair.sql',
    '202610240009_schedule_copy_link_self_repair.sql']) await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'))
  const owner = randomUUID(), deputy = randomUUID(), student = randomUUID(), stranger = randomUUID(), admin = randomUUID()
  const university = randomUUID(), unit = randomUUID(), program = randomUUID()
  const usernames = new Map([owner, deputy, student, stranger, admin].map(id => [id, 'conf_' + id.replaceAll('-', '').slice(0, 16)]))
  await db.query("insert into universities(id,name,slug) values($1,'Conference fixture',$2)", [university, 'conference-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Conference faculty',$3,'faculty')", [unit, university, 'conference-' + unit])
  await db.query("insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name) values($1,$2,$3,'CONF','Conference program','Conference program')", [program, university, unit])
  for (const user of [owner, deputy, student, stranger, admin]) await seedUser(user, { username: usernames.get(user), university_id: university, academic_unit_id: unit, specialty_id: program, study_year: 1, experience: 'bachelor', categories: ['General'] })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [admin])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [admin])
  const request = randomUUID()
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    select $1,id,full_name,university_id,academic_unit_id,specialty,'CONF-1','conference_fixture','approved',id,now() from profiles where id=$2`, [request, owner])
  const group = first(await asUser(owner, 'select xelay_create_study_group($1) as id', [request])).id
  for (const user of [deputy, student]) {
    const invite = first(await asUser(owner, 'select xelay_invite_to_study_group($1,$2) as id', [group, usernames.get(user)])).id
    await asUser(user, 'select xelay_respond_study_group_invitation($1,true)', [invite])
  }
  await asUser(owner, "select xelay_assign_study_group_deputy($1,$2,array['schedule'])", [group, deputy])
  const original = first(await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_url,valid_from,valid_until,created_by)
    values($1,3,'08:00','09:20','Original unchanged','lecture','Original room','https://example.test/unchanged','2026-10-01','2030-12-31',$2) returning id`, [group, owner])).id
  const originalBefore = first(await db.query('select to_jsonb(s) as data from study_group_schedule s where id=$1', [original])).data
  const contracts = () => db.query(`select p.oid::regprocedure::text signature,p.proowner::text,p.proacl::text,p.proconfig,p.prosecdef,p.provolatile
    from pg_proc p where p.oid in('xelay_import_study_group_timetable(uuid,jsonb)'::regprocedure,
      'xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)'::regprocedure,
      'xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)'::regprocedure,
      'xelay_private_first_shift_projection(jsonb,jsonb)'::regprocedure,
      'xelay_private_schedule_copy_link_guard()'::regprocedure,'xelay_private_schedule_copy_link_propagate()'::regprocedure,
      'xelay_admin_schedule_copy_link_repair(uuid,boolean,text,uuid)'::regprocedure,
      'xelay_repair_my_schedule_copy_links(uuid,boolean,text,uuid)'::regprocedure) order by signature`).then(result => result.rows)
  const policies = () => db.query("select policyname,roles,cmd,qual,with_check from pg_policies where tablename='study_group_schedule' order by policyname").then(result => result.rows)
  const beforeContracts = await contracts(), beforePolicies = await policies()
  await db.exec(migration)
  let source, saturday, sunday
  const row = async id => first(await asUser(owner, 'select * from study_group_schedule where id=$1', [id]))
  const insert = (subject, id, code, actor = owner) => asUser(actor, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,conference_id,conference_access_code,valid_from,valid_until,created_by)
    values($1,1,'14:30','15:50',$2,'lecture','',$3,$4,'2026-10-12','2026-11-30',$5) returning id`, [group, subject, id, code, actor])
  const importRows = (rows, actor = owner) => asUser(actor, 'select xelay_import_study_group_timetable($1,$2::jsonb) as n', [group, JSON.stringify(rows)])
  const payload = (subject, extra = {}) => ({ weekday: 2, starts_at: '09:40', ends_at: '11:00', subject, lesson_type: 'practical', location: '', valid_from: '2026-10-13', valid_until: '2026-11-30', conference_id: '555 888 000', conference_access_code: 'zero0Case', ...extra })
  const copy = async (from, to, mode = 'original', preview = true, signature = null) => first(await asUser(owner,
    'select xelay_copy_study_group_schedule_day_with_time_mode($1,$2,$3,$4,$5,$6,$7::jsonb) as result',
    [group, from, to, preview, signature, mode, '[]'])).result

  await t.test('installation preserves old rows, RLS policies and all installed function access contracts', async () => {
    assert.deepEqual(await contracts(), beforeContracts); assert.deepEqual(await policies(), beforePolicies)
    const now = first(await db.query('select to_jsonb(s) as data from study_group_schedule s where id=$1', [original])).data
    assert.equal(now.conference_id, null); assert.equal(now.conference_access_code, null)
    delete now.conference_id; delete now.conference_access_code
    assert.deepEqual(now, originalBefore)
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(first(await db.query("select has_function_privilege($1,'xelay_normalize_schedule_conference_access()','execute') as allowed", [role])).allowed, false)
  })
  await t.test('editor saves ID and case-sensitive passcode with no online link; outer spaces trim', async () => {
    source = first(await insert('Conference only', '  123 456 7890  ', '  AbC-009  ')).id
    const saved = await row(source)
    assert.equal(saved.online_url, null); assert.equal(saved.conference_id, '123 456 7890'); assert.equal(saved.conference_access_code, 'AbC-009')
    assert.equal(first(await asUser(student, 'select conference_access_code from study_group_schedule where id=$1', [source])).conference_access_code, 'AbC-009')
    await asUser(deputy, 'update study_group_schedule set conference_access_code=$2 where id=$1', [source, 'DeputyUpdate'])
    assert.equal((await row(source)).conference_access_code, 'DeputyUpdate')
  })
  await t.test('existing group boundaries protect credentials and ordinary students cannot modify them', async () => {
    for (const actor of [stranger, admin]) {
      const visible = (await asUser(actor, 'select conference_id,conference_access_code from study_group_schedule where id=$1', [source], { aal: 'aal2' })).rows
      if (actor === stranger) assert.deepEqual(visible, [])
      // Administrators already have schedule read access; this migration keeps
      // that existing audience without granting them schedule editing powers.
      else assert.deepEqual(visible, [{ conference_id: '123 456 7890', conference_access_code: 'DeputyUpdate' }])
      await assert.rejects(insert('Unauthorized credential', '444', 'secret', actor))
      await assert.rejects(importRows([payload('Unauthorized import')], actor), /PERMISSION/)
    }
    await assert.rejects(asUser(stranger, 'select conference_id from study_group_schedule where id=$1', [source], { role: 'anon' }), error => error.code === '42501')
    await assert.rejects(insert('Student credential', '444', 'secret', student))
    const prior = (await row(source)).conference_access_code
    await asUser(student, 'update study_group_schedule set conference_access_code=$2 where id=$1', [source, 'No permission'])
    assert.equal((await row(source)).conference_access_code, prior)
  })
  await t.test('controls, directional spoofing and oversized credentials fail atomically', async () => {
    for (const invalid of ['bad\ncode', 'bad\tcode', 'bad\u202Ecode', 'bad\u0085code', 'x'.repeat(121)]) {
      await assert.rejects(insert('Invalid credential', invalid, 'ok'), /CONFERENCE_ACCESS|conference_id_check/)
      await assert.rejects(insert('Invalid passcode', 'ok', invalid), /CONFERENCE_ACCESS|conference_access_code_check/)
    }
    await asUser(owner, 'update study_group_schedule set conference_id=$2 where id=$1', [source, '   '])
    assert.equal((await row(source)).conference_id, null)
    await asUser(owner, 'update study_group_schedule set conference_id=$2 where id=$1', [source, '123 456 7890'])
  })
  await t.test('batch import supports credential-only lessons, rejects non-text/unknown fields and rolls back a bad batch', async () => {
    assert.equal(first(await importRows([payload('Imported conference')])).n, 1)
    const saved = first(await asUser(owner, "select * from study_group_schedule where group_id=$1 and subject='Imported conference'", [group]))
    assert.equal(saved.conference_id, '555 888 000'); assert.equal(saved.conference_access_code, 'zero0Case'); assert.equal(saved.online_url, null)
    await assert.rejects(importRows([payload('Imported conference')]), /DUPLICATE_LESSON/)
    await assert.rejects(importRows([payload('Wrong type', { conference_id: 1234 })]), /INVALID_INPUT/)
    await assert.rejects(importRows([payload('Unknown key', { conference_key: 'Nope' })]), /INVALID_INPUT/)
    await assert.rejects(importRows([payload('Rolled back valid'), payload('Rolled back invalid', { conference_access_code: '\u202Ebad' })]), /CONFERENCE_ACCESS/)
    assert.equal(first(await db.query("select count(*)::int n from study_group_schedule where subject like 'Rolled back%' ")).n, 0)
  })
  await t.test('weekend copies retain ID/code and live inheritance even without URLs', async () => {
    const preview = await copy('2026-10-12', '2026-10-17')
    assert.equal(preview.lessons[0].conference_id, '123 456 7890')
    await copy('2026-10-12', '2026-10-17', 'original', false, preview.source_signature)
    saturday = first(await asUser(owner, "select * from study_group_schedule where group_id=$1 and valid_from='2026-10-17' and subject='Conference only'", [group]))
    assert.equal(saturday.copied_from_schedule_id, source); assert.equal(saturday.inherit_source_links, true)
    assert.equal(saturday.conference_id, '123 456 7890'); assert.equal(saturday.conference_access_code, 'DeputyUpdate')
    await asUser(owner, 'update study_group_schedule set conference_access_code=$2 where id=$1', [source, 'NewPassword'])
    assert.equal((await row(saturday.id)).conference_access_code, 'NewPassword'); assert.equal((await row(saturday.id)).inherit_source_links, true)
  })
  await t.test('first-shift copy starts at 08:00 and includes access credentials in the preview/signature', async () => {
    const preview = await copy('2026-10-12', '2026-10-18', 'first_shift')
    assert.equal(preview.lessons[0].starts_at, '08:00:00'); assert.equal(preview.lessons[0].conference_access_code, 'NewPassword')
    await copy('2026-10-12', '2026-10-18', 'first_shift', false, preview.source_signature)
    sunday = first(await asUser(owner, "select * from study_group_schedule where group_id=$1 and valid_from='2026-10-18' and subject='Conference only'", [group]))
    assert.equal(sunday.starts_at, '08:00:00'); assert.equal(sunday.conference_id, '123 456 7890'); assert.equal(sunday.conference_access_code, 'NewPassword')
    const stale = await copy('2026-10-12', '2026-10-24')
    await asUser(owner, 'update study_group_schedule set conference_id=$2 where id=$1', [source, 'ChangedMeeting'])
    await assert.rejects(copy('2026-10-12', '2026-10-24', 'original', false, stale.source_signature), /SOURCE_CHANGED/)
  })
  await t.test('editing a copied code opts out; further source changes preserve that explicit choice; rebind refreshes all access data', async () => {
    await asUser(owner, 'update study_group_schedule set conference_access_code=$2 where id=$1', [saturday.id, 'PrivateSaturday'])
    assert.equal((await row(saturday.id)).inherit_source_links, false)
    await asUser(owner, 'update study_group_schedule set conference_access_code=$2 where id=$1', [source, 'ParentFinal'])
    assert.equal((await row(saturday.id)).conference_access_code, 'PrivateSaturday')
    assert.equal((await row(sunday.id)).conference_access_code, 'ParentFinal')
    await asUser(owner, 'update study_group_schedule set inherit_source_links=true where id=$1', [saturday.id])
    assert.equal((await row(saturday.id)).conference_access_code, 'ParentFinal'); assert.equal((await row(saturday.id)).conference_id, 'ChangedMeeting')
  })
  await t.test('reviewed weekend repair inherits a credential-only source and leaves manually entered IDs/codes alone', async () => {
    const repairedSource = first(await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,conference_id,conference_access_code,valid_from,valid_until,created_by)
      values($1,1,'11:20','12:40','Repair access','lecture','','repair-555','RepairCase0','2030-04-08','2030-04-30',$2) returning id`, [group, owner])).id
    const targets = []
    for (const [date, id, code] of [['2030-04-13', null, null], ['2030-04-20', 'Manual ID', null], ['2030-04-27', null, 'Manual passcode']]) {
      targets.push(first(await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,conference_id,conference_access_code,valid_from,valid_until,created_by)
        values($1,6,'11:20','12:40','Repair access','lecture','',$2,$3,$4,$4,$5) returning id`, [group, id, code, date, owner])).id)
    }
    const preview = first(await asUser(owner, 'select xelay_repair_my_schedule_copy_links($1,true,null,$2) as data', [group, owner])).data
    assert.equal(preview.count, 1); assert.equal(preview.pairs[0].target_id, targets[0])
    const result = first(await asUser(owner, 'select xelay_repair_my_schedule_copy_links($1,false,$2,$3) as data', [group, preview.signature, owner])).data
    assert.equal(result.repaired, 1)
    assert.equal((await row(targets[0])).copied_from_schedule_id, repairedSource)
    assert.equal((await row(targets[0])).conference_id, 'repair-555'); assert.equal((await row(targets[0])).conference_access_code, 'RepairCase0')
    assert.equal((await row(targets[1])).conference_id, 'Manual ID'); assert.equal((await row(targets[1])).copied_from_schedule_id, null)
    assert.equal((await row(targets[2])).conference_access_code, 'Manual passcode'); assert.equal((await row(targets[2])).copied_from_schedule_id, null)
  })
  await t.test('credentials never allow a cross-group inherited source or expose access through copy RPCs', async () => {
    await assert.rejects(asUser(stranger, 'select xelay_copy_study_group_schedule_day($1,$2,$3,true,null)', [group, '2026-10-12', '2026-10-31']), /PERMISSION/)
    const otherRequest = randomUUID()
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
      select $1,id,full_name,university_id,academic_unit_id,specialty,'CONF-OTHER','conference_fixture','approved',id,now() from profiles where id=$2`, [otherRequest, stranger])
    const otherGroup = first(await asUser(stranger, 'select xelay_create_study_group($1) as id', [otherRequest])).id
    await assert.rejects(asUser(stranger, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,valid_from,valid_until,created_by,copied_from_schedule_id,inherit_source_links)
      values($1,6,'08:00','09:20','Conference only','lecture','','2026-10-31','2026-10-31',$2,$3,true)`, [otherGroup, stranger, source]), /COPY_SOURCE_INVALID/)
  })
})
