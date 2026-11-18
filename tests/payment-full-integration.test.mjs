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

test('full payment application integration uses real legacy scheduling and unmodified student migrations',{timeout:120000},async t=>{
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
  await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user?.id,session_id:user?.session,role})])
  try{return await fn()}finally{await db.exec('reset role');currentRole='postgres'}
 }
 const rpcArguments={
  xelay_create_student_plan_order:['p_user_id','p_mode','p_order_reference','p_plan_id'],
  xelay_apply_billing_event:['p_reference','p_mode','p_fingerprint','p_status','p_amount','p_currency','p_fee'],
  xelay_student_workspace_entitlement:['p_user_id'],xelay_student_workspace_status:[],xelay_billing_status:[],
  xelay_student_audience_assign:['p_user_id','p_audience','p_reason'],
  xelay_student_plan_grant:['p_user_id','p_plan_id','p_valid_from','p_valid_until','p_reference'],
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
 const billing=load('server/billing.ts',{'@supabase/supabase-js':supabaseAdapter,'../src/lib/legal.js':{legalMerchant:{ready:true}},'../src/lib/teamSupport.js':support,'./student-learning/studentPlanPrices.js':helpers,'./teacher-learning/teacherPlanPrices.js':load('server/teacher-learning/teacherPlanPrices.ts',{}, {process:{env}}), './student-learning/aiCreditPrices.js':load('server/student-learning/aiCreditPrices.ts')},{process:{env}})
 const originalSendError=billing.sendError;billing.sendError=(res,error)=>{if(!(error instanceof billing.BillingError))throw error;return originalSendError(res,error)}
 const billingImports={'../../server/billing.js':billing,'../../server/teacher-learning/teacherPlanPrices.js':load('server/teacher-learning/teacherPlanPrices.ts',{}, {process:{env}}), '../../server/student-learning/studentPlanPrices.js':helpers,'../../src/lib/legal.js':{LEGAL_TERMS_VERSION:'qa-local-current-terms',legalMerchant:{ready:true}},'../../src/lib/teamSupport.js':support,'../../server/student-learning/aiCreditPrices.js':load('server/student-learning/aiCreditPrices.ts')}
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

  const purchased={}
  for(const [index,plan,price]of [[1,'start',149],[2,'plus',399],[3,'max',999]])await t.test(`${plan}: real checkout signature → verified webhook → fresh own billing and entitlement`,async()=>{
   const user=await actor(index),before=await entitlement(user);assert.equal(before.studentPlan.planId,'free')
   const order=await checkout(user,plan,{amount:1,userId:id(99),audience:'teacher'}),fields=order.checkout.fields
   assert.equal(fields.amount,price);assert.equal(fields.currency,'UAH');assert.equal(fields.regularMode,'none');assert.equal(order.checkout.action,'https://secure.wayforpay.com/pay')
   assert.equal(fields.merchantSignature,billing.signature([env.WAYFORPAY_MERCHANT_ACCOUNT,env.WAYFORPAY_MERCHANT_DOMAIN,order.orderReference,fields.orderDate,price,'UAH',fields.productName[0],1,price],env.WAYFORPAY_SECRET_KEY))
   assert.equal((await entitlement(user)).studentPlan.planId,'free','Checkout cannot grant access')
   const approved=await event(order);assert.equal(approved.statusCode,200);assert.equal(approved.body.status,'accept');assert.equal(approved.body.signature,billing.signature([order.orderReference,'accept',approved.body.time],env.WAYFORPAY_SECRET_KEY))
   const after=await entitlement(user);assert.equal(after.studentPlan.planId,plan);assert.equal(after.is_premium,true);assert.equal(after.studentPlan.monthlyAiBudgetUsd,plan==='max'?10:0);assert.equal(after.studentPlan.budget.limitMicros,plan==='max'?10000000:0)
   assert.equal((await grants(user)).length,1);assert.equal((await legacy(user)).length,1);purchased[plan]={user,order}
  })

  await t.test('duplicate verified callbacks grant one period, and other account cannot see order or paid access',async()=>{
   const{user,order}=purchased.max,before=await grants(user),old=await legacy(user)
   assert.equal((await event(order)).statusCode,200);assert.deepEqual(await grants(user),before);assert.deepEqual(await legacy(user),old)
   const other=await actor(4),state=await entitlement(other);assert.equal(state.studentPlan.planId,'free');assert.deepEqual(state.orders,[])
   const [snapshot]=await rows('select * from public.billing_orders where order_reference=$1',[order.orderReference]);assert.equal(snapshot.user_id,user.id)
   assert.equal((await rows('select count(*)::int n from public.billing_payment_events where order_id=$1',[snapshot.id]))[0].n,1)
  })
  await t.test('previously opened legacy100 checkout still settles its original contract and queues new Start after it',async()=>{
   const user=await actor(12),reference='xelay_'+id(1200)
   const [old]=await rows("insert into public.billing_orders(user_id,product,order_reference,amount,mode)values($1,'participant',$2,100,'live')returning *",[user.id,reference])
   const order={orderReference:reference,checkout:billing.signedCheckout(old,user,{kind:'legacy'})};assert.equal(order.checkout.fields.amount,100);assert.match(order.checkout.fields.productName[0],/Учасник/)
   assert.equal((await event(order)).statusCode,200);const legacyPeriod=(await legacy(user))[0];assert.equal((await entitlement(user)).is_premium,true);assert.equal((await grants(user)).length,0)
   const next=await checkout(user,'start');assert.equal((await event(next)).statusCode,200);const privatePeriod=(await grants(user))[0]
   assert.equal(new Date(privatePeriod.period_from).getTime(),new Date(legacyPeriod.valid_until).getTime());assert.deepEqual((await legacy(user)).find(p=>p.id===legacyPeriod.id),legacyPeriod)
  })
  await t.test('pending/declined/tampered callback and browser return never grant access',async()=>{
   const user=await actor(5),order=await checkout(user,'max')
   let response=await event(order,'Pending');assert.equal(response.statusCode,200);assert.equal((await entitlement(user)).studentPlan.planId,'free')
   const forged=payload(order);forged.merchantSignature='0'.repeat(32);response=await call('webhook',{body:forged});assert.equal(response.statusCode,403)
   response=await event(order,'Approved',{amount:149});assert.equal(response.statusCode,409)
   response=await event(order,'Approved',{currency:'USD'});assert.equal(response.statusCode,400)
   response=await event(order,'Approved',{merchantAccount:'another-merchant'});assert.equal(response.statusCode,403)
   response=await event(order,'Declined');assert.equal(response.statusCode,200);assert.equal((await entitlement(user)).studentPlan.planId,'free')
   response=await call('return',{query:{orderReference:order.orderReference},body:payload(order)});assert.equal(response.statusCode,303);assert.match(response.headers.Location,/payment=returned/);assert.equal((await entitlement(user)).studentPlan.planId,'free')
   assert.deepEqual(await grants(user),[]);assert.deepEqual(await legacy(user),[])
  })
  await t.test('invalid origin, identity and client plan never create payable orders',async()=>{
   const user=await actor(6)
   for(const options of [{origin:'https://evil.invalid',user},{user:null},{user,body:{product:'participant',studentPlanId:'constructor',acceptedTerms:true,termsVersion:'qa-local-current-terms'}},{user,body:{product:'participant',studentPlanId:'max',acceptedTerms:false,termsVersion:'qa-local-current-terms'}}]){
    const r=await call('checkout',{body:{product:'participant',studentPlanId:'max',acceptedTerms:true,termsVersion:'qa-local-current-terms'},...options});assert.ok([400,401,403].includes(r.statusCode))
   }
   assert.equal((await rows('select count(*)::int n from public.billing_orders where user_id=$1',[user.id]))[0].n,0)
  })
  await t.test('test merchant Approved is accepted only in isolated test mode and grants no live access',async()=>{
   const user=await actor(7),saved={...env}
   Object.assign(env,{BILLING_MODE:'test',BILLING_TEST_ISOLATED:'true',WAYFORPAY_MERCHANT_ACCOUNT:'test_local_fixture'})
   try{const order=await checkout(user,'max');assert.equal(order.mode,'test');assert.equal((await event(order)).statusCode,200);assert.deepEqual(await grants(user),[]);assert.deepEqual(await legacy(user),[]);assert.equal((await entitlement(user)).studentPlan.planId,'free')
    Object.assign(env,{BILLING_MODE:'live',WAYFORPAY_MERCHANT_ACCOUNT:saved.WAYFORPAY_MERCHANT_ACCOUNT});assert.equal((await event(order)).statusCode,409);assert.deepEqual(await grants(user),[])
    Object.assign(env,{BILLING_MODE:'test',WAYFORPAY_MERCHANT_ACCOUNT:'test_local_fixture'})
    env.VERCEL_ENV='production';assert.equal(billing.billingConfiguration().checkoutAvailable,false);assert.equal(billing.billingConfiguration().callbacksAvailable,false)
   }finally{for(const key of Object.keys(env))delete env[key];Object.assign(env,saved)}
  })
  await t.test('real legacy paid and redeemed-gift periods retain precise time and continuous core coverage',async()=>{
   const user=await actor(8)
   const [oldOrder]=await rows("insert into public.billing_orders(user_id,product,order_reference,amount,mode,status,approved_at)values($1,'participant',$2,100,'live','approved',now()-interval'5 days')returning *",[user.id,'xelay_'+id(800)])
   await db.query("insert into public.participant_entitlements(user_id,order_id,source,term_months,valid_from,valid_until)values($1,$2,'payment',1,now()-interval'5 days',(((now()-interval'5 days')at time zone'Europe/Kyiv')+interval'1 month')at time zone'Europe/Kyiv')",[user.id,oldOrder.id])
   // Same persisted output as birthday/appreciation gift redemption.
   await db.query("insert into public.participant_entitlements(user_id,order_id,source,term_months,valid_from,valid_until)select $1,null,'admin_grant',1,max(valid_until),((max(valid_until)at time zone'Europe/Kyiv')+interval'1 month')at time zone'Europe/Kyiv'from public.participant_entitlements where user_id=$1",[user.id])
   const old=await legacy(user),before=await entitlement(user),order=await checkout(user,'max');assert.equal((await event(order)).statusCode,200)
   const after=await entitlement(user),afterRows=await legacy(user);assert.equal(after.studentPlan.planId,'max');assert.equal(after.is_premium,true);assert.deepEqual(afterRows.filter(p=>old.some(o=>o.id===p.id)),old)
   assert.equal(afterRows.length,3);const addition=afterRows.find(p=>!old.some(o=>o.id===p.id));assert.equal(new Date(addition.valid_from).getTime(),new Date(old.at(-1).valid_until).getTime());assert.equal(new Date(after.expires_at).getTime(),new Date(addition.valid_until).getTime());assert.ok(new Date(after.expires_at)>new Date(before.expires_at))
   assert.equal((await event(order,'Refunded')).statusCode,200);assert.deepEqual((await legacy(user)).filter(p=>old.some(o=>o.id===p.id)),old);const refunded=await entitlement(user);assert.equal(refunded.is_premium,true);assert.equal(new Date(refunded.expires_at).getTime(),new Date(before.expires_at).getTime());assert.equal(refunded.studentPlan.monthlyAiBudgetUsd,0)
  })
  await t.test('lifetime award remains byte-for-byte intact through monthly Max, duplicate callback and refund',async()=>{
   const user=await actor(9)
   await db.query('insert into public.participant_lifetime_awards(milestone,recipient_id,granted_at)values(1000,$1,now())',[user.id]);const award=await rows('select * from public.participant_lifetime_awards')
   let state=await entitlement(user);assert.equal(state.is_lifetime,true);assert.equal(state.expires_at,null);assert.equal(state.studentPlan.monthlyAiBudgetUsd,0)
   const order=await checkout(user,'max');assert.equal((await event(order)).statusCode,200);assert.equal((await event(order)).statusCode,200)
   state=await entitlement(user);assert.equal(state.is_lifetime,true);assert.equal(state.expires_at,null);assert.equal(state.studentPlan.planId,'max');assert.equal(state.studentPlan.monthlyAiBudgetUsd,10);assert.ok(state.studentPlan.expiresAt);assert.deepEqual(await rows('select * from public.participant_lifetime_awards'),award)
   assert.equal((await event(order,'Refunded')).statusCode,200);state=await entitlement(user);assert.equal(state.is_lifetime,true);assert.equal(state.is_premium,true);assert.equal(state.expires_at,null);assert.equal(state.studentPlan.monthlyAiBudgetUsd,0);assert.deepEqual(await rows('select * from public.participant_lifetime_awards'),award)
  })
  await t.test('higher upgrade is immediate while remaining lower-tier seconds are preserved',async()=>{
   const user=await actor(10),start=await checkout(user,'start');assert.equal((await event(start)).statusCode,200);const before=await grants(user)
   const plus=await checkout(user,'plus');assert.equal((await event(plus)).statusCode,200);let state=await entitlement(user);assert.equal(state.studentPlan.planId,'plus')
   const max=await checkout(user,'max');assert.equal((await event(max)).statusCode,200);state=await entitlement(user);assert.equal(state.studentPlan.planId,'max');assert.equal(state.studentPlan.monthlyAiBudgetUsd,10)
   const after=await grants(user),startRows=after.filter(p=>p.plan_id==='start'),duration=list=>list.reduce((total,p)=>total+new Date(p.period_until).getTime()-new Date(p.period_from).getTime(),0);assert.ok(Math.abs(duration(startRows)-duration(before))<=3)
   const maxRow=after.find(p=>p.plan_id==='max');assert.ok(new Date(maxRow.period_from).getTime()<=Date.now());assert.ok(startRows.some(p=>new Date(p.period_from)>=new Date(maxRow.period_until)))
  })
  await t.test('renewal/lower tier wait behind active gift without losing gift or paid periods',async()=>{
   const user=await actor(11),now=new Date(),end=new Date(now.getTime()+10*86400000)
   await rpcValue('xelay_student_plan_grant',{p_user_id:user.id,p_plan_id:'max',p_valid_from:now.toISOString(),p_valid_until:end.toISOString(),p_reference:'synthetic-local-max-gift'})
   const gifted=(await grants(user))[0],max=await checkout(user,'max');assert.equal((await event(max)).statusCode,200);const lower=await checkout(user,'plus');assert.equal((await event(lower)).statusCode,200)
   let active=await grants(user);assert.deepEqual(active.find(p=>p.id===gifted.id),gifted);let state=await entitlement(user);assert.equal(state.studentPlan.planId,'max')
   const renewal=active.find(p=>p.plan_id==='max'&&p.source==='payment'),plus=active.find(p=>p.plan_id==='plus');assert.equal(new Date(renewal.period_from).getTime(),new Date(end).getTime());assert.equal(new Date(plus.period_from).getTime(),new Date(renewal.period_until).getTime())
   assert.equal((await event(max,'Refunded')).statusCode,200);active=await grants(user);assert.deepEqual(active.find(p=>p.id===gifted.id),gifted);state=await entitlement(user);assert.equal(state.studentPlan.planId,'max');assert.equal(state.studentPlan.monthlyAiBudgetUsd,10);assert.equal(new Date(active.find(p=>p.plan_id==='plus').period_from).getTime(),new Date(end).getTime())
  })
 }finally{await db.close()}
})
