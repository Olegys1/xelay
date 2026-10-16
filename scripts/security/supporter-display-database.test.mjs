import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {PGlite} from '@electric-sql/pglite'
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8')
test('badge visibility and the one-time home notice remain own-account choices without payment authority',async t=>{
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);create table profiles(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create function xelay_free_groups_available() returns boolean language sql stable as $$select true$$;`)
  const ids=[randomUUID(),randomUUID()]
  for(const id of ids){await db.query('insert into auth.users values($1)',[id]);await db.query('insert into profiles values($1)',[id])}
  for(const name of ['202610060001_team_support.sql','202610160011_supporter_tiers.sql','202610160012_supporter_six_seven.sql',
    '202610070002_free_groups_announcement.sql','202610150006_social_launch_announcement.sql','202610160010_group_join_reminder.sql'])await db.exec(await read(name))
  await db.query("insert into support_orders(user_id,order_reference,amount_kopiykas,mode,status,terms_version) values($1,$2,6700,'live','approved','historical'),($1,$3,25000,'live','approved','historical')",[ids[0],'xelay_support_'+randomUUID(),'xelay_support_'+randomUUID()])
  const before=(await db.query('select * from support_orders order by id')).rows
  const providerFns=(await db.query("select pg_get_functiondef(oid) as definition,proacl::text from pg_proc where proname in('xelay_create_support_order','xelay_apply_support_event','xelay_claim_support_reconciliation','xelay_supporter_summary') order by proname")).rows
  for(const name of ['202610170001_supporter_badge_visibility.sql','202610170002_secret_badge_announcement.sql'])await db.exec(await read(name))
  async function run(uid,sql,args=[],role='authenticated'){
    await db.exec('begin');try{await db.exec('set local role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid||'']);const res=await db.query(sql,args);await db.exec('commit');return res.rows}catch(e){await db.exec('rollback');throw e}
  }
  const own=async id=>(await run(id,'select xelay_my_supporter_badges() as v'))[0].v
  const show=async(a,b,id=ids[0])=>(await run(id,'select xelay_set_my_supporter_badges($1,$2) as v',[a,b]))[0].v
  const pub=async id=>(await run(null,'select xelay_supporter_badges($1) as v',[id],'anon'))[0].v
  const denied=p=>assert.rejects(p,e=>e.code==='42501')
  await t.test('installation preserves payment rows, consents, events and privileged financial functions',async()=>{
    assert.deepEqual((await db.query('select * from support_orders order by id')).rows,before)
    assert.deepEqual((await db.query("select pg_get_functiondef(oid) as definition,proacl::text from pg_proc where proname in('xelay_create_support_order','xelay_apply_support_event','xelay_claim_support_reconciliation','xelay_supporter_summary') order by proname")).rows,providerFns)
    for(const fn of ['xelay_my_supporter_badges()','xelay_set_my_supporter_badges(boolean,boolean)']){
      const row=(await db.query('select prosecdef,proconfig from pg_proc where oid=$1::regprocedure',[fn])).rows[0];assert.equal(row.prosecdef,true);assert.ok(row.proconfig.includes('search_path=""'))
    }
  })
  await t.test('every independent visibility combination is respected by all public clients while earned totals remain intact',async()=>{
    assert.deepEqual(await own(ids[0]),{tier:3,sixSeven:true,showTier:true,showSixSeven:true})
    for(const [a,b] of [[false,true],[true,false],[false,false],[true,true]]){
      assert.deepEqual(await show(a,b),{tier:3,sixSeven:true,showTier:a,showSixSeven:b})
      assert.deepEqual(await pub(ids[0]),{tier:a?3:0,sixSeven:b})
      const legacy=(await run(null,'select xelay_supporter_tier($1) as tier,xelay_supporter_badge($1) as badge',[ids[0]],'anon'))[0]
      assert.deepEqual(legacy,{tier:a?3:0,badge:a})
      assert.deepEqual((await db.query('select xelay_supporter_summary($1) as v',[ids[0]])).rows[0].v,{tier:3,totalKopiykas:31700,sixSeven:true})
    }
    assert.deepEqual((await db.query('select * from support_orders order by id')).rows,before)
  })
  await t.test('settings never grant unearned badges and default to visible for future earned badges',async()=>{
    assert.deepEqual(await own(ids[1]),{tier:0,sixSeven:false,showTier:true,showSixSeven:true})
    await show(true,true,ids[1]);assert.deepEqual(await pub(ids[1]),{tier:0,sixSeven:false})
    assert.deepEqual(await pub(null),{tier:0,sixSeven:false})
    await show(false,false,ids[1]);assert.deepEqual(await pub(ids[0]),{tier:3,sixSeven:true})
  })
  await t.test('clients cannot write or inspect another account’s preferences or call the owner RPC anonymously',async()=>{
    await denied(run(null,'select xelay_my_supporter_badges()',[],'anon'))
    await denied(run(null,'select xelay_set_my_supporter_badges(false,false)',[],'anon'))
    await denied(run(null,'select xelay_my_supporter_badges()'))
    await denied(run(ids[1],'update supporter_badge_preferences set show_tier=false where user_id=$1',[ids[0]]))
    await denied(run(ids[1],'insert into supporter_badge_preferences values($1,false,false)',[ids[0]]))
    await denied(run(null,'select * from supporter_badge_preferences',[],'anon'))
    const rows=await run(ids[1],'select * from supporter_badge_preferences');assert.equal(rows.length,1);assert.equal(rows[0].user_id,ids[1])
    await assert.rejects(show(null,true),e=>e.code==='22023')
    await assert.rejects(run(ids[1],'select xelay_set_my_supporter_badges(false,false,$1)',[ids[0]]),e=>e.code==='42883')
    await denied(run(ids[0],'select xelay_supporter_summary($1)',[ids[0]]))
  })
  await t.test('refund removes an earned secret even if its saved visibility is enabled',async()=>{
    await show(true,true)
    await db.query("update support_orders set status='refunded' where user_id=$1 and amount_kopiykas=6700",[ids[0]])
    assert.deepEqual(await pub(ids[0]),{tier:3,sixSeven:false})
    assert.deepEqual(await own(ids[0]),{tier:3,sixSeven:false,showTier:true,showSixSeven:true})
  })
  await t.test('new announcement receipt is private, immutable and limited to the fixed campaign',async()=>{
    const campaign='secret-six-seven-2026-10-17'
    const insert=(actor,owner,id=campaign)=>run(actor,'insert into account_announcement_receipts(user_id,announcement_id) values($1,$2) on conflict do nothing',[owner,id])
    await insert(ids[0],ids[0]);const first=(await db.query('select * from account_announcement_receipts')).rows
    await insert(ids[0],ids[0]);assert.deepEqual((await db.query('select * from account_announcement_receipts')).rows,first)
    await denied(insert(ids[1],ids[0]));await denied(insert(ids[1],ids[1],'made-up-campaign'))
    await denied(run(ids[0],"update account_announcement_receipts set seen_at=now()"))
    await denied(run(ids[0],'delete from account_announcement_receipts'))
    assert.equal((await run(ids[1],'select user_id,announcement_id from account_announcement_receipts')).length,0)
    await denied(run(null,'select user_id,announcement_id from account_announcement_receipts',[],'anon'))
    for(const old of ['free-study-groups-2026-10-07','social-launch-2026-10-15','join-study-group-2026-10-16'])await insert(ids[1],ids[1],old)
  })
})
