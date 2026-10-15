// Isolated PostgreSQL and synthetic people only; never calls production or mail.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const first = result => result.rows[0]
const version = '2026-10-15.1'
const privacy = { xelay_privacy_consent: true, xelay_privacy_policy_version: version, xelay_privacy_consent_version: version }

test('privacy receipt migration enforces every new signup without changing existing accounts or academic registration', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610150010', beforeMigrationsSql: `
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
    create role supabase_auth_admin;
    grant usage on schema auth,public to supabase_auth_admin;
    grant select,insert,update,delete on auth.users to supabase_auth_admin;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const existing = randomUUID(), reader = randomUUID()
  await seedUser(existing)
  await seedUser(reader)
  const university = randomUUID(), unit = randomUUID(), specialty = randomUUID()
  await db.query("insert into universities(id,name,slug) values($1,'Privacy fixture university',$2)", [university, 'privacy-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Privacy fixture faculty',$3,'faculty')", [unit, university, 'privacy-' + unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'PRIVACY','Privacy fixture program','Privacy fixture program')`, [specialty, university, unit])
  const authAdmin = async (sql, params = []) => {
    await db.exec('set role supabase_auth_admin')
    try { return await db.query(sql, params) } finally { await db.exec('reset role') }
  }
  const signup = async (metadata, { id = randomUUID(), email = `${id}@example.test` } = {}) => {
    await authAdmin('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)', [id, email, JSON.stringify(metadata)])
    return id
  }
  const studentMeta = overrides => ({
    xelay_registration_version: 1, account_type: 'student', full_name: 'Synthetic privacy student',
    username: 'privacy_' + randomUUID().replaceAll('-', '').slice(0, 15), country: 'Україна', city: 'Київ', bio: '',
    experience: 'bachelor', categories: ['General'], university_id: university, academic_unit_id: unit,
    specialty_id: specialty, specialty: 'Privacy fixture program', ...privacy, ...overrides,
  })
  const policies = async () => (await db.query(`select schemaname,tablename,policyname,roles,cmd,qual,with_check
    from pg_policies where schemaname='public' and tablename in('profiles','user_roles','study_group_schedule','study_group_homework')
    order by schemaname,tablename,policyname`)).rows
  const policiesBefore = await policies()
  const registrationBody = first(await db.query(`select pg_get_functiondef(
    'public.xelay_create_registration_profile()'::regprocedure) as body`)).body
  const migration = await readFile(new URL('supabase/migrations/202610150011_privacy_consent.sql', root), 'utf8')
  await db.exec(migration)
  const receipts = async id => (await db.query('select to_jsonb(r) as value from user_privacy_consents r where user_id=$1', [id])).rows.map(row => row.value)
  let student, teacher, markerless

  await t.test('rollout starts in grace mode and old forms receive no fabricated receipt', async () => {
    assert.equal(first(await db.query('select enforce_new_signups from xelay_privacy_consent_settings where singleton')).enforce_new_signups, false)
    const { xelay_privacy_consent: _accepted, xelay_privacy_policy_version: _policy, xelay_privacy_consent_version: _consent, ...cached } = studentMeta()
    const id = await signup(cached)
    assert.equal(first(await db.query('select id from profiles where id=$1', [id])).id, id)
    assert.deepEqual(await receipts(id), [])
    await db.exec(migration)
    assert.equal(first(await db.query('select enforce_new_signups from xelay_privacy_consent_settings where singleton')).enforce_new_signups, false)
  })
  await t.test('valid new forms are recorded during grace while partial and invalid consent are already blocked', async () => {
    const id = await signup(studentMeta())
    assert.equal((await receipts(id)).length, 1)
    for (const invalid of [
      { xelay_privacy_consent: true }, { xelay_privacy_consent: false },
      { xelay_privacy_policy_version: version }, { xelay_privacy_consent_version: version },
      { ...privacy, xelay_privacy_consent: 'true' }, { ...privacy, xelay_privacy_policy_version: 'old' },
    ]) await assert.rejects(signup(invalid), /PRIVACY_CONSENT_REQUIRED|PRIVACY_VERSION_OUTDATED/)
    for (const user of [existing, id]) {
      for (const role of ['authenticated', 'anon', 'service_role']) {
        await assert.rejects(asUser(user, 'select * from xelay_privacy_consent_settings', [], { role }), error => error.code === '42501')
        await assert.rejects(asUser(user, 'update xelay_privacy_consent_settings set enforce_new_signups=false', [], { role }), error => error.code === '42501')
        await assert.rejects(asUser(user, 'delete from xelay_privacy_consent_settings', [], { role }), error => error.code === '42501')
        await assert.rejects(asUser(user, 'insert into xelay_privacy_consent_settings values(true,false)', [], { role }), error => error.code === '42501')
      }
    }
  })
  await t.test('an absent private singleton fails closed even for valid consent or legacy requests', async () => {
    await db.exec('delete from xelay_privacy_consent_settings')
    await assert.rejects(signup(privacy), /PRIVACY_CONSENT_CONFIGURATION_MISSING/)
    await assert.rejects(signup({}), /PRIVACY_CONSENT_CONFIGURATION_MISSING/)
    await db.exec('insert into xelay_privacy_consent_settings(singleton,enforce_new_signups) values(true,false)')
  })
  await t.test('operator activation enables strict signup validation without exposing a client switch', async () => {
    await db.exec('update public.xelay_privacy_consent_settings set enforce_new_signups=true where singleton')
    assert.equal(first(await db.query('select enforce_new_signups from xelay_privacy_consent_settings where singleton')).enforce_new_signups, true)
    await assert.rejects(signup({ rollout: true, enforce_new_signups: false, skip_privacy: true }), /PRIVACY_CONSENT_REQUIRED/)
    assert.deepEqual((await db.query("select policyname from pg_policies where schemaname='public' and tablename='xelay_privacy_consent_settings'")).rows, [])
  })
  await t.test('existing accounts gain no fabricated receipt and retain own-profile reads and edits', async () => {
    assert.deepEqual(await receipts(existing), [])
    assert.equal(first(await asUser(existing, 'select id from profiles where id=$1', [existing])).id, existing)
    await asUser(existing, 'update profiles set bio=$2 where id=$1', [existing, 'Existing profile remains editable'])
    assert.equal(first(await asUser(existing, 'select bio from profiles where id=$1', [existing])).bio, 'Existing profile remains editable')
    assert.deepEqual(await policies(), policiesBefore)
    assert.equal(first(await db.query(`select pg_get_functiondef('public.xelay_create_registration_profile()'::regprocedure) as body`)).body, registrationBody)
  })
  await t.test('GoTrue auth-admin cannot create accounts with missing, false or incorrectly typed consent', async () => {
    for (const value of [undefined, null, false, 'true', 1, {}, []]) {
      const id = randomUUID()
      const metadata = studentMeta({ xelay_privacy_consent: value })
      await assert.rejects(signup(metadata, { id }), /PRIVACY_CONSENT_REQUIRED/)
      assert.equal(first(await db.query('select count(*)::int as count from auth.users where id=$1', [id])).count, 0)
      assert.equal(first(await db.query('select count(*)::int as count from profiles where id=$1', [id])).count, 0)
      assert.deepEqual(await receipts(id), [])
    }
  })
  await t.test('both exact document versions are required and cached clients receive named errors', async () => {
    for (const changes of [
      { xelay_privacy_policy_version: undefined }, { xelay_privacy_consent_version: undefined },
      { xelay_privacy_policy_version: 'old' }, { xelay_privacy_consent_version: 'old' },
      { xelay_privacy_policy_version: 2026 }, { xelay_privacy_consent_version: null },
    ]) await assert.rejects(signup(studentMeta(changes)), /PRIVACY_VERSION_OUTDATED/)
    const { xelay_privacy_consent: _accepted, xelay_privacy_policy_version: _policy, xelay_privacy_consent_version: _consent, ...cached } = studentMeta()
    await assert.rejects(signup(cached), /PRIVACY_CONSENT_REQUIRED/)
  })
  await t.test('omitting or changing registration marker never bypasses privacy checks', async () => {
    for (const marker of [undefined, 0, 'legacy', 'company-1']) {
      await assert.rejects(signup({ xelay_registration_version: marker }), /PRIVACY_CONSENT_REQUIRED/)
      await assert.rejects(signup({ xelay_registration_version: marker, xelay_privacy_consent: true }), /PRIVACY_VERSION_OUTDATED/)
    }
    await assert.rejects(signup({ ...studentMeta(), trusted_backend: true, skip_privacy: true, xelay_privacy_consent: false }), /PRIVACY_CONSENT_REQUIRED/)
  })
  await t.test('valid student signup records current versions and server time while creating its ordinary profile', async () => {
    const before = first(await db.query('select clock_timestamp() as value')).value
    student = await signup(studentMeta({ accepted_at: '1970-01-01T00:00:00Z', xelay_privacy_accepted_at: '1970-01-01T00:00:00Z', source: 'admin' }))
    const after = first(await db.query('select clock_timestamp() as value')).value
    const [receipt] = await receipts(student)
    assert.deepEqual({ ...receipt, accepted_at: null }, { user_id: student, privacy_policy_version: version, consent_version: version, source: 'signup', accepted_at: null })
    assert.ok(Date.parse(receipt.accepted_at) >= new Date(before).getTime())
    assert.ok(Date.parse(receipt.accepted_at) <= new Date(after).getTime())
    const profile = first(await db.query('select account_type,specialty_id,experience from profiles where id=$1', [student]))
    assert.deepEqual(profile, { account_type: 'student', specialty_id: specialty, experience: 'bachelor' })
  })
  await t.test('valid teacher signup keeps teacher profile and verification-request creation unchanged', async () => {
    teacher = await signup(studentMeta({ account_type: 'teacher', teacher_department: 'Synthetic department', teacher_position: 'Викладач',
      experience: '', categories: [], specialty_id: null, specialty: '' }))
    assert.equal((await receipts(teacher)).length, 1)
    const profile = first(await db.query('select account_type,specialty_id from profiles where id=$1', [teacher]))
    assert.deepEqual(profile, { account_type: 'teacher', specialty_id: null })
    assert.equal(first(await db.query('select count(*)::int as count from teacher_verification_requests where user_id=$1', [teacher])).count, 1)
  })
  await t.test('a consented account without registration marker is recorded without fabricating a profile', async () => {
    markerless = await signup(privacy)
    assert.equal((await receipts(markerless)).length, 1)
    assert.equal(first(await db.query('select count(*)::int as count from profiles where id=$1', [markerless])).count, 0)
  })
  await t.test('each user reads only own receipts; anonymous and service clients have no table grant', async () => {
    assert.equal((await asUser(student, 'select * from user_privacy_consents')).rows.length, 1)
    assert.equal((await asUser(student, 'select * from user_privacy_consents where user_id=$1', [teacher])).rows.length, 0)
    assert.equal((await asUser(reader, 'select * from user_privacy_consents')).rows.length, 0)
    for (const role of ['anon', 'service_role']) await assert.rejects(asUser(null, 'select * from user_privacy_consents', [], { role }), error => error.code === '42501')
  })
  await t.test('clients cannot insert, rewrite, delete or forge historical receipts', async () => {
    for (const role of ['authenticated', 'anon', 'service_role']) {
      const options = { role }
      await assert.rejects(asUser(student, `insert into user_privacy_consents(user_id,privacy_policy_version,consent_version,accepted_at,source)
        values($1,'fake','fake','1970-01-01','signup')`, [reader], options), error => error.code === '42501')
      await assert.rejects(asUser(student, "update user_privacy_consents set accepted_at='1970-01-01' where user_id=$1", [student], options), error => error.code === '42501')
      await assert.rejects(asUser(student, 'delete from user_privacy_consents where user_id=$1', [student], options), error => error.code === '42501')
    }
    await assert.rejects(db.query("update user_privacy_consents set source='signup' where user_id=$1", [student]), /RECEIPT_IMMUTABLE/)
    await assert.rejects(db.query('delete from user_privacy_consents where user_id=$1', [student]), /RECEIPT_IMMUTABLE/)
    assert.equal((await receipts(student)).length, 1)
    assert.deepEqual(await receipts(reader), [])
  })
  await t.test('Auth metadata and email updates cannot rewrite or fabricate acceptance evidence', async () => {
    const before = await receipts(student)
    await authAdmin('update auth.users set raw_user_meta_data=$2::jsonb,email=$3 where id=$1',
      [student, JSON.stringify({ xelay_privacy_consent: false, xelay_privacy_policy_version: 'forged', accepted_at: '1970-01-01' }), `${randomUUID()}@example.test`])
    assert.deepEqual(await receipts(student), before)
    await authAdmin('update auth.users set raw_user_meta_data=$2::jsonb where id=$1', [existing, JSON.stringify(privacy)])
    assert.deepEqual(await receipts(existing), [])
    assert.equal(first(await asUser(existing, 'select id from profiles where id=$1', [existing])).id, existing)
  })
  await t.test('existing users explicitly accept only for themselves with immutable server time and account source', async () => {
    const before = first(await db.query('select clock_timestamp() as value')).value
    const accept = async user => first(await asUser(user,
      'select xelay_accept_privacy_consent($1,$2,true) as value', [version, version])).value
    const acknowledged = await accept(existing)
    const after = first(await db.query('select clock_timestamp() as value')).value
    assert.deepEqual({ ...acknowledged, accepted_at: null }, {
      privacy_policy_version: version, consent_version: version, source: 'account', accepted_at: null,
    })
    assert.ok(Date.parse(acknowledged.accepted_at) >= new Date(before).getTime())
    assert.ok(Date.parse(acknowledged.accepted_at) <= new Date(after).getTime())
    assert.deepEqual(await accept(existing), acknowledged)
    const [receipt] = await receipts(existing)
    assert.equal(receipt.user_id, existing)
    assert.equal(receipt.accepted_at, acknowledged.accepted_at)
    assert.equal((await receipts(existing)).length, 1)
    assert.deepEqual(await receipts(reader), [])
    assert.equal((await asUser(existing, 'select * from user_privacy_consents where user_id=$1', [student])).rows.length, 0)
    assert.equal((await asUser(reader, 'select * from user_privacy_consents where user_id=$1', [existing])).rows.length, 0)
    const signupBefore = await receipts(student)
    const signupResult = await accept(student)
    assert.equal(signupResult.source, 'signup')
    assert.deepEqual(await receipts(student), signupBefore)
  })
  await t.test('own-account acceptance rejects false, stale documents, anonymous callers and nonexistent identities', async () => {
    const call = (policy, consentVersion, accepted, user = reader, options = {}) => asUser(user,
      'select xelay_accept_privacy_consent($1,$2,$3)', [policy, consentVersion, accepted], options)
    for (const accepted of [false, null]) await assert.rejects(call(version, version, accepted), /PRIVACY_CONSENT_REQUIRED/)
    for (const [policy, consentVersion] of [['old', version], [version, 'old'], [null, version], [version, null]]) {
      await assert.rejects(call(policy, consentVersion, true), /PRIVACY_VERSION_OUTDATED/)
    }
    for (const role of ['anon', 'service_role']) await assert.rejects(call(version, version, true, null, { role }), error => error.code === '42501')
    await assert.rejects(call(version, version, true, null), /PRIVACY_AUTH_REQUIRED/)
    await assert.rejects(call(version, version, true, randomUUID()), error => error.code === '23503')
    assert.deepEqual(await receipts(reader), [])
    await assert.rejects(asUser(reader,
      'select xelay_accept_privacy_consent($1,$2,true,$3)', [version, version, existing]), error => error.code === '42883')
    await assert.rejects(signup({}), /PRIVACY_CONSENT_REQUIRED/)
  })
  await t.test('later registration failures roll back Auth, receipt and profile in the same transaction', async () => {
    const id = randomUUID()
    await assert.rejects(signup(studentMeta({ specialty_id: null }), { id }), /ACADEMIC_SPECIALTY_REQUIRED/)
    assert.equal(first(await db.query('select count(*)::int as count from auth.users where id=$1', [id])).count, 0)
    assert.equal(first(await db.query('select count(*)::int as count from profiles where id=$1', [id])).count, 0)
    assert.deepEqual(await receipts(id), [])
  })
  await t.test('account deletion cascades only its own receipts', async () => {
    await authAdmin('delete from auth.users where id=$1', [markerless])
    assert.deepEqual(await receipts(markerless), [])
    assert.equal((await receipts(student)).length, 1)
  })
  await t.test('reapplication preserves receipts, internal function ACLs and composite version history', async () => {
    const before = await receipts(student)
    const existingBefore = await receipts(existing)
    await db.exec(migration)
    assert.equal(first(await db.query('select enforce_new_signups from xelay_privacy_consent_settings where singleton')).enforce_new_signups, true)
    await assert.rejects(signup({}), /PRIVACY_CONSENT_REQUIRED/)
    assert.deepEqual(await receipts(student), before)
    assert.deepEqual(await receipts(existing), existingBefore)
    assert.deepEqual(await policies(), policiesBefore)
    const keys = first(await db.query(`select pg_get_constraintdef(oid) as value from pg_constraint
      where conrelid='public.user_privacy_consents'::regclass and contype='p'`)).value
    assert.equal(keys, 'PRIMARY KEY (user_id, privacy_policy_version, consent_version)')
    for (const role of ['anon', 'authenticated', 'service_role']) {
      for (const signature of ['xelay_require_signup_privacy_consent()', 'xelay_record_signup_privacy_consent()', 'xelay_guard_privacy_consent_receipt()']) {
        assert.equal(first(await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed', [role, 'public.' + signature])).allowed, false)
      }
      assert.equal(first(await db.query('select has_function_privilege($1,$2,\'EXECUTE\') as allowed',
        [role, 'public.xelay_accept_privacy_consent(text,text,boolean)'])).allowed, role === 'authenticated')
    }
  })
})
