import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { createFixture } from './fixture.mjs'

const read = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')
const migration = await read('202611100010_participant_lifetime_milestone.sql')
const forbidden = work => assert.rejects(work, error => error.code === '42501')

test('the 1000th visible profile gets one audited lifetime award and one private notice', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `
    create schema cron; create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id),provider text,identity_data jsonb default '{}');
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const ids = Object.fromEntries(['admin', 'other', 'winner', 'next', 'demo'].map(name => [name, randomUUID()]))
  const rpc = async (user, name, args = [], options = {}) => (await asUser(user,
    `select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) data`, args, options)).rows[0].data
  const grant = (recipient, actor = ids.admin, options = { aal: 'aal2' }) =>
    rpc(actor, 'xelay_admin_grant_lifetime_milestone', [recipient, ids.admin], options)
  const status = user => rpc(user, 'xelay_billing_status')
  const checkout = (user, reference = 'synthetic-milestone-' + randomUUID()) =>
    rpc(null, 'xelay_create_billing_order', [user, 'participant', 'live', reference, null], { role: 'service_role' })
  const count = async (table, where = '') => (await db.query(`select count(*)::int as total from ${table} ${where}`)).rows[0].total
  const snapshotEntitlements = async () => (await db.query('select to_jsonb(e) as entry from participant_entitlements e order by id')).rows
  const deliveryTriggers = async () => (await db.query(`select oid, pg_get_triggerdef(oid) as definition
    from pg_trigger where tgrelid='notifications'::regclass
      and tgname in ('notification_email_queue','xelay_participant_push_queue') order by tgname`)).rows
  const overviewDefinition = async () => (await db.query(`select oid, proacl::text, pg_get_functiondef(oid) as definition
    from pg_proc where oid='public.xelay_admin_billing_overview()'::regprocedure`)).rows[0]

  await db.exec(await read('202610260001_birthday_gifts.sql'))
  await db.exec(await read('202610260006_appreciation_gifts.sql'))
  const triggersBefore = await deliveryTriggers()
  const overviewBefore = await overviewDefinition()
  await db.exec(migration)
  assert.deepEqual(await deliveryTriggers(), triggersBefore)
  assert.deepEqual(await overviewDefinition(), overviewBefore)
  assert.equal((await db.query('select xelay_private_lifetime_uses_demo_scope() as scoped')).rows[0].scoped, false)

  for (const [name, date] of Object.entries({
    admin: '2026-01-02', other: '2026-01-03', winner: '2025-12-31', next: '2026-01-05', demo: '2026-01-02T09:00:00Z',
  })) await seedUser(ids[name], { created_at: date })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')", [ids.admin])
  await db.query("insert into auth.mfa_factors(user_id,status,factor_type) values($1,'verified','totp'),($2,'verified','totp')", [ids.admin, ids.other])
  await db.query("insert into xelay_google_registrations(user_id,completed_at) values($1,'2026-01-04')", [ids.winner])
  await db.exec(`
    alter table auth.users disable trigger user;
    insert into auth.users(id,email,email_confirmed_at)
      select md5('synthetic-lifetime-' || n)::uuid, 'synthetic-lifetime-' || n || '@example.test', now()
      from generate_series(1,997) n;
    alter table auth.users enable trigger user;
    insert into public.profiles(id,username,email,full_name,created_at)
      select md5('synthetic-lifetime-' || n)::uuid,'synthetic-life-' || n,
        'synthetic-lifetime-' || n || '@example.test','Fictional profile ' || n,
        '2026-01-01'::timestamptz + make_interval(secs => n)
      from generate_series(1,997) n;
    create schema xelay_demo_private;
    create table xelay_demo_private.demo_actor(id uuid primary key);
    create function xelay_demo_private.is_actor(p_id uuid) returns boolean language sql stable security definer set search_path='' as
      $$select exists(select 1 from xelay_demo_private.demo_actor where id=p_id)$$;
    create or replace function public.xelay_member_count() returns bigint language sql stable security definer set search_path='' as
      $$select count(*) from public.profiles p where not xelay_demo_private.is_actor(p.id)$$;
  `)
  await db.query('insert into xelay_demo_private.demo_actor values($1)', [ids.demo])
  assert.equal((await db.query('select xelay_private_lifetime_uses_demo_scope() as scoped')).rows[0].scoped, true)

  await t.test('installation grants nothing and only the authorized, unambiguous rank can be awarded', async () => {
    assert.equal(await count('participant_lifetime_awards'), 0)
    assert.equal(Number(await rpc(null, 'xelay_member_count', [], { role: 'anon' })), 1001)
    assert.equal((await status(ids.winner)).is_lifetime, false)
    await forbidden(grant(ids.winner, ids.admin, { aal: 'aal1' }))
    await forbidden(grant(ids.winner, ids.other))
    await forbidden(rpc(ids.other, 'xelay_admin_grant_lifetime_milestone', [ids.winner, ids.other], { aal: 'aal2' }))
    await forbidden(rpc(null, 'xelay_admin_grant_lifetime_milestone', [ids.winner, ids.admin], { role: 'service_role' }))
    await assert.rejects(grant(ids.next), /PARTICIPANT_LIFETIME_MILESTONE_CHANGED/)
    await db.query("update profiles set created_at='2026-01-04' where id=$1", [ids.next])
    await assert.rejects(grant(ids.winner), /PARTICIPANT_LIFETIME_MILESTONE_CHANGED/)
    await db.query("update profiles set created_at='2026-01-05' where id=$1", [ids.next])
    await db.query('update auth.users set email_confirmed_at=null where id=$1', [ids.winner])
    await forbidden(grant(ids.winner))
    await db.query('update auth.users set email_confirmed_at=now() where id=$1', [ids.winner])
  })

  await t.test('existing checkout and regular paid access remain intact, and the private award is idempotent', async () => {
    const paid = await checkout(ids.winner)
    await rpc(null, 'xelay_apply_billing_event',
      [paid.order_reference, 'live', 'a'.repeat(64), 'Approved', 100, 'UAH', 2], { role: 'service_role' })
    await rpc(ids.admin, 'xelay_admin_grant_participant', [ids.other, 1, 'Fictional finite access'], { aal: 'aal2' })
    const before = await snapshotEntitlements()
    const order = await checkout(ids.winner)
    await assert.rejects(grant(ids.winner), /PARTICIPANT_LIFETIME_CHECKOUT_PENDING/)
    assert.equal(await count('participant_lifetime_awards'), 0)
    await db.query("update billing_orders set status='expired' where id=$1", [order.id])
    const emailBefore = await count('notification_email_outbox')
    const pushBefore = await count('participant_push_outbox')
    await db.exec("alter table billing_audit_log add constraint synthetic_award_audit_failure check(action<>'grant_participant_lifetime')")
    await assert.rejects(grant(ids.winner), /synthetic_award_audit_failure/)
    await db.exec('alter table billing_audit_log drop constraint synthetic_award_audit_failure')
    assert.equal(await count('participant_lifetime_awards'), 0)
    assert.equal(await count('notifications', "where type='participant_lifetime_award'"), 0)

    assert.deepEqual(await grant(ids.winner), { granted: true, already_granted: false })
    assert.deepEqual(await grant(ids.winner), { granted: true, already_granted: true })
    await assert.rejects(grant(ids.next), /PARTICIPANT_LIFETIME_ALREADY_AWARDED/)
    assert.equal(await count('participant_lifetime_awards'), 1)
    assert.equal(await count('billing_audit_log', "where action='grant_participant_lifetime'"), 1)
    assert.equal(await count('notifications', "where type='participant_lifetime_award'"), 1)
    assert.equal(await count('notification_email_outbox'), emailBefore)
    assert.equal(await count('participant_push_outbox'), pushBefore)
    assert.deepEqual(await snapshotEntitlements(), before)
    assert.equal((await db.query('select status from billing_orders where id=$1', [order.id])).rows[0].status, 'expired')
    assert.equal((await db.query('select status from billing_orders where id=$1', [paid.id])).rows[0].status, 'approved')

    const winner = await status(ids.winner)
    assert.equal(winner.is_premium, true)
    assert.equal(winner.is_lifetime, true)
    assert.equal(winner.expires_at, null)
    const other = await status(ids.other)
    assert.equal(other.is_premium, true)
    assert.equal(other.is_lifetime, false)
    assert.ok(other.expires_at)
    const overview = await rpc(ids.admin, 'xelay_admin_billing_overview', [], { aal: 'aal2' })
    assert.equal(overview.active_participants, 2)
    assert.equal(overview.subscription_revenue, 100)
    await assert.rejects(checkout(ids.winner), /PARTICIPANT_LIFETIME_ACCESS/)
    assert.equal((await checkout(ids.other)).status, 'pending')
    assert.equal((await rpc(null, 'xelay_public_premium', [[ids.winner]], { role: 'anon' }))[0].is_premium, true)

    await forbidden(asUser(ids.winner, 'select * from participant_lifetime_awards'))
    await forbidden(asUser(ids.winner, 'select xelay_private_participant_lifetime($1)', [ids.winner]))
    const own = await asUser(ids.winner, "select id,message from notifications where type='participant_lifetime_award'")
    assert.match(own.rows[0].message, /профіль став тисячним/)
    assert.equal((await asUser(ids.other, "select id from notifications where type='participant_lifetime_award'")).rows.length, 0)
    await forbidden(asUser(ids.winner, "update notifications set message='Modified' where id=$1", [own.rows[0].id]))
    await asUser(ids.winner, 'update notifications set is_read=true where id=$1', [own.rows[0].id])
    assert.equal((await db.query('select is_read from notifications where id=$1', [own.rows[0].id])).rows[0].is_read, true)
  })
})
