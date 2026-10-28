// Focused offline regression for the administrator request outbox extension.
// Synthetic identities and in-memory PostgreSQL only; no provider or live DB.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/202610280001_admin_teacher_alerts.sql', root), 'utf8')
const first = result => result.rows[0]

test('teacher applications share the durable private bot queue without changing applicant access', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id),provider text,identity_data jsonb default '{}');
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  for (const name of ['202610240002_teacher_academic_profile.sql', '202610260004_teacher_request_contact.sql']) {
    await db.exec(await readFile(new URL('supabase/migrations/' + name, root), 'utf8'))
  }
  const ids = Object.fromEntries(['legacy', 'teacher', 'otherTeacher', 'head', 'admin', 'student'].map(name => [name, randomUUID()]))
  const scope = first(await db.query('select id,university_id from academic_units where is_active limit 1'))
  for (const [name, id] of Object.entries(ids)) await seedUser(id, {
    full_name: 'Synthetic ' + name, username: 'alert_' + id.replaceAll('-', '').slice(0, 15),
    university_id: scope.university_id, academic_unit_id: scope.id, account_type: 'teacher', categories: [], experience: '',
  })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [ids.admin])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [ids.admin])
  const rpc = async (user, name, params = [], options = {}) => first(await asUser(user,
    `select ${name}(${params.map((_, i) => '$' + (i + 1)).join(',')}) data`, params, options)).data
  const service = (name, params = []) => rpc(null, name, params, { role: 'service_role' })
  const submit = user => rpc(user, 'xelay_teacher_request', ['Synthetic department', 'Synthetic lecturer', 'Private test note', 'synthetic_contact', ''])
  const state = () => db.query('select * from admin_representative_alert_delivery').then(first)
  const summary = () => db.query('select xelay_private_admin_request_pending_summary() data').then(result => first(result).data)
  const forceDue = () => db.exec("update admin_representative_alert_delivery set next_attempt_at=clock_timestamp()-interval '1 second',provider_retry_until=null")
  const privateLegacyBody = first(await db.query("select pg_get_functiondef('xelay_private_representative_pending_summary()'::regprocedure) body")).body
  const access = () => db.query(`select p.oid::regprocedure::text signature,p.proacl::text acl from pg_proc p where p.oid in(
    'xelay_admin_representative_alert_summary()'::regprocedure,'xelay_claim_admin_representative_alert()'::regprocedure,
    'xelay_admin_representative_alert_delivery_context(uuid)'::regprocedure,
    'xelay_finish_admin_representative_alert(uuid,text,text,integer)'::regprocedure) order by signature`).then(result => result.rows)
  const accessBefore = await access()
  const tablesBefore = (await db.query(`select c.oid::regclass::text name,c.relrowsecurity,c.relacl::text acl from pg_class c
    where c.oid in('teacher_verification_requests'::regclass,'class_representative_requests'::regclass,'admin_representative_alert_delivery'::regclass) order by name`)).rows
  await submit(ids.legacy)
  const initial = await state()
  assert.equal(initial.generation, 0)
  await db.query("update admin_representative_alert_delivery set provider_retry_until=clock_timestamp()+interval '10 minutes',lease_token=$1,lease_until=clock_timestamp()+interval '2 minutes',claimed_generation=0,attempts=2", [randomUUID()])
  const beforeInstall = await state()
  await db.exec(migration)

  await t.test('installation includes an existing teacher backlog once and preserves roles, RLS and retry deadline', async () => {
    const installed = await state()
    assert.equal(installed.generation, 1)
    assert.deepEqual(installed.provider_retry_until, beforeInstall.provider_retry_until)
    for (const key of ['lease_token', 'lease_until', 'claimed_generation', 'attempts']) assert.deepEqual(installed[key], beforeInstall[key])
    assert.deepEqual(await access(), accessBefore)
    assert.deepEqual((await db.query(`select c.oid::regclass::text name,c.relrowsecurity,c.relacl::text acl from pg_class c
      where c.oid in('teacher_verification_requests'::regclass,'class_representative_requests'::regclass,'admin_representative_alert_delivery'::regclass) order by name`)).rows, tablesBefore)
    assert.equal(first(await db.query("select pg_get_functiondef('xelay_private_representative_pending_summary()'::regprocedure) body")).body, privateLegacyBody)
    await db.exec(migration)
    assert.deepEqual(await state(), installed)
    for (const role of ['anon', 'authenticated', 'service_role']) {
      assert.equal(first(await db.query("select has_function_privilege($1,'xelay_private_admin_request_pending_summary()','execute') value", [role])).value, false)
    }
    assert.equal((await service('xelay_claim_admin_representative_alert')), null)
    await db.exec('update admin_representative_alert_delivery set lease_token=null,lease_until=null,claimed_generation=null')
  })

  await t.test('registration alone has no application; actual application and reapplication enqueue, an idempotent pending retry does not', async () => {
    assert.equal(first(await db.query('select count(*)::int n from teacher_verification_requests where user_id=$1', [ids.teacher])).n, 0)
    const before = await state()
    const request = await submit(ids.teacher)
    assert.equal((await state()).generation, before.generation + 1)
    await submit(ids.teacher)
    assert.equal((await state()).generation, before.generation + 1)
    await db.query("update teacher_verification_requests set status='rejected',reviewed_by=$2,reviewed_at=now()-interval '2 days',updated_at=now()-interval '2 days' where id=$1", [request.id, ids.admin])
    assert.equal((await state()).generation, before.generation + 1)
    await submit(ids.teacher)
    assert.equal((await state()).generation, before.generation + 2)
    assert.equal((await summary()).teacher_pending_count, 2)
    assert.equal((await summary()).representative_pending_count, 0)
  })

  await t.test('mixed queue is aggregate only and the existing administrator popup remains representative-only', async () => {
    await db.query(`insert into class_representative_requests(user_id,full_name,university_id,academic_unit_id,group_name,telegram_username)
      values($1,'Synthetic head',$2,$3,'Synthetic group','synthetic_head')`, [ids.head, scope.university_id, scope.id])
    const combined = await summary()
    assert.equal(combined.pending_count, 3); assert.equal(combined.teacher_pending_count, 2); assert.equal(combined.representative_pending_count, 1)
    assert.deepEqual(Object.keys(combined).sort(), ['latest_pending_at', 'oldest_pending_at', 'oldest_representative_pending_at', 'oldest_teacher_pending_at', 'pending_count', 'representative_pending_count', 'teacher_pending_count'].sort())
    assert.doesNotMatch(JSON.stringify(combined), /Synthetic|synthetic_|Private|@example|request_id|user_id/)
    const legacy = await rpc(ids.admin, 'xelay_admin_representative_alert_summary', [], { aal: 'aal2' })
    assert.equal(legacy.pending_count, 1)
    await assert.rejects(rpc(ids.student, 'xelay_admin_representative_alert_summary'), /ADMIN_MFA_REQUIRED/)
    await assert.rejects(rpc(ids.student, 'xelay_claim_admin_representative_alert'), /permission denied/)
    await assert.rejects(rpc(null, 'xelay_claim_admin_representative_alert', [], { role: 'anon' }), /permission denied/)
  })

  await t.test('claim uses both kinds, isolates active lease and acknowledges only its current live snapshot', async () => {
    await forceDue()
    const claimed = await service('xelay_claim_admin_representative_alert')
    assert.equal(claimed.pending_count, 3); assert.equal(claimed.teacher_pending_count, 2)
    assert.equal(await service('xelay_claim_admin_representative_alert'), null)
    await db.query("update class_representative_requests set status='approved',reviewed_by=$2,reviewed_at=now() where user_id=$1", [ids.head, ids.admin])
    const live = await service('xelay_admin_representative_alert_delivery_context', [claimed.lease_token])
    assert.equal(live.pending_count, 2); assert.equal(live.representative_pending_count, 0)
    const before = await state()
    await submit(ids.otherTeacher)
    assert.equal((await state()).lease_token, claimed.lease_token)
    assert.equal((await state()).generation, before.generation + 1)
    assert.equal(await service('xelay_finish_admin_representative_alert', [claimed.lease_token, 'sent', null, null]), true)
    const finished = await state()
    assert.equal(finished.sent_generation, live.generation)
    assert.ok(finished.generation > finished.sent_generation)
    assert.ok(Date.parse(finished.next_attempt_at) <= Date.now() + 1000)
    assert.equal(await service('xelay_finish_admin_representative_alert', [claimed.lease_token, 'sent', null, null]), false)
  })

  await t.test('teacher-only failure retains bounded retry and provider Retry-After even when a new application arrives', async () => {
    const claimed = await service('xelay_claim_admin_representative_alert')
    assert.equal(claimed.teacher_pending_count, 3)
    assert.equal(await service('xelay_finish_admin_representative_alert', [claimed.lease_token, 'failed', 'telegram_rate_limited', 600]), true)
    const failed = await state()
    assert.equal(failed.last_error_code, 'telegram_rate_limited'); assert.equal(failed.lease_token, null)
    assert.ok(Date.parse(failed.provider_retry_until) > Date.now() + 590000)
    await db.query("update teacher_verification_requests set status='rejected',updated_at=now()-interval '2 days' where user_id=$1", [ids.otherTeacher])
    await submit(ids.otherTeacher)
    const after = await state()
    assert.deepEqual(after.provider_retry_until, failed.provider_retry_until)
    assert.equal(after.generation, failed.generation + 1)
    assert.equal(await service('xelay_claim_admin_representative_alert'), null)
  })

  await t.test('review and deletion stop the outstanding alert before an external send and do not generate new traffic', async () => {
    await forceDue()
    const claimed = await service('xelay_claim_admin_representative_alert')
    const before = await state()
    await db.query("update teacher_verification_requests set status='approved',reviewed_by=$1,reviewed_at=now() where user_id<>$2", [ids.admin, ids.otherTeacher])
    await db.query('delete from teacher_verification_requests where user_id=$1', [ids.otherTeacher])
    assert.equal((await state()).generation, before.generation)
    assert.equal((await summary()).pending_count, 0)
    assert.equal(await service('xelay_admin_representative_alert_delivery_context', [claimed.lease_token]), null)
    assert.equal(await service('xelay_finish_admin_representative_alert', [claimed.lease_token, 'skipped', null, null]), true)
    assert.equal(await service('xelay_claim_admin_representative_alert'), null)
    const empty = await state(); assert.equal(empty.sent_generation, empty.generation); assert.equal(empty.lease_token, null)
  })
})
