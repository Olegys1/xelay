// Full isolated migration chain, synthetic groups only. No production or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const first = result => result.rows[0]
const rejectsWith = (work, message) => assert.rejects(work, error => error.message.includes(message))

test('a reviewed distinct-cohort collision permits only its exact new group without guessing legacy identity', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610150011', beforeMigrationsSql: `
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const university = randomUUID(), unit = randomUUID(), specialty = randomUUID()
  const program = 'Synthetic Marketing Analytics'
  await db.query("insert into universities(id,name,slug) values($1,'Cohort resolution fixture university',$2)", [university, 'resolution-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Cohort resolution faculty',$3,'faculty')", [unit, university, 'resolution-' + unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'RESOLUTION',$4,$4)`, [specialty, university, unit, program])
  const user = async (year = 1, level = 'bachelor') => {
    const id = randomUUID()
    await seedUser(id, { username: 'resolution_' + id.replaceAll('-', '').slice(0, 15),
      university_id: university, academic_unit_id: unit, specialty_id: specialty,
      study_year: year, experience: level, categories: ['General'] })
    return id
  }
  const request = async (owner, name) => {
    const id = randomUUID()
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
      specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
      select $1,id,full_name,$3,$4,$5,$6,'resolution_fixture','approved',id,now() from profiles where id=$2`,
    [id, owner, university, unit, program, name])
    return { id, owner, name }
  }
  const create = async (context, actor = context.owner) => first(await asUser(actor, 'select xelay_create_study_group($1) as id', [context.id])).id
  const anchor = first(await db.query('select xelay_current_academic_year()::int as year')).year
  const oldOwner = await user(null), firstYearMember = await user(1), thirdYearMember = await user(3)
  const outsider = await user(1), newOwner = await user(1)
  const oldRequest = await request(oldOwner, 'МА-2')
  const oldGroup = await create(oldRequest)
  for (const member of [firstYearMember, thirdYearMember]) await db.query(`insert into study_group_members(group_id,user_id,status,invited_by,accepted_at)
    values($1,$2,'accepted',$3,now())`, [oldGroup, member, oldOwner])
  const newRequest = await request(newOwner, 'МА-2')
  const otherOldRequest = await request(await user(null), 'OTHER-UNKNOWN')
  const otherOldGroup = await create(otherOldRequest)
  const otherNewRequest = await request(await user(1), 'OTHER-UNKNOWN')
  const incompleteRequest = await request(await user(null), 'UNIQUE-INCOMPLETE')
  const legacyOwnIncomplete = await request(await user(null), 'EXISTING-INCOMPLETE')
  const legacyOwnIncompleteGroup = await create(legacyOwnIncomplete)
  const lesson = first(await asUser(oldOwner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,
    lesson_type,valid_from,valid_until,created_by)
    values($1,1,'08:00','09:20',$2,'lecture','2026-10-12','2026-10-26',$3) returning id`, [oldGroup, program, oldOwner])).id
  const homework = first(await asUser(oldOwner, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
    values($1,$2,'2026-10-19','Original private group homework',$3) returning id`, [oldGroup, lesson, oldOwner])).id
  const oldMemberships = (await db.query('select * from study_group_members where group_id=$1 order by id', [oldGroup])).rows
  const oldGroupBefore = first(await db.query('select * from study_groups where id=$1', [oldGroup]))
  const oldRequestBefore = first(await db.query('select * from class_representative_requests where id=$1', [oldRequest.id]))
  const policies = async () => (await db.query(`select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies
    where schemaname='public' and tablename in('class_representative_requests','study_groups','study_group_members','study_group_homework')
    order by tablename,policyname`)).rows
  const policiesBefore = await policies()
  const createAcl = first(await db.query("select proacl::text as acl from pg_proc where oid='public.xelay_create_study_group(uuid)'::regprocedure")).acl
  const migration = await readFile(new URL('../../supabase/migrations/202610150012_study_group_cohort_collision_resolution.sql', import.meta.url), 'utf8')
  const resolution = async (context, groupId) => db.query(`insert into study_group_cohort_collision_resolutions(
    request_id,existing_group_id,request_user_id,existing_representative_id,existing_representative_request_id,
    university_id,academic_unit_id,specialty,group_name,new_cohort_start_year,new_study_level,
    existing_cohort_start_year,existing_study_level,reason)
    select r.id,g.id,r.user_id,g.representative_id,g.representative_request_id,r.university_id,r.academic_unit_id,
      r.specialty,r.group_name,r.cohort_start_year,r.study_level,g.cohort_start_year,g.study_level,
      'Synthetic operator confirmed that the applicant belongs to another academic cohort; old course remains unknown.'
    from class_representative_requests r cross join study_groups g where r.id=$1 and g.id=$2`, [context.id, groupId])
  const setResolution = async (context, groupId, column, value) => {
    assert.ok(['new_cohort_start_year', 'request_user_id', 'existing_representative_id',
      'existing_representative_request_id', 'group_name', 'specialty'].includes(column))
    await db.query(`update study_group_cohort_collision_resolutions set ${column}=$3 where request_id=$1 and existing_group_id=$2`,
      [context.id, groupId, value])
  }
  let newGroup

  await t.test('reproduces the unknown legacy collision before migration', async () => {
    await rejectsWith(create(newRequest), 'GROUP_IDENTITY_NEEDS_REVIEW')
    assert.equal(oldGroupBefore.cohort_start_year, null)
    assert.equal(oldGroupBefore.study_level, null)
  })
  await t.test('migration adds no guessed snapshots, retroactive membership or broad group access', async () => {
    await db.exec(migration)
    assert.deepEqual(first(await db.query('select * from study_groups where id=$1', [oldGroup])), oldGroupBefore)
    assert.deepEqual(first(await db.query('select * from class_representative_requests where id=$1', [oldRequest.id])), oldRequestBefore)
    assert.equal(first(await db.query('select count(*)::int as count from study_group_cohort_collision_resolutions')).count, 0)
    assert.deepEqual(await policies(), policiesBefore)
  })
  await t.test('unreviewed collisions remain blocked even with a complete new request', async () => {
    await rejectsWith(create(newRequest), 'GROUP_IDENTITY_NEEDS_REVIEW')
    await rejectsWith(create(otherNewRequest), 'GROUP_IDENTITY_NEEDS_REVIEW')
    assert.equal(first(await db.query('select count(*)::int as count from study_groups where representative_request_id=$1', [newRequest.id])).count, 0)
  })
  await t.test('private review records cannot be read or written by any client role', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await assert.rejects(asUser(newOwner, 'select * from study_group_cohort_collision_resolutions', [], { role }), error => error.code === '42501')
      await assert.rejects(asUser(newOwner, 'delete from study_group_cohort_collision_resolutions', [], { role }), error => error.code === '42501')
      await assert.rejects(asUser(newOwner, 'update study_group_cohort_collision_resolutions set reason=$1', ['Forged resolution'], { role }), error => error.code === '42501')
      await assert.rejects(asUser(newOwner, `insert into study_group_cohort_collision_resolutions(request_id,existing_group_id)
        values($1,$2)`, [newRequest.id, oldGroup], { role }), error => error.code === '42501')
    }
  })
  await t.test('an exact operator record stores the new snapshot and leaves the old course unknown', async () => {
    await resolution(newRequest, oldGroup)
    const saved = first(await db.query('select * from study_group_cohort_collision_resolutions where request_id=$1', [newRequest.id]))
    assert.equal(saved.request_user_id, newOwner)
    assert.equal(saved.existing_representative_id, oldOwner)
    assert.equal(saved.existing_representative_request_id, oldRequest.id)
    assert.equal(saved.new_cohort_start_year, anchor)
    assert.equal(saved.new_study_level, 'bachelor')
    assert.equal(saved.existing_cohort_start_year, null)
    assert.equal(saved.existing_study_level, null)
    assert.ok(Number.isFinite(new Date(saved.confirmed_at).getTime()))
  })
  await t.test('stale review snapshots cannot authorize creation', async () => {
    for (const [column, invalid, original] of [
      ['new_cohort_start_year', anchor - 1, anchor],
      ['request_user_id', outsider, newOwner],
      ['existing_representative_id', outsider, oldOwner],
      ['existing_representative_request_id', otherOldRequest.id, oldRequest.id],
      ['group_name', 'A different reviewed group', 'МА-2'],
      ['specialty', 'A different reviewed program', program],
    ]) {
      await setResolution(newRequest, oldGroup, column, invalid)
      await rejectsWith(create(newRequest), 'GROUP_IDENTITY_NEEDS_REVIEW')
      await setResolution(newRequest, oldGroup, column, original)
    }
  })
  await t.test('reviewed distinct cohort creates a separate group and only its applicant membership', async () => {
    newGroup = await create(newRequest)
    assert.notEqual(newGroup, oldGroup)
    const created = first(await db.query('select representative_id,representative_request_id,cohort_start_year,study_level from study_groups where id=$1', [newGroup]))
    assert.deepEqual(created, { representative_id: newOwner, representative_request_id: newRequest.id, cohort_start_year: anchor, study_level: 'bachelor' })
    assert.deepEqual((await db.query('select user_id,status from study_group_members where group_id=$1', [newGroup])).rows,
      [{ user_id: newOwner, status: 'accepted' }])
    assert.deepEqual(first(await db.query('select * from study_groups where id=$1', [oldGroup])), oldGroupBefore)
    assert.deepEqual((await db.query('select * from study_group_members where group_id=$1 order by id', [oldGroup])).rows, oldMemberships)
    assert.equal(first(await db.query('select body from study_group_homework where id=$1', [homework])).body, 'Original private group homework')
  })
  await t.test('a resolution never transfers old private content or membership', async () => {
    assert.equal((await asUser(newOwner, 'select id from study_group_schedule where id=$1', [lesson])).rows.length, 0)
    assert.equal((await asUser(newOwner, 'select id from study_group_homework where id=$1', [homework])).rows.length, 0)
    assert.equal((await asUser(newOwner, 'select id from study_groups where id=$1', [oldGroup])).rows.length, 0)
    assert.equal(first(await asUser(firstYearMember, 'select body from study_group_homework where id=$1', [homework])).body,
      'Original private group homework')
    assert.equal((await asUser(firstYearMember, 'select id from study_groups where id=$1', [newGroup])).rows.length, 0)
  })
  await t.test('retries return the same group without duplicate rows or snapshot changes', async () => {
    assert.equal(await create(newRequest), newGroup)
    assert.equal(first(await db.query('select count(*)::int as count from study_groups where representative_request_id=$1', [newRequest.id])).count, 1)
    assert.equal(await create(legacyOwnIncomplete), legacyOwnIncompleteGroup)
  })
  await t.test('review is bound to a single request and cannot unblock another unknown collision', async () => {
    await rejectsWith(create(otherNewRequest), 'GROUP_IDENTITY_NEEDS_REVIEW')
    assert.equal(first(await db.query('select count(*)::int as count from study_group_cohort_collision_resolutions where request_id=$1', [otherNewRequest.id])).count, 0)
    assert.equal(first(await db.query('select cohort_start_year from study_groups where id=$1', [otherOldGroup])).cohort_start_year, null)
  })
  await t.test('an existing known same cohort remains blocked despite a reviewed unknown collision', async () => {
    const duplicate = await request(await user(1), 'МА-2')
    await resolution(duplicate, oldGroup)
    await rejectsWith(create(duplicate), 'GROUP_ALREADY_EXISTS')
    assert.equal(first(await db.query('select count(*)::int as count from study_groups where representative_request_id=$1', [duplicate.id])).count, 0)
  })
  await t.test('incomplete new requests cannot create even a unique base; owner profile correction repairs the snapshot', async () => {
    await rejectsWith(create(incompleteRequest), 'GROUP_COHORT_REQUIRED')
    assert.equal(first(await db.query('select count(*)::int as count from study_groups where representative_request_id=$1', [incompleteRequest.id])).count, 0)
    await asUser(incompleteRequest.owner, 'update profiles set study_year=1 where id=$1', [incompleteRequest.owner])
    const created = await create(incompleteRequest)
    assert.deepEqual(first(await db.query('select cohort_start_year,study_level from class_representative_requests where id=$1', [incompleteRequest.id])),
      { cohort_start_year: anchor, study_level: 'bachelor' })
    assert.deepEqual(first(await db.query('select cohort_start_year,study_level from study_groups where id=$1', [created])),
      { cohort_start_year: anchor, study_level: 'bachelor' })
  })
  await t.test('resolution cannot be used by another user or anonymous caller', async () => {
    await rejectsWith(create(newRequest, outsider), 'Approved class representative request not found')
    await rejectsWith(create(newRequest, null), 'Authentication required')
    await assert.rejects(asUser(null, 'select xelay_create_study_group($1)', [newRequest.id], { role: 'anon' }), error => error.code === '42501')
  })
  await t.test('reapplication preserves private review evidence, ACLs, legacy data and immutable known snapshots', async () => {
    const reviews = (await db.query('select * from study_group_cohort_collision_resolutions order by request_id,existing_group_id')).rows
    const createdBefore = first(await db.query('select * from study_groups where id=$1', [newGroup]))
    await db.exec(migration)
    assert.deepEqual((await db.query('select * from study_group_cohort_collision_resolutions order by request_id,existing_group_id')).rows, reviews)
    assert.deepEqual(first(await db.query('select * from study_groups where id=$1', [newGroup])), createdBefore)
    assert.deepEqual(first(await db.query('select * from study_groups where id=$1', [oldGroup])), oldGroupBefore)
    assert.deepEqual(await policies(), policiesBefore)
    assert.equal(first(await db.query("select proacl::text as acl from pg_proc where oid='public.xelay_create_study_group(uuid)'::regprocedure")).acl, createAcl)
    await rejectsWith(db.query('update study_groups set cohort_start_year=$2 where id=$1', [newGroup, anchor - 1]), 'GROUP_COHORT_SNAPSHOT_IMMUTABLE')
    assert.equal(await create(newRequest), newGroup)
  })
})
