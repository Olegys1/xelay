// Synthetic accounts and isolated PostgreSQL only; no production or provider calls.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const first = result => result.rows[0]
const rpcCalls = []
let rpcError = null
globalThis.__scheduleOccurrenceSupabase = { rpc: async (name, params) => {
  rpcCalls.push({ name, params })
  return { data: { cancelled: true, schedule_item_id: params.p_schedule_item_id, lesson_date: params.p_lesson_date }, error: rpcError }
} }
const source = (await readFile(new URL('src/lib/studyGroupTimetable.ts', root), 'utf8'))
  .replace("import { supabase } from './supabase'", 'const supabase = globalThis.__scheduleOccurrenceSupabase')
const copyTimesJs = ts.transpileModule(await readFile(new URL('src/lib/scheduleCopyTimes.ts', root), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const copyTimesUrl = 'data:text/javascript;base64,' + Buffer.from(copyTimesJs).toString('base64')
const helperJs = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  .replace(/from ['"]\.\/scheduleCopyTimes['"]/g, 'from ' + JSON.stringify(copyTimesUrl))
const { scheduleOccursOnDate, cancelStudyGroupScheduleOccurrence } = await import('data:text/javascript;base64,' + Buffer.from(helperJs).toString('base64'))

test('client occurrence helper excludes only explicitly cancelled dates and retains legacy recurrence', () => {
  const lesson = { weekday: 1, valid_from: '2026-10-12', valid_until: '2026-11-30', week_pattern: 'every', week_anchor_date: null }
  assert.equal(scheduleOccursOnDate(lesson, '2026-10-12'), true)
  const cancelled = { ...lesson, excluded_dates: ['2026-10-12'] }
  assert.equal(scheduleOccursOnDate(cancelled, '2026-10-12'), false)
  assert.equal(scheduleOccursOnDate(cancelled, '2026-10-19'), true)
  assert.equal(scheduleOccursOnDate(cancelled, '2026-10-13'), false)
  assert.equal(scheduleOccursOnDate(cancelled, 'invalid'), false)
  const upper = { ...lesson, week_pattern: 'upper', week_anchor_date: '2026-10-12', excluded_dates: ['2026-10-12'] }
  assert.equal(scheduleOccursOnDate(upper, '2026-10-12'), false)
  assert.equal(scheduleOccursOnDate(upper, '2026-10-19'), false)
  assert.equal(scheduleOccursOnDate(upper, '2026-10-26'), true)
  assert.equal(scheduleOccursOnDate({ ...lesson, valid_until: '2026-10-12' }, '2026-10-12'), true)
})

test('client cancellation calls only the scoped RPC and propagates errors', async () => {
  const group = randomUUID(), lesson = randomUUID()
  await cancelStudyGroupScheduleOccurrence(group, lesson, '2026-10-12')
  assert.deepEqual(rpcCalls.at(-1), { name: 'xelay_cancel_study_group_schedule_occurrence', params: {
    p_group_id: group, p_schedule_item_id: lesson, p_lesson_date: '2026-10-12',
  } })
  const before = rpcCalls.length
  await assert.rejects(cancelStudyGroupScheduleOccurrence(group, lesson, '2026-02-30'), /OCCURRENCE_INVALID/)
  assert.equal(rpcCalls.length, before)
  rpcError = { code: '42501', message: 'STUDY_GROUP_PERMISSION_REQUIRED' }
  await assert.rejects(cancelStudyGroupScheduleOccurrence(group, lesson, '2026-10-12'), error => error === rpcError)
  rpcError = null
})

test('date-specific cancellation preserves academic content and permissions through the current migration chain', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610150009', beforeMigrationsSql: `
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const university = randomUUID(), unit = randomUUID(), specialty = randomUUID()
  const owner = randomUUID(), member = randomUUID(), deputy = randomUUID(), homeworkDeputy = randomUUID()
  const outsider = randomUUID(), admin = randomUUID(), pending = randomUUID()
  const username = id => 'occ_' + id.replaceAll('-', '').slice(0, 16)
  await db.query("insert into universities(id,name,slug) values($1,'Occurrence fixture university',$2)", [university, 'occ-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Occurrence fixture faculty',$3,'faculty')", [unit, university, 'occ-' + unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'OCC','Occurrence fixture program','Occurrence fixture program')`, [specialty, university, unit])
  for (const id of [owner, member, deputy, homeworkDeputy, outsider, admin, pending]) await seedUser(id, {
    username: username(id), university_id: university, academic_unit_id: unit, specialty_id: specialty,
    study_year: 1, experience: 'bachelor', categories: ['General'],
  })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [admin])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [admin])
  const createGroup = async (representative, name) => {
    const request = randomUUID()
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
      specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
      select $1,id,full_name,$3,$4,specialty,$5,'occ_fixture','approved',id,now() from profiles where id=$2`,
    [request, representative, university, unit, name])
    return first(await asUser(representative, 'select xelay_create_study_group($1) as id', [request])).id
  }
  const group = await createGroup(owner, 'OCC-1')
  const otherGroup = await createGroup(outsider, 'OCC-2')
  for (const user of [member, deputy, homeworkDeputy, pending]) {
    const invite = first(await asUser(owner, 'select xelay_invite_to_study_group($1,$2) as id', [group, username(user)])).id
    if (user !== pending) await asUser(user, 'select xelay_respond_study_group_invitation($1,true)', [invite])
  }
  await asUser(owner, "select xelay_assign_study_group_deputy($1,$2,array['schedule'])", [group, deputy])
  await asUser(owner, "select xelay_assign_study_group_deputy($1,$2,array['homework'])", [group, homeworkDeputy])
  const insertLesson = async ({ subject = 'Occurrence lesson', weekday = 1, from = '2026-10-12', until = '2026-11-30',
    starts = '08:00', ends = '09:20', pattern = 'every', anchor = null, targetGroup = group, author = owner } = {}) =>
    first(await asUser(author, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,
      lesson_type,location,online_url,online_url_secondary,online_url_label,online_url_secondary_label,
      valid_from,valid_until,week_pattern,week_anchor_date,created_by)
      values($1,$2,$3,$4,$5,'lecture','','https://example.test/lecture','https://example.test/seminar',
        'Лекція','Семінар',$6,$7,$8,$9,$10) returning id`,
    [targetGroup, weekday, starts, ends, subject, from, until, pattern, anchor, author])).id
  const existing = await insertLesson()
  const otherLesson = await insertLesson({ targetGroup: otherGroup, author: outsider })
  const path = `${group}/${owner}/${randomUUID()}-lesson.pdf`
  await asUser(owner, `insert into storage.objects(bucket_id,name,owner,metadata)
    values('xelay-homework-files',$1,$2,'{"size":123,"mimetype":"application/pdf"}'::jsonb)`, [path, owner])
  const attachment = { storage_path: path, file_name: 'lesson.pdf', mime_type: 'application/pdf', file_size: 123 }
  const homework = first(await asUser(owner, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,
    resource_links,resource_link_labels,attachments,created_by)
    values($1,$2,'2026-10-12','Preserved homework','["https://example.test/homework"]',
      '{"https://example.test/homework":"Лекція"}',$3::jsonb,$4) returning id`,
  [group, existing, JSON.stringify([attachment]), owner])).id
  const policies = async () => (await db.query(`select schemaname,tablename,policyname,roles,cmd,qual,with_check
    from pg_policies where (schemaname='public' and tablename in('study_group_schedule','study_group_homework'))
      or (schemaname='storage' and tablename='objects') order by schemaname,tablename,policyname`)).rows
  const policiesBefore = await policies()
  const basePredicateBefore = first(await db.query(`select pg_get_functiondef(
    'public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)'::regprocedure) as body`)).body
  const migration = await readFile(new URL('supabase/migrations/202610150010_schedule_occurrence_cancellation.sql', root), 'utf8')
  await db.exec(migration)
  const lesson = async id => first(await db.query('select to_jsonb(s) as value from study_group_schedule s where id=$1', [id])).value
  const cancel = async (id, date, user = owner, targetGroup = group, options = {}) => first(await asUser(user,
    'select xelay_cancel_study_group_schedule_occurrence($1,$2,$3) as result', [targetGroup, id, date], options)).result
  const importLessons = async rows => first(await asUser(owner, 'select xelay_import_study_group_timetable($1,$2::jsonb) as count', [group, JSON.stringify(rows)])).count
  const imported = (subject, date, overrides = {}) => ({ weekday: 1, starts_at: '11:20', ends_at: '12:40', subject,
    lesson_type: 'seminar', location: '', online_url: 'https://example.test/lecture', online_url_secondary: 'https://example.test/seminar',
    online_url_label: 'Лекція', online_url_secondary_label: 'Семінар', valid_from: date, valid_until: date,
    week_pattern: 'every', week_anchor_date: null, lesson_number: 3, ...overrides })

  await t.test('existing schedules gain empty exclusions without changing base predicates or RLS', async () => {
    assert.deepEqual((await lesson(existing)).excluded_dates, [])
    assert.deepEqual(await policies(), policiesBefore)
    assert.equal(first(await db.query(`select pg_get_functiondef(
      'public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)'::regprocedure) as body`)).body, basePredicateBefore)
  })
  await t.test('representative cancels one date; repeated cancellation performs no further update', async () => {
    assert.deepEqual(await cancel(existing, '2026-10-12'), { cancelled: true, schedule_item_id: existing, lesson_date: '2026-10-12' })
    const row = await lesson(existing)
    assert.deepEqual(row.excluded_dates, ['2026-10-12'])
    assert.equal(scheduleOccursOnDate(row, '2026-10-12'), false)
    assert.equal(scheduleOccursOnDate(row, '2026-10-19'), true)
    const notifications = first(await db.query('select count(*)::int as count from notifications')).count
    await cancel(existing, '2026-10-12')
    assert.equal((await lesson(existing)).updated_at, row.updated_at)
    assert.equal(first(await db.query('select count(*)::int as count from notifications')).count, notifications)
  })
  await t.test('dated homework, names, private files and accepted-member access survive and remain editable', async () => {
    const row = first(await asUser(member, 'select * from study_group_homework where id=$1', [homework]))
    assert.equal(row.body, 'Preserved homework')
    assert.deepEqual(row.attachments, [attachment])
    assert.deepEqual(row.resource_link_labels, { 'https://example.test/homework': 'Лекція' })
    assert.equal((await asUser(member, "select name from storage.objects where bucket_id='xelay-homework-files' and name=$1", [path])).rows.length, 1)
    assert.equal((await asUser(outsider, "select name from storage.objects where bucket_id='xelay-homework-files' and name=$1", [path])).rows.length, 0)
    await asUser(owner, 'update study_group_homework set body=$2 where id=$1', [homework, 'Updated after cancellation'])
    assert.equal(first(await asUser(member, 'select body from study_group_homework where id=$1', [homework])).body, 'Updated after cancellation')
    await assert.rejects(asUser(owner, "update study_group_schedule set valid_from='2026-10-19' where id=$1", [existing]), /SCHEDULE_HAS_HOMEWORK/)
  })
  await t.test('wrong dates, alternate-week gaps and rows from other groups are rejected', async () => {
    const upper = await insertLesson({ subject: 'Upper lesson', pattern: 'upper', anchor: '2026-10-12' })
    for (const date of ['2026-10-13', '2026-10-19', '2026-12-07']) await assert.rejects(cancel(upper, date), /OCCURRENCE_NOT_FOUND/)
    for (const date of [null, 'infinity', '1800-01-01']) await assert.rejects(cancel(upper, date), /OCCURRENCE_INVALID/)
    await assert.rejects(cancel(otherLesson, '2026-10-12'), /SCHEDULE_NOT_FOUND/)
    await cancel(upper, '2026-10-26')
    assert.deepEqual((await lesson(upper)).excluded_dates, ['2026-10-26'])
  })
  await t.test('members, pending invitees, homework-only deputies, outsiders and even verified admins cannot cancel', async () => {
    for (const user of [member, pending, homeworkDeputy, outsider, admin]) await assert.rejects(
      cancel(existing, '2026-10-19', user, group, { aal: user === admin ? 'aal2' : 'aal1' }), error => error.code === '42501')
    await assert.rejects(cancel(existing, '2026-10-19', null, group, { role: 'anon' }), error => error.code === '42501')
    await assert.rejects(cancel(existing, '2026-10-19', null, group, { role: 'service_role' }), error => error.code === '42501')
    await cancel(existing, '2026-10-19', deputy)
    assert.deepEqual((await lesson(existing)).excluded_dates, ['2026-10-12', '2026-10-19'])
  })
  await t.test('one-off cancellation retains its row while removing its only occurrence', async () => {
    const id = await insertLesson({ subject: 'Single lesson', weekday: 3, from: '2026-10-14', until: '2026-10-14' })
    await cancel(id, '2026-10-14')
    const row = await lesson(id)
    assert.equal(row.valid_from, '2026-10-14')
    assert.equal(scheduleOccursOnDate(row, '2026-10-14'), false)
    assert.equal(scheduleOccursOnDate(row, '2026-10-21'), false)
  })
  await t.test('direct authorized writes deduplicate exceptions, prune obsolete dates and reject invalid arrays', async () => {
    const id = await insertLesson({ subject: 'Array normalization', weekday: 2, from: '2026-10-13', until: '2026-11-24' })
    await asUser(owner, "update study_group_schedule set excluded_dates=array['2026-10-27','2026-10-20','2026-10-20','2026-10-21']::date[] where id=$1", [id])
    assert.deepEqual((await lesson(id)).excluded_dates, ['2026-10-20', '2026-10-27'])
    await asUser(owner, "update study_group_schedule set valid_from='2026-10-27' where id=$1", [id])
    assert.deepEqual((await lesson(id)).excluded_dates, ['2026-10-27'])
    for (const value of ["null", "array[null]::date[]", "array['infinity']::date[]", "array['1800-01-01']::date[]", "array[['2026-10-27','2026-11-03']]::date[]"])
      await assert.rejects(asUser(owner, `update study_group_schedule set excluded_dates=${value} where id=$1`, [id]), /EXCLUSIONS_INVALID/)
    await assert.rejects(asUser(owner, "update study_group_schedule set excluded_dates=array_fill('2026-10-27'::date,array[367]) where id=$1", [id]), /EXCLUSIONS_LIMIT/)
    assert.equal((await asUser(member, "update study_group_schedule set excluded_dates='{}' where id=$1 returning id", [id])).rows.length, 0)
    assert.deepEqual((await lesson(id)).excluded_dates, ['2026-10-27'])
  })
  await t.test('import permits a one-off replacement on a cancelled date and retains both link names', async () => {
    const original = imported('Cancelled imported lesson', '2026-10-12')
    assert.equal(await importLessons([original]), 1)
    const id = first(await db.query('select id from study_group_schedule where group_id=$1 and subject=$2', [group, original.subject])).id
    await cancel(id, '2026-10-12')
    assert.equal(await importLessons([original]), 1)
    const rows = (await db.query('select to_jsonb(s) as value from study_group_schedule s where group_id=$1 and subject=$2', [group, original.subject])).rows.map(row => row.value)
    assert.equal(rows.filter(row => scheduleOccursOnDate(row, '2026-10-12')).length, 1)
    assert.ok(rows.every(row => row.online_url_label === 'Лекція' && row.online_url_secondary_label === 'Семінар'))
  })
  await t.test('import still rejects a recurring duplicate when the first two weeks are cancelled', async () => {
    const recurring = imported('Recurring duplicate guard', '2026-10-12', { valid_until: '2026-11-30' })
    assert.equal(await importLessons([recurring]), 1)
    const id = first(await db.query('select id from study_group_schedule where group_id=$1 and subject=$2', [group, recurring.subject])).id
    await cancel(id, '2026-10-12')
    await cancel(id, '2026-10-19')
    await assert.rejects(importLessons([recurring]), /DUPLICATE_LESSON/)
    assert.equal(first(await db.query('select count(*)::int as count from study_group_schedule where group_id=$1 and subject=$2', [group, recurring.subject])).count, 1)
  })
  await t.test('day-copy skips cancelled sources and ignores cancelled target conflicts while preserving names', async () => {
    const active = await insertLesson({ subject: 'Active copy source', weekday: 5, from: '2026-10-16', until: '2026-10-16' })
    const cancelled = await insertLesson({ subject: 'Cancelled copy source', weekday: 5, from: '2026-10-16', until: '2026-10-16', starts: '11:20', ends: '12:40' })
    await cancel(cancelled, '2026-10-16')
    const conflict = await insertLesson({ subject: 'Cancelled target conflict', weekday: 6, from: '2026-10-17', until: '2026-10-17' })
    await cancel(conflict, '2026-10-17')
    const copy = async (preview, signature = null) => first(await asUser(owner,
      "select xelay_copy_study_group_schedule_day($1,'2026-10-16','2026-10-17',$2,$3) as result", [group, preview, signature])).result
    const preview = await copy(true)
    assert.deepEqual(preview.lessons.map(row => row.id), [active])
    assert.equal(preview.lessons[0].online_url_label, 'Лекція')
    assert.equal(preview.lessons[0].online_url_secondary_label, 'Семінар')
    const copied = await copy(false, preview.source_signature)
    assert.equal(copied.copied, 1)
    const target = first(await db.query("select to_jsonb(s) as value from study_group_schedule s where group_id=$1 and subject='Active copy source' and valid_from='2026-10-17'", [group])).value
    assert.deepEqual(target.excluded_dates, [])
    assert.equal(target.online_url_label, 'Лекція')
    assert.equal(target.online_url_secondary_label, 'Семінар')
    const again = await copy(false, preview.source_signature)
    assert.equal(again.copied, 0)
    assert.equal(again.skipped, 1)
    await cancel(active, '2026-10-16')
    await assert.rejects(copy(true), /COPY_SOURCE_EMPTY/)
  })
  await t.test('cancelling a source invalidates an already prepared day-copy preview', async () => {
    const id = await insertLesson({ subject: 'Stale copy source', weekday: 4, from: '2026-10-15', until: '2026-10-15', starts: '14:30', ends: '15:50' })
    await insertLesson({ subject: 'Remaining copy source', weekday: 4, from: '2026-10-15', until: '2026-10-15', starts: '16:00', ends: '17:20' })
    const preview = first(await asUser(owner, "select xelay_copy_study_group_schedule_day($1,'2026-10-15','2026-10-18',true,null) as result", [group])).result
    await cancel(id, '2026-10-15')
    await assert.rejects(asUser(owner, "select xelay_copy_study_group_schedule_day($1,'2026-10-15','2026-10-18',false,$2)", [group, preview.source_signature]), /COPY_SOURCE_CHANGED/)
  })
  await t.test('reapplying the migration preserves cancellations, homework and private access policies', async () => {
    await db.exec(migration)
    assert.deepEqual((await lesson(existing)).excluded_dates, ['2026-10-12', '2026-10-19'])
    assert.equal(first(await db.query('select body from study_group_homework where id=$1', [homework])).body, 'Updated after cancellation')
    assert.equal((await asUser(member, "select name from storage.objects where bucket_id='xelay-homework-files' and name=$1", [path])).rows.length, 1)
    assert.deepEqual(await policies(), policiesBefore)
    const acl = first(await db.query(`select
      has_function_privilege('authenticated','public.xelay_cancel_study_group_schedule_occurrence(uuid,uuid,date)','EXECUTE') as authenticated,
      has_function_privilege('anon','public.xelay_cancel_study_group_schedule_occurrence(uuid,uuid,date)','EXECUTE') as anon,
      has_function_privilege('service_role','public.xelay_cancel_study_group_schedule_occurrence(uuid,uuid,date)','EXECUTE') as service`))
    assert.deepEqual(acl, { authenticated: true, anon: false, service: false })
  })
})
