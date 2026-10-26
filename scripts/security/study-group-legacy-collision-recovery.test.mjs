// Isolated PostgreSQL and synthetic identities only. No production or network.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const migration = await readFile(new URL('../../supabase/migrations/202610260002_study_group_legacy_collision_recovery.sql', import.meta.url), 'utf8')
const first = result => result.rows[0]
const fails = (work, message) => assert.rejects(work, error => error.message === message)

test('legacy collisions recover only from consistent anchored evidence, without changing or joining old groups', async t => {
  // Install the real chain through the latest unrelated migration before the
  // platform-news migration's deployment-specific admin-helper fingerprint.
  const fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,
      provider text,identity_data jsonb default '{}');
  ` })
  t.after(() => fx.close())
  const { db, seedUser, asUser } = fx
  const university = randomUUID(), unit = randomUUID(), specialty = randomUUID(), alternate = randomUUID()
  const program = 'Synthetic Marketing', alternateProgram = 'Synthetic Other Programme'
  await db.query("insert into universities(id,name,slug) values($1,'Synthetic recovery university',$2)", [university, 'recovery-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Synthetic recovery faculty',$3,'faculty')", [unit, university, 'recovery-' + unit])
  for (const [id, name] of [[specialty, program], [alternate, alternateProgram]]) await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'RECOVERY',$4,$4)`, [id, university, unit, name])
  const anchor = first(await db.query('select xelay_current_academic_year()::int as year')).year
  const user = async (year = 2, level = 'bachelor', programId = specialty) => {
    const id = randomUUID()
    await seedUser(id, { username: 'recovery_' + id.replaceAll('-', '').slice(0, 16), university_id: university,
      academic_unit_id: unit, specialty_id: programId, experience: level, study_year: year, categories: ['General'] })
    return id
  }
  const request = async (owner, name) => {
    const id = randomUUID()
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,
      group_name,telegram_username,status,reviewed_by,reviewed_at)
      select $1,id,full_name,university_id,academic_unit_id,specialty,$3,'synthetic_recovery','approved',id,now()
      from profiles where id=$2`, [id, owner, name])
    return { id, owner, name }
  }
  const addMember = (group, owner, member, status = 'accepted') => db.transaction(async tx => {
    // Seed pre-existing memberships with their representative as the actor so
    // the installed notification guards also see a valid synthetic identity.
    await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: owner, role: 'authenticated' })])
    return tx.query(`insert into study_group_members(group_id,user_id,status,invited_by,accepted_at)
      values($1,$2,$3,$4,case when $3='accepted' then now() end)`, [group, member, status, owner])
  })
  const legacy = async (name, year = 3, level = 'bachelor', requestYear = null) => {
    const owner = await user(requestYear, level), req = await request(owner, name), group = randomUUID()
    await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
      values($1,$2,$3,$4,$5,$6,$7)`, [group, req.id, owner, university, unit, program, name])
    await addMember(group, owner, owner)
    if (year !== requestYear) await asUser(owner, 'update profiles set study_year=$2 where id=$1', [owner, year])
    return { group, owner, request: req.id, name }
  }
  const create = async (req, actor = req.owner) => first(await asUser(actor, 'select xelay_create_study_group($1) as id', [req.id])).id
  const seedRecordedProgression = async (sql, params) => {
    // Reproduce historical server-owned state in this isolated fixture. Normal
    // profile writes intentionally recalculate/clear these fields themselves.
    await db.exec('alter table profiles disable trigger xelay_profile_study_year_progression')
    try { await db.query(sql, params) }
    finally { await db.exec('alter table profiles enable trigger xelay_profile_study_year_progression') }
  }
  const snapshot = async groups => Object.fromEntries(await Promise.all([
    ['groups', 'study_groups', 'id'], ['members', 'study_group_members', 'group_id'],
    ['schedule', 'study_group_schedule', 'group_id'], ['homework', 'study_group_homework', 'group_id'],
  ].map(async ([key, table, column]) => [key, (await db.query(`select to_jsonb(t) as data from public.${table} t
    where ${column}=any($1::uuid[]) order by to_jsonb(t)::text`, [groups])).rows])))
  const policies = async () => (await db.query(`select tablename,policyname,roles,cmd,qual,with_check from pg_policies
    where schemaname='public' and tablename in('class_representative_requests','study_groups','study_group_members','study_group_schedule','study_group_homework')
    order by tablename,policyname`)).rows
  const acl = async () => first(await db.query("select proowner,proacl::text as acl from pg_proc where oid='public.xelay_create_study_group(uuid)'::regprocedure"))
  const old = await legacy('МА-2')
  await addMember(old.group, old.owner, await user(3))
  await addMember(old.group, old.owner, await user(null))
  await addMember(old.group, old.owner, await user(2), 'pending')
  await addMember(old.group, old.owner, await user(2), 'removed')
  const applicant = await request(await user(2), old.name)
  const firstYear = await request(await user(1), old.name), firstYearGroup = randomUUID()
  await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name,cohort_start_year,study_level)
    values($1,$2,$3,$4,$5,$6,$7,$8,'bachelor')`, [firstYearGroup, firstYear.id, firstYear.owner, university, unit, program, old.name, anchor])
  await addMember(firstYearGroup, firstYear.owner, firstYear.owner)
  const lesson = first(await asUser(old.owner, `insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,created_by)
    values($1,1,'08:00','09:20','Synthetic private lesson','lecture','2026-10-12','2026-10-26',$2) returning id`, [old.group, old.owner])).id
  const homework = first(await asUser(old.owner, `insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
    values($1,$2,'2026-10-19','Synthetic original private homework',$3) returning id`, [old.group, lesson, old.owner])).id
  const before = await snapshot([old.group, firstYearGroup]), policiesBefore = await policies(), aclBefore = await acl()
  const requestBefore = first(await db.query('select * from class_representative_requests where id=$1', [old.request]))
  let newGroup

  await t.test('reproduces failure despite distinct complete anchored representative evidence', async () => {
    await fails(create(applicant), 'GROUP_IDENTITY_NEEDS_REVIEW')
  })
  await t.test('installation changes no existing data, policies, owner or grants', async () => {
    await db.exec(migration)
    assert.deepEqual(await snapshot([old.group, firstYearGroup]), before)
    assert.deepEqual(await policies(), policiesBefore)
    assert.deepEqual(await acl(), aclBefore)
    assert.equal(first(await db.query('select count(*)::int as n from study_group_cohort_collision_resolutions')).n, 0)
  })
  await t.test('consistent old third-year evidence permits separate second-year group beside known first-year group', async () => {
    newGroup = await create(applicant)
    assert.notEqual(newGroup, old.group)
    assert.notEqual(newGroup, firstYearGroup)
    assert.deepEqual(first(await db.query('select representative_request_id,representative_id,cohort_start_year,study_level from study_groups where id=$1', [newGroup])),
      { representative_request_id: applicant.id, representative_id: applicant.owner, cohort_start_year: anchor - 1, study_level: 'bachelor' })
    assert.deepEqual((await db.query('select user_id,status from study_group_members where group_id=$1', [newGroup])).rows,
      [{ user_id: applicant.owner, status: 'accepted' }])
    assert.deepEqual(await snapshot([old.group, firstYearGroup]), before)
    assert.deepEqual(first(await db.query('select * from class_representative_requests where id=$1', [old.request])), requestBefore)
    assert.equal(first(await db.query('select count(*)::int as n from study_group_cohort_collision_resolutions')).n, 0)
  })
  await t.test('new owner gains no legacy membership or private-content access; old users keep their data', async () => {
    for (const table of ['study_groups', 'study_group_schedule', 'study_group_homework']) {
      const column = table === 'study_groups' ? 'id' : 'group_id'
      assert.equal((await asUser(applicant.owner, `select id from ${table} where ${column}=$1`, [old.group])).rows.length, 0)
    }
    assert.equal(first(await asUser(old.owner, 'select body from study_group_homework where id=$1', [homework])).body, 'Synthetic original private homework')
  })
  await t.test('known same-cohort duplicates stay blocked and owner retries return exactly the original result', async () => {
    await fails(create(await request(await user(2), '  ма-2  ')), 'GROUP_ALREADY_EXISTS')
    assert.equal(await create(applicant), newGroup)
    assert.equal(await create({ id: old.request, owner: old.owner }), old.group)
    await asUser(applicant.owner, 'update profiles set study_year=1 where id=$1', [applicant.owner])
    assert.equal(await create(applicant), newGroup)
  })
  await t.test('same inferred legacy degree and cohort cannot be claimed or duplicated', async () => {
    const existing = await legacy('SAME-LEGACY')
    const req = await request(await user(3), existing.name)
    await fails(create(req), 'GROUP_ALREADY_EXISTS')
    assert.equal(first(await db.query('select count(*)::int as n from study_groups where representative_request_id=$1', [req.id])).n, 0)
  })
  await t.test('a different degree alone can distinguish an otherwise identical cohort', async () => {
    const existing = await legacy('DIFFERENT-DEGREE', 1, 'master')
    const req = await request(await user(1), existing.name)
    const group = await create(req)
    assert.notEqual(group, existing.group)
    assert.deepEqual(first(await db.query('select cohort_start_year,study_level from study_groups where id=$1', [group])),
      { cohort_start_year: anchor, study_level: 'bachelor' })
  })
  await t.test('an incomplete representative cannot be replaced by unanimous member evidence', async () => {
    const existing = await legacy('INCOMPLETE-OWNER', null)
    await addMember(existing.group, existing.owner, await user(3))
    await fails(create(await request(await user(2), existing.name)), 'GROUP_IDENTITY_NEEDS_REVIEW')
  })
  await t.test('one contradictory accepted member blocks automatic recovery regardless of majority', async () => {
    const existing = await legacy('CONFLICTING-MEMBER')
    await addMember(existing.group, existing.owner, await user(3))
    await addMember(existing.group, existing.owner, await user(3))
    await addMember(existing.group, existing.owner, await user(2))
    await fails(create(await request(await user(2), existing.name)), 'GROUP_IDENTITY_NEEDS_REVIEW')
  })
  await t.test('a contradictory known degree on an incomplete member profile remains evidence', async () => {
    const existing = await legacy('PARTIAL-DEGREE')
    await addMember(existing.group, existing.owner, await user(null, 'master'))
    await fails(create(await request(await user(2), existing.name)), 'GROUP_IDENTITY_NEEDS_REVIEW')
  })
  await t.test('a contradictory anchored course on a member without a known degree remains evidence', async () => {
    const existing = await legacy('PARTIAL-COHORT')
    await addMember(existing.group, existing.owner, await user(2, 'Student / Fresh Graduate'))
    await fails(create(await request(await user(2), existing.name)), 'GROUP_IDENTITY_NEEDS_REVIEW')
  })
  await t.test('a member from a different academic program makes the evidence ambiguous', async () => {
    const existing = await legacy('FOREIGN-PROGRAM')
    await addMember(existing.group, existing.owner, await user(3, 'bachelor', alternate))
    await fails(create(await request(await user(2), existing.name)), 'GROUP_IDENTITY_NEEDS_REVIEW')
  })
  await t.test('same group name in another program remains independently creatable', async () => {
    const req = await request(await user(2, 'bachelor', alternate), 'INCOMPLETE-OWNER')
    const group = await create(req)
    assert.equal(first(await db.query('select specialty from study_groups where id=$1', [group])).specialty, alternateProgram)
  })
  await t.test('terminal-year review flag blocks apparently complete representative or member evidence', async () => {
    for (const target of ['representative', 'member']) {
      const existing = await legacy('NEEDS-REVIEW-' + target)
      const profile = target === 'representative' ? existing.owner : await user(3)
      if (target === 'member') await addMember(existing.group, existing.owner, profile)
      await seedRecordedProgression('update profiles set study_year_needs_review=true where id=$1', [profile])
      await fails(create(await request(await user(2), existing.name)), 'GROUP_IDENTITY_NEEDS_REVIEW')
    }
  })
  await t.test('current profile changes cannot override a contradictory immutable old-request snapshot', async () => {
    const existing = await legacy('CHANGED-OWNER-COURSE', 3, 'bachelor', 2)
    await fails(create(await request(await user(2), existing.name)), 'GROUP_IDENTITY_NEEDS_REVIEW')
  })
  await t.test('anchored cohorts stay stable when a delayed annual job has not updated profiles', async () => {
    const existing = await legacy('DELAYED-PROGRESSION')
    await seedRecordedProgression('update profiles set study_year=2,study_year_academic_year=$2 where id=$1', [existing.owner, anchor - 1])
    const group = await create(await request(await user(2), existing.name))
    assert.notEqual(group, existing.group)
  })
  await t.test('exact operator-reviewed distinctions remain valid for unresolved contradictory evidence', async () => {
    const existing = await legacy('EXPLICIT-REVIEW', null)
    const req = await request(await user(2), existing.name)
    await db.query(`insert into study_group_cohort_collision_resolutions(request_id,existing_group_id,request_user_id,
      existing_representative_id,existing_representative_request_id,university_id,academic_unit_id,specialty,group_name,
      new_cohort_start_year,new_study_level,existing_cohort_start_year,existing_study_level,reason)
      select r.id,g.id,r.user_id,g.representative_id,g.representative_request_id,r.university_id,r.academic_unit_id,
        r.specialty,r.group_name,r.cohort_start_year,r.study_level,g.cohort_start_year,g.study_level,
        'Synthetic explicit operator distinction, independent of incomplete old profile evidence.'
      from class_representative_requests r cross join study_groups g where r.id=$1 and g.id=$2`, [req.id, existing.group])
    const saved = first(await db.query('select * from study_group_cohort_collision_resolutions where request_id=$1', [req.id]))
    await db.query('update study_group_cohort_collision_resolutions set new_cohort_start_year=$2 where request_id=$1', [req.id, anchor])
    await fails(create(req), 'GROUP_IDENTITY_NEEDS_REVIEW')
    await db.query('update study_group_cohort_collision_resolutions set new_cohort_start_year=$2 where request_id=$1', [req.id, saved.new_cohort_start_year])
    assert.notEqual(await create(req), existing.group)
  })
  await t.test('anonymous, another user and incomplete new requests cannot create groups', async () => {
    await fails(create(applicant, await user()), 'Approved class representative request not found')
    await fails(create(applicant, null), 'Authentication required')
    await assert.rejects(asUser(null, 'select xelay_create_study_group($1)', [applicant.id], { role: 'anon' }), error => error.code === '42501')
    await fails(create(await request(await user(null), 'INCOMPLETE-NEW')), 'GROUP_COHORT_REQUIRED')
  })
  await t.test('migration reapplication preserves old data, resolution records, grants and immutable snapshots', async () => {
    const data = await snapshot([old.group, firstYearGroup, newGroup])
    const reviews = (await db.query('select * from study_group_cohort_collision_resolutions order by request_id,existing_group_id')).rows
    await db.exec(migration)
    assert.deepEqual(await snapshot([old.group, firstYearGroup, newGroup]), data)
    assert.deepEqual((await db.query('select * from study_group_cohort_collision_resolutions order by request_id,existing_group_id')).rows, reviews)
    assert.deepEqual(await policies(), policiesBefore)
    assert.deepEqual(await acl(), aclBefore)
    await fails(db.query('update study_groups set cohort_start_year=$2 where id=$1', [newGroup, anchor]), 'GROUP_COHORT_SNAPSHOT_IMMUTABLE')
    assert.equal(await create(applicant), newGroup)
  })
})
