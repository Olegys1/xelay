// Real application routines in isolated PostgreSQL, synthetic identities only.
// No Auth provider, email, network, production data or real contact is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const first = result => result.rows[0]
const migration = await readFile(new URL('supabase/migrations/202610260004_teacher_request_contact.sql', root), 'utf8')
const required = work => assert.rejects(work, /TEACHER_REQUEST_CONTACT_REQUIRED/)
const denied = work => assert.rejects(work, error => error.code === '42501')

test('new teacher applications require a private contact without changing registration, historical approval or optional profile disclosure', async t => {
  // Install all shared dependencies and the actual academic-profile migration;
  // unrelated later releases fingerprint managed live routines independently.
  const fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id),provider text,identity_data jsonb default '{}');
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  await db.exec(await readFile(new URL('supabase/migrations/202610240002_teacher_academic_profile.sql', root), 'utf8'))
  const ids = Object.fromEntries(['telegram', 'phone', 'legacyPending', 'legacyApproved', 'legacyRejected', 'other', 'admin', 'signup'].map(name => [name, randomUUID()]))
  const scope = first(await db.query('select id,university_id from academic_units where is_active limit 1'))
  assert.ok(scope)
  const specialty = randomUUID()
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'CONTACT','Synthetic contact programme','Synthetic contact programme')`, [specialty, scope.university_id, scope.id])
  for (const [name, id] of Object.entries(ids).filter(([name]) => name !== 'signup')) await seedUser(id, {
    full_name: 'Synthetic teacher ' + name, username: 'tc_' + id.replaceAll('-', '').slice(0, 15),
    university_id: scope.university_id, academic_unit_id: scope.id, specialty_id: name === 'other' ? specialty : null, account_type: name === 'other' ? 'student' : 'teacher',
    categories: name === 'other' ? ['General'] : [], experience: name === 'other' ? 'bachelor' : '',
  })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [ids.admin])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [ids.admin])
  for (const [name, status] of [['legacyPending', 'pending'], ['legacyApproved', 'approved'], ['legacyRejected', 'rejected']]) {
    await db.query(`insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,position,status,reviewed_by,reviewed_at,updated_at)
      select id,full_name,university_id,academic_unit_id,'Legacy department','Legacy position',$2,$3,now()-interval '2 days',now()-interval '2 days' from profiles where id=$1`, [ids[name], status, status === 'pending' ? null : ids.admin])
  }
  const rpc = async (user, name, args = [], options = {}) => first(await asUser(user,
    `select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) as data`, args, options)).data
  const submit = (user, telegram = '', phone = '') => rpc(user, 'xelay_teacher_request', ['Synthetic department', 'Synthetic lecturer', 'Synthetic note', telegram, phone])
  const status = user => rpc(user, 'xelay_teacher_status')
  const adminStatus = () => rpc(ids.admin, 'xelay_teacher_status', [], { aal: 'aal2' })
  const profilePayload = (user, patch = {}) => ({ expected_user_id: user, expected_updated_at: null,
    position_code: 'lecturer', position_other: '', is_postgraduate: false, requested_valid_until: null,
    contact_email: '', contact_phone: '', contact_telegram: '', email_visible_to_groups: false, email_visible_public: false,
    phone_visible_to_groups: false, phone_visible_public: false, telegram_visible_to_groups: false, telegram_visible_public: false, ...patch })
  const academic = await rpc(ids.telegram, 'xelay_teacher_academic_profile_save', [profilePayload(ids.telegram, { contact_email: 'synthetic-profile@example.test', email_visible_public: true })])
  const rows = () => db.query('select to_jsonb(r) as data from teacher_verification_requests r order by id').then(result => result.rows)
  const academicRows = () => db.query('select to_jsonb(a) as data from teacher_academic_profiles a order by user_id').then(result => result.rows)
  const profileRows = () => db.query('select to_jsonb(p) as data from profiles p order by id').then(result => result.rows)
  const authRows = () => db.query('select id,raw_user_meta_data,raw_app_meta_data from auth.users order by id').then(result => result.rows)
  const permissions = () => db.query(`select c.relrowsecurity,c.relacl::text from pg_class c where c.oid='public.teacher_verification_requests'::regclass`).then(result => result.rows)
  const before = { rows: await rows(), academics: await academicRows(), profiles: await profileRows(), auth: await authRows(), permissions: await permissions() }
  const closedPublicBodies = () => db.query(`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) body,p.proacl::text
    from pg_proc p where p.oid in('xelay_verified_teacher_public(uuid)'::regprocedure,'xelay_teacher_contacts(uuid,uuid)'::regprocedure,
      'xelay_teacher_academic_profile_save(jsonb)'::regprocedure,'xelay_teacher_review_with_period(uuid,text,text,date,timestamptz,uuid)'::regprocedure)
    order by signature`).then(result => result.rows)
  const publicBefore = await closedPublicBodies()
  await db.exec(migration)

  await t.test('installation adds blank private history fields and changes no existing request, profile, metadata or audience', async () => {
    assert.deepEqual((await rows()).map(({ data }) => ({ data: Object.fromEntries(Object.entries(data).filter(([key]) => !['contact_telegram', 'contact_phone'].includes(key))) })), before.rows)
    for (const { data } of await rows()) { assert.equal(data.contact_telegram, ''); assert.equal(data.contact_phone, '') }
    assert.deepEqual(await academicRows(), before.academics); assert.deepEqual(await profileRows(), before.profiles)
    assert.deepEqual(await authRows(), before.auth); assert.deepEqual(await permissions(), before.permissions)
    assert.deepEqual(await closedPublicBodies(), publicBefore)
  })

  await t.test('legacy submit RPCs and optional public contacts cannot bypass an explicit verification contact', async () => {
    await required(rpc(ids.telegram, 'xelay_teacher_request', ['Synthetic department', '', '']))
    await required(rpc(ids.telegram, 'xelay_teacher_request_with_academic_profile', ['Synthetic department', '', '', profilePayload(ids.telegram, { expected_updated_at: academic.updated_at, contact_phone: '+380 00 111 2233', phone_visible_public: true })]))
    await required(submit(ids.telegram)); await required(submit(ids.telegram, '   ', '   '))
    assert.equal((await status(ids.telegram)).request, null)
    assert.deepEqual(await academicRows(), before.academics)
  })

  await t.test('invalid contact formats, controls and oversized values fail before any write or notification', async () => {
    const notificationCount = first(await db.query('select count(*)::int n from notifications')).n
    for (const [telegram, phone] of [['abcd', ''], ['1badname', ''], ['x'.repeat(33), ''], ['valid_name\n', ''], ['', '+12'], ['', '123456'], ['', '1'.repeat(16)], ['', 'phoneword'], ['', '1'.repeat(41)], ['', '+380\n00123456'], ['valid_name', 'bad']]) {
      await assert.rejects(submit(ids.telegram, telegram, phone), /TEACHER_REQUEST_CONTACT_INVALID/)
    }
    assert.equal((await status(ids.telegram)).request, null)
    assert.equal(first(await db.query('select count(*)::int n from notifications')).n, notificationCount)
  })

  await t.test('reserved Telegram routes and multiple @ prefixes cannot bypass the client through RPC or direct writes', async () => {
    for (const telegram of ['@@synthetic_teacher', '@@@synthetic_teacher', 'joinchat', '@SHARE', 'addstickers', 'addemoji', 'proxy', 'socks', 'login', 'confirmphone', 'setlanguage', 'iv']) {
      await assert.rejects(submit(ids.telegram, telegram, ''), /TEACHER_REQUEST_CONTACT_INVALID/)
      await assert.rejects(db.query(`insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,contact_telegram)
        values($1,'Invalid direct contact',$2,$3,'Synthetic department',$4)`, [ids.other, scope.university_id, scope.id, telegram]), /TEACHER_REQUEST_CONTACT_INVALID/)
    }
    assert.equal((await status(ids.telegram)).request, null)
    assert.equal((await status(ids.other)).request, null)
  })

  let telegramRequest, phoneRequest
  await t.test('Telegram submission stores only its private snapshot and retries preserve that snapshot', async () => {
    telegramRequest = await submit(ids.telegram, '  @Private_teacher_tg  ', '')
    assert.equal(telegramRequest.contact_telegram, 'Private_teacher_tg'); assert.equal(telegramRequest.contact_phone, '')
    const retry = await submit(ids.telegram, '', '+380 00 111 2233')
    assert.equal(retry.id, telegramRequest.id); assert.equal(retry.contact_telegram, telegramRequest.contact_telegram); assert.equal(retry.contact_phone, '')
    assert.equal((await status(ids.telegram)).request.contact_telegram, 'Private_teacher_tg')
    assert.deepEqual(await academicRows(), before.academics)
    assert.deepEqual(await profileRows(), before.profiles); assert.deepEqual(await authRows(), before.auth)
  })

  await t.test('academic-profile wrapper is atomic, accepts phone-only and does not publish or copy the verification contact', async () => {
    await assert.rejects(rpc(ids.phone, 'xelay_teacher_request_with_academic_profile', ['Synthetic department', '', '', {}, '', '+380 00 555 6677']), /TEACHER_ACADEMIC_INVALID_INPUT/)
    assert.equal((await status(ids.phone)).request, null)
    phoneRequest = await rpc(ids.phone, 'xelay_teacher_request_with_academic_profile', ['Synthetic department', '', '', profilePayload(ids.phone), '', ' +380 00 555 6677 '])
    assert.equal(phoneRequest.contact_phone, '+380 00 555 6677'); assert.equal(phoneRequest.contact_telegram, '')
    const own = await rpc(ids.phone, 'xelay_teacher_academic_profile')
    assert.equal(own.contact_phone, ''); assert.equal(own.contact_telegram, '')
    assert.equal(own.phone_visible_to_groups, false); assert.equal(own.phone_visible_public, false)
    assert.equal(own.telegram_visible_to_groups, false); assert.equal(own.telegram_visible_public, false)
  })

  await t.test('only the request owner and MFA administrator can read private contact snapshots', async () => {
    const unrelated = await status(ids.other)
    assert.equal(unrelated.request, null); assert.deepEqual(unrelated.requests, [])
    const unstepped = await status(ids.admin)
    assert.deepEqual(unstepped.requests, [])
    const list = (await adminStatus()).requests
    assert.equal(list.find(row => row.user_id === ids.telegram).contact_telegram, 'Private_teacher_tg')
    assert.equal(list.find(row => row.user_id === ids.phone).contact_phone, '+380 00 555 6677')
    for (const user of [ids.telegram, ids.other, ids.admin]) await denied(asUser(user, 'select contact_phone,contact_telegram from teacher_verification_requests'))
    await denied(asUser(ids.other, 'select contact_phone from teacher_verification_requests', [], { role: 'anon' }))
    await denied(asUser(ids.other, 'select xelay_teacher_status()', [], { role: 'anon' }))
    await denied(asUser(ids.telegram, 'select xelay_private_teacher_request_contact_guard()'))
  })

  await t.test('direct table/API writers cannot create or resubmit a contactless application', async () => {
    await denied(asUser(ids.other, `insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department)
      values($1,'Unauthorized',$2,$3,'Synthetic department')`, [ids.other, scope.university_id, scope.id]))
    await required(db.query(`insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department)
      values($1,'No contact',$2,$3,'Synthetic department')`, [ids.other, scope.university_id, scope.id]))
    await required(db.query("update teacher_verification_requests set status='pending' where user_id=$1", [ids.legacyRejected]))
    await required(db.query("update teacher_verification_requests set department='Changed application' where user_id=$1", [ids.legacyPending]))
  })

  await t.test('old contactless pending applications remain readable and approvable without retrospective contacts', async () => {
    const old = (await status(ids.legacyPending)).request
    assert.equal(old.contact_telegram, ''); assert.equal(old.contact_phone, '')
    await rpc(ids.admin, 'xelay_teacher_review_with_period', [old.id, 'approved', '', null, null, ids.admin], { aal: 'aal2' })
    assert.equal((await status(ids.legacyPending)).verified, true)
    assert.equal((await status(ids.legacyApproved)).verified, true)
  })

  await t.test('rejected applications require an explicitly supplied fresh contact for resubmission', async () => {
    await required(rpc(ids.legacyRejected, 'xelay_teacher_request', ['Synthetic department', '', '']))
    await required(submit(ids.legacyRejected))
    const resubmitted = await submit(ids.legacyRejected, 'Resubmitted_teacher', '')
    assert.equal(resubmitted.status, 'pending'); assert.equal(resubmitted.contact_telegram, 'Resubmitted_teacher')
    await db.query("update teacher_verification_requests set status='rejected',updated_at=now()-interval '2 days' where id=$1", [resubmitted.id])
    await required(submit(ids.legacyRejected)); await required(rpc(ids.legacyRejected, 'xelay_teacher_request', ['Synthetic department', '', '']))
    const changed = await submit(ids.legacyRejected, '', '+380 00 777 8899')
    assert.equal(changed.id, resubmitted.id); assert.equal(changed.contact_telegram, ''); assert.equal(changed.contact_phone, '+380 00 777 8899')
  })

  await t.test('registration remains contact-optional and creates no application from mutable auth metadata', async () => {
    const metadata = { xelay_registration_version: 1, xelay_privacy_consent: true, xelay_privacy_policy_version: '2026-10-15.1', xelay_privacy_consent_version: '2026-10-15.1',
      account_type: 'teacher', full_name: 'Synthetic registration teacher', username: 'tc_' + ids.signup.replaceAll('-', '').slice(0, 15),
      country: 'Україна', city: 'Київ', bio: '', experience: '', categories: [], university_id: scope.university_id, academic_unit_id: scope.id,
      teacher_department: 'Synthetic department', teacher_position: 'Synthetic lecturer' }
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)', [ids.signup, ids.signup + '@example.test', JSON.stringify(metadata)])
    assert.equal(first(await db.query('select account_type from profiles where id=$1', [ids.signup])).account_type, 'teacher')
    assert.equal(first(await db.query('select count(*)::int n from teacher_verification_requests where user_id=$1', [ids.signup])).n, 0)
    await db.query("update auth.users set email_confirmed_at=now(),raw_user_meta_data=raw_user_meta_data||'{\"teacher_contact_phone\":\"+380 00 000 0000\"}'::jsonb where id=$1", [ids.signup])
    await db.query('update profiles set academic_unit_id=academic_unit_id where id=$1', [ids.signup])
    assert.equal((await status(ids.signup)).request, null)
    const applied = await submit(ids.signup, 'Signup_teacher', '')
    assert.equal(applied.contact_telegram, 'Signup_teacher')
  })

  await t.test('private contacts never enter public teacher results, optional profile values, notifications or period audit', async () => {
    await rpc(ids.admin, 'xelay_teaching_mutate', ['review_teacher', { request_id: telegramRequest.id, status: 'approved', reason: '' }], { aal: 'aal2' })
    await rpc(ids.admin, 'xelay_teaching_mutate', ['review_teacher', { request_id: phoneRequest.id, status: 'approved', reason: '' }], { aal: 'aal2' })
    for (const user of [ids.telegram, ids.phone]) {
      const publicResult = await rpc(ids.other, 'xelay_verified_teacher_public', [user])
      assert.equal(publicResult.verified, true); assert.equal(publicResult.contact_phone, undefined); assert.equal(publicResult.contact_telegram, undefined)
      const contacts = await rpc(ids.other, 'xelay_teacher_contacts', [user, null])
      assert.equal(contacts.contact_phone, null); assert.equal(contacts.contact_telegram, null)
    }
    const outputs = JSON.stringify((await db.query('select to_jsonb(n) as data from notifications n')).rows)
      + JSON.stringify(await academicRows()) + JSON.stringify((await db.query('select to_jsonb(a) as data from teacher_academic_period_audit a')).rows)
    assert.doesNotMatch(outputs, /Private_teacher_tg|380 00 555 6677|Resubmitted_teacher|380 00 777 8899|Signup_teacher/)
  })
})
