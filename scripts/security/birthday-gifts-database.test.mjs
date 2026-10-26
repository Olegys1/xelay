// Real migration chain in an isolated synthetic PostgreSQL model. No network,
// real account, provider, mail or production database is accessed by this test.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createFixture } from './fixture.mjs'

const migration = await readFile(new URL('../../supabase/migrations/202610260001_birthday_gifts.sql', import.meta.url), 'utf8')
const ids = Object.fromEntries(['admin', 'unverifiedAdmin', 'owner', 'other', 'unconfirmed', 'banned', 'deleted',
  'rollback', 'offerRollback', 'fall', 'spring', 'monthEnd', 'rollover'].map(name => [name, randomUUID()]))
const first = result => result.rows[0]
const denied = work => assert.rejects(work, error => error.code === '42501')
const iso = value => value === null ? null : new Date(value).toISOString()

test('birthday gifts are private, explicitly offered, idempotently claimed calendar months without payments or email', async t => {
  // Through 202610220006 includes the actual installed billing and trusted
  // notification dependencies. Later platform-news migration intentionally
  // fingerprints a different inspected live admin helper; do not weaken its
  // production preflight merely to install unrelated code in this fixture.
  const fx = await createFixture({ useStagingParity: true, through: '202610220006', beforeMigrationsSql: `
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;
    alter table auth.users add column raw_app_meta_data jsonb default '{}';
    create table auth.identities(id uuid primary key,user_id uuid references auth.users(id) on delete cascade,
      provider text,identity_data jsonb default '{}');
  ` })
  t.after(() => fx.close())
  const { db, seedUser } = fx
  for (const [name, id] of Object.entries(ids)) await seedUser(id, { username: 'birthday_' + name.toLowerCase(), full_name: name === 'owner' ? 'Тестове Прізвище Аліна' : 'Synthetic ' + name, categories: ['General'] })
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN'),($2,'ADMIN')", [ids.admin, ids.unverifiedAdmin])
  await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified'),($2,'unverified'),($3,'verified')", [ids.admin, ids.unverifiedAdmin, ids.other])
  await db.query('update auth.users set email_confirmed_at=null where id=$1', [ids.unconfirmed])
  await db.query("update auth.users set banned_until='infinity' where id=$1", [ids.banned])
  await db.query('update auth.users set deleted_at=now() where id=$1', [ids.deleted])
  const baselineTime = first(await db.query('select now() as value')).value
  const initialYear = new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Europe/Kyiv' }).format(new Date(baselineTime))

  async function run(user, sql, params = [], { role = 'authenticated', aal = 'aal1' } = {}) {
    return db.transaction(async tx => {
      await tx.exec('set local role ' + role)
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role, aal })])
      return (await tx.query(sql, params)).rows
    })
  }
  const admin = (sql, params = [], options = {}) => run(ids.admin, sql, params, { aal: 'aal2', ...options })
  const offer = async (user, greetingName = '') => (await admin('select xelay_admin_offer_birthday_gift($1,$2) as value', [user, greetingName]))[0].value
  const list = async user => (await run(user, 'select xelay_my_birthday_gifts() as value'))[0].value
  const claim = async (user, gift) => (await run(user, 'select xelay_claim_birthday_gift($1) as value', [gift]))[0].value
  const count = async (table, where = '') => first(await db.query(`select count(*)::int as n from public.${table} ${where}`)).n
  const financialState = async () => Object.fromEntries(await Promise.all(
    ['billing_orders', 'billing_payment_events', 'support_orders', 'support_payment_events', 'user_roles'].map(async table =>
      [table, (await db.query(`select to_jsonb(t) as row from public.${table} t order by id`)).rows])))
  const existingFunctions = async () => (await db.query(`select proname,pg_get_functiondef(oid) as definition,proacl::text
    from pg_proc where pronamespace='public'::regnamespace and proname in(
      'xelay_apply_billing_event','xelay_reflow_participant_access','xelay_admin_grant_participant',
      'xelay_apply_support_event','xelay_create_billing_order','xelay_queue_notification_email','xelay_is_platform_admin') order by proname`)).rows
  const protectedBefore = await financialState(), functionsBefore = await existingFunctions()
  const notificationsBefore = (await db.query('select to_jsonb(t) as row from notifications t order by id')).rows
  const outboxBefore = (await db.query('select to_jsonb(t) as row from notification_email_outbox t order by id')).rows
  const existingEntitlements = (await db.query('select * from participant_entitlements order by id')).rows
  const otherTriggers = async () => (await db.query(`select tgname,pg_get_triggerdef(oid) as definition
    from pg_trigger where tgrelid='notifications'::regclass and not tgisinternal
    and tgname not in('notification_email_queue','birthday_gift_notification_update_guard') order by tgname`)).rows
  const triggersBefore = await otherTriggers()
  await t.test('installation fails closed for an incompatible type CHECK or a changed email trigger, with no partial changes', async () => {
    await db.exec("alter table notifications add constraint birthday_fixture_type_check check(type is distinct from 'birthday_gift')")
    await assert.rejects(db.exec(migration), /BIRTHDAY_GIFT_NOTIFICATION_CHECK_UNSUPPORTED/)
    await db.exec('rollback')
    assert.equal(first(await db.query("select to_regclass('public.birthday_gifts') as relation")).relation, null)
    await db.exec('alter table notifications drop constraint birthday_fixture_type_check')
    const trigger = first(await db.query("select pg_get_triggerdef(oid) as body from pg_trigger where tgrelid='notifications'::regclass and tgname='notification_email_queue'")).body
    await db.exec(`drop trigger notification_email_queue on notifications;
      create trigger notification_email_queue after insert on notifications for each row when(new.type is not null) execute function xelay_queue_notification_email()`)
    try {
      await assert.rejects(db.exec(migration), /BIRTHDAY_GIFT_PREREQUISITES_MISSING/)
      await db.exec('rollback')
      assert.equal(first(await db.query("select to_regclass('public.birthday_gifts') as relation")).relation, null)
    } finally { await db.exec('drop trigger notification_email_queue on notifications;' + trigger) }
    assert.deepEqual(await existingFunctions(), functionsBefore)
  })
  await db.exec(migration)
  // Replace only the new private clock inside this isolated synthetic database.
  const setTime = async stamp => {
    const literal = new Date(stamp).toISOString()
    await db.exec(`create or replace function public.xelay_private_birthday_gift_clock()
      returns timestamptz language sql volatile security invoker set search_path='' as $$select '${literal}'::timestamptz$$`)
  }

  await t.test('installation has no offers or side effects and preserves existing financial/admin functions', async () => {
    assert.deepEqual(await financialState(), protectedBefore)
    assert.deepEqual(await existingFunctions(), functionsBefore)
    assert.deepEqual(await otherTriggers(), triggersBefore)
    assert.deepEqual((await db.query('select * from participant_entitlements order by id')).rows, existingEntitlements)
    assert.deepEqual((await db.query('select to_jsonb(t) as row from notifications t order by id')).rows, notificationsBefore)
    assert.deepEqual((await db.query('select to_jsonb(t) as row from notification_email_outbox t order by id')).rows, outboxBefore)
    assert.equal(await count('birthday_gifts'), 0)
    const clock = first(await db.query("select pg_get_functiondef(oid) as body from pg_proc where oid='xelay_private_birthday_gift_clock()'::regprocedure"))
    assert.match(clock.body, /pg_catalog\.clock_timestamp\(\)/)
    const acl = first(await db.query(`select c.relrowsecurity as rls,
      has_table_privilege('anon',c.oid,'SELECT') as anon_select,
      has_table_privilege('authenticated',c.oid,'SELECT') as auth_select,
      has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') as auth_write,
      has_table_privilege('service_role',c.oid,'SELECT') as service_select
      from pg_class c where c.oid='birthday_gifts'::regclass`))
    assert.deepEqual(acl, { rls: true, anon_select: false, auth_select: false, auth_write: false, service_select: false })
    const functions = (await db.query(`select proname,prosecdef,proconfig,
      has_function_privilege('anon',oid,'EXECUTE') as anon_execute,
      has_function_privilege('authenticated',oid,'EXECUTE') as auth_execute,
      has_function_privilege('service_role',oid,'EXECUTE') as service_execute
      from pg_proc where pronamespace='public'::regnamespace and proname like '%birthday_gift%'`)).rows
    assert.equal(functions.length, 6)
    for (const fn of functions) {
      assert.ok(fn.proconfig.includes('search_path=""'))
      assert.equal(fn.anon_execute, false)
      assert.equal(fn.service_execute, false)
      assert.equal(fn.auth_execute, ['xelay_my_birthday_gifts', 'xelay_admin_offer_birthday_gift', 'xelay_claim_birthday_gift'].includes(fn.proname))
      assert.equal(fn.prosecdef, fn.proname !== 'xelay_private_birthday_gift_clock')
    }
  })

  await t.test('only an MFA verified administrator may offer; recipient and private state cannot be selected by a browser', async () => {
    await denied(run(null, 'select xelay_my_birthday_gifts()', [], { role: 'anon' }))
    await denied(run(null, 'select xelay_my_birthday_gifts()'))
    await denied(run(null, 'select xelay_claim_birthday_gift($1)', [randomUUID()], { role: 'anon' }))
    await denied(run(null, 'select xelay_claim_birthday_gift($1)', [randomUUID()]))
    await denied(run(ids.other, 'select xelay_admin_offer_birthday_gift($1)', [ids.owner], { aal: 'aal2' }))
    await denied(admin('select xelay_admin_offer_birthday_gift($1)', [ids.owner], { aal: 'aal1' }))
    await denied(run(ids.unverifiedAdmin, 'select xelay_admin_offer_birthday_gift($1)', [ids.owner], { aal: 'aal2' }))
    await denied(run(null, 'select xelay_admin_offer_birthday_gift($1)', [ids.owner], { role: 'service_role' }))
    for (const target of [null, randomUUID(), ids.unconfirmed, ids.banned, ids.deleted]) await denied(offer(target))
    for (const role of ['anon', 'authenticated', 'service_role']) {
      await denied(run(ids.owner, 'select * from birthday_gifts', [], { role }))
      await denied(run(ids.owner, 'select xelay_private_birthday_gift_clock()', [], { role }))
      await denied(run(ids.owner, 'select xelay_private_birthday_gift_json($1,false)', [randomUUID()], { role }))
    }
    await denied(run(ids.owner, 'delete from birthday_gifts'))
    await denied(run(ids.owner, 'update birthday_gifts set recipient_id=$1', [ids.owner]))
    await assert.rejects(run(ids.owner, 'select xelay_my_birthday_gifts($1)', [ids.other]), error => error.code === '42883')
    await assert.rejects(admin('select xelay_admin_offer_birthday_gift($1,2027)', [ids.owner]), error => error.code === '42883')
    assert.deepEqual(await list(ids.owner), [])
  })

  await t.test('endpoint enforces its own MFA with a production-like base ADMIN helper', async () => {
    const original = first(await db.query("select pg_get_functiondef('public.xelay_is_platform_admin()'::regprocedure) as body")).body
    try {
      await db.exec(`create or replace function public.xelay_is_platform_admin()
        returns boolean language sql stable security definer set search_path=public,pg_temp as $$
          select exists(select 1 from public.user_roles where user_id=auth.uid() and role='ADMIN')$$`)
      assert.equal((await admin('select xelay_is_platform_admin() as value', [], { aal: 'aal1' }))[0].value, true)
      await denied(admin('select xelay_admin_offer_birthday_gift($1)', [ids.owner], { aal: 'aal1' }))
      await denied(run(ids.unverifiedAdmin, 'select xelay_admin_offer_birthday_gift($1)', [ids.owner], { aal: 'aal2' }))
      await db.query("update auth.users set banned_until='infinity' where id=$1", [ids.admin])
      await denied(offer(ids.owner))
    } finally {
      await db.query('update auth.users set banned_until=null where id=$1', [ids.admin])
      await db.exec(original)
    }
    assert.deepEqual(await existingFunctions(), functionsBefore)
  })

  let gift
  await t.test('repeated and queued offers create one in-app notification, no entitlement, email or push', async () => {
    await setTime(baselineTime)
    const offers = await Promise.all([offer(ids.owner, '  Аліна  '), offer(ids.owner, 'Аліна'), offer(ids.owner, 'Аліна')])
    gift = offers[0]
    assert.ok(offers.every(result => result.id === gift.id && result.notification_id === gift.notification_id))
    assert.equal(gift.recipient_name, 'Аліна')
    assert.doesNotMatch(JSON.stringify(gift), /Тестове Прізвище/)
    assert.equal(gift.gift_year, Number(initialYear))
    assert.equal(gift.claimed_at, null)
    assert.equal(gift.valid_from, null)
    assert.equal(gift.valid_until, null)
    assert.equal(gift.newly_claimed, false)
    assert.deepEqual(Object.keys(gift).sort(), ['id', 'notification_id', 'recipient_name', 'gift_year', 'offered_at', 'claimed_at', 'valid_from', 'valid_until', 'newly_claimed'].sort())
    assert.deepEqual(await list(ids.owner), [gift])
    assert.deepEqual(await list(ids.other), [])
    assert.deepEqual(await list(ids.admin), [])
    assert.equal(await count('birthday_gifts'), 1)
    assert.equal(await count('notifications', "where type='birthday_gift'"), 1)
    assert.equal(await count('participant_entitlements'), existingEntitlements.length)
    assert.equal(await count('notification_email_outbox', "where notification_type='birthday_gift'"), 0)
    assert.equal(await count('participant_push_outbox'), 0)
    assert.equal(await count('billing_audit_log', "where action='birthday_gift_offer'"), 1)
    const originalNotification = first(await db.query('select * from notifications where id=$1', [gift.notification_id]))
    const reoffered = await offer(ids.owner, 'Змінене ім’я')
    assert.equal(reoffered.id, gift.id)
    assert.equal(reoffered.recipient_name, 'Аліна')
    assert.deepEqual(first(await db.query('select * from notifications where id=$1', [gift.notification_id])), originalNotification)
    assert.equal(await count('notifications', "where type='birthday_gift'"), 1)
    assert.deepEqual(await run(ids.other, 'select * from notifications where id=$1', [gift.notification_id]), [])
  })

  await t.test('greeting names are explicit, optional, bounded, control-free and never fall back to profile identity', async () => {
    for (const value of ['x'.repeat(81), 'Аліна\n', '\tАліна', 'Аліна\rСакун', 'Аліна\u007f']) {
      await assert.rejects(offer(ids.offerRollback, value), error => error.code === '22023')
    }
    assert.deepEqual(await list(ids.offerRollback), [])
    const unnamed = (await admin('select xelay_admin_offer_birthday_gift($1) as value', [ids.other]))[0].value
    assert.equal(unnamed.recipient_name, '')
    assert.equal((await list(ids.other))[0].recipient_name, '')
    const namedList = await list(ids.owner)
    assert.equal(namedList[0].recipient_name, 'Аліна')
    assert.doesNotMatch(JSON.stringify(namedList), /Тестове Прізвище/)
  })

  await t.test('notification read marker remains usable; content/type cannot be forged or converted', async () => {
    await run(ids.owner, 'update notifications set is_read=true where id=$1', [gift.notification_id])
    assert.equal(first(await db.query('select is_read from notifications where id=$1', [gift.notification_id])).is_read, true)
    await denied(run(ids.owner, 'update notifications set message=$2 where id=$1', [gift.notification_id, 'forged']))
    await denied(run(ids.owner, "update notifications set type='answer' where id=$1", [gift.notification_id]))
    await denied(run(ids.owner, "insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$1,'Xelay','birthday_gift','forged')", [ids.owner]))
    // Even a future accidental broad update grant must not bypass the new guard.
    await db.exec('grant update(message,type) on notifications to authenticated')
    try {
      await denied(run(ids.owner, 'update notifications set message=$2 where id=$1', [gift.notification_id, 'forged']))
      const ordinary = first(await db.query("insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$1,'Synthetic','birthday_fixture_other','Synthetic ordinary event') returning id", [ids.owner]))
      assert.equal(await count('notification_email_outbox', "where notification_type='birthday_fixture_other'"), 1)
      await denied(run(ids.owner, "update notifications set type='birthday_gift' where id=$1", [ordinary.id]))
    } finally { await db.exec('revoke update(message,type) on notifications from authenticated') }
  })

  await t.test('foreign, unknown and unavailable account claims fail without changing any access', async () => {
    await denied(claim(ids.other, gift.id))
    await denied(claim(ids.owner, randomUUID()))
    await denied(claim(ids.owner, null))
    for (const alteration of ["email_confirmed_at=null", "banned_until='infinity'", 'deleted_at=now()']) {
      await db.query(`update auth.users set ${alteration} where id=$1`, [ids.owner])
      await denied(claim(ids.owner, gift.id))
      await db.query('update auth.users set email_confirmed_at=now(),banned_until=null,deleted_at=null where id=$1', [ids.owner])
    }
    assert.equal((await list(ids.owner))[0].claimed_at, null)
    assert.equal(await count('participant_entitlements'), existingEntitlements.length)
  })

  let paidOrder
  await t.test('claim appends after paid and granted queued access; duplicate queued claims create exactly one audited entitlement', async () => {
    // Keep all access dates relative to actual DB now because the existing
    // reflow deliberately retains its own untouched billing/server clock.
    paidOrder = first(await db.query(`insert into billing_orders(user_id,product,order_reference,amount,mode,status,approved_at)
      values($1,'participant',$2,100,'live','approved',now()) returning id`, [ids.owner, 'birthday-existing-' + randomUUID()]))
    await db.query(`insert into participant_entitlements(user_id,source,order_id,term_months,valid_from,valid_until)
      values($1,'payment',$2,1,now()-interval '1 day',now()+interval '1 day'),
      ($1,'admin_grant',null,1,now()+interval '1 day',((now()+interval '1 day') at time zone 'Europe/Kyiv')+interval '1 month'),
      ($1,'admin_grant',null,1,now()-interval '2 months',now()-interval '1 month')`, [ids.owner, paidOrder.id])
    await db.query(`insert into participant_entitlements(user_id,source,term_months,valid_from,valid_until,revoked_at)
      values($1,'admin_grant',1,now()+interval '2 months',now()+interval '3 months',now())`, [ids.owner])
    const before = await financialState()
    const paidBefore = first(await db.query('select * from participant_entitlements where order_id=$1', [paidOrder.id]))
    const unchangedBefore = (await db.query('select * from participant_entitlements where user_id=$1 and (revoked_at is not null or valid_until<=now()) order by id', [ids.owner])).rows
    await run(ids.owner, 'update notifications set is_read=false where id=$1', [gift.notification_id])
    const claims = await Promise.all([claim(ids.owner, gift.id), claim(ids.owner, gift.id), claim(ids.owner, gift.id)])
    assert.equal(claims.filter(result => result.newly_claimed).length, 1)
    assert.ok(claims.every(result => result.recipient_name === 'Аліна'))
    assert.doesNotMatch(JSON.stringify(claims), /Тестове Прізвище/)
    assert.ok(claims.every(result => result.id === gift.id && result.valid_from === claims[0].valid_from && result.valid_until === claims[0].valid_until))
    const entitlement = first(await db.query(`select e.*,e.valid_from=(select max(other.valid_until) from participant_entitlements other
      where other.user_id=e.user_id and other.id<>e.id and other.revoked_at is null and other.valid_until>now()) as appended,
      e.valid_until=(((e.valid_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv') as calendar_month
      from participant_entitlements e join birthday_gifts g on g.entitlement_id=e.id where g.id=$1`, [gift.id]))
    assert.equal(entitlement.source, 'admin_grant')
    assert.equal(entitlement.order_id, null)
    assert.equal(entitlement.term_months, 1)
    assert.equal(entitlement.revoked_at, null)
    assert.equal(entitlement.appended, true)
    assert.equal(entitlement.calendar_month, true)
    assert.equal(await count('billing_audit_log', "where action='birthday_gift_claim'"), 1)
    assert.equal(await count('notifications', "where type='birthday_gift' and recipient_id='" + ids.owner + "'"), 1)
    assert.equal(await count('notification_email_outbox', "where notification_type='birthday_gift'"), 0)
    assert.equal(first(await db.query('select is_read from notifications where id=$1', [gift.notification_id])).is_read, true)
    assert.deepEqual(await financialState(), before)
    assert.deepEqual(first(await db.query('select * from participant_entitlements where order_id=$1', [paidOrder.id])), paidBefore)
    assert.deepEqual((await db.query('select * from participant_entitlements where user_id=$1 and (revoked_at is not null or valid_until<=now()) order by id', [ids.owner])).rows, unchangedBefore)
    assert.deepEqual(await existingFunctions(), functionsBefore)
    assert.equal((await list(ids.owner))[0].newly_claimed, false)
    assert.equal((await offer(ids.owner)).id, gift.id)
    await run(ids.owner, 'update notifications set is_read=false where id=$1', [gift.notification_id])
    assert.equal((await claim(ids.owner, gift.id)).newly_claimed, false)
    assert.equal(first(await db.query('select is_read from notifications where id=$1', [gift.notification_id])).is_read, true)
  })

  await t.test('audit failure rolls the whole claim or offer back, including entitlement/notification writes', async () => {
    const rollbackGift = await offer(ids.rollback)
    await db.exec(`create function public.birthday_fixture_reject_audit() returns trigger language plpgsql as $$begin
      if new.action in('birthday_gift_claim','birthday_gift_offer') then raise exception 'SYNTHETIC_AUDIT_FAILURE'; end if;return new;end$$;
      create trigger birthday_fixture_reject_audit before insert on billing_audit_log for each row execute function birthday_fixture_reject_audit();`)
    const beforeGifts = await count('birthday_gifts'), beforeEntitlements = await count('participant_entitlements')
    const beforeNotifications = await count('notifications'), beforeAudits = await count('billing_audit_log')
    try {
      await assert.rejects(claim(ids.rollback, rollbackGift.id), /SYNTHETIC_AUDIT_FAILURE/)
      await assert.rejects(offer(ids.offerRollback), /SYNTHETIC_AUDIT_FAILURE/)
      assert.equal((await list(ids.rollback))[0].claimed_at, null)
      assert.equal(first(await db.query('select is_read from notifications where id=$1', [rollbackGift.notification_id])).is_read, false)
      assert.equal(await count('birthday_gifts'), beforeGifts)
      assert.equal(await count('participant_entitlements'), beforeEntitlements)
      assert.equal(await count('notifications'), beforeNotifications)
      assert.equal(await count('billing_audit_log'), beforeAudits)
      assert.equal(await count('notification_email_outbox', "where notification_type='birthday_gift'"), 0)
    } finally {
      await db.exec('drop trigger birthday_fixture_reject_audit on billing_audit_log;drop function birthday_fixture_reject_audit()')
    }
    assert.equal((await claim(ids.rollback, rollbackGift.id)).newly_claimed, true)
  })

  await t.test('Kyiv calendar month preserves local time across both DST changes and clamps month end', async () => {
    for (const [user, start, end] of [
      [ids.fall, '2026-10-24T09:00:00Z', '2026-11-24T10:00:00Z'],
      [ids.spring, '2027-02-28T10:00:00Z', '2027-03-28T09:00:00Z'],
      [ids.monthEnd, '2027-01-31T10:00:00Z', '2027-02-28T10:00:00Z'],
    ]) {
      await setTime(start)
      const result = await claim(user, (await offer(user)).id)
      assert.equal(iso(result.valid_from), iso(start))
      assert.equal(iso(result.valid_until), iso(end))
      assert.equal(iso(result.claimed_at), iso(start))
      assert.equal(result.newly_claimed, true)
    }
  })

  await t.test('offer year follows Kyiv server midnight and each year remains independently idempotent', async () => {
    await setTime('2026-12-31T21:59:59.999Z')
    const beforeMidnight = await offer(ids.rollover)
    assert.equal(beforeMidnight.gift_year, 2026)
    await setTime('2026-12-31T22:00:00Z')
    const afterMidnight = await offer(ids.rollover)
    assert.equal(afterMidnight.gift_year, 2027)
    assert.notEqual(beforeMidnight.id, afterMidnight.id)
    assert.equal((await offer(ids.rollover)).id, afterMidnight.id)
    assert.equal((await list(ids.rollover)).length, 2)
    assert.equal(await count('notification_email_outbox', "where notification_type='birthday_gift'"), 0)
    assert.equal(await count('participant_push_outbox'), 0)
    assert.deepEqual(await existingFunctions(), functionsBefore)
    assert.equal((await db.query('select status from billing_orders where id=$1', [paidOrder.id])).rows[0].status, 'approved')
  })

  await t.test('own list bounds all offer history, including claimed gifts, to its latest 20 rows', async () => {
    const before = await financialState()
    for (let year = 2028; year <= 2048; year++) {
      await setTime(`${year}-01-01T12:00:00Z`)
      await offer(ids.rollover)
    }
    const own = await list(ids.rollover)
    assert.equal(own.length, 20)
    assert.equal(own[0].gift_year, 2048)
    assert.equal(own.at(-1).gift_year, 2029)
    await claim(ids.rollover, own[0].id)
    assert.equal((await list(ids.rollover)).length, 20)
    assert.ok((await list(ids.rollover))[0].claimed_at)
    assert.deepEqual(await financialState(), before)
  })
})
