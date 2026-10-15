// Isolated PostgreSQL checks with synthetic accounts; no live database or mail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'
import ts from 'typescript'

const root = new URL('../../', import.meta.url)
const first = result => result.rows[0]
const helperSource = await readFile(new URL('src/lib/studyGroupLinks.ts', root), 'utf8')
const helperJs = ts.transpileModule(helperSource, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { getStudyGroupLessonLinks } = await import('data:text/javascript;base64,' + Buffer.from(helperJs).toString('base64'))

test('link display keeps custom names and original fallback positions', () => {
  assert.deepEqual(getStudyGroupLessonLinks({ online_url: 'https://example.test/lecture', online_url_label: ' Лекція ', online_url_secondary: 'https://example.test/seminar', online_url_secondary_label: 'Семінар' }), [
    { slot: 1, url: 'https://example.test/lecture', label: 'Лекція' },
    { slot: 2, url: 'https://example.test/seminar', label: 'Семінар' },
  ])
  assert.equal(getStudyGroupLessonLinks({ online_url_secondary: 'https://example.test/second' })[0].label, 'Посилання 2')
  assert.equal(getStudyGroupLessonLinks({ online_url: 'https://example.test/first', online_url_label: '   ' })[0].label, 'Посилання 1')
})

test('link display rejects non-web addresses and never treats names as URLs', () => {
  for (const online_url of ['javascript:alert(1)', 'data:text/html,test', 'file:///tmp/a', '//example.test/path', 'invalid']) {
    assert.deepEqual(getStudyGroupLessonLinks({ online_url, online_url_label: 'Лекція' }), [])
  }
  const row = getStudyGroupLessonLinks({ online_url: 'https://example.test/safe', online_url_label: '<b>Лекція</b>' })[0]
  assert.equal(row.url, 'https://example.test/safe')
  assert.equal(row.label, '<b>Лекція</b>')
})

test('named lesson links preserve URLs, copying and private academic permissions', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610150007', beforeMigrationsSql: `
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const university = randomUUID(), unit = randomUUID(), specialty = randomUUID()
  const owner = randomUUID(), member = randomUUID(), outsider = randomUUID(), request = randomUUID()
  await db.query("insert into universities(id,name,slug) values($1,'Link fixture university',$2)", [university, 'links-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Link fixture faculty',$3,'faculty')", [unit, university, 'links-' + unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'LINKS','Link fixture program','Link fixture program')`, [specialty, university, unit])
  for (const id of [owner, member, outsider]) await seedUser(id, {
    username: 'links_' + id.replaceAll('-', '').slice(0, 15), university_id: university,
    academic_unit_id: unit, specialty_id: specialty, study_year: 1, experience: 'bachelor', categories: ['General'],
  })
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
    specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    select $1,id,full_name,$3,$4,specialty,'LINKS-1','link_fixture','approved',id,now() from profiles where id=$2`,
  [request, owner, university, unit])
  const group = first(await asUser(owner, 'select xelay_create_study_group($1) as id', [request])).id
  const invite = first(await asUser(owner, 'select xelay_invite_to_study_group($1,$2) as id',
    [group, 'links_' + member.replaceAll('-', '').slice(0, 15)])).id
  await asUser(member, 'select xelay_respond_study_group_invitation($1,true)', [invite])
  const old = first(await asUser(owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,
    lesson_type,location,online_url,online_url_secondary,valid_from,valid_until,created_by)
    values($1,1,'08:00','09:20','Existing lesson','lecture','','https://example.test/lecture','https://example.test/seminar',
      '2026-10-12','2026-10-12',$2) returning id`, [group, owner])).id
  const policyBefore = (await db.query("select policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='study_group_schedule' order by policyname")).rows
  const migration = await readFile(new URL('supabase/migrations/202610150008_schedule_link_labels.sql', root), 'utf8')
  await db.exec(migration)
  const getLesson = async id => first(await db.query('select * from study_group_schedule where id=$1', [id]))
  const importRows = async (rows, user = owner) => first(await asUser(user,
    'select xelay_import_study_group_timetable($1,$2::jsonb) as count', [group, JSON.stringify(rows)])).count
  const base = { weekday: 2, starts_at: '09:40', ends_at: '11:00', subject: 'Named lesson', lesson_type: 'seminar',
    location: '', online_url: 'https://example.test/room-a', online_url_secondary: 'https://example.test/room-b',
    valid_from: '2026-10-13', valid_until: '2026-10-13', week_pattern: 'every', week_anchor_date: null, lesson_number: 2 }

  await t.test('existing URL values survive and unnamed legacy labels are optional', async () => {
    const row = await getLesson(old)
    assert.equal(row.online_url, 'https://example.test/lecture')
    assert.equal(row.online_url_secondary, 'https://example.test/seminar')
    assert.equal(row.online_url_label, null)
    assert.equal(row.online_url_secondary_label, null)
  })
  await t.test('representative edits two independent trimmed labels', async () => {
    await asUser(owner, 'update study_group_schedule set online_url_label=$2,online_url_secondary_label=$3 where id=$1', [old, ' Лекція ', ' Семінар '])
    const row = await getLesson(old)
    assert.equal(row.online_url_label, 'Лекція')
    assert.equal(row.online_url_secondary_label, 'Семінар')
    assert.equal(row.online_url, 'https://example.test/lecture')
  })
  await t.test('members read labels; membership never grants schedule writes', async () => {
    assert.equal(first(await asUser(member, 'select online_url_label from study_group_schedule where id=$1', [old])).online_url_label, 'Лекція')
    const result = await asUser(member, 'update study_group_schedule set online_url_label=$2 where id=$1 returning id', [old, 'Unauthorized'])
    assert.equal(result.rows.length, 0)
    assert.equal((await getLesson(old)).online_url_label, 'Лекція')
    assert.equal((await asUser(outsider, 'select id from study_group_schedule where id=$1', [old])).rows.length, 0)
  })
  await t.test('label validation rejects oversized and control-character values', async () => {
    for (const value of ['x'.repeat(81), 'line\nbreak']) {
      await assert.rejects(asUser(owner, 'update study_group_schedule set online_url_label=$2 where id=$1', [old, value]))
    }
    assert.equal((await getLesson(old)).online_url_label, 'Лекція')
  })
  await t.test('import accepts optional independent names and normalizes whitespace', async () => {
    assert.equal(await importRows([{ ...base, online_url_label: ' Лекція ', online_url_secondary_label: ' Семінар ' }]), 1)
    const row = first(await db.query("select * from study_group_schedule where group_id=$1 and subject='Named lesson'", [group]))
    assert.equal(row.online_url_label, 'Лекція')
    assert.equal(row.online_url_secondary_label, 'Семінар')
  })
  await t.test('legacy imports with no name fields still work', async () => {
    assert.equal(await importRows([{ ...base, weekday: 3, subject: 'Legacy imported lesson', valid_from: '2026-10-14', valid_until: '2026-10-14' }]), 1)
    const row = first(await db.query("select * from study_group_schedule where group_id=$1 and subject='Legacy imported lesson'", [group]))
    assert.equal(row.online_url_label, null)
  })
  await t.test('invalid import labels roll back the entire batch', async () => {
    const before = first(await db.query('select count(*)::int as count from study_group_schedule where group_id=$1', [group])).count
    await assert.rejects(importRows([
      { ...base, weekday: 4, subject: 'Must roll back', valid_from: '2026-10-15', valid_until: '2026-10-15', online_url_label: 'Valid' },
      { ...base, weekday: 5, subject: 'Invalid label', valid_from: '2026-10-16', valid_until: '2026-10-16', online_url_label: 'x'.repeat(81) },
    ]))
    assert.equal(first(await db.query('select count(*)::int as count from study_group_schedule where group_id=$1', [group])).count, before)
    await assert.rejects(importRows([{ ...base, online_url_label: { invalid: true } }]))
  })
  await t.test('copy preview and target preserve both labels and URLs', async () => {
    const preview = first(await asUser(owner, `select xelay_copy_study_group_schedule_day($1,'2026-10-12','2026-10-17',true,null) as result`, [group])).result
    assert.equal(preview.lessons[0].online_url_label, 'Лекція')
    assert.equal(preview.lessons[0].online_url_secondary_label, 'Семінар')
    const copied = first(await asUser(owner, `select xelay_copy_study_group_schedule_day($1,'2026-10-12','2026-10-17',false,$2) as result`, [group, preview.source_signature])).result
    assert.equal(copied.copied, 1)
    const target = first(await db.query("select * from study_group_schedule where group_id=$1 and valid_from='2026-10-17'", [group]))
    assert.equal(target.online_url_label, 'Лекція')
    assert.equal(target.online_url_secondary_label, 'Семінар')
    assert.equal(target.online_url, 'https://example.test/lecture')
    const again = first(await asUser(owner, `select xelay_copy_study_group_schedule_day($1,'2026-10-12','2026-10-17',false,$2) as result`, [group, preview.source_signature])).result
    assert.equal(again.copied, 0)
    assert.equal(again.skipped, 1)
  })
  await t.test('a renamed link invalidates stale copying previews', async () => {
    const preview = first(await asUser(owner, `select xelay_copy_study_group_schedule_day($1,'2026-10-12','2026-10-18',true,null) as result`, [group])).result
    await asUser(owner, 'update study_group_schedule set online_url_label=$2 where id=$1', [old, 'Консультація'])
    await assert.rejects(asUser(owner, `select xelay_copy_study_group_schedule_day($1,'2026-10-12','2026-10-18',false,$2) as result`, [group, preview.source_signature]), /COPY_SOURCE_CHANGED/)
  })
  await t.test('removing a URL clears its obsolete name and keeps the other link', async () => {
    await asUser(owner, 'update study_group_schedule set online_url=null where id=$1', [old])
    const row = await getLesson(old)
    assert.equal(row.online_url_label, null)
    assert.equal(row.online_url_secondary_label, 'Семінар')
    assert.equal(row.online_url_secondary, 'https://example.test/seminar')
  })
  await t.test('RPCs still reject outsider writes and preserve existing RLS definitions', async () => {
    await assert.rejects(importRows([{ ...base, subject: 'Unauthorized' }], outsider), error => error.code === '42501')
    await assert.rejects(asUser(outsider, `select xelay_copy_study_group_schedule_day($1,'2026-10-12','2026-10-18',true,null)`, [group]), error => error.code === '42501')
    assert.deepEqual((await db.query("select policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename='study_group_schedule' order by policyname")).rows, policyBefore)
  })
  await t.test('the migration can be reapplied without erasing existing names', async () => {
    await db.exec(migration)
    assert.equal((await getLesson(old)).online_url_secondary_label, 'Семінар')
  })
})
