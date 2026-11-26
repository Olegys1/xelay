import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../../supabase/migrations/20261126200041_winter_advent_private_progress.sql', import.meta.url), 'utf8')
const denied = work => assert.rejects(work, error => error.code === '42501')
async function fixture() {
  const db = new PGlite()
  const owner = randomUUID(), other = randomUUID(), ownerSession = randomUUID(), otherSession = randomUUID()
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key, email_confirmed_at timestamptz, deleted_at timestamptz,
      banned_until timestamptz, is_anonymous boolean default false);
    create table auth.sessions(id uuid primary key, user_id uuid references auth.users on delete cascade, not_after timestamptz);
    create table public.profiles(id uuid primary key references auth.users on delete cascade);
    create table public.synthetic_preserved_entitlements(user_id uuid primary key, value text);
    grant usage on schema public, auth to anon, authenticated, service_role;
  `)
  for (const [user, session] of [[owner, ownerSession], [other, otherSession]]) {
    await db.query("insert into auth.users(id,email_confirmed_at) values($1,'2026-10-01')", [user])
    await db.query('insert into auth.sessions(id,user_id) values($1,$2)', [session, user])
    await db.query('insert into public.profiles values($1)', [user])
    await db.query("insert into synthetic_preserved_entitlements values($1,'paid-and-gifted-remain-unchanged')", [user])
  }
  await db.exec(migration)
  // The production clock has no caller parameters. Only this isolated test
  // replaces the privileged helper; there is no live clock override.
  await db.exec(`create or replace function public.xelay_private_winter_clock()
    returns timestamptz language sql volatile set search_path='' as $$
      select current_setting('test.winter.clock')::timestamptz
    $$`)
  const clock = async value => db.query("select set_config('test.winter.clock',$1,false)", [value])
  await clock('2026-12-10T12:00:00Z')
  const as = async (role, sql, args = []) => {
    await db.exec('set role ' + role)
    await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ role })])
    try { return await db.query(sql, args) }
    finally { await db.exec('reset role; reset "request.jwt.claims"') }
  }
  const call = (day = null, user = owner, session = ownerSession) => as('service_role',
    'select public.xelay_winter_advent($1,$2,$3) data', [user, session, day]).then(result => result.rows[0].data)
  return { db, owner, other, ownerSession, otherSession, as, call, clock, close: () => db.close() }
}

test('Advent tables are private, only the service RPC is executable, and caller identity is mandatory', async t => {
  const f = await fixture(); t.after(() => f.close())
  const tables = (await f.db.query("select relname, relrowsecurity from pg_class where relname in ('winter_advent_claims','winter_advent_claim_rate')")).rows
  assert.equal(tables.length, 2); assert.ok(tables.every(row => row.relrowsecurity))
  for (const role of ['anon', 'authenticated', 'service_role']) {
    await denied(f.as(role, 'select * from public.winter_advent_claims'))
    await denied(f.as(role, 'select * from public.winter_advent_claim_rate'))
    await denied(f.as(role, "insert into public.winter_advent_claims(user_id,campaign_id,day) values($1,'winter-2026',31)", [f.other]))
    await denied(f.as(role, 'update public.winter_advent_claims set day=31'))
    await denied(f.as(role, 'delete from public.winter_advent_claims'))
    await denied(f.as(role, 'select public.xelay_private_winter_clock()'))
  }
  for (const role of ['anon', 'authenticated']) await denied(f.as(role, 'select public.xelay_winter_advent($1,$2,1)', [f.owner, f.ownerSession]))
  await denied(f.call(1, null, f.ownerSession))
  await denied(f.call(1, f.owner, null))
  const functions = (await f.db.query("select proname,proconfig from pg_proc where proname in ('xelay_winter_advent','xelay_private_winter_clock')")).rows
  assert.ok(functions.every(fn => fn.proconfig.includes('search_path=""')))
  assert.equal((await f.call()).eligible, true)
})

test('Kyiv midnight, future-day denial, catch-up, the final day and campaign closure are enforced by PostgreSQL', async t => {
  const f = await fixture(); t.after(() => f.close())
  await f.clock('2026-11-30T21:59:59.999Z')
  assert.equal((await f.call()).phase, 'upcoming'); assert.equal((await f.call()).currentDay, 0)
  await assert.rejects(f.call(1), /WINTER_DAY_UNAVAILABLE/)
  await f.clock('2026-11-30T22:00:00Z')
  assert.equal((await f.call(1)).newlyClaimed, true)
  assert.equal((await f.call(1)).newlyClaimed, false)
  assert.deepEqual((await f.call()).claimedDays, [1])
  await assert.rejects(f.call(2), /WINTER_DAY_UNAVAILABLE/)
  await f.clock('2026-12-01T21:59:59.999Z'); assert.equal((await f.call()).currentDay, 1)
  await f.clock('2026-12-01T22:00:00Z'); assert.equal((await f.call(2)).currentDay, 2)
  await f.clock('2026-12-20T12:00:00Z')
  assert.equal((await f.call(7)).newlyClaimed, true)
  assert.deepEqual((await f.call(20)).claimedDays, [1, 2, 7, 20])
  await assert.rejects(f.call(21), /WINTER_DAY_UNAVAILABLE/)
  for (const day of [0, -1, 32, 400]) await assert.rejects(f.call(day), /WINTER_DAY_INVALID/)
  await f.clock('2026-12-31T21:59:59.999Z')
  assert.equal((await f.call(31)).newlyClaimed, true)
  await f.clock('2026-12-31T22:00:00Z')
  assert.equal((await f.call()).phase, 'ended'); assert.equal((await f.call()).currentDay, 31)
  assert.deepEqual((await f.call()).claimedDays, [1, 2, 7, 20, 31])
  await assert.rejects(f.call(3), /WINTER_DAY_UNAVAILABLE/)
  await assert.rejects(f.call(31), /WINTER_DAY_UNAVAILABLE/)
})

test('claims are idempotent and account-scoped, survive reads, and leave subscriptions and gifts unchanged', async t => {
  const f = await fixture(); t.after(() => f.close())
  await f.db.exec("set role service_role; select set_config('request.jwt.claims','{\"role\":\"service_role\"}',false)")
  let retries
  try {
    retries = await Promise.all(Array.from({ length: 20 }, () => f.db.query(
      'select public.xelay_winter_advent($1,$2,5) data', [f.owner, f.ownerSession])))
  } finally { await f.db.exec('reset role; reset "request.jwt.claims"') }
  assert.equal(retries.filter(result => result.rows[0].data.newlyClaimed).length, 1)
  assert.deepEqual((await f.call()).claimedDays, [5])
  assert.deepEqual((await f.call(null, f.other, f.otherSession)).claimedDays, [])
  await f.call(5, f.other, f.otherSession)
  assert.equal((await f.db.query('select count(*)::int count from public.winter_advent_claims')).rows[0].count, 2)
  assert.equal((await f.db.query("select count(*)::int count from synthetic_preserved_entitlements where value='paid-and-gifted-remain-unchanged'")).rows[0].count, 2)
  await f.db.query('delete from auth.users where id=$1', [f.owner])
  assert.equal((await f.db.query('select count(*)::int count from public.winter_advent_claims where user_id=$1', [f.owner])).rows[0].count, 0)
  assert.equal((await f.db.query('select count(*)::int count from public.winter_advent_claim_rate where user_id=$1', [f.owner])).rows[0].count, 0)
  assert.deepEqual((await f.call(null, f.other, f.otherSession)).claimedDays, [5])
})

test('revoked, mismatched and expired sessions and unavailable accounts cannot read or claim private progress', async t => {
  const f = await fixture(); t.after(() => f.close())
  await f.call(1)
  for (const session of [randomUUID(), f.otherSession]) {
    const read = await f.call(null, f.owner, session)
    assert.equal(read.eligible, false); assert.deepEqual(read.claimedDays, [])
    await denied(f.call(2, f.owner, session))
  }
  for (const [update, restore] of [
    ["update auth.users set email_confirmed_at=null where id=$1", "update auth.users set email_confirmed_at='2026-10-01' where id=$1"],
    ["update auth.users set banned_until='2027-01-01' where id=$1", "update auth.users set banned_until=null where id=$1"],
    ["update auth.users set deleted_at='2026-12-01' where id=$1", "update auth.users set deleted_at=null where id=$1"],
    ["update auth.users set is_anonymous=true where id=$1", "update auth.users set is_anonymous=false where id=$1"],
    ["update auth.sessions set not_after='2026-12-10T11:59:59Z' where user_id=$1", "update auth.sessions set not_after=null where user_id=$1"],
  ]) {
    await f.db.query(update, [f.owner])
    const read = await f.call(); assert.equal(read.eligible, false); assert.deepEqual(read.claimedDays, [])
    await denied(f.call(2))
    await f.db.query(restore, [f.owner])
  }
  await f.db.query('delete from profiles where id=$1', [f.owner])
  assert.equal((await f.call()).eligible, false); await denied(f.call(2))
})

test('durable rate limit bounds repeated requests without granting duplicates or blocking later recovery', async t => {
  const f = await fixture(); t.after(() => f.close())
  for (let index = 0; index < 60; index++) await f.call(1)
  await assert.rejects(f.call(1), error => error.code === 'PT429')
  assert.deepEqual((await f.call()).claimedDays, [1])
  assert.equal((await f.db.query('select hits from winter_advent_claim_rate where user_id=$1', [f.owner])).rows[0].hits, 60)
  await f.clock('2026-12-10T12:01:00Z')
  assert.equal((await f.call(1)).newlyClaimed, false)
  assert.equal((await f.call(2)).newlyClaimed, true)
  assert.deepEqual((await f.call()).claimedDays, [1, 2])
})
