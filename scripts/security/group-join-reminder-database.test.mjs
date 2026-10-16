// Minimal real PostgreSQL fixture: existing receipt migrations plus the whitelist addition.
// Synthetic accounts only; no production database or outbound requests.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const root = new URL('../../', import.meta.url)
const read = file => readFile(new URL(`supabase/migrations/${file}`, root), 'utf8')
const base = await read('202610070002_free_groups_announcement.sql')
const social = await read('202610150006_social_launch_announcement.sql')
const migration = await read('202610160010_group_join_reminder.sql')
const ids = ['11000000-0000-4000-8000-000000000001', '11000000-0000-4000-8000-000000000002']
const campaign = 'join-study-group-2026-10-16'
const oldIds = ['free-study-groups-2026-10-07', 'social-launch-2026-10-15']
const first = result => result.rows[0]

test('group join reminder extends only the private immutable receipt whitelist', async t => {
  const db = new PGlite(); t.after(() => db.close())
  await db.exec(`
    set timezone='UTC';
    create role authenticated; create role anon;
    create schema auth; grant usage on schema auth to authenticated, anon;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function public.xelay_free_groups_available() returns boolean language sql stable as $$ select true $$;
    create table public.untouched_sentinel(id integer primary key, value text);
    insert into public.untouched_sentinel values(1,'unchanged');
  `)
  await db.query('insert into auth.users(id) values($1),($2)', ids)
  await db.exec(base); await db.exec(social)
  await db.query('insert into account_announcement_receipts(user_id,announcement_id) values($1,$2),($3,$4)', [ids[0], oldIds[0], ids[1], oldIds[1]])
  const snapshot = async () => ({
    columns: (await db.query(`select n.nspname,c.relname,a.attname,a.attacl::text,format_type(a.atttypid,a.atttypmod) as type,pg_get_expr(d.adbin,d.adrelid) as default_value
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`)).rows,
    tables: (await db.query(`select c.relname,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity,c.relowner::regrole::text from pg_class c
      join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname`)).rows,
    policies: (await db.query(`select polname,polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid) as using_expression
      from pg_policy where polrelid='public.account_announcement_receipts'::regclass order by polname`)).rows,
    readPolicy: first(await db.query(`select pg_get_expr(polqual,polrelid) as expression from pg_policy
      where polrelid='public.account_announcement_receipts'::regclass and polname='Read own announcement receipt'`)),
    functions: (await db.query(`select p.oid::regprocedure::text as signature,p.proacl::text,pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','auth') order by signature`)).rows,
    receipts: (await db.query('select user_id,announcement_id,seen_at::text from account_announcement_receipts order by user_id,announcement_id')).rows,
    sentinel: (await db.query('select * from untouched_sentinel')).rows,
  })
  const before = await snapshot()
  await db.exec(migration)
  const after = await snapshot()

  const asRole = async (userId, sql, params = [], role = 'authenticated') => {
    await db.exec('begin')
    try {
      await db.exec(`set local role ${role}`)
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [userId || ''])
      const result = await db.query(sql, params)
      await db.exec('commit')
      return result
    } catch (error) { await db.exec('rollback'); throw error }
  }
  const insert = (userId, id, actor = userId, role = 'authenticated') => asRole(actor,
    'insert into account_announcement_receipts(user_id,announcement_id) values($1,$2) returning user_id,announcement_id', [userId, id], role)
  const denied = promise => assert.rejects(promise, error => error.code === '42501')

  await t.test('installation retains all rows, columns, grants, table security, read policy and functions', () => {
    assert.deepEqual(after, before)
    assert.doesNotMatch(migration, /\b(?:grant|revoke|create\s+(?:or\s+replace\s+)?function|disable\s+row\s+level\s+security)\b/i)
    assert.equal((migration.match(/alter policy/gi) || []).length, 1)
    assert.match(migration, /alter policy "Record own announcement receipt"/)
  })

  await t.test('own new receipt is allowed once and duplicate insertion cannot change server timestamp', async () => {
    const start = first(await db.query('select clock_timestamp() as value')).value
    assert.deepEqual((await insert(ids[0], campaign)).rows, [{ user_id: ids[0], announcement_id: campaign }])
    const row = first(await db.query('select seen_at from account_announcement_receipts where user_id=$1 and announcement_id=$2', [ids[0], campaign]))
    const end = first(await db.query('select clock_timestamp() as value')).value
    assert.ok(new Date(row.seen_at) >= new Date(start)); assert.ok(new Date(row.seen_at) <= new Date(end))
    const duplicate = await asRole(ids[0], 'insert into account_announcement_receipts(user_id,announcement_id) values($1,$2) on conflict(user_id,announcement_id) do nothing returning user_id', [ids[0], campaign])
    assert.equal(duplicate.rows.length, 0)
    assert.deepEqual(first(await db.query('select seen_at from account_announcement_receipts where user_id=$1 and announcement_id=$2', [ids[0], campaign])), row)
  })

  await t.test('own receipt reads reveal no other account and cross-account insertion is denied', async () => {
    const own = await asRole(ids[0], 'select user_id,announcement_id from account_announcement_receipts order by announcement_id')
    assert.deepEqual(own.rows.map(row => row.user_id), [ids[0], ids[0]])
    assert.deepEqual((await asRole(ids[0], 'select user_id,announcement_id from account_announcement_receipts where user_id=$1', [ids[1]])).rows, [])
    await denied(insert(ids[1], campaign, ids[0]))
    assert.equal(first(await db.query('select count(*)::int as n from account_announcement_receipts where user_id=$1 and announcement_id=$2', [ids[1], campaign])).n, 0)
  })

  await t.test('anonymous or unauthenticated identities cannot read or insert receipts', async () => {
    await denied(asRole(null, 'select user_id,announcement_id from account_announcement_receipts', [], 'anon'))
    await denied(insert(ids[1], campaign, null, 'anon'))
    await denied(insert(ids[1], campaign, null, 'authenticated'))
  })

  await t.test('receipts are immutable and clients cannot write or read seen_at', async () => {
    await denied(asRole(ids[0], 'update account_announcement_receipts set announcement_id=$1 where user_id=$2', [oldIds[1], ids[0]]))
    await denied(asRole(ids[0], 'delete from account_announcement_receipts where user_id=$1', [ids[0]]))
    await denied(asRole(ids[0], 'insert into account_announcement_receipts(user_id,announcement_id,seen_at) values($1,$2,$3)', [ids[0], oldIds[1], '2001-01-01T00:00:00Z']))
    await denied(asRole(ids[0], 'select seen_at from account_announcement_receipts where user_id=$1', [ids[0]]))
  })

  await t.test('unknown campaign IDs remain denied while both old IDs remain valid', async () => {
    await assert.rejects(insert(ids[1], 'unapproved-campaign'), error => ['42501', '23514'].includes(error.code))
    await assert.rejects(db.query('insert into account_announcement_receipts(user_id,announcement_id) values($1,$2)', [ids[1], 'unapproved-campaign']), error => error.code === '23514')
    await insert(ids[1], oldIds[0]); await insert(ids[0], oldIds[1])
    const policy = first(await db.query(`select pg_get_expr(polwithcheck,polrelid) as expression from pg_policy
      where polrelid='public.account_announcement_receipts'::regclass and polname='Record own announcement receipt'`)).expression
    assert.match(policy, /user_id = \( SELECT auth.uid\(\)/)
    for (const id of [...oldIds, campaign]) assert.ok(policy.includes(id))
    assert.match(policy, /clock_timestamp\(\)/)
    assert.match(policy, /2026-10-15 10:10:00/)
  })
})
