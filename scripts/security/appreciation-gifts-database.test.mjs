// Real gift routines in isolated PostgreSQL, with fictional accounts only.
// No provider, production database, real recipient, email or push is contacted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const root = new URL('../../', import.meta.url), first = result => result.rows[0]
const migration = await readFile(new URL('supabase/migrations/202610260006_appreciation_gifts.sql', root), 'utf8')
const denied = work => assert.rejects(work, error => error.code === '42501')

test('appreciation offers grant exactly one recipient-claimed calendar month and permanent hideable badge', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id),provider text,identity_data jsonb default '{}');
  ` })
  t.after(() => fx.close())
  const { db, seedUser } = fx
  await db.exec(await readFile(new URL('supabase/migrations/202610260001_birthday_gifts.sql', root), 'utf8'))
  const ids = Object.fromEntries(['admin', 'unverifiedAdmin', 'owner', 'other', 'unconfirmed', 'banned', 'deleted', 'rollback', 'offerRollback', 'fall', 'spring', 'monthEnd'].map(name => [name, randomUUID()]))
  for (const [name, id] of Object.entries(ids)) await seedUser(id, { full_name: 'Synthetic private full name ' + name, username: 'appreciation_' + name.toLowerCase(), categories: ['General'] })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN'),($2,'ADMIN')", [ids.admin, ids.unverifiedAdmin])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified'),($2,'unverified'),($3,'verified')", [ids.admin, ids.unverifiedAdmin, ids.other])
  await db.query('update auth.users set email_confirmed_at=null where id=$1', [ids.unconfirmed])
  await db.query("update auth.users set banned_until='infinity' where id=$1", [ids.banned])
  await db.query('update auth.users set deleted_at=now() where id=$1', [ids.deleted])
  async function run(user, sql, args = [], { role = 'authenticated', aal = 'aal1' } = {}) {
    return db.transaction(async tx => {
      await tx.exec('set local role ' + role)
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role, aal })])
      return (await tx.query(sql, args)).rows
    })
  }
  const rpc = async (user, name, args = [], options = {}) => (await run(user, `select ${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) data`, args, options))[0].data
  const offer = (user, greeting = '') => rpc(ids.admin, 'xelay_admin_offer_appreciation_gift', [user, greeting], { aal: 'aal2' })
  const claim = (user, gift) => rpc(user, 'xelay_claim_appreciation_gift', [gift])
  const list = user => rpc(user, 'xelay_my_appreciation_gifts')
  const badge = user => rpc(null, 'xelay_appreciation_badge', [user], { role: 'anon' })
  const count = async (table, where = '') => first(await db.query(`select count(*)::int n from ${table} ${where}`)).n
  const financial = async () => Object.fromEntries(await Promise.all(['billing_orders', 'billing_payment_events', 'support_orders', 'support_payment_events', 'user_roles'].map(async table => [table, (await db.query(`select to_jsonb(t) data from ${table} t order by id`)).rows])))
  const protectedFunctions = async () => (await db.query(`select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) body,p.proacl::text
    from pg_proc p where p.oid in('xelay_is_platform_admin()'::regprocedure,'xelay_reflow_participant_access(uuid)'::regprocedure,
      'xelay_queue_notification_email()'::regprocedure,'xelay_queue_participant_push()'::regprocedure,
      'xelay_profile_badge_preferences(uuid)'::regprocedure,'xelay_set_my_profile_badges(boolean,boolean)'::regprocedure,
      'xelay_claim_birthday_gift(uuid)'::regprocedure,'xelay_admin_offer_birthday_gift(uuid,text)'::regprocedure) order by signature`)).rows
  const initial = { financial: await financial(), functions: await protectedFunctions(), entitlements: await count('participant_entitlements'), notifications: await count('notifications'), email: await count('notification_email_outbox'), push: await count('participant_push_outbox') }

  await t.test('incompatible notification schema fails closed without partial installation', async () => {
    await db.exec("alter table notifications add constraint synthetic_appreciation_check check(type is distinct from 'appreciation_gift')")
    await assert.rejects(db.exec(migration), /APPRECIATION_GIFT_NOTIFICATION_CHECK_UNSUPPORTED/)
    await db.exec('rollback')
    assert.equal(first(await db.query("select to_regclass('public.appreciation_gifts') value")).value, null)
    await db.exec('alter table notifications drop constraint synthetic_appreciation_check')
    const trigger = first(await db.query("select pg_get_triggerdef(oid) body from pg_trigger where tgrelid='notifications'::regclass and tgname='notification_email_queue'")).body
    await db.exec("drop trigger notification_email_queue on notifications;create trigger notification_email_queue after insert on notifications for each row when(new.type is not null) execute function xelay_queue_notification_email()")
    try {
      await assert.rejects(db.exec(migration), /APPRECIATION_GIFT_PREREQUISITE_OR_SCHEMA_DRIFT/)
      await db.exec('rollback')
      assert.equal(first(await db.query("select to_regclass('public.appreciation_gifts') value")).value, null)
    } finally { await db.exec('drop trigger notification_email_queue on notifications;' + trigger) }
  })
  const preflight = (await db.exec(await readFile(new URL('artifacts/appreciation-gift-20261026/preflight.sql', root), 'utf8')))
    .flatMap(result => result.rows).find(row => row.appreciation_gift_preflight)?.appreciation_gift_preflight
  assert.equal(preflight?.ready, true, JSON.stringify(preflight?.checks))
  // Exercise the entire submitted SQL exactly as a Windows/browser CRLF paste.
  await db.exec(migration.replace(/\r?\n/g, '\r\n'))
  const postflight = (await db.exec(await readFile(new URL('artifacts/appreciation-gift-20261026/postflight.sql', root), 'utf8')))
    .flatMap(result => result.rows).find(row => row.appreciation_gift_postflight)?.appreciation_gift_postflight
  assert.equal(postflight?.passed, true, JSON.stringify(postflight?.checks))
  assert.deepEqual(postflight.legacy_functions, preflight.legacy_functions)
  const setTime = async stamp => db.exec(`create or replace function xelay_private_appreciation_gift_clock()
    returns timestamptz language sql volatile security invoker set search_path='' as $$select '${new Date(stamp).toISOString()}'::timestamptz$$`)

  await t.test('installation offers nothing and preserves financial functions, private badge preferences and existing access', async () => {
    assert.deepEqual(await financial(), initial.financial); assert.deepEqual(await protectedFunctions(), initial.functions)
    assert.equal(await count('appreciation_gifts'), 0); assert.equal(await count('participant_entitlements'), initial.entitlements)
    assert.equal(await count('notifications'), initial.notifications); assert.equal(await count('notification_email_outbox'), initial.email)
    assert.equal(await count('participant_push_outbox'), initial.push)
    const acl = first(await db.query(`select relrowsecurity rls,has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE') browser_access,
      has_table_privilege('anon',oid,'SELECT') anon_access,has_table_privilege('service_role',oid,'SELECT') service_access
      from pg_class where oid='appreciation_gifts'::regclass`))
    assert.deepEqual(acl, { rls: true, browser_access: false, anon_access: false, service_access: false })
    assert.equal(await badge(ids.owner), false); assert.equal(await badge(randomUUID()), false)
  })

  await t.test('MFA admin and confirmed active recipient are mandatory; no public table/helper or parameter-based identity bypass', async () => {
    await denied(rpc(ids.admin, 'xelay_admin_offer_appreciation_gift', [ids.owner, ''], { aal: 'aal1' }))
    await denied(rpc(ids.unverifiedAdmin, 'xelay_admin_offer_appreciation_gift', [ids.owner, ''], { aal: 'aal2' }))
    await denied(rpc(ids.other, 'xelay_admin_offer_appreciation_gift', [ids.owner, ''], { aal: 'aal2' }))
    for (const user of [null, randomUUID(), ids.unconfirmed, ids.banned, ids.deleted]) await denied(offer(user))
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await denied(run(ids.owner, 'select * from appreciation_gifts', [], { role }))
      await denied(run(ids.owner, 'select xelay_private_appreciation_gift_clock()', [], { role }))
      await denied(run(ids.owner, 'select xelay_private_appreciation_gift_json($1,false)', [randomUUID()], { role }))
    }
    await denied(rpc(null, 'xelay_my_appreciation_gifts', [], { role: 'anon' }))
    await denied(rpc(null, 'xelay_claim_appreciation_gift', [randomUUID()]))
    await assert.rejects(rpc(ids.owner, 'xelay_my_appreciation_gifts', [ids.other]), error => error.code === '42883')
    await assert.rejects(rpc(ids.owner, 'xelay_set_my_appreciation_badge', [ids.other, true]), error => error.code === '42883')
  })

  await t.test('offer enforces its own MFA even if the installed administrator helper only checks the base role', async () => {
    const original = first(await db.query("select pg_get_functiondef('xelay_is_platform_admin()'::regprocedure) body")).body
    await db.exec(`create or replace function xelay_is_platform_admin() returns boolean language sql stable security definer set search_path=public,pg_temp as $$
      select exists(select 1 from user_roles where user_id=auth.uid() and role='ADMIN')$$`)
    try {
      assert.equal(await rpc(ids.admin, 'xelay_is_platform_admin'), true)
      await denied(rpc(ids.admin, 'xelay_admin_offer_appreciation_gift', [ids.owner, ''], { aal: 'aal1' }))
      await denied(rpc(ids.unverifiedAdmin, 'xelay_admin_offer_appreciation_gift', [ids.owner, ''], { aal: 'aal2' }))
      await db.query("update auth.users set banned_until='infinity' where id=$1", [ids.admin])
      await denied(offer(ids.owner))
    } finally { await db.query('update auth.users set banned_until=null where id=$1', [ids.admin]); await db.exec(original) }
    assert.deepEqual(await protectedFunctions(), initial.functions)
  })

  let gift
  await t.test('duplicate queued offers create one private notification and no entitlement, earned badge, email or push', async () => {
    const offers = await Promise.all([offer(ids.owner, 'Synthetic first name'), offer(ids.owner, 'Changed name'), offer(ids.owner)])
    gift = offers[0]
    assert.ok(offers.every(item => item.id === gift.id && item.notification_id === gift.notification_id))
    assert.equal(gift.recipient_name, 'Synthetic first name'); assert.equal(gift.badge_name, 'Іскра Xelay'); assert.equal(gift.badge_key, 'community_spark')
    assert.equal(gift.badge_earned, false); assert.equal(gift.badge_visible, true); assert.equal(gift.claimed_at, null)
    assert.equal(gift.valid_from, null); assert.equal(gift.valid_until, null); assert.equal(gift.newly_claimed, false)
    assert.doesNotMatch(JSON.stringify(gift), /Synthetic private full name/)
    assert.deepEqual(await list(ids.owner), [gift]); assert.deepEqual(await list(ids.other), []); assert.deepEqual(await list(ids.admin), [])
    assert.equal(await badge(ids.owner), false); assert.equal(await count('appreciation_gifts'), 1)
    assert.equal(await count('participant_entitlements'), initial.entitlements)
    assert.equal(await count('notifications', "where type='appreciation_gift'"), 1)
    assert.equal(await count('notification_email_outbox'), initial.email); assert.equal(await count('participant_push_outbox'), initial.push)
    assert.equal(await count('billing_audit_log', "where action='appreciation_gift_offer'"), 1)
    assert.deepEqual(await run(ids.other, 'select * from notifications where id=$1', [gift.notification_id]), [])
  })

  await t.test('greeting is explicit and bounded; recipient read marker works but notification spoofing fails', async () => {
    for (const name of ['x'.repeat(81), 'bad\nname', 'bad\tname']) await assert.rejects(offer(ids.offerRollback, name), error => error.code === '22023')
    const unnamed = await offer(ids.other)
    assert.equal(unnamed.recipient_name, ''); assert.doesNotMatch(JSON.stringify(unnamed), /Synthetic private full name/)
    await run(ids.owner, 'update notifications set is_read=true where id=$1', [gift.notification_id])
    await denied(run(ids.owner, "insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$1,'Xelay','appreciation_gift','forged')", [ids.owner]))
    await db.exec('grant update(message,type) on notifications to authenticated')
    try {
      await denied(run(ids.owner, 'update notifications set message=$2 where id=$1', [gift.notification_id, 'forged']))
      await denied(run(ids.owner, "update notifications set type='answer' where id=$1", [gift.notification_id]))
      const ordinary = first(await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$1,'Synthetic','appreciation_fixture_ordinary','Ordinary preserved notification') returning id", [ids.owner]))
      assert.equal(await count('notification_email_outbox', "where notification_type='appreciation_fixture_ordinary'"), 1)
      await denied(run(ids.owner, "update notifications set type='appreciation_gift' where id=$1", [ordinary.id]))
    } finally { await db.exec('revoke update(message,type) on notifications from authenticated') }
  })

  await t.test('foreign, unknown and unavailable accounts cannot claim or earn the badge', async () => {
    await denied(claim(ids.other, gift.id)); await denied(claim(ids.owner, randomUUID()))
    await denied(rpc(ids.owner, 'xelay_set_my_appreciation_badge', [false]))
    for (const alteration of ['email_confirmed_at=null', "banned_until='infinity'", 'deleted_at=now()']) {
      await db.query(`update auth.users set ${alteration} where id=$1`, [ids.owner])
      await denied(claim(ids.owner, gift.id))
      await db.query('update auth.users set email_confirmed_at=now(),banned_until=null,deleted_at=null where id=$1', [ids.owner])
    }
    assert.equal(await badge(ids.owner), false); assert.equal((await list(ids.owner))[0].claimed_at, null)
  })

  await t.test('recipient claim appends after queued access, earns badge and grants exactly one month despite repeated claims', async () => {
    const payment = first(await db.query(`insert into billing_orders(user_id,product,order_reference,amount,mode,status,approved_at)
      values($1,'participant',$2,100,'live','approved',now()) returning id`, [ids.owner, 'synthetic-appreciation-' + randomUUID()]))
    await db.query(`insert into participant_entitlements(user_id,source,order_id,term_months,valid_from,valid_until)
      values($1,'payment',$2,1,now()-interval '1 day',now()+interval '1 day'),
        ($1,'admin_grant',null,1,now()+interval '1 day',now()+interval '1 month')`, [ids.owner, payment.id])
    const paidBefore = first(await db.query('select to_jsonb(e) data from participant_entitlements e where order_id=$1', [payment.id])).data
    const financialBefore = await financial()
    const claims = await Promise.all([claim(ids.owner, gift.id), claim(ids.owner, gift.id), claim(ids.owner, gift.id)])
    assert.equal(claims.filter(item => item.newly_claimed).length, 1)
    assert.ok(claims.every(item => item.badge_earned && item.id === gift.id && item.valid_until === claims[0].valid_until))
    const entitlement = first(await db.query(`select e.source,e.term_months,e.order_id,
      e.valid_from=(select max(other.valid_until) from participant_entitlements other where other.user_id=e.user_id and other.id<>e.id
        and other.revoked_at is null and other.valid_until>now()) appended,
      e.valid_until=(((e.valid_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv') calendar_month
      from participant_entitlements e join appreciation_gifts g on g.entitlement_id=e.id where g.id=$1`, [gift.id]))
    assert.deepEqual(entitlement, { source: 'admin_grant', term_months: 1, order_id: null, appended: true, calendar_month: true })
    assert.equal(await count('billing_audit_log', "where action='appreciation_gift_claim'"), 1)
    assert.equal(await badge(ids.owner), true); assert.deepEqual(await financial(), financialBefore)
    assert.deepEqual(first(await db.query('select to_jsonb(e) data from participant_entitlements e where order_id=$1', [payment.id])).data, paidBefore)
    assert.equal(await count('participant_push_outbox'), initial.push)
    assert.equal(await count('notification_email_outbox', "where notification_type='appreciation_gift'"), 0)
  })

  await t.test('visibility hides the public badge without changing earned status, exact access dates, other badges or replay state', async () => {
    const before = first(await db.query('select to_jsonb(e) data from participant_entitlements e join appreciation_gifts g on g.entitlement_id=e.id where g.id=$1', [gift.id])).data
    const preferences = await rpc(ids.owner, 'xelay_profile_badge_preferences', [ids.owner])
    assert.deepEqual(await rpc(ids.owner, 'xelay_set_my_appreciation_badge', [false]), { badge_key: 'community_spark', badge_name: 'Іскра Xelay', earned: true, visible: false })
    assert.equal(await badge(ids.owner), false); assert.equal(await badge(randomUUID()), false)
    assert.equal((await claim(ids.owner, gift.id)).badge_visible, false)
    assert.equal((await rpc(ids.owner, 'xelay_my_appreciation_badge')).earned, true)
    assert.equal(await rpc(null, 'xelay_appreciation_badge', [ids.owner], { role: 'anon' }), false)
    assert.deepEqual(await rpc(ids.owner, 'xelay_profile_badge_preferences', [ids.owner]), preferences)
    assert.deepEqual(first(await db.query('select to_jsonb(e) data from participant_entitlements e join appreciation_gifts g on g.entitlement_id=e.id where g.id=$1', [gift.id])).data, before)
    await rpc(ids.owner, 'xelay_set_my_appreciation_badge', [true]); assert.equal(await badge(ids.owner), true)
    assert.equal(typeof await badge(ids.owner), 'boolean')
  })

  await t.test('an audit failure rolls notification, entitlement, read marker and earned badge back atomically', async () => {
    const rollbackGift = await offer(ids.rollback)
    await db.exec(`create function pg_temp.reject_appreciation_audit() returns trigger language plpgsql as $$begin
      if new.action in('appreciation_gift_offer','appreciation_gift_claim') then raise exception 'Synthetic appreciation audit failure';end if;return new;end$$;
      create trigger synthetic_reject_appreciation_audit before insert on billing_audit_log for each row execute function pg_temp.reject_appreciation_audit();`)
    const before = { gifts: await count('appreciation_gifts'), entitlements: await count('participant_entitlements'), notifications: await count('notifications') }
    try {
      await assert.rejects(claim(ids.rollback, rollbackGift.id), /Synthetic appreciation audit failure/)
      await assert.rejects(offer(ids.offerRollback), /Synthetic appreciation audit failure/)
      assert.equal((await list(ids.rollback))[0].claimed_at, null); assert.equal(await badge(ids.rollback), false)
      assert.equal(first(await db.query('select is_read from notifications where id=$1', [rollbackGift.notification_id])).is_read, false)
      assert.equal(await count('appreciation_gifts'), before.gifts); assert.equal(await count('participant_entitlements'), before.entitlements)
      assert.equal(await count('notifications'), before.notifications)
    } finally { await db.exec('drop trigger synthetic_reject_appreciation_audit on billing_audit_log') }
  })

  await t.test('Kyiv calendar months preserve local time across DST and clamp a month-end date', async () => {
    for (const [user, start, end] of [[ids.fall, '2026-10-24T09:00:00Z', '2026-11-24T10:00:00Z'],
      [ids.spring, '2027-02-28T10:00:00Z', '2027-03-28T09:00:00Z'], [ids.monthEnd, '2027-01-31T10:00:00Z', '2027-02-28T10:00:00Z']]) {
      await setTime(start)
      const offered = await offer(user), result = await claim(user, offered.id)
      assert.equal(new Date(result.valid_from).toISOString(), new Date(start).toISOString())
      assert.equal(new Date(result.valid_until).toISOString(), new Date(end).toISOString()); assert.equal(result.badge_earned, true)
    }
    assert.deepEqual(await protectedFunctions(), initial.functions)
  })
})
