// Actual receipt migration chain in isolated PGlite. Synthetic accounts only;
// no production access, external requests or Google Form responses are used.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const read = path => readFile(new URL('../../' + path, import.meta.url), 'utf8')
const migration = await read('supabase/migrations/202610180003_rectorate_feedback_announcement.sql')
const audit = await read('supabase/audits/202610180003_rectorate_feedback_announcement.sql')
const campaign = 'rectorate-feedback-2026-10-18'
const oldIds = ['free-study-groups-2026-10-07', 'social-launch-2026-10-15',
  'join-study-group-2026-10-16', 'secret-six-seven-2026-10-17']
const ids = ['18000000-0000-4000-8000-000000000001', '18000000-0000-4000-8000-000000000002']

test('rectorate feedback invitation only adds its own private immutable receipt ID', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`set timezone='UTC';
    create role anon; create role authenticated;
    create schema auth; grant usage on schema auth to anon,authenticated;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function xelay_free_groups_available() returns boolean language sql stable as $$select true$$;
    create table public.untouched_sentinel(id integer primary key,value text);
    insert into public.untouched_sentinel values(1,'unchanged');`)
  await db.query('insert into auth.users values($1),($2)', ids)
  for (const name of ['202610070002_free_groups_announcement.sql', '202610150006_social_launch_announcement.sql',
    '202610160010_group_join_reminder.sql', '202610170002_secret_badge_announcement.sql']) {
    await db.exec(await read('supabase/migrations/' + name))
  }
  for (const [i, old] of oldIds.entries()) {
    await db.query('insert into account_announcement_receipts(user_id,announcement_id) values($1,$2)', [ids[i % 2], old])
  }
  const before = (await db.query(audit)).rows[0].deployment_audit
  const sentinelBefore = (await db.query('select * from untouched_sentinel')).rows
  await db.exec(migration)
  const after = (await db.query(audit)).rows[0].deployment_audit
  async function run(actor, sql, args = [], role = 'authenticated') {
    return db.transaction(async tx => {
      await tx.exec('set local role ' + role)
      await tx.query("select set_config('request.jwt.claim.sub',$1,true)", [actor || ''])
      return (await tx.query(sql, args)).rows
    })
  }
  const insert = (actor, owner = actor, id = campaign, role = 'authenticated') => run(actor,
    'insert into account_announcement_receipts(user_id,announcement_id) values($1,$2) on conflict(user_id,announcement_id) do nothing returning user_id,announcement_id',
    [owner, id], role)
  const denied = promise => assert.rejects(promise, error => error.code === '42501')

  await t.test('installation preserves data, ownership, RLS, column grants, all functions and other policies/constraints', async () => {
    for (const key of Object.keys(before).filter(key => !['receipt_check', 'receipt_insert_check'].includes(key))) {
      assert.deepEqual(after[key], before[key], key)
    }
    assert.deepEqual((await db.query('select * from untouched_sentinel')).rows, sentinelBefore)
    assert.equal(after.receipt_data.row_count, 4)
    assert.doesNotMatch(migration, /\b(?:grant|revoke|create\s+(?:or\s+replace\s+)?(?:function|table)|disable\s+row\s+level\s+security)\b/i)
    assert.equal((migration.match(/alter policy/gi) || []).length, 1)
  })

  await t.test('own new receipt is allowed once with an immutable server timestamp', async () => {
    const start = (await db.query('select clock_timestamp() as value')).rows[0].value
    assert.deepEqual(await insert(ids[0]), [{ user_id: ids[0], announcement_id: campaign }])
    const first = (await db.query('select * from account_announcement_receipts where user_id=$1 and announcement_id=$2', [ids[0], campaign])).rows
    const end = (await db.query('select clock_timestamp() as value')).rows[0].value
    assert.ok(new Date(first[0].seen_at) >= new Date(start))
    assert.ok(new Date(first[0].seen_at) <= new Date(end))
    assert.deepEqual(await insert(ids[0]), [])
    assert.deepEqual((await db.query('select * from account_announcement_receipts where user_id=$1 and announcement_id=$2', [ids[0], campaign])).rows, first)
  })

  await t.test('receipts remain isolated by account and cross-account insertion is denied', async () => {
    const own = await run(ids[0], 'select user_id,announcement_id from account_announcement_receipts')
    assert.equal(own.length, 3)
    assert.ok(own.every(row => row.user_id === ids[0]))
    assert.deepEqual(await run(ids[0], 'select user_id,announcement_id from account_announcement_receipts where user_id=$1', [ids[1]]), [])
    await denied(insert(ids[0], ids[1]))
    assert.equal((await db.query('select count(*)::int as n from account_announcement_receipts where user_id=$1 and announcement_id=$2', [ids[1], campaign])).rows[0].n, 0)
  })

  await t.test('anonymous and missing-identity callers cannot read or write receipts', async () => {
    await denied(run(null, 'select user_id,announcement_id from account_announcement_receipts', [], 'anon'))
    await denied(insert(null, ids[1], campaign, 'anon'))
    await denied(insert(null, ids[1]))
    assert.deepEqual(await run(null, 'select user_id,announcement_id from account_announcement_receipts'), [])
  })

  await t.test('clients cannot edit, delete, select or supply the server timestamp', async () => {
    await denied(run(ids[0], 'update account_announcement_receipts set announcement_id=$1', [oldIds[0]]))
    await denied(run(ids[0], 'delete from account_announcement_receipts'))
    await denied(run(ids[0], 'select seen_at from account_announcement_receipts'))
    await denied(run(ids[0], 'insert into account_announcement_receipts(user_id,announcement_id,seen_at) values($1,$2,$3)', [ids[0], oldIds[1], '2000-01-01T00:00:00Z']))
  })

  await t.test('all four previous IDs and the social server-time condition are preserved exactly', async () => {
    for (const id of oldIds) {
      await insert(ids[1], ids[1], id)
      assert.ok(after.receipt_check.includes(id))
      assert.ok(after.receipt_insert_check.includes(id))
    }
    assert.equal(after.receipt_check.replace(', ' + "'" + campaign + "'::text", ''), before.receipt_check)
    assert.equal(after.receipt_insert_check.replace(', ' + "'" + campaign + "'::text", ''), before.receipt_insert_check)
    assert.match(after.receipt_insert_check, /clock_timestamp\(\) >= '2026-10-15 10:10:00\+00'::timestamp with time zone/)
    assert.match(after.receipt_insert_check, /user_id = \( SELECT auth.uid\(\)/)
  })

  await t.test('unknown campaigns stay rejected by both RLS and the table check', async () => {
    await assert.rejects(insert(ids[1], ids[1], 'unapproved-campaign'), error => ['42501', '23514'].includes(error.code))
    await assert.rejects(db.query('insert into account_announcement_receipts(user_id,announcement_id) values($1,$2)', [ids[1], 'unapproved-campaign']), error => error.code === '23514')
  })
})
