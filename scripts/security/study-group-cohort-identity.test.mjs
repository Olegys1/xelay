// Isolated full-chain PostgreSQL regression; no production, provider or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const migration = await readFile(new URL('../../supabase/migrations/202610150007_study_group_cohort_identity.sql', import.meta.url), 'utf8')
const first = result => result.rows[0]
const rejectsWith = (work, message) => assert.rejects(work, error => error.message.includes(message))

test('full migration chain separates group cohorts without taking over existing groups', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610150006', beforeMigrationsSql: `
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  ` })
  const { db, asUser, seedUser } = fx
  t.after(() => fx.close())
  const university = randomUUID(), unit = randomUUID(), specialty = randomUUID()
  const program = 'Synthetic Finance'
  await db.query("insert into universities(id,name,slug) values($1,'Cohort fixture university',$2)", [university, 'cohort-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Cohort faculty',$3,'faculty')", [unit, university, 'cohort-' + unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'COHORT',$4,$4)`, [specialty, university, unit, program])
  const user = async (year = 1, level = 'bachelor') => {
    const id = randomUUID()
    await seedUser(id, { username: 'cohort_' + id.replaceAll('-', '').slice(0, 16),
      university_id: university, academic_unit_id: unit, specialty_id: specialty,
      study_year: year, experience: level, categories: ['General'] })
    return id
  }
  const request = async (owner, name, extra = {}) => {
    const id = randomUUID()
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
      specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
      select $1,id,full_name,$3,$4,$5,$6,'cohort_fixture','approved',id,now() from profiles where id=$2`,
    [id, owner, university, unit, program, name])
    return { id, owner, name, ...extra }
  }
  const legacyGroup = async (context) => {
    const id = randomUUID()
    await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
      values($1,$2,$3,$4,$5,$6,$7)`, [id, context.id, context.owner, university, unit, program, context.name])
    await db.query(`insert into study_group_members(group_id,user_id,status,invited_by,accepted_at)
      values($1,$2,'accepted',$2,now())`, [id, context.owner])
    return id
  }
  const addMember = async (group, owner, member) => db.query(`insert into study_group_members(group_id,user_id,status,invited_by,accepted_at)
    values($1,$2,'accepted',$3,now())`, [group, member, owner])
  const create = async context => first(await asUser(context.owner, 'select xelay_create_study_group($1) as id', [context.id])).id
  const snapshot = async (table, id) => first(await db.query(`select cohort_start_year,study_level from ${table} where id=$1`, [id]))
  const anchor = first(await db.query('select public.xelay_current_academic_year()::integer as year')).year

  const oldOwner = await user(null)
  const oldRequest = await request(oldOwner, 'Ф-1')
  const oldGroup = await legacyGroup(oldRequest)
  const oldMembers = []
  for (let i = 0; i < 4; i++) {
    const member = await user(1)
    oldMembers.push(member)
    await addMember(oldGroup, oldOwner, member)
  }
  const newOwner = await user(4)
  const newRequest = await request(newOwner, 'Ф-1')
  const unknownOwner = await user(null)
  const unknownRequest = await request(unknownOwner, 'UNKNOWN-1')
  const unknownGroup = await legacyGroup(unknownRequest)
  const conflictingOwner = await user(null)
  const conflictingRequest = await request(conflictingOwner, 'MIXED-1')
  const conflictingGroup = await legacyGroup(conflictingRequest)
  await addMember(conflictingGroup, conflictingOwner, await user(1))
  await addMember(conflictingGroup, conflictingOwner, await user(2))

  const lesson = first(await asUser(oldOwner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,
    lesson_type,valid_from,valid_until,created_by) values($1,1,'08:00','09:20',$2,'lecture','2026-10-15','2026-12-31',$3) returning id`,
  [oldGroup, program, oldOwner])).id
  const homework = first(await asUser(oldOwner, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
    values($1,$2,'2026-10-19','Preserve the original group homework',$3) returning id`, [oldGroup, lesson, oldOwner])).id
  const oldMemberships = (await db.query('select * from study_group_members where group_id=$1 order by id', [oldGroup])).rows
  let newGroup

  await t.test('reproduces the old unique-index failure for another course', async () => {
    await assert.rejects(create(newRequest), error => error.code === '23505')
  })
  await t.test('applies migration and resolves unanimous legacy membership evidence', async () => {
    await db.exec(migration)
    assert.deepEqual(await snapshot('study_groups', oldGroup), { cohort_start_year: anchor, study_level: 'bachelor' })
    assert.deepEqual(await snapshot('class_representative_requests', oldRequest.id), { cohort_start_year: anchor, study_level: 'bachelor' })
    assert.deepEqual(await snapshot('class_representative_requests', newRequest.id), { cohort_start_year: anchor - 3, study_level: 'bachelor' })
    assert.deepEqual(await snapshot('study_groups', conflictingGroup), { cohort_start_year: null, study_level: null })
  })
  await t.test('creates the fourth-year group independently while preserving existing students and homework', async () => {
    newGroup = await create(newRequest)
    assert.notEqual(newGroup, oldGroup)
    const group = first(await db.query('select representative_id,representative_request_id,cohort_start_year,study_level from study_groups where id=$1', [newGroup]))
    assert.deepEqual(group, { representative_id: newOwner, representative_request_id: newRequest.id, cohort_start_year: anchor - 3, study_level: 'bachelor' })
    assert.deepEqual((await db.query('select * from study_group_members where group_id=$1 order by id', [oldGroup])).rows, oldMemberships)
    assert.deepEqual((await db.query('select user_id,status from study_group_members where group_id=$1', [newGroup])).rows,
      [{ user_id: newOwner, status: 'accepted' }])
    assert.equal(first(await asUser(oldMembers[0], 'select body from study_group_homework where id=$1', [homework])).body, 'Preserve the original group homework')
    assert.equal((await asUser(newOwner, 'select id from study_group_homework where id=$1', [homework])).rows.length, 0)
  })
  await t.test('retries return the same group and cannot duplicate ownership', async () => {
    assert.equal(await create(newRequest), newGroup)
    assert.equal(first(await db.query('select count(*)::int as count from study_groups where representative_request_id=$1', [newRequest.id])).count, 1)
  })
  await t.test('rejects an unrelated owner of the same degree and cohort', async () => {
    const duplicate = await request(await user(4), '  ф-1  ')
    await rejectsWith(create(duplicate), 'GROUP_ALREADY_EXISTS')
    assert.equal((await db.query('select id from study_groups where representative_request_id=$1', [duplicate.id])).rows.length, 0)
  })
  await t.test('another degree remains separate even for the same name and entry year', async () => {
    const masters = await request(await user(1, 'master'), 'Ф-1')
    const group = await create(masters)
    assert.notEqual(group, oldGroup)
    assert.deepEqual(await snapshot('study_groups', group), { cohort_start_year: anchor, study_level: 'master' })
  })
  await t.test('unknown legacy identity is preserved and requires review before a possible collision', async () => {
    assert.deepEqual(await snapshot('study_groups', unknownGroup), { cohort_start_year: null, study_level: null })
    const known = await request(await user(1), 'UNKNOWN-1')
    await rejectsWith(create(known), 'GROUP_IDENTITY_NEEDS_REVIEW')
    const mixed = await request(await user(1), 'MIXED-1')
    await rejectsWith(create(mixed), 'GROUP_IDENTITY_NEEDS_REVIEW')
  })
  await t.test('unknown new cohorts can use a unique base but cannot overlap any existing base', async () => {
    const unique = await request(await user(null), 'UNIQUE-UNKNOWN')
    const group = await create(unique)
    assert.deepEqual(await snapshot('study_groups', group), { cohort_start_year: null, study_level: null })
    assert.equal(await create(unique), group)
    const collision = await request(await user(null), 'Ф-1')
    await rejectsWith(create(collision), 'GROUP_COHORT_REQUIRED')
  })
  await t.test('existing approved-request snapshot does not move after profile corrections', async () => {
    await asUser(newOwner, 'update profiles set study_year=3 where id=$1', [newOwner])
    assert.equal(await create(newRequest), newGroup)
    assert.deepEqual(await snapshot('class_representative_requests', newRequest.id), { cohort_start_year: anchor - 3, study_level: 'bachelor' })
    assert.deepEqual(await snapshot('study_groups', newGroup), { cohort_start_year: anchor - 3, study_level: 'bachelor' })
  })
  await t.test('authenticated direct requests overwrite forged degree/cohort values from the actual profile', async () => {
    const applicant = await user(2)
    const forged = first(await asUser(applicant, `insert into class_representative_requests(user_id,full_name,university_id,
      academic_unit_id,specialty,group_name,telegram_username,cohort_start_year,study_level)
      select id,full_name,university_id,academic_unit_id,specialty,'FORGED-1','cohort_fixture',1901,'master'
      from profiles where id=$1 returning id`, [applicant])).id
    assert.deepEqual(await snapshot('class_representative_requests', forged), { cohort_start_year: anchor - 1, study_level: 'bachelor' })
  })
  await t.test('known request and group snapshots reject direct mutation even by the fixture owner', async () => {
    await rejectsWith(db.query('update class_representative_requests set cohort_start_year=1901 where id=$1', [newRequest.id]), 'GROUP_COHORT_SNAPSHOT_IMMUTABLE')
    await rejectsWith(db.query("update study_groups set study_level='master' where id=$1", [newGroup]), 'GROUP_COHORT_SNAPSHOT_IMMUTABLE')
    await assert.rejects(asUser(newOwner, 'update study_groups set cohort_start_year=1901 where id=$1', [newGroup]), error => error.code === '42501')
  })
  await t.test('new creation remains authenticated and request-owner scoped', async () => {
    await rejectsWith(asUser(await user(1), 'select xelay_create_study_group($1)', [newRequest.id]), 'Approved class representative request not found')
    await rejectsWith(asUser(null, 'select xelay_create_study_group($1)', [newRequest.id]), 'Authentication required')
    await assert.rejects(asUser(null, 'select xelay_create_study_group($1)', [newRequest.id], { role: 'anon' }), error => error.code === '42501')
  })
  await t.test('private cohort helpers introduce no callable client or service capability', async () => {
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_private_profile_group_cohort(uuid,uuid,uuid,text)','EXECUTE') as allowed", [role])).allowed, false)
      assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_guard_class_rep_cohort_snapshot()','EXECUTE') as allowed", [role])).allowed, false)
      assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_guard_study_group_cohort_snapshot()','EXECUTE') as allowed", [role])).allowed, false)
    }
  })
  await t.test('migration retry is idempotent and cannot reinterpret known snapshots', async () => {
    await db.exec(migration)
    assert.deepEqual(await snapshot('study_groups', newGroup), { cohort_start_year: anchor - 3, study_level: 'bachelor' })
    assert.deepEqual(await snapshot('study_groups', oldGroup), { cohort_start_year: anchor, study_level: 'bachelor' })
    assert.equal(await create(newRequest), newGroup)
    assert.deepEqual((await db.query('select * from study_group_members where group_id=$1 order by id', [oldGroup])).rows, oldMemberships)
  })
})
