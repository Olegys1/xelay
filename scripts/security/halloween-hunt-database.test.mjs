// Actual migration and existing billing/notification chain, isolated synthetic
// PGlite database only. PGlite queues transactions; PostgreSQL contention safety
// is additionally enforced by the migration's row/advisory locks and constraints.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {createFixture} from './fixture.mjs'

const migration=await readFile(new URL('../../supabase/migrations/202610180001_halloween_hunt.sql',import.meta.url),'utf8')
const auditSql=await readFile(new URL('../../supabase/audits/202610180001_halloween_hunt.sql',import.meta.url),'utf8')
const ids=Array.from({length:16},()=>randomUUID())
const pumpkins=['home','questions','news','groups','people','messages','support','opportunities','subscription','profile']
const first=r=>r.rows[0]
const denied=p=>assert.rejects(p,e=>e.code==='42501')

test('Halloween rewards use private own progress, a fixed server window and at most ten atomic monthly grants',async t=>{
  const fx=await createFixture({useStagingParity:true,through:'202610170999',beforeMigrationsSql:`
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;`})
  t.after(()=>fx.close());const {db,seedUser}=fx
  for(const id of ids)await seedUser(id,{username:'halloween_'+id.replaceAll('-','').slice(0,12),categories:['General']})
  await db.query('update auth.users set email_confirmed_at=null where id=$1',[ids[14]])
  await db.query("update auth.users set banned_until='2026-12-01' where id=$1",[ids[15]])
  const order=first(await db.query(`insert into billing_orders(user_id,product,order_reference,amount,mode,status,approved_at)
    values($1,'participant',$2,100,'live','approved',now()) returning id`,[ids[0],'halloween-existing-'+randomUUID()]))
  await db.query(`insert into participant_entitlements(user_id,source,order_id,term_months,valid_from,valid_until)
    values($1,'payment',$2,1,'2026-10-01 10:00+00','2026-11-01 11:00+00'),
    ($1,'admin_grant',null,1,'2026-11-01 11:00+00','2026-12-01 11:00+00'),
    ($1,'admin_grant',null,1,'2026-09-01 10:00+00','2026-10-01 10:00+00')`,[ids[0],order.id])
  await db.query(`insert into participant_entitlements(user_id,source,term_months,valid_from,valid_until,revoked_at)
    values($1,'admin_grant',1,'2026-12-01','2027-01-01',now())`,[ids[0]])
  const finances=async()=>Object.fromEntries(await Promise.all(['billing_orders','billing_payment_events','support_orders','support_payment_events'].map(async table=>[table,(await db.query(`select to_jsonb(t) as row from public.${table} t order by id`)).rows])))
  const financialBefore=await finances()
  const financialFunctions=async()=>(await db.query(`select proname,pg_get_functiondef(oid) as definition,proacl::text
    from pg_proc where pronamespace='public'::regnamespace and proname in('xelay_apply_billing_event','xelay_reflow_participant_access',
    'xelay_admin_grant_participant','xelay_apply_support_event','xelay_create_billing_order','xelay_queue_notification_email') order by proname`)).rows
  const funcsBefore=await financialFunctions(),existingEntitlements=(await db.query('select * from participant_entitlements order by id')).rows
  const auditBefore=first(await db.query(auditSql)).audit
  await db.exec(migration)
  const auditAfter=first(await db.query(auditSql)).audit
  // Private clock implementation is checked before replacing it solely inside
  // this isolated fixture. App roles cannot execute/alter the clock or pass time.
  const clock=first(await db.query("select pg_get_functiondef(oid) as body from pg_proc where oid='xelay_private_halloween_clock()'::regprocedure"))
  assert.match(clock.body,/pg_catalog\.clock_timestamp\(\)/)
  const setTime=async stamp=>db.exec(`create or replace function public.xelay_private_halloween_clock()
    returns timestamptz language sql volatile security invoker set search_path='' as $$select '${stamp}'::timestamptz$$`)
  async function run(user,sql,args=[],role='authenticated'){
    return db.transaction(async tx=>{
      await tx.exec('set local role '+role)
      await tx.query("select set_config('request.jwt.claims',$1,true)",[JSON.stringify({sub:user,role,aal:'aal1'})])
      return (await tx.query(sql,args)).rows
    })
  }
  const state=async user=>(await run(user,'select xelay_my_halloween_hunt() as value'))[0].value
  const collect=async(user,id)=>(await run(user,'select xelay_collect_halloween_pumpkin($1) as value',[id]))[0].value
  const badge=async user=>(await run(null,'select xelay_halloween_badge($1) as value',[user],'anon'))[0].value

  await t.test('installation creates no rewards, email, payments or entitlement changes and keeps financial functions byte-identical',async()=>{
    assert.deepEqual(await finances(),financialBefore);assert.deepEqual(await financialFunctions(),funcsBefore)
    assert.deepEqual((await db.query('select * from participant_entitlements order by id')).rows,existingEntitlements)
    for(const name of ['payments','other_functions_hash','existing_table_acl_hash','other_policies_hash'])assert.deepEqual(auditAfter[name],auditBefore[name],name)
    assert.equal(auditBefore.halloween_functions.length,0);assert.equal(auditAfter.halloween_functions.length,6)
    assert.ok(auditAfter.halloween_tables.every(row=>row.rls&&!row.anon_select&&!row.authenticated_select&&!row.authenticated_write))
    for(const row of auditAfter.halloween_functions){
      assert.equal(row.anon_execute,row.name==='xelay_halloween_badge')
      assert.equal(row.authenticated_execute,['xelay_my_halloween_hunt','xelay_collect_halloween_pumpkin','xelay_set_my_halloween_badge','xelay_halloween_badge'].includes(row.name))
    }
    for(const table of ['halloween_2026_collections','halloween_2026_rewards'])assert.equal(first(await db.query(`select count(*)::int as n from ${table}`)).n,0)
    assert.equal(first(await db.query("select count(*)::int as n from notifications where type='halloween_reward'")).n,0)
    for(const fn of ['xelay_my_halloween_hunt()','xelay_collect_halloween_pumpkin(text)','xelay_set_my_halloween_badge(boolean)','xelay_halloween_badge(uuid)']){
      const meta=first(await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[fn]));assert.equal(meta.prosecdef,true);assert.ok(meta.proconfig.includes('search_path=""'))
    }
  })
  await t.test('Kyiv start and DST-adjusted exclusive end are enforced by server time; clients cannot select account/time/campaign',async()=>{
    await setTime('2026-10-18 08:59:59.999999+00')
    const s=await state(ids[0]);assert.equal(s.phase,'upcoming');assert.equal(s.startsAt,'2026-10-18T09:00:00.000Z');assert.equal(s.endsAt,'2026-11-01T22:00:00.000Z');assert.equal(s.winnersRemaining,10)
    await assert.rejects(collect(ids[0],'home'),/HALLOWEEN_NOT_STARTED/)
    await setTime('2026-11-01 22:00:00+00');assert.equal((await state(ids[0])).phase,'ended')
    await assert.rejects(collect(ids[0],'home'),/HALLOWEEN_ENDED/)
    await assert.rejects(collect(ids[0],'organizer'),/HALLOWEEN_UNKNOWN_PUMPKIN/)
    await assert.rejects(collect(ids[0],null),/HALLOWEEN_UNKNOWN_PUMPKIN/)
    await assert.rejects(run(ids[0],'select xelay_collect_halloween_pumpkin($1,$2)',['home',ids[1]]),e=>e.code==='42883')
    await denied(run(null,"select xelay_collect_halloween_pumpkin('home')",[],'anon'))
    await denied(run(null,"select xelay_collect_halloween_pumpkin('home')"))
    await denied(run(ids[0],'select xelay_private_halloween_clock()'))
  })
  await t.test('confirmed active accounts only; unsupported IDs, anonymous writes and cross-account private reads are blocked',async()=>{
    await setTime('2026-10-18 09:00:00+00')
    assert.deepEqual([(await state(ids[14])).eligible,(await state(ids[14])).ineligibleReason],[false,'email_unconfirmed'])
    await assert.rejects(collect(ids[14],'home'),/HALLOWEEN_EMAIL_UNCONFIRMED/)
    assert.equal((await state(ids[15])).ineligibleReason,'account_unavailable');await denied(collect(ids[15],'home'))
    for(const table of ['halloween_2026_campaign','halloween_2026_collections','halloween_2026_rewards']){
      await denied(run(ids[1],`select * from ${table}`));await denied(run(null,`select * from ${table}`,[],'anon'))
      assert.equal(first(await db.query('select relrowsecurity from pg_class where oid=$1::regclass',[table])).relrowsecurity,true)
    }
    await denied(run(ids[0],"insert into halloween_2026_collections(user_id,pumpkin_id) values($1,'home')",[ids[1]]))
    await denied(run(ids[0],'update halloween_2026_campaign set winners_claimed=0'))
    await assert.rejects(run(ids[0],'select xelay_set_my_halloween_badge(true)'),/HALLOWEEN_BADGE_NOT_EARNED/)
    assert.equal(await badge(ids[0]),false);assert.equal(await badge(null),false)
  })
  await t.test('exact start accepts one pickup, duplicate retry and a second tab are idempotent, rate-limit does not lose progress',async()=>{
    const a=await collect(ids[0],'home');assert.equal(a.newlyCollected,true);assert.equal(a.collected.length,1);assert.equal(a.phase,'active')
    const b=await collect(ids[0],'home');assert.equal(b.newlyCollected,false);assert.equal(b.newlyCompleted,false)
    await assert.rejects(collect(ids[0],'questions'),/HALLOWEEN_TOO_FAST/)
    assert.deepEqual((await state(ids[0])).collected,['home']);assert.deepEqual((await state(ids[1])).collected,[])
    await setTime('2026-10-18 09:00:02+00')
    const races=await Promise.all([collect(ids[0],'questions'),collect(ids[0],'questions')])
    assert.equal(races.filter(r=>r.newlyCollected).length,1);assert.equal((await state(ids[0])).collected.length,2)
  })
  await t.test('twelve queued finish requests grant exactly ten one-month entitlements and every finisher gets a permanent badge',async()=>{
    // Every account has nine distinct genuine successful calls before the final race.
    for(let index=0;index<9;index++){
      await setTime(`2026-10-18 09:01:${String(index*2).padStart(2,'0')}+00`)
      await Promise.all(ids.slice(0,12).map(user=>collect(user,pumpkins[index])))
    }
    await setTime('2026-10-18 09:02:00+00')
    const completed=await Promise.all(ids.slice(0,12).map(user=>collect(user,'profile')))
    assert.equal(completed.filter(r=>r.subscriptionWon).length,10)
    assert.equal(completed.filter(r=>r.badgeEarned&&r.completed&&r.newlyCompleted).length,12)
    assert.equal(completed.at(-1).winnersRemaining,0)
    const rewards=(await db.query('select * from halloween_2026_rewards order by subscription_slot nulls last')).rows
    assert.equal(rewards.length,12);assert.deepEqual(rewards.filter(r=>r.subscription_slot!==null).map(r=>r.subscription_slot),[1,2,3,4,5,6,7,8,9,10])
    const grants=(await db.query(`select e.*,e.valid_until=(((e.valid_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv') as calendar_month
      from participant_entitlements e join halloween_2026_rewards r on r.entitlement_id=e.id`)).rows
    assert.equal(grants.length,10);assert.ok(grants.every(e=>e.term_months===1&&e.source==='admin_grant'&&e.order_id===null&&e.revoked_at===null&&e.calendar_month))
    const paid=await state(ids[0]);assert.equal(paid.subscriptionWon,true)
    const prior=(await db.query('select max(valid_until) as until from participant_entitlements where user_id=$1 and revoked_at is null and id<> (select entitlement_id from halloween_2026_rewards where user_id=$1)',[ids[0]])).rows[0].until
    assert.equal(new Date(paid.subscriptionStartsAt).toISOString(),new Date(prior).toISOString())
    assert.equal(first(await db.query("select count(*)::int as n from billing_audit_log where action='halloween_reward'")).n,10)
    for(const user of ids.slice(0,12))assert.equal(await badge(user),true)
    assert.deepEqual(await finances(),financialBefore);assert.deepEqual(await financialFunctions(),funcsBefore)
  })
  await t.test('completion retries never duplicate entitlement, notification or email; genuine reward notifications cannot be forged',async()=>{
    for(let i=0;i<3;i++)await Promise.all(ids.slice(0,12).map(user=>collect(user,'profile')))
    assert.equal(first(await db.query("select count(*)::int as n from notifications where type='halloween_reward'")).n,12)
    assert.equal(first(await db.query("select count(*)::int as n from notification_email_outbox where notification_type='halloween_reward'")).n,12)
    assert.equal(first(await db.query('select count(*)::int as n from halloween_2026_rewards where entitlement_id is not null')).n,10)
    await denied(run(ids[0],"insert into notifications(recipient_id,actor_id,actor_name,type,message) values($1,$1,'Xelay','halloween_reward','forged')",[ids[0]]))
    const notification=first(await db.query("select id from notifications where recipient_id=$1 and type='halloween_reward'",[ids[0]]))
    await denied(run(ids[0],"update notifications set message='forged' where id=$1",[notification.id]))
    await run(ids[0],'update notifications set is_read=true where id=$1',[notification.id])
  })
  await t.test('earned badge may be hidden/restored after season with no leaked progress, and late incomplete accounts never earn rewards',async()=>{
    await setTime('2026-11-01 21:59:59.999999+00')
    assert.equal((await collect(ids[12],'home')).newlyCollected,true)
    await setTime('2026-11-01 22:00:00+00')
    assert.equal((await collect(ids[12],'home')).newlyCollected,false)
    await assert.rejects(collect(ids[12],'questions'),/HALLOWEEN_ENDED/)
    assert.equal((await state(ids[0])).phase,'ended');assert.equal(await badge(ids[0]),true)
    const hidden=(await run(ids[0],'select xelay_set_my_halloween_badge(false) as value'))[0].value
    assert.equal(hidden.badgeEarned,true);assert.equal(hidden.showBadge,false);assert.equal(await badge(ids[0]),false)
    assert.equal(await badge(ids[1]),true)
    await run(ids[0],'select xelay_set_my_halloween_badge(true)');assert.equal(await badge(ids[0]),true)
    await denied(run(ids[0],'update halloween_2026_rewards set show_badge=false where user_id=$1',[ids[1]]))
    await denied(run(null,'select xelay_my_halloween_hunt()',[],'anon'))
    await denied(run(null,'select xelay_set_my_halloween_badge(false)',[],'anon'))
    assert.equal(first(await db.query('select count(*)::int as n from halloween_2026_rewards')).n,12)
    // Deletion cannot reopen a subscription slot; claims remain permanently capped.
    await db.query('delete from halloween_2026_rewards where user_id=$1',[ids[9]])
    assert.equal((await state(ids[13])).winnersRemaining,0)
    assert.deepEqual(await finances(),financialBefore)
  })
  await t.test('the unchanged payment refund flow revokes only its paid access and reflows the earned promotional month without revoking the badge',async()=>{
    const gift=first(await db.query('select entitlement_id from halloween_2026_rewards where user_id=$1',[ids[0]])).entitlement_id
    const reference=first(await db.query('select order_reference from billing_orders where id=$1',[order.id])).order_reference
    const result=(await run(null,"select xelay_apply_billing_event($1,'live',$2,'Refunded',100,'UAH') as value",[reference,'f'.repeat(64)],'service_role'))[0].value
    assert.equal(result.duplicate,false)
    assert.equal(first(await db.query('select status from billing_orders where id=$1',[order.id])).status,'refunded')
    assert.ok(first(await db.query('select revoked_at from participant_entitlements where order_id=$1',[order.id])).revoked_at)
    const kept=first(await db.query(`select source,order_id,revoked_at,valid_until=(((valid_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv') as calendar_month
      from participant_entitlements where id=$1`,[gift]))
    assert.deepEqual(kept,{source:'admin_grant',order_id:null,revoked_at:null,calendar_month:true})
    assert.equal(await badge(ids[0]),true);assert.equal((await state(ids[0])).subscriptionWon,true)
    const retry=(await run(null,"select xelay_apply_billing_event($1,'live',$2,'Refunded',100,'UAH') as value",[reference,'f'.repeat(64)],'service_role'))[0].value
    assert.equal(retry.duplicate,true)
    assert.equal(first(await db.query('select winners_claimed from halloween_2026_campaign')).winners_claimed,10)
    assert.equal(first(await db.query("select count(*)::int as n from notifications where type='halloween_reward'")).n,12)
    assert.deepEqual(await financialFunctions(),funcsBefore)
  })
})
