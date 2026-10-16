import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
const root=new URL('../../',import.meta.url)
const base=await readFile(new URL('supabase/migrations/202610060001_team_support.sql',root),'utf8')
const migration=await readFile(new URL('supabase/migrations/202610160011_supporter_tiers.sql',root),'utf8')
const first=result=>result.rows[0]
const denied=promise=>assert.rejects(promise,error=>error.code==='42501')

test('cumulative supporter tiers are payment-authoritative and publish only a bounded level',async t=>{
  const db=new PGlite();t.after(()=>db.close())
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated,service_role;
    create table public.profiles(id uuid primary key);`)
  await db.exec(base)
  const ids=Object.fromEntries(['donor','other','nonlive','many','large','states'].map(name=>[name,randomUUID()]))
  for(const id of Object.values(ids))await db.query('insert into profiles(id)values($1)',[id])
  async function asRole(role,sql,args=[],uid=''){
    await db.exec('begin');try{await db.exec('set local role '+role);await db.query("select set_config('request.jwt.claim.sub',$1,true)",[uid]);const result=await db.query(sql,args);await db.exec('commit');return result}catch(error){await db.exec('rollback');throw error}
  }
  const service=(sql,args=[])=>asRole('service_role',sql,args)
  const tier=(id,role='anon')=>asRole(role,'select public.xelay_supporter_tier($1) as value',[id]).then(first).then(row=>row.value)
  const summary=id=>service('select public.xelay_supporter_summary($1) as value',[id]).then(first).then(row=>row.value)
  const fingerprint=text=>createHash('sha256').update(text).digest('hex')
  async function event(reference,status,amount,mode='live',suffix=randomUUID()){
    return first(await service('select public.xelay_apply_support_event($1,$2,$3,$4,$5,$6) as value',[reference,mode,fingerprint(reference+status+suffix),status,amount/100,'UAH'])).value
  }
  async function order(id,amount,mode='live',status='Approved'){
    // Distinct terms versions keep pending test orders separate without changing checkout code.
    const reference='xelay_support_'+randomUUID()
    await service('select public.xelay_create_support_order($1,$2,$3,$4,$5)',[id,mode,reference,amount,'synthetic-'+randomUUID()])
    if(status)await event(reference,status,amount,mode)
    return reference
  }
  const old=await order(ids.donor,5000)
  const snapshot=async()=>({
    data:(await db.query(`select (select jsonb_agg(to_jsonb(t) order by id) from profiles t) as profiles,
      (select jsonb_agg(to_jsonb(t) order by id) from support_orders t) as orders,
      (select jsonb_agg(to_jsonb(t) order by id) from support_payment_events t) as events`)).rows,
    grants:(await db.query(`select c.relname,c.relacl::text,c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' order by c.relname`)).rows,
    policies:(await db.query(`select polname,pg_get_expr(polqual,polrelid) as using_expression,pg_get_expr(polwithcheck,polrelid) as check_expression from pg_policy order by polname`)).rows,
    functions:(await db.query(`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,p.proacl::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f' order by signature`)).rows,
  })
  const before=await snapshot();await db.exec(migration);const after=await snapshot()
  await t.test('installation adds exactly three functions and preserves every existing row, policy, grant and payment function',async()=>{
    assert.deepEqual(after.data,before.data);assert.deepEqual(after.grants,before.grants);assert.deepEqual(after.policies,before.policies)
    assert.equal(after.functions.length,before.functions.length+3)
    for(const row of before.functions)assert.deepEqual(after.functions.find(next=>next.signature===row.signature),row)
    for(const fn of ['xelay_supporter_tier(uuid)','xelay_supporter_summary(uuid)']){
      const row=first(await db.query('select prosecdef,provolatile,proconfig from pg_proc where oid=$1::regprocedure',['public.'+fn]));assert.equal(row.prosecdef,true);assert.equal(row.provolatile,'s');assert.ok(row.proconfig.includes('search_path=""'))
    }
  })
  await t.test('the original approved contribution receives a basic tier without rewriting its historical consent',async()=>{
    assert.equal(await tier(ids.donor),1);assert.deepEqual(await summary(ids.donor),{tier:1,totalKopiykas:5000})
    assert.equal(first(await db.query('select terms_version from support_orders where order_reference=$1',[old])).terms_version.startsWith('synthetic-'),true)
  })
  await t.test('public callers can obtain only the level; exact totals and payment rows remain private',async()=>{
    for(const role of ['anon','authenticated','service_role']){
      assert.equal(await tier(ids.donor,role),1)
      assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_supporter_summary(uuid)','execute') as value",[role])).value,role==='service_role')
      assert.equal(first(await db.query("select has_function_privilege($1,'public.xelay_private_supporter_tier(bigint)','execute') as value",[role])).value,false)
    }
    for(const role of ['anon','authenticated'])await denied(asRole(role,'select public.xelay_supporter_summary($1)',[ids.donor],ids.donor))
    await denied(asRole('anon','select * from public.support_orders'))
    assert.equal((await asRole('authenticated','select * from public.support_orders',[],ids.other)).rows.length,0)
    assert.equal((await asRole('authenticated','select * from public.support_orders',[],ids.donor)).rows.length,1)
    assert.equal(await tier(randomUUID()),0);assert.equal(await tier(null),0)
  })
  await t.test('two fifty-hryvnia contributions grant bronze; every kopeck boundary is exact',async()=>{
    await order(ids.donor,5000);assert.equal(await tier(ids.donor),2);assert.deepEqual(await summary(ids.donor),{tier:2,totalKopiykas:10000})
    for(const [amount,expected] of [[100,1],[9999,1],[10000,2],[24999,2],[25000,3],[49999,3],[50000,4],[99999,4],[100000,5]]){
      const id=randomUUID();await db.query('insert into profiles(id) values($1)',[id]);await order(id,amount)
      assert.equal(await tier(id),expected,String(amount));assert.equal((await summary(id)).totalKopiykas,amount)
    }
  })
  await t.test('test, pending, declined, expired and voided orders do not grant or inflate a public tier',async()=>{
    await order(ids.nonlive,100000,'test')
    for(const state of [null,'Declined','Expired','Voided'])await order(ids.nonlive,100000,'live',state)
    assert.equal(await tier(ids.nonlive),0);assert.deepEqual(await summary(ids.nonlive),{tier:0,totalKopiykas:0})
  })
  await t.test('duplicate provider events do not add support twice and late approval cannot revive a refunded order',async()=>{
    const ref=await order(ids.states,50000);const args=[ref,'live',fingerprint('duplicate'), 'Approved',500,'UAH']
    const apply=()=>service('select public.xelay_apply_support_event($1,$2,$3,$4,$5,$6) as value',args).then(first).then(row=>row.value)
    assert.equal((await apply()).duplicate,false);assert.equal((await apply()).duplicate,true)
    assert.equal(await tier(ids.states),4);assert.equal((await summary(ids.states)).totalKopiykas,50000)
    await event(ref,'Refunded',50000);assert.equal(await tier(ids.states),0)
    await event(ref,'Approved',50000);assert.equal(await tier(ids.states),0)
  })
  await t.test('a refund decreases the cumulative tier and the last refund removes it without changing another donor',async()=>{
    const ref=await order(ids.donor,15000);assert.equal(await tier(ids.donor),3)
    await event(ref,'Refunded',15000);assert.equal(await tier(ids.donor),2)
    await event(old,'Refunded',5000);assert.equal(await tier(ids.donor),1)
    const remaining=first(await db.query("select order_reference,amount_kopiykas from support_orders where user_id=$1 and status='approved'",[ids.donor]))
    await event(remaining.order_reference,'Voided',remaining.amount_kopiykas);assert.equal(await tier(ids.donor),0)
    assert.equal(await tier(ids.nonlive),0)
  })
  await t.test('the lifetime aggregate is independent of a twenty-order history page and handles totals beyond int32',async()=>{
    // Bulk synthetic rows exercise the same immutable table constraints, with no provider traffic.
    await db.query(`insert into support_orders(user_id,order_reference,amount_kopiykas,mode,status,terms_version)
      select $1,'xelay_support_'||gen_random_uuid(),490,'live','approved','synthetic-history' from generate_series(1,21)`,[ids.many])
    assert.equal((await summary(ids.many)).totalKopiykas,10290);assert.equal(await tier(ids.many),2)
    await db.query(`insert into support_orders(user_id,order_reference,amount_kopiykas,mode,status,terms_version)
      select $1,'xelay_support_'||gen_random_uuid(),14999900,'live','approved','synthetic-large' from generate_series(1,200)`,[ids.large])
    assert.deepEqual(await summary(ids.large),{tier:5,totalKopiykas:2999980000});assert.equal(await tier(ids.large),5)
  })
  await t.test('ordinary clients still cannot mint orders, edit contributions, set levels or apply payment events',async()=>{
    await denied(asRole('authenticated',"update support_orders set amount_kopiykas=100000 where user_id=$1",[ids.donor],ids.donor))
    await denied(asRole('authenticated','select public.xelay_create_support_order($1,$2,$3,$4,$5)',[ids.other,'live','xelay_support_'+randomUUID(),100000,'fake'],ids.donor))
    await denied(asRole('authenticated','select public.xelay_apply_support_event($1,$2,$3,$4,$5,$6)',[old,'live',fingerprint('fake'),'Approved',50,'UAH'],ids.donor))
    assert.equal(await tier(ids.donor),0)
  })
})
