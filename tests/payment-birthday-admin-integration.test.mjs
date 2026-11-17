import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'
import {PGlite} from '@electric-sql/pglite'

// Disposable local database + synthetic authenticated identities/provider HMACs.
// No provider request, production credentials, database or account is used.
// This is application integration proof, not a completed hosted gateway payment.
const native=createRequire(import.meta.url)
const source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8')
const compile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
const plain=v=>JSON.parse(JSON.stringify(v))
function load(file,imports={},globals={}){
 const module={exports:{}}
 vm.runInNewContext(compile(source(file)),{module,exports:module.exports,Buffer,URL,Date,Number,Math,JSON,AbortController,setTimeout,clearTimeout,
  fetch(){throw Error('Network forbidden in payment integration')},...globals,
  require(name){if(Object.hasOwn(imports,name))return imports[name];if(name.startsWith('node:'))return native(name);throw Error('Unexpected module '+name)}})
 return module.exports
}
function block(text,name){
 const match=new RegExp('create (?:or replace )?function public\\.'+name+'\\(').exec(text)
 assert.ok(match,`Missing real function ${name}`)
 const end=text.indexOf('$$;',match.index);assert.ok(end>match.index)
 return text.slice(match.index,end+3)
}
const initial=source('supabase/migrations/202609300001_participant_billing.sql')
const group=source('supabase/migrations/202610030016_group_trial.sql')
const communication=source('supabase/migrations/202610130001_free_people_communication.sql')
const lifetime=source('supabase/migrations/202611100010_participant_lifetime_milestone.sql')
const foundation=source('supabase/migrations/202611160100_student_max_workspace.sql')
const studentBilling=source('supabase/migrations/202611160110_student_plan_billing.sql')
function lifetimePatch(name,definition){
 const match=new RegExp("\\('public\\."+name+"\\([^']*\\)',\\s*\\$old\\$([\\s\\S]*?)\\$old\\$,\\s*\\$new\\$([\\s\\S]*?)\\$new\\$\\)").exec(lifetime)
 assert.ok(match,`Missing exact lifetime patch ${name}`)
 assert.equal(definition.split(match[1]).length,2,`Lifetime source drift ${name}`)
 return definition.replace(match[1],match[2])
}
const id=n=>`57000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const env={BILLING_MODE:'live',VERCEL_ENV:'development',STUDENT_PLANS_ENABLED:'true',
 XELAY_PUBLIC_URL:'https://local-payment-fixture.invalid',WAYFORPAY_MERCHANT_ACCOUNT:'synthetic_local_merchant',WAYFORPAY_SECRET_KEY:'synthetic-local-test-signing-key',
 WAYFORPAY_MERCHANT_DOMAIN:'local-payment-fixture.invalid',SUPABASE_URL:'https://local-db.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-local-service-role',
 BILLING_CHECKOUT_ENABLED:'true',WAYFORPAY_LIVE_APPROVED:'true'}

test('birthday discounts and administrator grants preserve access with exact authenticated payment snapshots',{timeout:120000},async t=>{
 const db=new PGlite()
 const actors=new Map()
 let currentRole='postgres'
 let adapterQueue=Promise.resolve()
 function queued(fn){const task=adapterQueue.then(fn);adapterQueue=task.catch(()=>{});return task}
 const rows=async(sql,args=[])=>(await db.query(sql,args)).rows
 async function as(role,user,fn){
  assert.equal(currentRole,'postgres','Fixture database access must remain sequential')
  currentRole=role
  await db.exec('set role '+role)
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user?.id,session_id:user?.session,role,aal:user?.aal??'aal1'})])
  try{return await fn()}finally{await db.exec('reset role');currentRole='postgres'}
 }
 const rpcArguments={
  xelay_create_student_plan_order:['p_user_id','p_mode','p_order_reference','p_plan_id'],
  xelay_apply_billing_event:['p_reference','p_mode','p_fingerprint','p_status','p_amount','p_currency','p_fee'],
  xelay_student_workspace_entitlement:['p_user_id'],xelay_student_workspace_status:[],xelay_billing_status:[],
  xelay_student_audience_assign:['p_user_id','p_audience','p_reason'],
  xelay_student_plan_grant:['p_user_id','p_plan_id','p_valid_from','p_valid_until','p_reference'],
  xelay_create_discounted_student_plan_order:['p_user_id','p_mode','p_order_reference','p_plan_id','p_gift_id'],
 }
 async function rpcValue(name,args={},user=null){
  const names=rpcArguments[name];assert.ok(names,'Unexpected fixture RPC '+name)
  return queued(()=>as(user?'authenticated':'service_role',user,async()=>(await rows(`select public.${name}(${names.map((_,i)=>'$'+(i+1)).join(',')}) as value`,names.map(n=>args[n]??null)))[0].value))
 }
 function queryBuilder(table){
  assert.equal(table,'billing_orders')
  let columns='*',update=null,clauses=[],ordering='',limit=''
  const allowed=new Set(['id','user_id','status','order_reference','product','group_id','mode','created_at','student_plan_id','amount','currency','approved_at','updated_at','provider_status','provider_fee','terms_version','terms_accepted_at'])
  const safe=column=>{assert.ok(allowed.has(column),'Unexpected fixture column '+column);return column}
  async function execute(){
   const args=[]
   let sql
   if(update){const assignments=Object.entries(update).map(([key,value])=>{args.push(value);return `${safe(key)}=$${args.length}`});sql='update public.billing_orders set '+assignments.join(',')}
   else sql='select '+(columns==='*'?'*':columns.split(',').map(c=>safe(c.trim())).join(','))+' from public.billing_orders'
   const where=clauses.map(([column,value])=>{args.push(value);return `${safe(column)}=$${args.length}`})
   if(where.length)sql+=' where '+where.join(' and ')
   sql+=update?' returning '+columns:ordering+limit
   try{return {data:await queued(()=>rows(sql,args)),error:null}}catch(error){return {data:null,error:{message:error.message,code:error.code}}}
  }
  const builder={select(value){columns=value;return builder},update(value){update=value;return builder},eq(column,value){clauses.push([column,value]);return builder},order(column,{ascending=true}={}){ordering=` order by ${safe(column)} ${ascending?'asc':'desc'}`;return builder},limit(value){assert.ok(Number.isInteger(value)&&value>0&&value<=100);limit=' limit '+value;return builder},
   async single(){const result=await execute();return result.error||result.data.length!==1?{data:null,error:result.error??{message:'Expected one row'}}:{data:result.data[0],error:null}},
   async maybeSingle(){const result=await execute();return result.error?result:{data:result.data[0]??null,error:null}},
   then(resolve,reject){return execute().then(resolve,reject)}}
  return builder
 }
 const supabaseAdapter={createClient(_url,_key,options){
  const token=options?.global?.headers?.Authorization?.replace(/^Bearer /,'')
  const user=actors.get(token)
  return {auth:{async getUser(value){const known=actors.get(value);return {data:{user:known?{id:known.id,email:known.email}:null},error:null}}},from:queryBuilder,
   async rpc(name,args){try{return {data:await rpcValue(name,args,user),error:null}}catch(error){return {data:null,error:{message:error.message,code:error.code}}}}}
 }}
 const helpers=load('server/student-learning/studentPlanPrices.ts',{}, {process:{env}})
 const support={SUPPORT_ORDER_REFERENCE:/^xelay_support_/}
 const billing=load('server/billing.ts',{'@supabase/supabase-js':supabaseAdapter,'../src/lib/legal.js':{legalMerchant:{ready:true}},'../src/lib/teamSupport.js':support,'./student-learning/studentPlanPrices.js':helpers,'./student-learning/aiCreditPrices.js':load('server/student-learning/aiCreditPrices.ts')},{process:{env}})
 const billingImports={'../../server/billing.js':billing,'../../server/student-learning/studentPlanPrices.js':helpers,'../../src/lib/legal.js':{LEGAL_TERMS_VERSION:'qa-local-current-terms',legalMerchant:{ready:true}},'../../src/lib/teamSupport.js':support,'../../server/student-learning/aiCreditPrices.js':load('server/student-learning/aiCreditPrices.ts')}
 const handlers={checkout:load('api/billing/checkout.ts',billingImports).default,webhook:load('api/billing/webhook.ts',billingImports).default,status:load('api/billing/status.ts',billingImports).default,return:load('api/billing/return.ts',billingImports).default}
 async function call(name,{user,body={},query={},method='POST',origin=env.XELAY_PUBLIC_URL}={}){
  const response={statusCode:200,headers:{},setHeader(name,value){this.headers[name]=value},status(value){this.statusCode=value;return this},json(value){this.body=plain(value);return this},end(){return this}}
  await handlers[name]({method,headers:{origin,...(user?{authorization:'Bearer '+user.token}:{})},body,query},response)
  return response
 }
 async function actor(n){const user={id:id(n),session:id(1000+n),token:'local-auth-fixture-'+n,email:`synthetic-${n}@example.invalid`};actors.set(user.token,user)
  await db.query('insert into auth.users(id,email_confirmed_at)values($1,now());',[user.id]);await db.query("insert into public.profiles(id,account_type)values($1,'student')",[user.id]);await db.query('insert into auth.sessions(id,user_id)values($1,$2)',[user.session,user.id]);return user}
 async function checkout(user,plan,extra={}){const response=await call('checkout',{user,body:{product:'participant',studentPlanId:plan,recurring:false,acceptedTerms:true,termsVersion:'qa-local-current-terms',...extra}});assert.equal(response.statusCode,200,JSON.stringify(response.body));return response.body}
 function payload(order,status='Approved',change={}){const p={merchantAccount:env.WAYFORPAY_MERCHANT_ACCOUNT,orderReference:order.orderReference,amount:order.checkout.fields.amount,currency:'UAH',authCode:'LOCALONLY',cardPan:'411111******1111',transactionStatus:status,reasonCode:status==='Approved'?1100:1101,...change};p.merchantSignature=billing.signature(['merchantAccount','orderReference','amount','currency','authCode','cardPan','transactionStatus','reasonCode'].map(k=>p[k]),env.WAYFORPAY_SECRET_KEY);return p}
 async function event(order,status='Approved',change={}){return call('webhook',{body:payload(order,status,change)})}
 async function entitlement(user){const response=await call('status',{user,method:'GET'});assert.equal(response.statusCode,200,JSON.stringify(response.body));const workspace=await rpcValue('xelay_student_workspace_status',{},user);if(workspace.startsAt&&workspace.expiresAt)assert.equal(response.body.studentPlan.id,workspace.planId);else assert.equal(response.body.studentPlan,null);return {...response.body,billingStudentPlan:response.body.studentPlan,studentPlan:workspace}}
 const grants=user=>rows('select g.*,p.valid_from as period_from,p.valid_until as period_until from xelay_student_private.grants g join xelay_student_private.grant_periods p on p.grant_id=g.id where g.user_id=$1 and g.revoked_at is null order by p.valid_from,g.id',[user.id])
 const legacy=user=>rows('select * from public.participant_entitlements where user_id=$1 order by valid_from,id',[user.id])
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
   create function auth.uid()returns uuid language sql stable as $$select(auth.jwt()->>'sub')::uuid$$;
   grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt()to anon,authenticated,service_role;
   create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
   create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);
   create table public.profiles(id uuid primary key,account_type text default 'student');
   create table public.study_groups(id uuid primary key);create table public.notifications(id uuid primary key);
  `)
  // Real legacy DDL and relevant functions; no business scheduling/access stubs.
  await db.exec(initial.slice(initial.indexOf('create table if not exists public.billing_orders ('),initial.indexOf('create table if not exists public.user_search_usage (')))
  await db.exec(`alter table public.billing_orders add column group_term_months integer;alter table public.billing_orders add column terms_version text;alter table public.billing_orders add column terms_accepted_at timestamptz;alter table public.premium_preferences add column status_text text;
   create table public.group_annual_entitlements(id uuid primary key default gen_random_uuid(),group_id uuid,order_id uuid unique,term_months integer,valid_from timestamptz,valid_until timestamptz,revoked_at timestamptz,created_at timestamptz default now());
   create table public.group_trial_entitlements(group_id uuid primary key,expires_at timestamptz);`)
  await db.exec(lifetime.slice(lifetime.indexOf('create table public.participant_lifetime_awards ('),lifetime.indexOf('-- Preserve function identities')))
  await db.exec(lifetimePatch('xelay_has_participant_access',block(initial,'xelay_has_participant_access')))
  await db.exec(block(initial,'xelay_reflow_participant_access'))
  await db.exec(block(group,'xelay_reflow_group_access'))
  await db.exec(lifetimePatch('xelay_billing_status',block(communication,'xelay_billing_status')))
  await db.exec(block(group,'xelay_apply_billing_event'))
  await db.exec(foundation);await db.exec(studentBilling)
  await db.exec(source('supabase/migrations/20261116155610_student_max_paid_period.sql'))

  // Real birthday migration, with local no-op notification delivery only.
  await db.exec(`alter table public.notifications add column recipient_id uuid;alter table public.notifications add column actor_id uuid;
   alter table public.notifications add column actor_name text;alter table public.notifications add column type text;alter table public.notifications add column message text;
   alter table public.notifications add column is_read boolean;alter table public.notifications add column created_at timestamptz;
   alter table public.notifications alter column id set default gen_random_uuid();
   create table auth.mfa_factors(user_id uuid,status text);create table public.fixture_admins(user_id uuid);
   create function public.xelay_is_platform_admin()returns boolean language sql security definer set search_path=''as $$select exists(select 1 from public.fixture_admins where user_id=auth.uid())$$;
   create function public.xelay_queue_notification_email()returns trigger language plpgsql as $$begin return new;end$$;
   create trigger notification_email_queue after insert on public.notifications for each row execute function public.xelay_queue_notification_email();
   create table public.profile_birthdays(user_id uuid primary key,day integer,month integer);
  `)
  await db.exec(source('supabase/migrations/202610260001_birthday_gifts.sql'))
  await db.exec(block(source('supabase/migrations/202610290002_profile_birthdays.sql'),'xelay_private_birthday_observed_date'))
  const admin=await actor(90);admin.aal='aal2'
  await db.query('insert into public.fixture_admins values($1)',[admin.id]);await db.query("insert into auth.mfa_factors values($1,'verified')",[admin.id])
  const own=async(user,sql,args=[])=>queued(()=>as('authenticated',user,async()=>(await rows(sql,args))[0]?.value))
  const offer=async user=>own(admin,'select public.xelay_admin_offer_birthday_gift($1)as value',[user.id])
  const legacyRecipient=await actor(91),oldGift=await offer(legacyRecipient)
  await db.exec(source('supabase/migrations/20261116155614_student_tier_admin_birthday_discounts.sql'))
  const normal=await actor(92)
  await t.test('null and partial discount snapshots are rejected by real CHECK constraints',async()=>{
   const user=await actor(93),gift=await offer(user)
   await assert.rejects(db.query('update public.birthday_gifts set coupon_expires_at=null where id=$1',[gift.id]),/birthday_coupon_shape/)
   const base={user:user.id,gift:gift.id}
   for(const[plan,list,percent]of[[null,999,20],['max',null,20],['max',999,null]]){
    await assert.rejects(db.query("insert into public.billing_orders(user_id,product,order_reference,amount,mode,student_plan_id,birthday_gift_id,list_amount,discount_percent,discount_expires_at)values($1,'participant',$2,799.2,'live',$3,$4,$5,$6,clock_timestamp()+interval'1 day')",[base.user,'xelay_'+native('node:crypto').randomUUID(),plan,base.gift,list,percent]),/billing_order_product_price/)
   }
  })
  await t.test('installation preserves the prior unclaimed free month and its recipient can still redeem exactly once',async()=>{
   const claimed=await own(legacyRecipient,'select public.xelay_claim_birthday_gift($1)as value',[oldGift.id])
   assert.ok(claimed.claimed_at);assert.equal(claimed.gift_kind,'legacy_month');assert.equal((await legacy(legacyRecipient)).length,1)
   await own(legacyRecipient,'select public.xelay_claim_birthday_gift($1)as value',[oldGift.id]);assert.equal((await legacy(legacyRecipient)).length,1)
  })
  for(const[index,plan,price,discount]of[[20,'start',74.5,50],[21,'plus',279.3,30],[22,'max',799.2,20]])await t.test(`${plan}: one birthday coupon → exact signed discounted checkout → one paid period`,async()=>{
   const user=await actor(index),gift=await offer(user)
   assert.equal(gift.gift_kind,'discount_coupon');assert.equal(new Date(gift.coupon_expires_at)-new Date(gift.offered_at),7*86400000)
   await assert.rejects(own(user,'select public.xelay_claim_birthday_gift($1)as value',[gift.id]),/BIRTHDAY_COUPON_CHECKOUT_REQUIRED/)
   const order=await checkout(user,plan,{birthdayGiftId:gift.id}),again=await checkout(user,plan,{birthdayGiftId:gift.id})
   assert.equal(order.orderReference,again.orderReference);assert.equal(order.checkout.fields.amount,price);assert.ok(order.checkout.fields.orderLifetime>3600)
   const[snapshot]=await rows('select *from public.billing_orders where order_reference=$1',[order.orderReference]);assert.equal(snapshot.discount_percent,discount)
   assert.equal((await grants(user)).length,0)
   const wrong=await event(order,'Approved',{amount:price+0.01});assert.equal(wrong.statusCode,409)
   assert.equal((await event(order,'Declined')).statusCode,200)
   const retried=await checkout(user,plan,{birthdayGiftId:gift.id});assert.equal(retried.orderReference,order.orderReference)
   assert.equal((await event(order)).statusCode,200);assert.equal((await event(order)).statusCode,200)
   assert.equal((await grants(user)).length,1);const state=await entitlement(user);assert.equal(state.studentPlan.planId,plan)
   assert.equal(state.studentPlan.monthlyAiBudgetUsd,plan==='max'?10:0)
   const[g]=await rows('select *from public.birthday_gifts where id=$1',[gift.id]);assert.ok(g.coupon_redeemed_at);assert.equal(g.claimed_at,null);assert.equal(g.entitlement_id,null)
   const foreign=await call('checkout',{user:normal,body:{product:'participant',studentPlanId:plan,birthdayGiftId:gift.id,acceptedTerms:true,termsVersion:'qa-local-current-terms'}});assert.equal(foreign.statusCode,409)
   await assert.rejects(db.query('update public.billing_orders set discount_percent=99 where id=$1',[snapshot.id]),/BILLING_ORDER_SNAPSHOT_IMMUTABLE/)
   await assert.rejects(db.query('update public.billing_orders set student_plan_id=$2 where id=$1',[snapshot.id,'start'===plan?'max':'start']),/BILLING_ORDER_SNAPSHOT_IMMUTABLE/)
   assert.equal((await event(order,'Refunded')).statusCode,200)
   assert.equal((await entitlement(user)).studentPlan.planId,'free');assert.ok((await rows('select coupon_redeemed_at from public.birthday_gifts where id=$1',[gift.id]))[0].coupon_redeemed_at,'Refund does not mint another coupon')
  })
  await t.test('a coupon locks one selected tariff, rejects foreign/expired gifts and cannot stack arbitrary discounts',async()=>{
   const user=await actor(23),gift=await offer(user);await checkout(user,'plus',{birthdayGiftId:gift.id})
   const body={product:'participant',studentPlanId:'max',birthdayGiftId:gift.id,acceptedTerms:true,termsVersion:'qa-local-current-terms'}
   assert.equal((await call('checkout',{user,body})).statusCode,409)
   assert.equal((await call('checkout',{user,body:{...body,discountPercent:99}})).statusCode,400)
   assert.equal((await call('checkout',{user:normal,body})).statusCode,409)
   const expired=await actor(24),expiredGift=await offer(expired)
   await db.query("update public.birthday_gifts set offered_at=offered_at-interval'8 days',coupon_expires_at=coupon_expires_at-interval'8 days'where id=$1",[expiredGift.id])
   assert.equal((await call('checkout',{user:expired,body:{...body,birthdayGiftId:expiredGift.id}})).statusCode,409)
   assert.equal(await own(expired,'select public.xelay_my_birthday_discount()as value'),null)
  })
  await t.test('automatic anniversary creates a coupon, never a free entitlement, and annual re-offer is idempotent',async()=>{
   const user=await actor(25)
   await db.query("insert into public.profile_birthdays select $1,extract(day from clock_timestamp()at time zone'Europe/Kyiv')::integer,extract(month from clock_timestamp()at time zone'Europe/Kyiv')::integer",[user.id])
   const gift=await own(user,'select public.xelay_my_birthday_discount()as value')
   assert.equal(gift.gift_kind,'discount_coupon');assert.equal((await offer(user)).id,gift.id);assert.equal((await legacy(user)).length,0)
   assert.equal((await rows('select count(*)::integer n from public.birthday_gifts where recipient_id=$1',[user.id]))[0].n,1)
  })
  await t.test('new admin grants support all tiers and lifetime gifts survive without becoming paid revenue',async()=>{
   for(const[n,plan]of[[30,'start'],[31,'plus'],[32,'max']]){
    const user=await actor(n)
    await rpcValue('xelay_student_audience_assign',{p_user_id:user.id,p_audience:'student',p_reason:'Synthetic approved student audience'})
    if(plan==='max')await db.query('insert into public.participant_lifetime_awards(milestone,recipient_id,granted_at)values(1000,$1,now())',[user.id])
    const before=await rows('select *from public.participant_lifetime_awards')
    const grant=await own(admin,'select public.xelay_admin_grant_student_plan($1,$2,$3,$4,$5)as value',[user.id,plan,7,'Approved synthetic gift',id(9930+n)])
    assert.equal(grant.plan_id,plan);const state=await entitlement(user);assert.equal(state.studentPlan.planId,plan)
    assert.equal(state.studentPlan.monthlyAiBudgetUsd,plan==='max'?10:0)
    if(plan==='max'){assert.equal(state.is_lifetime,true);assert.deepEqual(await rows('select *from public.participant_lifetime_awards'),before)}
    assert.equal((await rows('select count(*)::integer n from public.billing_orders where user_id=$1',[user.id]))[0].n,0)
   }
  })
  await t.test('an explicit MFA administrator gift assigns unresolved billing audience once, without overriding teachers or trusting profile metadata',async()=>{
   const target=await actor(40),teacher=await actor(41)
   await db.query('delete from xelay_student_private.audiences where user_id=$1',[target.id])
   await db.query('delete from xelay_student_private.audiences where user_id=$1',[teacher.id])
   await rpcValue('xelay_student_audience_assign',{p_user_id:teacher.id,p_audience:'teacher',p_reason:'Synthetic explicitly registered teacher'})
   const sql='select public.xelay_admin_grant_student_plan($1,$2,$3,$4,$5)as value',args=[target.id,'max',7,'Approved unresolved student gift',id(9980)]
   admin.aal='aal1';await assert.rejects(own(admin,sql,args),/STUDENT_GRANT_ADMIN_MFA_REQUIRED/);admin.aal='aal2'
   assert.equal((await rows('select count(*)::integer n from xelay_student_private.audiences where user_id=$1',[target.id]))[0].n,0)
   assert.equal((await own(admin,sql,args)).granted,true);assert.equal((await own(admin,sql,args)).already_granted,true)
   const[audience]=await rows('select *from xelay_student_private.audiences where user_id=$1',[target.id]);assert.equal(audience.audience,'student');assert.equal(audience.source,'audited_assignment');assert.match(audience.reason,new RegExp(admin.id));assert.match(audience.reason,/Approved unresolved student gift/)
   assert.equal((await rows("select count(*)::integer n from public.billing_audit_log where action='student_audience_assignment'and target_user_id=$1",[target.id]))[0].n,1)
   await assert.rejects(own(admin,sql,[teacher.id,'max',7,'Do not override teacher',id(9981)]),/STUDENT_AUDIENCE_REQUIRED/)
   assert.equal((await rows('select audience from xelay_student_private.audiences where user_id=$1',[teacher.id]))[0].audience,'teacher')
   assert.equal((await rows('select count(*)::integer n from xelay_student_private.grants where user_id=$1',[teacher.id]))[0].n,0)
  })
  await t.test('admin tier grants require current MFA session, are idempotent and preserve lower paid seconds and lifetime awards',async()=>{
   const user=await actor(26),start=await checkout(user,'start');assert.equal((await event(start)).statusCode,200)
   const before=await grants(user),legacyBefore=await legacy(user)
   const request=id(9900),args=[user.id,'max',7,'Approved isolated trial',request]
   const sql='select public.xelay_admin_grant_student_plan($1,$2,$3,$4,$5)as value'
   admin.aal='aal1';await assert.rejects(own(admin,sql,args),/STUDENT_GRANT_ADMIN_MFA_REQUIRED/);admin.aal='aal2'
   await assert.rejects(own(normal,sql,args),/STUDENT_GRANT_ADMIN_MFA_REQUIRED/)
   const granted=await own(admin,sql,args);assert.equal(granted.granted,true);assert.equal((await own(admin,sql,args)).already_granted,true)
   await assert.rejects(own(admin,sql,[user.id,'plus',7,'Approved isolated trial',request]),/STUDENT_GRANT_CONFLICT/)
   assert.equal((await entitlement(user)).studentPlan.planId,'max')
   const after=await grants(user),duration=list=>list.reduce((n,p)=>n+new Date(p.period_until).getTime()-new Date(p.period_from).getTime(),0)
   assert.ok(Math.abs(duration(after.filter(p=>p.plan_id==='start'))-duration(before))<=3);assert.deepEqual(await legacy(user),legacyBefore)
   assert.equal(after.filter(p=>p.plan_id==='max').length,1)
   const[audit]=await rows("select *from public.billing_audit_log where action='grant_student_plan'and target_user_id=$1",[user.id]);assert.equal(audit.actor_id,admin.id)
   await assert.rejects(own(normal,'select *from public.birthday_gifts'),/permission denied/)
   await assert.rejects(own(normal,'select public.xelay_create_discounted_student_plan_order($1,$2,$3,$4,$5)',[user.id,'live','xelay_'+id(9998),'max',id(9999)]),/permission denied/)
  })
 }finally{await db.close()}
})

