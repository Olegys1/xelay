// One sequential, synthetic PGlite fixture. Never connects to Supabase.
// This file works here or when copied into the repository's scripts/security/.
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const repo = existsSync(new URL('./fixture.mjs', import.meta.url))
  ? new URL('../../', import.meta.url) : new URL('../../xelay/', import.meta.url)
const { createFixture } = await import(new URL('scripts/security/fixture.mjs', repo))
const migrationName = '202610300001_halloween_extra_rewards.sql'
const migrationUrl = existsSync(new URL(migrationName, import.meta.url))
  ? new URL(migrationName, import.meta.url) : new URL(`supabase/migrations/${migrationName}`, repo)
const migration = await readFile(migrationUrl, 'utf8')
const historicalMigration = await readFile(new URL('supabase/migrations/202610180001_halloween_hunt.sql', repo), 'utf8')
// Optional private preflight input exercises the exact installed production bodies.
// No preflight data or real account identifier is embedded in this committed test.
const productionFunctions = process.env.XELAY_HALLOWEEN_PREFLIGHT
  ? JSON.parse(await readFile(pathToFileURL(process.env.XELAY_HALLOWEEN_PREFLIGHT), 'utf8')).functions
      .map(({ name, source }) => ({ name, source })) : []
const users = Array.from({ length: 18 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
const pumpkins = ['home', 'questions', 'news', 'groups', 'people', 'messages', 'support', 'opportunities', 'subscription', 'profile']
const first = result => result.rows[0]
const signatures = ['public.xelay_my_halloween_hunt()', 'public.xelay_collect_halloween_pumpkin(text)']
const oldCopy = 'Перші 10 подарункових підписок уже розібрали, але ваш бейдж залишиться з вами.'
const newCopy = 'Подарункові підписки нової хвилі вже розібрали, але ваш бейдж залишиться з вами.'

test('five extra Halloween slots belong only to new completions after activation', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610170999', beforeMigrationsSql: `
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;` })
  t.after(() => fx.close())
  const { db, seedUser } = fx
  for (let i = 0; i < users.length; i++) await seedUser(users[i], { username: `extra_halloween_${i}`, categories: ['General'] })
  await db.exec(historicalMigration)

  for (const production of productionFunctions) {
    const signature = signatures.find(value => value.includes(`${production.name}(`))
    assert.ok(signature, 'Only the two intended production RPC bodies may be used')
    const row = first(await db.query('select pg_get_functiondef(oid) definition,prosrc source from pg_proc where oid=$1::regprocedure', [signature]))
    assert.ok(row.definition.includes(row.source))
    await db.exec(row.definition.replace(row.source, production.source))
    assert.equal(first(await db.query('select prosrc source from pg_proc where oid=$1::regprocedure', [signature])).source, production.source)
  }

  const originalFunctions = []
  for (const signature of signatures) originalFunctions.push(first(await db.query(
    'select oid::regprocedure::text signature,pg_get_functiondef(oid) definition,prosrc source from pg_proc where oid=$1::regprocedure', [signature])))
  const protectedFunctions = async () => (await db.query(`select oid::regprocedure::text signature,pg_get_functiondef(oid) definition,proacl::text
    from pg_proc where pronamespace='public'::regnamespace and proname in(
    'xelay_apply_billing_event','xelay_reflow_participant_access','xelay_admin_grant_participant',
    'xelay_apply_support_event','xelay_create_billing_order','xelay_queue_notification_email') order by signature`)).rows
  const protectedBefore = await protectedFunctions()
  const permissions = async () => ({
    functions: (await db.query(`select oid::regprocedure::text signature,proowner,proacl::text,prosecdef,proconfig
      from pg_proc where pronamespace='public'::regnamespace and proname like '%halloween%' order by signature`)).rows,
    tables: (await db.query(`select relname,relowner,relacl::text,relrowsecurity from pg_class
      where oid in('halloween_2026_campaign'::regclass,'halloween_2026_collections'::regclass,'halloween_2026_rewards'::regclass) order by relname`)).rows,
  })
  const rows = async table => (await db.query(`select to_jsonb(t) data from public.${table} t order by to_jsonb(t)::text`)).rows
  const data = async () => {
    const result = {}
    for (const table of ['halloween_2026_campaign', 'halloween_2026_collections', 'halloween_2026_rewards',
      'participant_entitlements', 'billing_audit_log', 'notifications', 'notification_email_outbox',
      'billing_orders', 'billing_payment_events', 'support_orders', 'support_payment_events']) result[table] = await rows(table)
    return result
  }
  const constraintDefinitions = async () => (await db.query(`select conname,pg_get_constraintdef(oid) definition from pg_constraint
    where conname in('halloween_2026_campaign_winners_claimed_check','halloween_2026_rewards_subscription_slot_check') order by conname`)).rows
  const setTime = stamp => db.query(`create or replace function public.xelay_private_halloween_clock()
    returns timestamptz language sql volatile security invoker set search_path='' as $$select '${stamp}'::timestamptz$$`)
  let tick = 0
  async function run(user, sql, args = [], role = 'authenticated') {
    return db.transaction(async tx => {
      await tx.exec(`set local role ${role}`)
      await tx.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: user, role, aal: 'aal1' })])
      return (await tx.query(sql, args)).rows
    })
  }
  const state = async user => (await run(user, 'select xelay_my_halloween_hunt() value'))[0].value
  const collect = async (user, pumpkin) => (await run(user, 'select xelay_collect_halloween_pumpkin($1) value', [pumpkin]))[0].value
  async function finish(user, ids = pumpkins) {
    let result
    for (const pumpkin of ids) {
      await setTime(new Date(Date.UTC(2026, 9, 30, 12, 0, tick += 2)).toISOString())
      result = await collect(user, pumpkin)
    }
    return result
  }
  async function seedCampaign() {
    // Test-only reset; every case reuses the same in-memory database to limit RAM.
    await db.exec(`delete from public.notification_email_outbox; delete from public.notifications;
      delete from public.halloween_2026_rewards; delete from public.halloween_2026_collections;
      delete from public.participant_entitlements; delete from public.billing_audit_log;
      update public.halloween_2026_campaign set winners_claimed=10 where singleton;
      alter table public.halloween_2026_campaign drop constraint halloween_2026_campaign_winners_claimed_check;
      alter table public.halloween_2026_campaign add constraint halloween_2026_campaign_winners_claimed_check check(winners_claimed between 0 and 10);
      alter table public.halloween_2026_rewards drop constraint halloween_2026_rewards_subscription_slot_check;
      alter table public.halloween_2026_rewards add constraint halloween_2026_rewards_subscription_slot_check check(subscription_slot between 1 and 10);`)
    for (const fn of originalFunctions) await db.exec(fn.definition)
    tick = 0
    await setTime('2026-10-30T12:00:00.000Z')
    for (let i = 0; i < 12; i++) {
      const completed = new Date(Date.UTC(2026, 9, 18, 9, 5, i)).toISOString()
      for (let j = 0; j < pumpkins.length; j++) await db.query(`insert into halloween_2026_collections(user_id,pumpkin_id,collected_at)
        values($1,$2,$3::timestamptz-interval '30 seconds'+$4::integer*interval '2 seconds')`, [users[i], pumpkins[j], completed, j])
      let entitlement = null
      if (i < 10) {
        entitlement = first(await db.query(`insert into participant_entitlements(user_id,source,term_months,valid_from,valid_until)
          values($1,'admin_grant',1,'2026-10-18 09:05+00','2026-11-18 10:05+00') returning id`, [users[i]])).id
        await db.query(`insert into billing_audit_log(actor_id,action,target_user_id,detail)
          values($1,'halloween_reward',$1,jsonb_build_object('campaign','halloween-2026','months',1,'slot',$2::integer))`, [users[i], i + 1])
      }
      await db.query(`insert into halloween_2026_rewards(user_id,completed_at,show_badge,subscription_slot,entitlement_id)
        values($1,$2,$3,$4,$5)`, [users[i], completed, i !== 10, i < 10 ? i + 1 : null, entitlement])
      await db.query(`insert into notifications(recipient_id,actor_id,actor_name,type,message,is_read)
        values($1,$1,'Xelay','halloween_reward','Synthetic historical completion',false)`, [users[i]])
    }
  }

  await t.test('activation and replay leave every historical row and permission unchanged; old finishers remain ineligible for another reward', async () => {
    await seedCampaign()
    const before = await data(), acl = await permissions()
    await db.exec(migration)
    assert.deepEqual(await data(), before)
    assert.deepEqual(await permissions(), acl)
    assert.deepEqual(await protectedFunctions(), protectedBefore)
    assert.ok((await constraintDefinitions()).every(row => row.definition.includes('<= 15')))
    for (const fn of originalFunctions) {
      const after = first(await db.query('select prosrc source from pg_proc where oid=$1::regprocedure', [fn.signature])).source
      const expected = fn.source.replace("'winnersRemaining',10-campaign.winners_claimed", "'winnersRemaining',15-campaign.winners_claimed")
        .replace('if v_claimed<10 then', 'if v_claimed<15 then').replace(oldCopy, newCopy)
      assert.equal(after, expected, 'Only the three intended source tokens change')
    }
    const old = await state(users[10])
    assert.equal(old.completed, true); assert.equal(old.subscriptionWon, false)
    assert.equal(old.showBadge, false); assert.equal(old.winnersRemaining, 5)
    for (const pumpkin of pumpkins) {
      const result = await collect(users[10], pumpkin)
      assert.equal(result.newlyCollected, false); assert.equal(result.newlyCompleted, false); assert.equal(result.subscriptionWon, false)
    }
    await db.exec(migration)
    assert.deepEqual(await data(), before)
    assert.deepEqual(await permissions(), acl)
    for (const role of ['anon', 'service_role']) await assert.rejects(run(null, "select xelay_collect_halloween_pumpkin('home')", [], role), error => error.code === '42501')
    await assert.rejects(run(users[10], 'update halloween_2026_campaign set winners_claimed=0'), error => error.code === '42501')
  })

  await t.test('five new completions win slots 11–15, the sixth earns only a badge, and existing access is extended by a Kyiv calendar month', async () => {
    await seedCampaign()
    await db.query(`insert into participant_entitlements(user_id,source,term_months,valid_from,valid_until)
      values($1,'admin_grant',1,clock_timestamp()-interval '1 day','2030-01-31 10:00+00'),
        ($1,'admin_grant',1,'2030-01-31 10:00+00','2030-02-28 10:00+00')`, [users[12]])
    await db.query(`insert into participant_entitlements(user_id,source,term_months,valid_from,valid_until,revoked_at)
      values($1,'admin_grant',1,'2031-01-01','2031-02-01',now())`, [users[12]])
    const originals = (await db.query('select to_jsonb(r) data from halloween_2026_rewards r order by user_id')).rows
    const originalGrants = (await db.query('select to_jsonb(e) data from participant_entitlements e join halloween_2026_rewards r on r.entitlement_id=e.id order by e.id')).rows
    await db.exec(migration)
    for (let i = 12; i < 17; i++) {
      const result = await finish(users[i])
      assert.equal(result.subscriptionWon, true); assert.equal(result.newlyCompleted, true)
      assert.equal(result.winnersRemaining, 16 - i)
    }
    const sixth = await finish(users[17])
    assert.equal(sixth.completed, true); assert.equal(sixth.badgeEarned, true)
    assert.equal(sixth.subscriptionWon, false); assert.equal(sixth.winnersRemaining, 0)
    const slots = (await db.query('select subscription_slot slot from halloween_2026_rewards where subscription_slot is not null order by slot')).rows.map(row => row.slot)
    assert.deepEqual(slots, Array.from({ length: 15 }, (_, i) => i + 1))
    const gift = first(await db.query(`select e.*,e.valid_until=(((e.valid_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv') calendar_month
      from participant_entitlements e join halloween_2026_rewards r on r.entitlement_id=e.id where r.user_id=$1`, [users[12]]))
    assert.equal(new Date(gift.valid_from).toISOString(), '2030-02-28T10:00:00.000Z')
    assert.equal(gift.calendar_month, true); assert.equal(gift.source, 'admin_grant'); assert.equal(gift.term_months, 1)
    assert.equal(gift.order_id, null); assert.equal(gift.revoked_at, null)
    assert.deepEqual((await db.query('select to_jsonb(r) data from halloween_2026_rewards r where user_id=any($1::uuid[]) order by user_id', [users.slice(0, 12)])).rows, originals)
    assert.deepEqual((await db.query('select to_jsonb(e) data from participant_entitlements e join halloween_2026_rewards r on r.entitlement_id=e.id where r.subscription_slot<=10 order by e.id')).rows, originalGrants)
    assert.equal(first(await db.query("select count(*)::int n from billing_audit_log where action='halloween_reward'")).n, 15)
    assert.equal(first(await db.query("select count(*)::int n from notifications where type='halloween_reward'")).n, 18)
    assert.equal(first(await db.query("select count(*)::int n from notification_email_outbox where notification_type='halloween_reward'")).n, 18)
    const after = await data()
    for (const user of users) await collect(user, 'profile')
    await db.exec(migration)
    assert.deepEqual(await data(), after)
    for (const table of ['billing_orders', 'billing_payment_events', 'support_orders', 'support_payment_events']) assert.deepEqual(after[table], [])
    assert.deepEqual(await protectedFunctions(), protectedBefore)
  })

  await t.test('deleted historical or new winners never reopen an occupied permanent slot', async () => {
    await seedCampaign()
    await db.query('delete from halloween_2026_rewards where user_id=$1', [users[0]])
    await db.exec(migration)
    for (const user of users.slice(12, 17)) assert.equal((await finish(user)).subscriptionWon, true)
    await db.query('delete from halloween_2026_rewards where user_id=$1', [users[12]])
    assert.equal((await finish(users[17])).subscriptionWon, false)
    assert.equal(first(await db.query('select winners_claimed from halloween_2026_campaign')).winners_claimed, 15)
    assert.equal(first(await db.query('select count(*)::int n from halloween_2026_rewards where subscription_slot in(1,11)')).n, 0)
    await db.exec(migration)
    assert.equal(first(await db.query('select winners_claimed from halloween_2026_campaign')).winners_claimed, 15)
  })

  await t.test('activation does not issue any historical audit entry, and an audit failure rolls back the complete new reward', async () => {
    await seedCampaign()
    await db.exec(`create function public.synthetic_extra_reward_audit_failure() returns trigger language plpgsql as $$
      begin if new.action='halloween_reward' then raise exception 'SYNTHETIC_EXTRA_REWARD_AUDIT_FAILURE'; end if; return new; end $$;
      create trigger synthetic_extra_reward_audit_failure before insert on public.billing_audit_log
        for each row execute function public.synthetic_extra_reward_audit_failure();`)
    try {
      const before = await data()
      await db.exec(migration)
      assert.deepEqual(await data(), before)
      await finish(users[12], pumpkins.slice(0, 9))
      const beforeFinal = await data()
      await assert.rejects(finish(users[12], ['profile']), /SYNTHETIC_EXTRA_REWARD_AUDIT_FAILURE/)
      assert.deepEqual(await data(), beforeFinal)
      assert.equal((await state(users[12])).collected.length, 9)
    } finally {
      await db.exec('drop trigger synthetic_extra_reward_audit_failure on public.billing_audit_log; drop function public.synthetic_extra_reward_audit_failure()')
    }
    assert.equal((await finish(users[12], ['profile'])).subscriptionWon, true)
    assert.equal(first(await db.query('select subscription_slot from halloween_2026_rewards where user_id=$1', [users[12]])).subscription_slot, 11)
  })

  await t.test('unexpected production source causes the outer transaction to roll back both constraints and any earlier RPC edit', async () => {
    await seedCampaign()
    const collectDefinition = originalFunctions.find(fn => fn.signature.includes('xelay_collect_halloween_pumpkin'))
    await db.exec(collectDefinition.definition.replace('if v_claimed<10 then', 'if v_claimed < 10 then'))
    const before = await data(), constraints = await constraintDefinitions(), acl = await permissions()
    const beforeFunctions = (await db.query(`select oid::regprocedure::text signature,pg_get_functiondef(oid) definition
      from pg_proc where oid=any($1::regprocedure[]) order by signature`, [signatures])).rows
    await assert.rejects(db.exec(migration), /HALLOWEEN_EXTRA_REWARDS_UNEXPECTED_RPC_TOKEN/)
    await db.exec('rollback')
    assert.deepEqual(await data(), before)
    assert.deepEqual(await constraintDefinitions(), constraints)
    assert.deepEqual(await permissions(), acl)
    assert.deepEqual((await db.query(`select oid::regprocedure::text signature,pg_get_functiondef(oid) definition
      from pg_proc where oid=any($1::regprocedure[]) order by signature`, [signatures])).rows, beforeFunctions)
  })
})
