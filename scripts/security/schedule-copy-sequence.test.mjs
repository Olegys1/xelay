// Isolated PostgreSQL, synthetic groups and local migration files only.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const first = result => result.rows[0]
const day = (date, offset) => new Date(Date.parse(date + 'T00:00:00Z') + offset * 86400000).toISOString().slice(0, 10)

test('atomic weekday-to-weekend sequences preserve permissions, source occurrences and existing content', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610150012', beforeMigrationsSql: `
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const university = randomUUID(), unit = randomUUID(), specialty = randomUUID()
  const owner = randomUUID(), deputy = randomUUID(), member = randomUUID(), outsider = randomUUID()
  const homeworkDeputy = randomUUID(), pending = randomUUID(), admin = randomUUID()
  const username = id => 'seq_' + id.replaceAll('-', '').slice(0, 16)
  await db.query("insert into universities(id,name,slug) values($1,'Sequence fixture university',$2)", [university, 'seq-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Sequence fixture faculty',$3,'faculty')", [unit, university, 'seq-' + unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'SEQ','Sequence fixture program','Sequence fixture program')`, [specialty, university, unit])
  for (const id of [owner, deputy, member, outsider, homeworkDeputy, pending, admin]) await seedUser(id, {
    username: username(id), university_id: university, academic_unit_id: unit, specialty_id: specialty,
    study_year: 1, experience: 'bachelor', categories: ['General'],
  })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [admin])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [admin])
  const request = randomUUID()
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
    specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    select $1,id,full_name,$3,$4,specialty,'SEQ-1','seq_fixture','approved',id,now() from profiles where id=$2`,
  [request, owner, university, unit])
  const group = first(await asUser(owner, 'select xelay_create_study_group($1) as id', [request])).id
  for (const user of [deputy, member, homeworkDeputy, pending]) {
    const invite = first(await asUser(owner, 'select xelay_invite_to_study_group($1,$2) as id', [group, username(user)])).id
    if (user !== pending) await asUser(user, 'select xelay_respond_study_group_invitation($1,true)', [invite])
  }
  await asUser(owner, "select xelay_assign_study_group_deputy($1,$2,array['schedule'])", [group, deputy])
  await asUser(owner, "select xelay_assign_study_group_deputy($1,$2,array['homework'])", [group, homeworkDeputy])
  const insertLesson = async ({ subject, weekday = 1, from = '2026-10-12', until = '2026-11-30',
    starts = '08:00', ends = '09:20', pattern = 'every', anchor = null }) => first(await asUser(owner,
    `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,
      online_url,online_url_secondary,online_url_label,online_url_secondary_label,valid_from,valid_until,
      week_pattern,week_anchor_date,created_by)
    values($1,$2,$3,$4,$5,'lecture','Room 1','https://example.test/lecture','https://example.test/seminar',
      'Лекція','Семінар',$6,$7,$8,$9,$10) returning id`,
    [group, weekday, starts, ends, subject, from, until, pattern, anchor, owner])).id
  const weekly = await insertLesson({ subject: 'Weekly economics' })
  const upper = await insertLesson({ subject: 'Upper mathematics', starts: '09:40', ends: '11:00', pattern: 'upper', anchor: '2026-10-12' })
  await insertLesson({ subject: 'Lower mathematics', starts: '09:40', ends: '11:00', pattern: 'lower', anchor: '2026-10-12' })
  await asUser(owner, "select xelay_cancel_study_group_schedule_occurrence($1,$2,'2026-10-19')", [group, weekly])
  const homework = first(await asUser(owner, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,url,created_by)
    values($1,$2,'2026-10-12','Preserved source homework','https://example.test/homework',$3) returning id`, [group, weekly, owner])).id
  const homeworkBefore = first(await db.query('select to_jsonb(h) as value from study_group_homework h where id=$1', [homework])).value
  const policies = async () => (await db.query(`select schemaname,tablename,policyname,roles,cmd,qual,with_check
    from pg_policies where (schemaname='public' and tablename in('study_group_schedule','study_group_homework','study_group_members'))
      or (schemaname='storage' and tablename='objects') order by schemaname,tablename,policyname`)).rows
  const policiesBefore = await policies()
  const singleBefore = first(await db.query(`select pg_get_functiondef(oid) as body,proacl::text as acl from pg_proc
    where oid='public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)'::regprocedure`))
  const migration = await readFile(new URL('supabase/migrations/202610160001_schedule_copy_sequence.sql', root), 'utf8')
  await db.exec(migration)
  const sequence = async (pairs, preview = true, signature = null, user = owner, options = {}) => first(await asUser(user,
    'select xelay_copy_study_group_schedule_sequence($1,$2::jsonb,$3,$4) as value',
    [group, JSON.stringify(pairs), preview, signature], options)).value
  const pairs = Array.from({ length: 6 }, (_, index) => ({ source_date: day('2026-10-12', index * 7), target_date: day('2026-10-17', index * 7) }))
  const rowsOn = async dates => (await db.query('select to_jsonb(s) as value from study_group_schedule s where group_id=$1 and valid_from=any($2::date[]) and valid_from=valid_until order by valid_from,starts_at', [group, dates])).rows.map(row => row.value)
  let sixPreview

  await t.test('preview of six Saturdays follows source parity, exclusions and both named links without writes', async () => {
    sixPreview = await sequence(pairs)
    assert.equal(sixPreview.copied, 11)
    assert.equal(sixPreview.skipped, 0)
    assert.match(sixPreview.source_signature, /^[a-f0-9]{32}$/)
    assert.deepEqual(sixPreview.days.map(row => row.target_date), pairs.map(pair => pair.target_date))
    assert.deepEqual(sixPreview.days.map(row => row.lessons.length), [2, 1, 2, 2, 2, 2])
    assert.ok(sixPreview.days[0].lessons.some(row => row.subject === 'Upper mathematics'))
    assert.deepEqual(sixPreview.days[1].lessons.map(row => row.subject), ['Lower mathematics'])
    assert.ok(sixPreview.days.every(row => row.lessons.every(lesson => lesson.online_url_label === 'Лекція' && lesson.online_url_secondary_label === 'Семінар')))
    assert.deepEqual(await rowsOn(pairs.map(pair => pair.target_date)), [])
  })
  await t.test('one confirmation creates all six one-off days without copying any homework', async () => {
    const result = await sequence(pairs, false, sixPreview.source_signature)
    assert.equal(result.copied, 11)
    assert.equal(result.skipped, 0)
    assert.equal(result.source_signature, sixPreview.source_signature)
    assert.ok(result.days.every(row => row.lessons.length === 0))
    const rows = await rowsOn(pairs.map(pair => pair.target_date))
    assert.equal(rows.length, 11)
    assert.ok(rows.every(row => row.week_pattern === 'every' && row.week_anchor_date === null && row.excluded_dates.length === 0))
    assert.ok(rows.every(row => row.online_url_label === 'Лекція' && row.online_url_secondary_label === 'Семінар'))
    assert.deepEqual(first(await db.query('select to_jsonb(h) as value from study_group_homework h where id=$1', [homework])).value, homeworkBefore)
    assert.equal(first(await db.query('select count(*)::int as count from study_group_homework where group_id=$1', [group])).count, 1)
  })
  await t.test('retry skips exact copies and cannot duplicate any target lesson', async () => {
    const result = await sequence(pairs, false, sixPreview.source_signature)
    assert.equal(result.copied, 0)
    assert.equal(result.skipped, 11)
    assert.equal((await rowsOn(pairs.map(pair => pair.target_date))).length, 11)
  })
  await t.test('approved schedule deputy can copy Sunday while all other roles remain denied', async () => {
    const sunday = [{ source_date: '2026-11-16', target_date: '2026-11-22' }]
    const preview = await sequence(sunday, true, null, deputy)
    assert.equal((await sequence(sunday, false, preview.source_signature, deputy)).copied, 2)
    for (const user of [member, homeworkDeputy, pending, outsider, admin]) await assert.rejects(
      sequence(sunday, true, null, user, { aal: user === admin ? 'aal2' : 'aal1' }), error => error.code === '42501')
    for (const role of ['anon', 'service_role']) await assert.rejects(sequence(sunday, true, null, null, { role }), error => error.code === '42501')
    await assert.rejects(db.query('select xelay_copy_study_group_schedule_sequence($1,$2::jsonb,true,null)', [group, JSON.stringify(sunday)]), error => error.code === '42501')
    assert.equal((await asUser(outsider, 'select id from study_group_schedule where group_id=$1', [group])).rows.length, 0)
  })
  await t.test('changed pair selection and missing approvals fail before any insertion', async () => {
    const changed = [{ source_date: '2026-10-12', target_date: '2026-10-18' }, ...pairs.slice(1)]
    await assert.rejects(sequence(changed, false, sixPreview.source_signature), /COPY_SOURCE_CHANGED/)
    await assert.rejects(sequence(changed, false), /COPY_SOURCE_CHANGED/)
    assert.deepEqual(await rowsOn(['2026-10-18']), [])
  })
  await t.test('a changed source invalidates aggregate approval and leaves every target untouched', async () => {
    const fresh = [{ source_date: '2026-10-12', target_date: '2026-12-05' }, { source_date: '2026-10-19', target_date: '2026-12-12' }]
    const preview = await sequence(fresh)
    await asUser(owner, 'update study_group_schedule set online_url_label=$2 where id=$1', [upper, 'Консультація'])
    await assert.rejects(sequence(fresh, false, preview.source_signature), /COPY_SOURCE_CHANGED/)
    assert.deepEqual(await rowsOn(fresh.map(pair => pair.target_date)), [])
  })
  await t.test('a later destination conflict prevents the entire sequence without earlier copies', async () => {
    const fresh = [
      { source_date: '2026-10-12', target_date: '2026-12-05' },
      { source_date: '2026-10-19', target_date: '2026-12-12' },
      { source_date: '2026-10-26', target_date: '2026-12-19' },
    ]
    const preview = await sequence(fresh)
    const conflict = await insertLesson({ subject: 'Existing target conflict', weekday: 6, from: '2026-12-19', until: '2026-12-19', starts: '08:30', ends: '09:00' })
    await assert.rejects(sequence(fresh, false, preview.source_signature), /COPY_CONFLICT/)
    assert.deepEqual(await rowsOn(['2026-12-05', '2026-12-12']), [])
    assert.deepEqual((await rowsOn(['2026-12-19'])).map(row => row.id), [conflict])
  })
  await t.test('an insertion failure on the last target rolls back prior inserts and their notification events', async () => {
    const fresh = [{ source_date: '2026-10-12', target_date: '2027-01-30' }, { source_date: '2026-10-19', target_date: '2027-02-06' }]
    const preview = await sequence(fresh)
    const before = first(await db.query('select count(*)::int as count from notifications')).count
    await db.exec(`create function public.fixture_reject_sequence_last_target() returns trigger language plpgsql as $$
      begin if new.group_id='${group}'::uuid and new.valid_from=date '2027-02-06' then
        raise exception 'fixture_late_sequence_failure' using errcode='23505'; end if; return new; end; $$;
      create trigger fixture_sequence_last_target before insert on study_group_schedule
      for each row execute function public.fixture_reject_sequence_last_target();`)
    try {
      await assert.rejects(sequence(fresh, false, preview.source_signature), /fixture_late_sequence_failure/)
      assert.deepEqual(await rowsOn(fresh.map(pair => pair.target_date)), [])
      assert.equal(first(await db.query('select count(*)::int as count from notifications')).count, before)
    } finally {
      await db.exec('drop trigger fixture_sequence_last_target on study_group_schedule; drop function public.fixture_reject_sequence_last_target()')
    }
  })
  await t.test('an empty source is a visible no-op while other days copy normally', async () => {
    const fresh = [{ source_date: '2026-10-12', target_date: '2027-02-13' }, { source_date: '2026-10-13', target_date: '2027-02-20' }]
    const preview = await sequence(fresh)
    assert.equal(preview.copied, 2)
    assert.equal(preview.days[0].empty, false)
    assert.deepEqual(preview.days[1], { source_date: '2026-10-13', target_date: '2027-02-20', copied: 0, skipped: 0, empty: true, lessons: [] })
    const copied = await sequence(fresh, false, preview.source_signature)
    assert.equal(copied.copied, 2)
    assert.equal((await rowsOn(['2027-02-13'])).length, 2)
    assert.deepEqual(await rowsOn(['2027-02-20']), [])
  })
  await t.test('all-empty plans retain a stable approval with no writes and cannot conceal a new source', async () => {
    const fresh = [{ source_date: '2026-10-13', target_date: '2027-02-27' }]
    const preview = await sequence(fresh)
    assert.equal(preview.copied, 0)
    assert.equal(preview.skipped, 0)
    assert.equal(preview.days[0].empty, true)
    const result = await sequence(fresh, false, preview.source_signature)
    assert.equal(result.copied, 0)
    assert.deepEqual(await rowsOn(['2027-02-27']), [])
    await insertLesson({ subject: 'New formerly empty source', weekday: 2, from: '2026-10-13', until: '2026-10-13' })
    await assert.rejects(sequence(fresh, false, preview.source_signature), /COPY_SOURCE_CHANGED/)
    assert.deepEqual(await rowsOn(['2027-02-27']), [])
  })
  await t.test('input rejects non-arrays, invalid fields, impossible dates, weekday targets and unordered duplicates', async () => {
    for (const invalid of [null, false, 1, {}, [null], [false], ['row'],
      [{ source_date: '2026-02-30', target_date: '2027-02-13' }],
      [{ source_date: '2026-10-17', target_date: '2027-02-13' }],
      [{ source_date: '2026-10-12', target_date: '2026-10-13' }],
      [{ source_date: '1800-01-01', target_date: '2027-02-13' }],
      [{ source_date: '2026-10-12', target_date: '2201-01-03' }],
      [{ source_date: '2026-10-12', target_date: '2027-02-13', unexpected: true }],
      [{ source_date: 2026, target_date: '2027-02-13' }],
      [pairs[0], pairs[0]], [pairs[1], pairs[0]],
    ]) await assert.rejects(sequence(invalid), /COPY_SEQUENCE_INVALID/)
    await assert.rejects(sequence(pairs, null), /COPY_SEQUENCE_INVALID/)
    await assert.rejects(sequence([]), /COPY_SEQUENCE_LIMIT/)
    await assert.rejects(sequence(Array.from({ length: 27 }, (_, index) => ({ source_date: '2026-10-12', target_date: day('2027-03-06', index * 7) }))), /COPY_SEQUENCE_LIMIT/)
  })
  await t.test('26 days are permitted but total expanded source occurrences remain bounded at 1008', async () => {
    const maxPairs = Array.from({ length: 26 }, (_, index) => ({ source_date: '2026-10-12', target_date: day('2028-01-01', index * 7) }))
    assert.equal((await sequence(maxPairs)).days.length, 26)
    await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,created_by)
      select $1,5,'00:00','00:01','Bulk bounded source '||n,'lecture','2026-10-16','2026-10-16',$2
      from generate_series(1,145) n`, [group, owner])
    const expanded = Array.from({ length: 7 }, (_, index) => ({ source_date: '2026-10-16', target_date: day('2027-03-06', index * 7) }))
    await assert.rejects(sequence(expanded), /COPY_SEQUENCE_LIMIT/)
    assert.deepEqual(await rowsOn(expanded.map(pair => pair.target_date)), [])
  })
  await t.test('reapplication preserves existing single-day RPC, academic RLS, ownership and narrow execute grants', async () => {
    await db.exec(migration)
    assert.deepEqual(first(await db.query(`select pg_get_functiondef(oid) as body,proacl::text as acl from pg_proc
      where oid='public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)'::regprocedure`)), singleBefore)
    assert.deepEqual(await policies(), policiesBefore)
    assert.equal(first(await db.query('select representative_id from study_groups where id=$1', [group])).representative_id, owner)
    for (const role of ['anon', 'authenticated', 'service_role']) assert.equal(first(await db.query(
      "select has_function_privilege($1,'public.xelay_copy_study_group_schedule_sequence(uuid,jsonb,boolean,text)','EXECUTE') as allowed", [role])).allowed, role === 'authenticated')
  })
})
