// SQL artifacts only, isolated PGlite and synthetic rows. No Supabase requests.
// Mock Auth/Storage schemas cannot prove managed HTTP behavior or real MFA login.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const setup = new URL('../../supabase/setup/', import.meta.url)
const snapshotSql = await readFile(new URL('security_staging_schema_snapshot.sql', setup), 'utf8')
const preflightSql = await readFile(new URL('security_staging_schema_preflight.sql', setup), 'utf8')
const smokeSql = await readFile(new URL('security_staging_smoke_rollback.sql', setup), 'utf8')
const confirm = "set xelay.security_staging='true'; set xelay.security_test_project='saufzpryybuawudohhwj'"
const result = (results) => results.find((r) => r.rows?.[0]?.security_smoke_results)?.rows[0].security_smoke_results
const counts = async (db) => (await db.query(`select
  (select count(*)::int from auth.users) as users,
  (select count(*)::int from profiles) as profiles,
  (select count(*)::int from storage.objects) as objects,
  (select count(*)::int from billing_orders) as orders,
  (select count(*)::int from group_annual_entitlements) as annual_entitlements,
  (select count(*)::int from study_groups) as groups,
  (select count(*)::int from messages) as messages,
  (select count(*)::int from user_roles) as roles,
  (select count(*)::int from auth.mfa_factors) as factors,
  (select enforce_group_payment from billing_settings limit 1) as enforce_payment
`)).rows[0]

test('staging metadata SQL returns one snapshot without user data or hook secrets', async () => {
  const fixture = await createFixture({ useStagingParity: true })
  try {
    await fixture.seedUser(randomUUID(), { email: 'private-fixture@example.test', full_name: 'PRIVATE_FIXTURE_NAME' })
    // Unexecuted fixture hook: ensure only the presence of HTTP/args is exported.
    await fixture.db.exec(`create function public.fixture_http_metadata_only() returns trigger language plpgsql as $$
      begin perform 'PRIVATE_HOOK_SECRET_MARKER'; return new; end $$;
      create trigger fixture_http_metadata_only before insert on questions for each row
      execute function public.fixture_http_metadata_only('PRIVATE_TRIGGER_ARG_MARKER');`)
    const before = await counts(fixture.db)
    const snapshot = await fixture.db.query(snapshotSql)
    assert.equal(snapshot.rows.length, 1)
    assert.equal(Object.keys(snapshot.rows[0].security_schema_snapshot).length, 14)
    const serialized = JSON.stringify(snapshot.rows)
    for (const privateValue of ['private-fixture@example.test', 'PRIVATE_FIXTURE_NAME', 'PRIVATE_HOOK_SECRET_MARKER', 'PRIVATE_TRIGGER_ARG_MARKER']) {
      assert.equal(serialized.includes(privateValue), false)
    }
    const hook = snapshot.rows[0].security_schema_snapshot.trigger_structure.find((t) => t.trigger_name === 'fixture_http_metadata_only')
    assert.equal(hook.has_redacted_arguments, true)
    assert.equal(hook.possible_outbound_http_hook, true)
    assert.ok((await fixture.db.exec(preflightSql)).length > 1)
    assert.deepEqual(await counts(fixture.db), before)
  } finally { await fixture.close() }
})

test('staging smoke requires confirmation, exercises six groups and rolls every fixture row back', async () => {
  const fixture = await createFixture({ useStagingParity: true })
  try {
    const before = await counts(fixture.db)
    await assert.rejects(fixture.db.exec(smokeSql), /same-call staging confirmation/)
    await fixture.db.exec('rollback')
    assert.deepEqual(await counts(fixture.db), before)
    await fixture.db.exec(confirm)
    const summary = result(await fixture.db.exec(smokeSql))
    assert.ok(summary)
    assert.equal(summary.target, 'saufzpryybuawudohhwj')
    assert.equal(summary.checks.filter((c) => c.status === 'PASS').length, 6)
    assert.equal(summary.checks.find((c) => c.check_name === 'admin_mfa_actual_factor').status, 'SKIP')
    assert.deepEqual(await counts(fixture.db), before)
    assert.equal((await fixture.db.query("select to_regclass('pg_temp.xelay_security_smoke_results') as table_name")).rows[0].table_name, null)
  } finally { await fixture.close() }
})

test('optional MFA relational branch uses preexisting fixture factor and rolls temporary ADMIN grant back', async () => {
  const fixture = await createFixture({ useStagingParity: true })
  try {
    const id = randomUUID()
    await fixture.seedUser(id, { username: 'security_smoke_mfa' })
    // This is a MOCK factor in the local fixture, never a real hosted enrollment.
    await fixture.db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')", [id])
    const before = await counts(fixture.db)
    await fixture.db.exec(confirm)
    await fixture.db.query("select set_config('xelay.security_mfa_user_id',$1,false)", [id])
    const summary = result(await fixture.db.exec(smokeSql))
    assert.equal(summary.checks.find((c) => c.check_name === 'admin_mfa_actual_factor').status, 'PASS')
    assert.equal(summary.checks.filter((c) => c.status === 'PASS').length, 7)
    assert.deepEqual(await counts(fixture.db), before)
    assert.equal((await fixture.asUser(id, 'select xelay_is_platform_admin() as allowed', [], { aal: 'aal2' })).rows[0].allowed, false)
  } finally { await fixture.close() }
})
