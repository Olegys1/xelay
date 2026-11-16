import test from 'node:test'
import assert from 'node:assert/strict'
import{readFile}from'node:fs/promises'
import{PGlite}from'@electric-sql/pglite'
const foundation=await readFile(new URL('../supabase/migrations/202611160100_student_max_workspace.sql',import.meta.url),'utf8'),migration=await readFile(new URL('../supabase/migrations/202611160110_student_plan_billing.sql',import.meta.url),'utf8'),previous=await readFile(new URL('../supabase/migrations/202610030016_group_trial.sql',import.meta.url),'utf8')
const statusMigration=await readFile(new URL('../supabase/migrations/202610130001_free_people_communication.sql',import.meta.url),'utf8')
const legacyStatus=statusMigration.match(/create or replace function public\.xelay_billing_status\(\)[\s\S]*?\nend \$\$;/)[0].replace("'is_premium',v_premium,'expires_at',v_expiry,","'is_premium',v_premium,'is_lifetime',public.xelay_private_participant_lifetime(auth.uid()),'expires_at',case when public.xelay_private_participant_lifetime(auth.uid()) then null else v_expiry end,")
const legacyCallback=previous.slice(previous.indexOf('create or replace function public.xelay_apply_billing_event('),previous.indexOf('\n$$;',previous.indexOf('create or replace function public.xelay_apply_billing_event('))+4)
const id=n=>`42000000-0000-4000-8000-${String(n).padStart(12,'0')}`,owner=id(1),other=id(2),session=id(101)
test('student billing extends verified payments while preserving paid time and legacy orders',{timeout:120000},async t=>{
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.uid()returns uuid language sql stable as $$select(auth.jwt()->>'sub')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt()to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
 create table public.profiles(id uuid primary key,account_type text default 'student');
 create table public.billing_orders(id uuid primary key default gen_random_uuid(),user_id uuid not null,product text not null,group_id uuid,order_reference text unique not null,amount numeric not null,currency text default 'UAH',mode text not null,status text default 'pending',provider_status text,provider_fee numeric,approved_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now(),group_term_months integer,
 constraint billing_order_product_price check(product='participant'and amount=100 and group_id is null or product='group'and amount=750 and group_id is not null));
 create table public.billing_payment_events(id uuid default gen_random_uuid(),order_id uuid,fingerprint text unique,provider_status text,amount numeric,mode text);
 create table public.participant_entitlements(id uuid default gen_random_uuid(),user_id uuid,order_id uuid unique,source text,term_months integer,valid_from timestamptz,valid_until timestamptz,revoked_at timestamptz);
 create table public.group_entitlements(group_id uuid primary key,source text,order_id uuid,revoked_at timestamptz,created_at timestamptz default now());
 create table public.group_annual_entitlements(group_id uuid,order_id uuid unique,term_months integer,valid_from timestamptz,valid_until timestamptz,revoked_at timestamptz);
 create table public.group_trial_entitlements(group_id uuid,expires_at timestamptz);
 create table public.billing_audit_log(action text,target_user_id uuid,group_id uuid,detail jsonb);
 create function public.xelay_reflow_participant_access(uuid)returns void language plpgsql as $$begin return;end$$;
 create function public.xelay_reflow_group_access(uuid)returns void language plpgsql as $$begin return;end$$;
 create table public.participant_lifetime_awards(recipient_id uuid primary key,revoked_at timestamptz);
 create table public.premium_preferences(user_id uuid primary key,emoji_status text,status_text text);
 create function public.xelay_private_participant_lifetime(p_user_id uuid)returns boolean language sql stable security definer as $$select exists(select 1 from public.participant_lifetime_awards where recipient_id=p_user_id and revoked_at is null)$$;
 create function public.xelay_has_participant_access(p_user_id uuid)returns boolean language sql stable security definer as $$select exists(select 1 from public.participant_entitlements where user_id=p_user_id and revoked_at is null and valid_from<=now()and valid_until>now())or public.xelay_private_participant_lifetime(p_user_id)$$;
 insert into auth.users(id,email_confirmed_at)values('${owner}',now()),('${other}',now());insert into public.profiles(id)select id from auth.users;insert into auth.sessions(id,user_id)values('${session}','${owner}');`)
 await db.exec(legacyCallback);await db.exec(legacyStatus);await db.exec(foundation);const originalOid=(await db.query("select 'public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)'::regprocedure::oid oid")).rows[0].oid
 const originalAccessOid=(await db.query("select 'public.xelay_has_participant_access(uuid)'::regprocedure::oid oid")).rows[0].oid,originalStatusOid=(await db.query("select 'public.xelay_billing_status()'::regprocedure::oid oid")).rows[0].oid
 await db.exec(migration)
 const rows=async(s,a=[])=>(await db.query(s,a)).rows
 const as=async(role,fn,user=owner,sid=session)=>{await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:sid,role})]);try{return await fn()}finally{await db.exec('reset role')}}
 const rpc=(name,args=[])=>as('service_role',async()=>(await rows(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})v`,args))[0].v)
 const create=(plan,reference='order-'+plan+'-'+Math.random().toString(16).slice(2),mode='live',user=owner)=>rpc('xelay_create_student_plan_order',[user,mode,reference,plan])
 let event=0;const apply=(o,status='Approved',amount=o.amount)=>rpc('xelay_apply_billing_event',[o.order_reference,o.mode,(++event).toString(16).padStart(64,'0'),status,amount,'UAH',null])
 const periods=async()=>rows('select g.plan_id,g.order_id,p.valid_from,p.valid_until from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id where g.user_id=$1 and g.revoked_at is null order by p.valid_from',[owner])
 try{
 await t.test('callback identity and legacy signed100UAH orders remain intact; prices are server snapshots',async()=>{
  assert.equal((await rows("select 'public.xelay_apply_billing_event(text,text,text,text,numeric,text,numeric)'::regprocedure::oid oid"))[0].oid,originalOid)
  assert.equal((await rows("select 'public.xelay_has_participant_access(uuid)'::regprocedure::oid oid"))[0].oid,originalAccessOid);assert.equal((await rows("select 'public.xelay_billing_status()'::regprocedure::oid oid"))[0].oid,originalStatusOid)
  await db.query("insert into public.billing_orders(user_id,product,order_reference,amount,mode)values($1,'participant','old-pending-order',100,'live')",[other]);const old=(await rows("select*from public.billing_orders where order_reference='old-pending-order'"))[0];await apply(old)
  assert.equal((await rows('select count(*)::int n from public.participant_entitlements where user_id=$1',[other]))[0].n,1);assert.equal((await rows('select count(*)::int n from xelay_student_private.grants where user_id=$1',[other]))[0].n,0)
  const start=await create('start','snapshot-start-order');assert.equal(Number(start.amount),149);assert.equal(start.student_plan_id,'start');assert.equal((await create('start','another-duplicate-reference')).id,start.id)
  await assert.rejects(db.query("update public.billing_orders set amount=1 where id=$1",[start.id]));await assert.rejects(apply(start,'Approved',100));await apply(start)
 })
 let firstPlus,firstMax,queuedMax
 await t.test('new verified student payment freezes declared billing audience and grants exactly one term',async()=>{
  const state=await rpc('xelay_student_workspace_entitlement',[owner]);assert.equal(state.audience,'student');assert.equal(state.planId,'start');assert.ok(state.startsAt);assert.ok(state.expiresAt);assert.equal(state.monthlyAiBudgetUsd,0);assert.equal(state.aiAllowance,'not_included');assert.equal(state.budget.limitMicros,0)
  assert.equal((await rows('select source from xelay_student_private.audiences where user_id=$1',[owner]))[0].source,'paid_student_order')
  firstPlus=await create('plus','first-plus-order');assert.equal(Number(firstPlus.amount),399);await apply(firstPlus);await apply(firstPlus)
  assert.equal((await rows('select count(*)::int n from xelay_student_private.grants where order_id=$1',[firstPlus.id]))[0].n,1);const plusStatus=await rpc('xelay_student_workspace_entitlement',[owner]);assert.equal(plusStatus.planId,'plus');assert.ok(plusStatus.startsAt);assert.ok(plusStatus.expiresAt);assert.equal(plusStatus.monthlyAiBudgetUsd,0);assert.equal(plusStatus.aiAllowance,'not_included');assert.equal(plusStatus.budget.limitMicros,0)
 })
 await t.test('higher upgrade starts now, preserves consumed lower segment and exact remaining lower seconds',async()=>{
  const before=await periods(),oldGrant=(await rows('select*from xelay_student_private.grants where order_id=$1',[firstPlus.id]))[0];firstMax=await create('max','first-max-order');await apply(firstMax)
  const after=await periods(),max=after.find(p=>p.order_id===firstMax.id),plus=after.filter(p=>p.order_id===firstPlus.id);assert.ok(new Date(max.valid_from).getTime()<=Date.now());assert.ok(new Date(max.valid_from).getTime()>Date.now()-5000)
  const originalPlus=before.filter(p=>p.order_id===firstPlus.id).reduce((n,p)=>n+(new Date(p.valid_until).getTime()-new Date(p.valid_from).getTime()),0),carriedPlus=plus.reduce((n,p)=>n+(new Date(p.valid_until).getTime()-new Date(p.valid_from).getTime()),0);assert.ok(Math.abs(originalPlus-carriedPlus)<=2)
  assert.ok(plus.some(p=>new Date(p.valid_from)>=new Date(max.valid_until)));assert.deepEqual((await rows('select*from xelay_student_private.grants where order_id=$1',[firstPlus.id]))[0],oldGrant)
  assert.equal((await rpc('xelay_student_workspace_entitlement',[owner])).planId,'max');assert.ok((await rows('select count(*)::int n from xelay_student_private.schedule_audit'))[0].n>=1)
 })
 await t.test('same-tier renewal and lower-tier purchase queue without wasting either paid period',async()=>{
  const current=await periods(),maxEnd=current.filter(p=>p.plan_id==='max').reduce((m,p)=>Math.max(m,new Date(p.valid_until).getTime()),0)
  const next=await create('max','max-renewal-order');queuedMax=next;await apply(next);const renewal=(await periods()).find(p=>p.order_id===next.id);assert.equal(new Date(renewal.valid_from).getTime(),maxEnd)
  const lower=await create('plus','plus-after-max-order');await apply(lower);const lowerPeriod=(await periods()).find(p=>p.order_id===lower.id);assert.ok(new Date(lowerPeriod.valid_from)>=new Date(renewal.valid_until))
 })
 await t.test('refund revokes both rights for that order and does not remove separate paid time',async()=>{
  const beforeCount=(await rows('select count(*)::int n from xelay_student_private.grants where revoked_at is null'))[0].n;await apply(firstMax,'Refunded')
  assert.equal((await rows('select count(*)::int n from xelay_student_private.grants where revoked_at is null'))[0].n,beforeCount-1)
  assert.equal((await rows('select revoked_at is not null revoked from public.participant_entitlements where order_id=$1',[firstMax.id]))[0].revoked,true)
  assert.equal((await rows('select revoked_at is null active from xelay_student_private.grants where order_id=$1',[firstPlus.id]))[0].active,true)
 })
 await t.test('refunding a queued renewal with an active current period leaves no artificial gap or consumed-time duplication',async()=>{
  await apply(queuedMax,'Refunded');const active=await periods(),first=active.find(p=>new Date(p.valid_from)<=new Date()&&new Date(p.valid_until)>new Date());assert.ok(first)
  const future=active.filter(p=>new Date(p.valid_from)>new Date()).sort((a,b)=>new Date(a.valid_from)-new Date(b.valid_from));let cursor=new Date(first.valid_until).getTime()
  for(const p of future){assert.ok(new Date(p.valid_from).getTime()<=cursor+2);cursor=Math.max(cursor,new Date(p.valid_until).getTime())}
 })
 await t.test('paid calendar months use Kyiv wall time across daylight saving and leap-month boundaries',async()=>{
  const cases=[['2026-10-24T10:30:00Z','2026-11-24T11:30:00Z'],['2028-01-31T10:30:00Z','2028-02-29T10:30:00Z'],['2026-03-15T10:30:00Z','2026-04-15T09:30:00Z']]
  for(const[start,end]of cases){const actual=(await rows("select (($1::timestamptz at time zone'Europe/Kyiv')+interval'1 month')at time zone'Europe/Kyiv'v",[start]))[0].v;assert.equal(new Date(actual).toISOString(),end.replace('Z','.000Z'))}
 })
 await t.test('test payments, unverified public requests and confirmed teacher audience cannot activate Max',async()=>{
  const testOrder=await create('max','test-max-order','test');await apply(testOrder);assert.equal((await rows('select count(*)::int n from xelay_student_private.grants where order_id=$1',[testOrder.id]))[0].n,0)
  await rpc('xelay_student_audience_assign',[other,'teacher','Audited teacher billing identity']);await assert.rejects(create('max','teacher-max-order','live',other),e=>e.code==='42501')
  await assert.rejects(as('authenticated',()=>db.query("select public.xelay_create_student_plan_order($1,'live','forged-max-order','max')",[owner])),e=>e.code==='42501')
 })
 await t.test('lifetime owner can explicitly buy monthly Max without changing lifetime or old paid time, and gift alone has no AI',async()=>{
  const lifetimeOwner=id(3);await db.exec(`insert into auth.users(id,email_confirmed_at)values('${lifetimeOwner}',now());insert into profiles(id,account_type)values('${lifetimeOwner}','student');insert into public.participant_lifetime_awards(recipient_id)values('${lifetimeOwner}');`)
  const before=await rpc('xelay_student_workspace_entitlement',[lifetimeOwner]),legacyRows=await rows('select*from public.participant_entitlements order by id'),award=await rows('select*from public.participant_lifetime_awards');assert.equal(before.isLifetime,true);assert.equal(before.aiAllowance,'pending_legacy_policy');assert.equal(before.monthlyAiBudgetUsd,0)
  const paid=await create('max','lifetime-max-purchase','live',lifetimeOwner);await apply(paid);const after=await rpc('xelay_student_workspace_entitlement',[lifetimeOwner]);assert.equal(after.planId,'max');assert.equal(after.isLifetime,true);assert.equal(after.monthlyAiBudgetUsd,6);assert.ok(after.startsAt);assert.ok(after.expiresAt)
  assert.deepEqual(await rows('select*from public.participant_lifetime_awards'),award);assert.deepEqual(await rows('select*from public.participant_entitlements where user_id<>$1 order by id',[lifetimeOwner]),legacyRows)
  await apply(paid,'Refunded');const refunded=await rpc('xelay_student_workspace_entitlement',[lifetimeOwner]);assert.equal(refunded.isLifetime,true);assert.equal(refunded.aiAllowance,'pending_legacy_policy');assert.equal(refunded.monthlyAiBudgetUsd,0)
  const lifetimeStatus=await as('authenticated',async()=>(await rows('select public.xelay_billing_status()v'))[0].v,lifetimeOwner,id(103));assert.equal(lifetimeStatus.is_lifetime,true);assert.equal(lifetimeStatus.expires_at,null)
 })
 await t.test('calendar carryover independently preserves core premium rights and precise continuous expiry after legacy core ends',async()=>{
  const user=id(4),sid=id(104);await db.exec(`insert into auth.users(id,email_confirmed_at)values('${user}',now());insert into public.profiles(id,account_type)values('${user}','student');insert into auth.sessions(id,user_id)values('${sid}','${user}');`)
  const paid=await create('start','carryover-boundary-order','live',user);await apply(paid)
  await db.query("update public.participant_entitlements set valid_from=clock_timestamp()-interval'60 days',valid_until=clock_timestamp()-interval'12 hours'where user_id=$1",[user])
  await db.query("update xelay_student_private.grant_periods set valid_from=clock_timestamp()-interval'12 hours',valid_until=clock_timestamp()+interval'12 hours'where grant_id in(select id from xelay_student_private.grants where user_id=$1)",[user])
  const expiry=(await rows('select p.valid_until from xelay_student_private.grant_periods p join xelay_student_private.grants g on g.id=p.grant_id where g.user_id=$1',[user]))[0].valid_until,legacyBefore=await rows('select*from public.participant_entitlements where user_id=$1',[user])
  assert.equal((await rows('select xelay_student_private.legacy_has_participant_access($1)v',[user]))[0].v,false);assert.equal((await rows('select public.xelay_has_participant_access($1)v',[user]))[0].v,true)
  const status=await as('authenticated',async()=>(await rows('select public.xelay_billing_status()v'))[0].v,user,sid);assert.equal(status.is_premium,true);assert.equal(new Date(status.expires_at).toISOString(),new Date(expiry).toISOString());assert.equal(status.free_communication,true)
  assert.deepEqual(await rows('select*from public.participant_entitlements where user_id=$1',[user]),legacyBefore)
  await apply(paid,'Refunded');assert.equal((await rows('select public.xelay_has_participant_access($1)v',[user]))[0].v,false)
 })
 await t.test('March-April-May example reaches May2 without granting access across a later unpaid gap',async()=>{
  const user=id(5);await db.exec(`insert into auth.users(id,email_confirmed_at)values('${user}',now());insert into public.profiles(id,account_type)values('${user}','student');insert into public.participant_entitlements(user_id,source,term_months,valid_from,valid_until)values('${user}','admin_grant',1,'2026-03-01T00:00:00Z','2026-05-01T00:00:00Z');`)
  await rpc('xelay_student_plan_grant',[user,'start','2026-03-01T00:00:00Z','2026-04-01T00:00:00Z','static-calendar-carryover'])
  await db.query("update xelay_student_private.grant_periods set valid_from='2026-04-16T00:00:00Z',valid_until='2026-05-02T00:00:00Z'where grant_id in(select id from xelay_student_private.grants where user_id=$1)",[user])
  await rpc('xelay_student_plan_grant',[user,'start','2026-05-05T00:00:00Z','2026-05-15T00:00:00Z','static-calendar-later-gap'])
  assert.equal((await rows("select xelay_student_private.active_plan_access($1,'2026-05-01T12:00:00Z')v",[user]))[0].v,true)
  assert.equal(new Date((await rows("select xelay_student_private.participant_coverage_until($1,'2026-05-01T12:00:00Z')v",[user]))[0].v).toISOString(),'2026-05-02T00:00:00.000Z')
  assert.equal((await rows("select xelay_student_private.active_plan_access($1,'2026-05-03T12:00:00Z')v",[user]))[0].v,false)
 })
 }finally{await db.close()}
})
