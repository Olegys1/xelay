// Explicit profile name parts against an isolated PostgreSQL database.
// No production account, authentication provider, email or network is used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createTeachingScopedFixture } from './teaching-scoped-fixture.mjs'
import { composeProfileName, isValidProfileNamePart, profileNameParts } from '../../src/lib/profileNames.ts'

const migration = await readFile(new URL('../../supabase/migrations/202611040012_profile_name_parts.sql', import.meta.url), 'utf8')
const row = result => result.rows[0]

test('profile names preserve legacy identity, canonicalize explicit parts and keep registration/RLS intact', async t => {
  const fx = await createTeachingScopedFixture()
  t.after(() => fx.close())
  const { db, ids, asUser, scope } = fx
  const legacy = row(await db.query('select full_name from profiles where id=$1', [ids.studentA])).full_name
  const rolesBefore = (await db.query('select * from user_roles order by user_id,role')).rows
  await db.exec(migration)
  const profile = async id => row(await db.query('select full_name,first_name,last_name,bio from profiles where id=$1', [id]))

  await t.test('legacy names are never split and unrelated profile changes preserve them', async () => {
    assert.deepEqual(await profile(ids.studentA), { full_name: legacy, first_name: null, last_name: null, bio: null })
    await asUser(ids.studentA, "update profiles set bio='Updated biography' where id=$1", [ids.studentA])
    assert.equal((await profile(ids.studentA)).full_name, legacy)
    assert.deepEqual(profileNameParts({ full_name: 'Олена Складне Прізвище' }), { firstName: '', lastName: '', hasStructuredName: false })
  })

  await t.test('explicit surname is first everywhere and live roster updates without changing grades/history', async () => {
    const entriesBefore = (await db.query('select id,version from teaching_entries where user_id=$1 order by id', [ids.studentA])).rows
    const gradeCount = row(await db.query('select count(*)::int n from teaching_grades')).n
    const auditCount = row(await db.query('select count(*)::int n from teaching_grade_audit')).n
    await asUser(ids.studentA, "update profiles set first_name='  Марія  Анна ',last_name='  Прикладенко ',full_name='Ignored forged order' where id=$1", [ids.studentA])
    assert.deepEqual(await profile(ids.studentA), { full_name: 'Прикладенко Марія Анна', first_name: 'Марія Анна', last_name: 'Прикладенко', bio: 'Updated biography' })
    const entriesAfter = (await db.query('select id,version,full_name from teaching_entries where user_id=$1 order by id', [ids.studentA])).rows
    assert.ok(entriesAfter.length)
    assert.deepEqual(entriesAfter, entriesBefore.map(e => ({ ...e, version: e.version + 1, full_name: 'Прикладенко Марія Анна' })))
    assert.equal(row(await db.query('select count(*)::int n from teaching_grades')).n, gradeCount)
    assert.equal(row(await db.query('select count(*)::int n from teaching_grade_audit')).n, auditCount)
    assert.deepEqual(profileNameParts({ first_name: 'Марія Анна', last_name: 'Прикладенко' }), { firstName: 'Марія Анна', lastName: 'Прикладенко', hasStructuredName: true })
    assert.equal(composeProfileName('О’Браєн', 'Анна-Марія'), 'О’Браєн Анна-Марія')
    assert.equal(composeProfileName('D’Arcy', 'Jose\u0301'), 'D’Arcy José')
    await asUser(ids.studentB, "update profiles set first_name=$1,last_name='D’Arcy' where id=$2", ['Jose\u0301', ids.studentB])
    assert.equal((await profile(ids.studentB)).full_name, 'D’Arcy José')
  })

  await t.test('invalid parts roll back, RLS still blocks foreign identities and old clients remain compatible', async () => {
    const before = await profile(ids.studentA)
    for (const [firstName, lastName] of [['', 'Прикладенко'], ['Марія', null], ['123', 'Прикладенко'], ['<script>', 'Прикладенко'], ['Марія\nАнна', 'Прикладенко'], ['А'.repeat(61), 'Б'], ['А'.repeat(60), 'Б'.repeat(60)]]) {
      await assert.rejects(asUser(ids.studentA, 'update profiles set first_name=$1,last_name=$2 where id=$3', [firstName, lastName, ids.studentA]), error => error.code === '23514')
      assert.deepEqual(await profile(ids.studentA), before)
    }
    assert.equal(isValidProfileNamePart('Анна-Марія'), true)
    assert.equal(isValidProfileNamePart('123'), false)
    assert.equal(isValidProfileNamePart('Олег\u200b'), false)
    await asUser(ids.studentB, "update profiles set first_name='Чуже',last_name='Ім’я' where id=$1", [ids.studentA])
    assert.deepEqual(await profile(ids.studentA), before)
    await asUser(ids.studentA, "update profiles set full_name='Legacy client explicit name' where id=$1", [ids.studentA])
    assert.deepEqual(await profile(ids.studentA), { ...before, full_name: 'Legacy client explicit name', first_name: null, last_name: null })
    await asUser(ids.studentA, "update profiles set bio='Another edit' where id=$1", [ids.studentA])
    assert.equal((await profile(ids.studentA)).full_name, 'Legacy client explicit name')
    assert.deepEqual((await db.query('select * from user_roles order by user_id,role')).rows, rolesBefore)
  })

  await t.test('email and Google completion store explicit parts; consent, pending status and retry safety remain', async () => {
    const specialty = row(await db.query('select specialty_id from profiles where id=$1', [ids.studentA])).specialty_id
    const metadata = overrides => ({ xelay_registration_version: 1, xelay_privacy_consent: true,
      xelay_privacy_policy_version: '2026-10-15.1', xelay_privacy_consent_version: '2026-10-15.1',
      account_type: 'student', full_name: 'Прикладенко Марія', first_name: 'Марія', last_name: 'Прикладенко',
      username: 'np_' + randomUUID().replaceAll('-', '').slice(0, 16), country: 'Україна', city: 'Київ', bio: '',
      experience: 'bachelor', study_year: 1, categories: ['General'], university_id: scope.university_id,
      academic_unit_id: scope.id, specialty_id: specialty, specialty: 'Synthetic scoped programme', ...overrides })
    const emailUser = randomUUID()
    await db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)', [emailUser, emailUser + '@example.test', JSON.stringify(metadata())])
    assert.equal((await profile(emailUser)).full_name, 'Прикладенко Марія')
    assert.equal((await profile(emailUser)).last_name, 'Прикладенко')
    assert.equal(row(await db.query('select email_confirmed_at from auth.users where id=$1', [emailUser])).email_confirmed_at, null)
    assert.equal(row(await db.query('select count(*)::int n from user_privacy_consents where user_id=$1', [emailUser])).n, 1)
    const teacherUser = randomUUID()
    await db.query('insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data) values($1,$2,now(),$3::jsonb)', [teacherUser, teacherUser + '@example.test', JSON.stringify(metadata({ account_type: 'teacher', experience: '', study_year: null, categories: [], specialty_id: null, specialty: '', teacher_department: 'Synthetic department', teacher_position: 'Synthetic lecturer', is_teacher: true, role: 'ADMIN' }))])
    assert.equal((await profile(teacherUser)).full_name, 'Прикладенко Марія')
    assert.equal(row(await db.query('select count(*)::int n from teacher_verification_requests where user_id=$1', [teacherUser])).n, 0)
    await asUser(teacherUser, "select xelay_teacher_request('Synthetic department','Synthetic lecturer','','synthetic_teacher','')")
    assert.equal(row(await db.query('select status from teacher_verification_requests where user_id=$1', [teacherUser])).status, 'pending')
    assert.equal(row(await db.query('select count(*)::int n from user_roles where user_id=$1', [teacherUser])).n, 0)
    const invalid = randomUUID()
    await assert.rejects(db.query('insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3::jsonb)', [invalid, invalid + '@example.test', JSON.stringify(metadata({ last_name: null }))]), e => e.code === '23514')
    assert.equal(row(await db.query('select count(*)::int n from auth.users where id=$1', [invalid])).n, 0)

    const googleUser = randomUUID()
    await db.query("insert into auth.users(id,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data) values($1,$2,now(),'{\"provider\":\"google\"}', '{\"email_verified\":true}')", [googleUser, googleUser + '@example.test'])
    await db.query("insert into auth.identities(id,user_id,provider,identity_data) values($1,$2,'google','{\"email_verified\":true}')", [randomUUID(), googleUser])
    assert.equal(await profile(googleUser), undefined)
    const complete = async payload => row(await asUser(googleUser, "select xelay_complete_google_registration($1::jsonb,'2026-10-15.1','2026-10-15.1',true) value", [JSON.stringify({ ...metadata(), expected_user_id: googleUser, ...payload })])).value
    assert.equal((await complete({})).completed, true)
    assert.equal((await profile(googleUser)).full_name, 'Прикладенко Марія')
    assert.equal((await profile(googleUser)).first_name, 'Марія')
    await complete({ first_name: 'Інша', last_name: 'Назва', full_name: 'Назва Інша' })
    assert.equal((await profile(googleUser)).full_name, 'Прикладенко Марія')
    assert.equal(row(await db.query("select has_function_privilege('authenticated','public.xelay_complete_google_registration_before_names_20261104(jsonb,text,text,boolean)','EXECUTE') allowed")).allowed, false)
    assert.equal(row(await db.query('select count(*)::int n from user_roles where user_id in($1,$2)', [emailUser, googleUser])).n, 0)
  })
})
