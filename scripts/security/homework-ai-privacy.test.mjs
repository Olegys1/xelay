// Real registration/consent functions in isolated PGlite. Synthetic identities
// only; this test never connects to Google, mail, OpenAI or a Supabase project.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const OLD = '2026-10-15.1', NEW = '2026-10-25.1'
const first = result => result.rows[0]
const migration = await readFile(new URL('supabase/migrations/202610250002_homework_ai_privacy_versions.sql', root), 'utf8')
const googleMigration = await readFile(new URL('supabase/migrations/202610220001_google_registration.sql', root), 'utf8')
const consent = version => ({ xelay_privacy_consent: true,
  xelay_privacy_policy_version: version, xelay_privacy_consent_version: version })
const invalidPairs = [[OLD, NEW], [NEW, OLD], [null, NEW], [NEW, null], [null, null], ['unknown', NEW], [NEW, 'unknown']]

test('additive privacy edition preserves receipts, registration and deferred Google completion', async t => {
  // Exercise the real current creator and consent functions, then the Google
  // migration, without unrelated later platform migrations or external cron.
  const fx = await createFixture({ useStagingParity: true, through: '202610160003', beforeMigrationsSql: `
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,
      provider text,identity_data jsonb default '{}');
    create role supabase_auth_admin;
    grant usage on schema auth,public to supabase_auth_admin;
    grant select,insert,update,delete on auth.users,auth.identities to supabase_auth_admin;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  await db.exec(googleMigration)
  const university = randomUUID(), unit = randomUUID(), specialty = randomUUID()
  await db.query("insert into universities(id,name,slug) values($1,'Privacy edition fixture',$2)", [university, 'edition-' + university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Synthetic faculty',$3,'faculty')", [unit, university, 'edition-' + unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'EDITION','Synthetic program','Synthetic program')`, [specialty, university, unit])
  const studentMeta = (version = OLD, overrides = {}) => ({
    xelay_registration_version: 1, account_type: 'student', full_name: 'Synthetic edition student',
    username: 'edition_' + randomUUID().replaceAll('-', '').slice(0, 16), country: 'Україна', city: 'Київ', bio: '',
    experience: 'bachelor', study_year: 1, categories: ['General'], university_id: university,
    academic_unit_id: unit, specialty_id: specialty, specialty: 'Synthetic program', ...consent(version), ...overrides,
  })
  const authAdmin = async (sql, params = []) => {
    await db.exec('set role supabase_auth_admin')
    try { return await db.query(sql, params) } finally { await db.exec('reset role') }
  }
  const signup = async (metadata, { id = randomUUID(), app = {}, confirmed = true } = {}) => {
    await authAdmin(`insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data)
      values($1,$2,$3,$4::jsonb,$5::jsonb)`,
    [id, `${id}@example.test`, confirmed ? '2026-10-25T09:00:00Z' : null, JSON.stringify(app), JSON.stringify(metadata)])
    return id
  }
  const receipts = async id => (await db.query(`select to_jsonb(r) as value from user_privacy_consents r
    where user_id=$1 order by privacy_policy_version,consent_version`, [id])).rows.map(row => row.value)
  const body = async signature => first(await db.query('select pg_get_functiondef($1::regprocedure) as value', [signature])).value
  const accept = async (id, policy, consentVersion = policy, accepted = true, options = {}) => first(await asUser(id,
    'select xelay_accept_privacy_consent($1,$2,$3) as value', [policy, consentVersion, accepted], options)).value
  const googleProfile = id => ({ ...studentMeta(NEW), expected_user_id: id })
  const googleSignup = async (metadata = {}, options = {}) => {
    const id = await signup({ email_verified: true, sub: 'synthetic-google-subject', ...metadata },
      { ...options, app: { provider: 'google', providers: ['google'] } })
    await authAdmin('insert into auth.identities(id,user_id,provider,identity_data) values($1,$2,\'google\',$3::jsonb)',
      [randomUUID(), id, JSON.stringify({ email_verified: true })])
    return id
  }
  const complete = async (id, policy = NEW, consentVersion = policy, accepted = true, profile = googleProfile(id)) =>
    first(await asUser(id, 'select xelay_complete_google_registration($1::jsonb,$2,$3,$4) as value',
      [JSON.stringify(profile), policy, consentVersion, accepted])).value
  const state = async id => first(await db.query(`select to_jsonb(g) as value from xelay_google_registrations g where user_id=$1`, [id]))?.value
  const profileCount = async id => first(await db.query('select count(*)::int as value from profiles where id=$1', [id])).value
  const permissions = async () => ({
    functions: (await db.query(`select p.oid::regprocedure::text as signature,p.proacl::text as acl,p.proowner,
      p.prosecdef,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in('xelay_require_signup_privacy_consent','xelay_record_signup_privacy_consent',
        'xelay_accept_privacy_consent','xelay_complete_google_registration','xelay_create_registration_profile',
        'xelay_guard_google_registration_profile','xelay_google_registration_status','xelay_guard_privacy_consent_receipt')
      order by signature`)).rows,
    tables: (await db.query(`select relname,relacl::text as acl,relrowsecurity from pg_class
      where oid in('public.user_privacy_consents'::regclass,'public.xelay_privacy_consent_settings'::regclass,
        'public.xelay_google_registrations'::regclass) order by relname`)).rows,
    policies: (await db.query(`select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies
      where schemaname='public' order by tablename,policyname`)).rows,
    triggers: (await db.query(`select tgname,pg_get_triggerdef(oid) as definition from pg_trigger
      where not tgisinternal and tgrelid in('auth.users'::regclass,'public.profiles'::regclass,
        'public.user_privacy_consents'::regclass) order by tgrelid,tgname`)).rows,
  })
  const existing = randomUUID(), reader = randomUUID()
  await seedUser(existing); await seedUser(reader)
  const oldSignup = await signup(studentMeta())
  const oldReceipt = await receipts(oldSignup)
  const pendingBeforeMigration = await googleSignup({ ...consent(NEW), xelay_registration_version: 1 })
  const pendingState = await state(pendingBeforeMigration)
  await db.exec('update xelay_privacy_consent_settings set enforce_new_signups=true where singleton')
  const permissionsBefore = await permissions()
  const unchangedSignatures = ['public.xelay_create_registration_profile()', 'public.xelay_guard_google_registration_profile()',
    'public.xelay_google_registration_status()', 'public.xelay_guard_privacy_consent_receipt()']
  const unchangedBodies = await Promise.all(unchangedSignatures.map(body))
  // SQL Editor transport may use CRLF inside the expected dollar-quoted
  // fragments even when already-stored function bodies use LF.
  await db.exec(migration.replaceAll('\n', '\r\n'))

  await t.test('migration leaves historical evidence, Google provisional state and all permissions unchanged', async () => {
    assert.deepEqual(await receipts(oldSignup), oldReceipt)
    assert.deepEqual(await receipts(existing), [])
    assert.deepEqual(await state(pendingBeforeMigration), pendingState)
    assert.equal(await profileCount(pendingBeforeMigration), 0)
    assert.deepEqual(await receipts(pendingBeforeMigration), [])
    assert.deepEqual(await permissions(), permissionsBefore)
    assert.deepEqual(await Promise.all(unchangedSignatures.map(body)), unchangedBodies)
    assert.equal(first(await db.query('select enforce_new_signups from xelay_privacy_consent_settings')).enforce_new_signups, true)
  })

  const newEmailUsers = []
  await t.test('email signup accepts both exact editions and records their real version, source and server time', async () => {
    for (const version of [OLD, NEW]) {
      const before = Date.now()
      const id = await signup(studentMeta(version, { accepted_at: '1970-01-01', source: 'forged' }))
      newEmailUsers.push(id)
      const [receipt] = await receipts(id)
      assert.equal(receipt.privacy_policy_version, version)
      assert.equal(receipt.consent_version, version)
      assert.equal(receipt.source, 'signup')
      assert.ok(Date.parse(receipt.accepted_at) >= before - 1000)
      assert.equal(await profileCount(id), 1)
      assert.equal(first(await db.query('select study_year from profiles where id=$1', [id])).study_year, 1)
    }
    const teacher = await signup(studentMeta(NEW, { account_type: 'teacher', teacher_department: 'Synthetic department',
      teacher_position: 'Викладач', experience: '', categories: [], specialty_id: null, specialty: '' }))
    assert.equal(first(await db.query('select account_type from profiles where id=$1', [teacher])).account_type, 'teacher')
    assert.equal(first(await db.query('select count(*)::int as value from teacher_verification_requests where user_id=$1', [teacher])).value, 1)
    assert.equal((await receipts(teacher))[0].privacy_policy_version, NEW)
  })

  await t.test('email rejects NULL, mixed and unknown editions and keeps later academic failures atomic', async () => {
    for (const [policy, consentVersion] of invalidPairs) {
      const id = randomUUID()
      await assert.rejects(signup(studentMeta(NEW, { xelay_privacy_policy_version: policy,
        xelay_privacy_consent_version: consentVersion }), { id }), /PRIVACY_VERSION_OUTDATED/)
      assert.deepEqual(await receipts(id), [])
      assert.equal(await profileCount(id), 0)
    }
    for (const accepted of [false, null, 'true', 1]) await assert.rejects(signup(studentMeta(NEW,
      { xelay_privacy_consent: accepted })), /PRIVACY_CONSENT_REQUIRED/)
    const id = randomUUID()
    await assert.rejects(signup(studentMeta(NEW, { specialty_id: null }), { id }), /ACADEMIC_SPECIALTY_REQUIRED/)
    assert.deepEqual(await receipts(id), [])
    assert.equal(await profileCount(id), 0)
    assert.equal(first(await db.query('select count(*)::int as value from auth.users where id=$1', [id])).value, 0)
  })

  await t.test('own-account acceptance stores two accurate immutable editions and replay preserves original timestamp', async () => {
    for (const version of [OLD, NEW]) {
      const value = await accept(existing, version)
      assert.equal(value.privacy_policy_version, version)
      assert.equal(value.consent_version, version)
      assert.equal(value.source, 'account')
      assert.deepEqual(await accept(existing, version), value)
    }
    assert.equal((await receipts(existing)).length, 2)
    const oldSignupResult = await accept(oldSignup, OLD)
    assert.equal(oldSignupResult.source, 'signup')
    assert.deepEqual(await receipts(oldSignup), oldReceipt)
    for (const [policy, consentVersion] of invalidPairs) await assert.rejects(accept(reader, policy, consentVersion), /PRIVACY_VERSION_OUTDATED/)
    for (const accepted of [false, null]) await assert.rejects(accept(reader, NEW, NEW, accepted), /PRIVACY_CONSENT_REQUIRED/)
    assert.deepEqual(await receipts(reader), [])
  })

  await t.test('Google remains provisional with no inferred receipt or direct profile bypass', async () => {
    assert.deepEqual(first(await asUser(pendingBeforeMigration, 'select xelay_google_registration_status() as value')).value, { required: true })
    await assert.rejects(db.query('insert into profiles(id,full_name,username) values($1,$2,$3)',
      [pendingBeforeMigration, 'Synthetic bypass', 'bypass_' + randomUUID().slice(-8)]), /GOOGLE_REGISTRATION_REQUIRED/)
    await assert.rejects(signup({ email_verified: false, ...consent(NEW) }, { app: { provider: 'google' } }), /GOOGLE_VERIFIED_EMAIL_REQUIRED/)
    assert.equal(await profileCount(pendingBeforeMigration), 0)
    assert.deepEqual(await receipts(pendingBeforeMigration), [])
  })

  await t.test('Google completion rejects invalid editions without advancing the deferred lifecycle', async () => {
    for (const [policy, consentVersion] of invalidPairs) {
      await assert.rejects(complete(pendingBeforeMigration, policy, consentVersion), /PRIVACY_VERSION_OUTDATED/)
      assert.deepEqual(await state(pendingBeforeMigration), pendingState)
      assert.deepEqual(await receipts(pendingBeforeMigration), [])
    }
    await assert.rejects(complete(pendingBeforeMigration, NEW, NEW, false), /PRIVACY_CONSENT_REQUIRED/)
    await assert.rejects(complete(pendingBeforeMigration, NEW, NEW, true,
      { ...googleProfile(pendingBeforeMigration), expected_user_id: reader }), /GOOGLE_REGISTRATION_SESSION_CHANGED/)
    await assert.rejects(complete(pendingBeforeMigration, NEW, NEW, true,
      { ...googleProfile(pendingBeforeMigration), study_year: 9 }), /STUDY_YEAR_INVALID/)
    await assert.rejects(complete(pendingBeforeMigration, NEW, NEW, true,
      { ...googleProfile(pendingBeforeMigration), specialty_id: null }), /ACADEMIC_SPECIALTY_REQUIRED/)
    assert.deepEqual(await state(pendingBeforeMigration), pendingState)
    assert.deepEqual(await receipts(pendingBeforeMigration), [])
    assert.equal(await profileCount(pendingBeforeMigration), 0)
  })

  const completedGoogle = []
  await t.test('Google completes either edition through the unchanged academic validator and accurate account receipt', async () => {
    for (const version of [OLD, NEW]) {
      const id = version === NEW ? pendingBeforeMigration : await googleSignup({ ...consent(NEW), xelay_registration_version: 1 })
      assert.deepEqual(await complete(id, version), { completed: true })
      completedGoogle.push(id)
      const [receipt] = await receipts(id)
      assert.equal(receipt.privacy_policy_version, version)
      assert.equal(receipt.consent_version, version)
      assert.equal(receipt.source, 'account')
      const meta = first(await db.query('select raw_user_meta_data as value from auth.users where id=$1', [id])).value
      assert.equal(meta.xelay_privacy_policy_version, version)
      assert.equal(meta.xelay_privacy_consent_version, version)
      assert.equal(meta.sub, 'synthetic-google-subject')
      assert.equal(meta.email_verified, true)
      assert.equal(await profileCount(id), 1)
      assert.equal(first(await db.query('select study_year from profiles where id=$1', [id])).study_year, 1)
      assert.equal((await state(id)).completing, false)
      assert.ok((await state(id)).completed_at)
      assert.deepEqual(first(await asUser(id, 'select xelay_google_registration_status() as value')).value, { required: false })
      // Preserve the existing-profile early return even when a retry uses stale
      // or absent consent input; it must not overwrite profile or old receipts.
      const before = await receipts(id)
      assert.deepEqual(await complete(id, null, null, false), { completed: true })
      assert.deepEqual(await receipts(id), before)
    }
  })

  await t.test('Google confirmed-active identity checks remain unchanged', async () => {
    for (const column of ['banned_until', 'deleted_at', 'email_confirmed_at']) {
      const id = await googleSignup()
      await authAdmin(`update auth.users set ${column}=$2 where id=$1`,
        [id, column === 'email_confirmed_at' ? null : '2099-01-01T00:00:00Z'])
      await assert.rejects(complete(id), /GOOGLE_VERIFIED_EMAIL_REQUIRED/)
      assert.deepEqual(await receipts(id), [])
      assert.equal(await profileCount(id), 0)
    }
  })

  await t.test('rollout grace and missing-configuration behavior are preserved without fabricating consent', async () => {
    await db.exec('update xelay_privacy_consent_settings set enforce_new_signups=false where singleton')
    const { xelay_privacy_consent: _accepted, xelay_privacy_policy_version: _policy,
      xelay_privacy_consent_version: _consent, ...legacy } = studentMeta(NEW)
    const id = await signup(legacy)
    assert.equal(await profileCount(id), 1)
    assert.deepEqual(await receipts(id), [])
    await assert.rejects(signup(studentMeta(NEW, { xelay_privacy_consent_version: OLD })), /PRIVACY_VERSION_OUTDATED/)
    await db.exec('delete from xelay_privacy_consent_settings')
    await assert.rejects(signup(studentMeta(NEW)), /PRIVACY_CONSENT_CONFIGURATION_MISSING/)
    await db.exec('insert into xelay_privacy_consent_settings(singleton,enforce_new_signups) values(true,true)')
  })

  await t.test('receipt RLS, internal function ACLs and immutability survive both editions', async () => {
    assert.equal((await asUser(existing, 'select * from user_privacy_consents')).rows.length, 2)
    assert.equal((await asUser(reader, 'select * from user_privacy_consents')).rows.length, 0)
    for (const role of ['anon', 'service_role']) {
      await assert.rejects(asUser(null, 'select * from user_privacy_consents', [], { role }), error => error.code === '42501')
      await assert.rejects(accept(null, NEW, NEW, true, { role }), error => error.code === '42501')
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await assert.rejects(asUser(existing, 'delete from user_privacy_consents where user_id=$1', [existing], { role }), error => error.code === '42501')
      await assert.rejects(asUser(existing, "update user_privacy_consents set accepted_at='1970-01-01' where user_id=$1", [existing], { role }), error => error.code === '42501')
      for (const signature of ['xelay_require_signup_privacy_consent()', 'xelay_record_signup_privacy_consent()', 'xelay_guard_google_registration_profile()']) {
        assert.equal(first(await db.query("select has_function_privilege($1,$2,'EXECUTE') as value", [role, 'public.' + signature])).value, false)
      }
    }
    await assert.rejects(db.query("update user_privacy_consents set source='signup' where user_id=$1", [existing]), /RECEIPT_IMMUTABLE/)
    assert.deepEqual(await receipts(oldSignup), oldReceipt)
    assert.deepEqual(await permissions(), permissionsBefore)
  })

  await t.test('an exact rerun preserves both edition histories and Google lifecycle timestamps', async () => {
    const history = await receipts(existing)
    const googleHistory = await Promise.all(completedGoogle.map(receipts))
    const states = await Promise.all(completedGoogle.map(state))
    await db.exec(migration)
    assert.deepEqual(await receipts(existing), history)
    assert.deepEqual(await Promise.all(completedGoogle.map(receipts)), googleHistory)
    assert.deepEqual(await Promise.all(completedGoogle.map(state)), states)
    assert.deepEqual(await receipts(oldSignup), oldReceipt)
    assert.deepEqual(await permissions(), permissionsBefore)
    assert.deepEqual(await Promise.all(unchangedSignatures.map(body)), unchangedBodies)
    assert.equal(first(await db.query('select enforce_new_signups from xelay_privacy_consent_settings')).enforce_new_signups, true)
  })

  await t.test('CRLF stored functions and CRLF SQL transport match only exact canonical fragments', async () => {
    const signatures = ['public.xelay_require_signup_privacy_consent()', 'public.xelay_record_signup_privacy_consent()',
      'public.xelay_accept_privacy_consent(text,text,boolean)', 'public.xelay_complete_google_registration(jsonb,text,text,boolean)']
    const beforeBodies = await Promise.all(signatures.map(body))
    const history = await receipts(existing)
    const googleStates = await Promise.all(completedGoogle.map(state))
    for (const definition of beforeBodies) await db.exec(definition.replaceAll('\n', '\r\n'))
    for (const signature of signatures) assert.ok((await body(signature)).includes('\r\n'))
    await db.exec(migration.replaceAll('\n', '\r\n'))
    assert.deepEqual(await Promise.all(signatures.map(body)), beforeBodies)
    assert.deepEqual(await receipts(existing), history)
    assert.deepEqual(await receipts(oldSignup), oldReceipt)
    assert.deepEqual(await Promise.all(completedGoogle.map(state)), googleStates)
    assert.deepEqual(await permissions(), permissionsBefore)
    assert.deepEqual(await Promise.all(unchangedSignatures.map(body)), unchangedBodies)
    assert.deepEqual(await complete(completedGoogle[0], null, null, false), { completed: true })
    const id = await signup(studentMeta(NEW))
    assert.equal((await receipts(id))[0].privacy_policy_version, NEW)
    assert.equal((await accept(id, NEW)).source, 'signup')
  })

  await t.test('a standalone CR in stored source or expected literals is rejected without broad whitespace repair', async () => {
    const signature = 'public.xelay_require_signup_privacy_consent()'
    const original = await body(signature)
    const drifted = original.replace('begin\n', 'begin\n  /* standalone CR \r sentinel */\n')
    assert.notEqual(drifted, original)
    await db.exec(drifted)
    try {
      await assert.rejects(db.exec(migration), /HOMEWORK_AI_PRIVACY_LINE_ENDINGS_DRIFT/)
      await db.exec('rollback')
      assert.equal(await body(signature), drifted)
    } finally {
      await db.exec('rollback')
      await db.exec(original)
    }
    const literalDrift = migration.replace("$old$if v_meta->>'xelay_privacy_policy_version'", "$old$if\r v_meta->>'xelay_privacy_policy_version'")
    assert.notEqual(literalDrift, migration)
    await assert.rejects(db.exec(literalDrift), /HOMEWORK_AI_PRIVACY_LINE_ENDINGS_DRIFT/)
    await db.exec('rollback')
    assert.equal(await body(signature), original)
    assert.deepEqual(await receipts(oldSignup), oldReceipt)
    assert.deepEqual(await permissions(), permissionsBefore)
  })

  await t.test('unexpected replacement-fragment drift fails closed and rolls back earlier patches', async () => {
    const guardSignature = 'public.xelay_require_signup_privacy_consent()'
    const googleSignature = 'public.xelay_complete_google_registration(jsonb,text,text,boolean)'
    const originalGuard = await body(guardSignature), originalGoogle = await body(googleSignature)
    const newGuardCheck = `if row(v_meta->>'xelay_privacy_policy_version',v_meta->>'xelay_privacy_consent_version')
      is distinct from row('2026-10-15.1','2026-10-15.1')
    and row(v_meta->>'xelay_privacy_policy_version',v_meta->>'xelay_privacy_consent_version')
      is distinct from row('2026-10-25.1','2026-10-25.1') then`
    const oldGuardCheck = `if v_meta->>'xelay_privacy_policy_version' is distinct from '2026-10-15.1'
    or v_meta->>'xelay_privacy_consent_version' is distinct from '2026-10-15.1' then`
    const driftGuard = originalGuard.replace(newGuardCheck, oldGuardCheck)
    const driftGoogle = originalGoogle.replace("'xelay_privacy_policy_version',p_policy_version", "'xelay_privacy_policy_version',upper(p_policy_version)")
    assert.notEqual(driftGuard, originalGuard); assert.notEqual(driftGoogle, originalGoogle)
    await db.exec(driftGuard); await db.exec(driftGoogle)
    try {
      await assert.rejects(db.exec(migration), /HOMEWORK_AI_PRIVACY_FUNCTION_DRIFT/)
      await db.exec('rollback')
      assert.equal(await body(guardSignature), driftGuard)
      assert.equal(await body(googleSignature), driftGoogle)
      assert.deepEqual(await receipts(oldSignup), oldReceipt)
    } finally {
      await db.exec('rollback')
      await db.exec(originalGuard); await db.exec(originalGoogle)
    }
  })
})
