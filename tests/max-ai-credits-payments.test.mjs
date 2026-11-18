import test from'node:test'
import assert from'node:assert/strict'
import{readFileSync}from'node:fs'
import{createRequire}from'node:module'
import vm from'node:vm'
import ts from'typescript'
import{PGlite}from'@electric-sql/pglite'
const native=createRequire(import.meta.url),source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8')
function load(file,imports={},globals={}){const module={exports:{}};vm.runInNewContext(ts.transpileModule(source(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Buffer,URL,Date,Number,Math,JSON,AbortController,Response,setTimeout,clearTimeout,fetch(){throw Error('External network forbidden')},...globals,require(name){if(Object.hasOwn(imports,name))return imports[name];if(name.startsWith('node:'))return native(name);throw Error('Unexpected '+name)}});return module.exports}
const owner='77000000-0000-4000-8000-000000000001',other='77000000-0000-4000-8000-000000000002',session='77000000-0000-4000-8000-000000000101'
const env={BILLING_MODE:'live',VERCEL_ENV:'development',STUDENT_PLANS_ENABLED:'true',XELAY_PUBLIC_URL:'https://credit-payment-fixture.invalid',WAYFORPAY_MERCHANT_ACCOUNT:'synthetic_credit_merchant',WAYFORPAY_SECRET_KEY:'synthetic-credit-signing-key',WAYFORPAY_MERCHANT_DOMAIN:'credit-payment-fixture.invalid',SUPABASE_URL:'https://credit-db.invalid',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-role',BILLING_CHECKOUT_ENABLED:'true',WAYFORPAY_LIVE_APPROVED:'true'}
test('real credit checkout → signed provider callback → SQL wallet → owner reconciliation, without real payments',{timeout:120000},async t=>{
 const db=new PGlite(),rows=async(s,a=[])=>(await db.query(s,a)).rows
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.jwt()returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb$$;
 create function auth.uid()returns uuid language sql stable as $$select(auth.jwt()->>'sub')::uuid$$;
 grant usage on schema public,auth to anon,authenticated,service_role;grant execute on function auth.uid(),auth.jwt()to anon,authenticated,service_role;
 create table auth.users(id uuid primary key,email_confirmed_at timestamptz,deleted_at timestamptz,banned_until timestamptz);
 create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz);create table public.profiles(id uuid primary key,account_type text default'student');
 create function public.xelay_has_participant_access(uuid)returns boolean language sql stable security definer as $$select false$$;
 insert into auth.users(id,email_confirmed_at)values('${owner}',now()),('${other}',now());insert into profiles(id)select id from auth.users;insert into auth.sessions(id,user_id)values('${session}','${owner}');`)
 for(const name of['202611160100_student_max_workspace.sql','20261116155610_student_max_paid_period.sql','20261117105257_student_max_ai_credits.sql'])await db.exec(source('supabase/migrations/'+name))
 const args={xelay_student_audience_assign:['p_user_id','p_audience','p_reason'],xelay_student_plan_grant:['p_user_id','p_plan_id','p_valid_from','p_valid_until','p_reference'],xelay_max_credit_status:['p_user_id'],xelay_create_max_credit_order:['p_user_id','p_mode','p_order_reference','p_package_id','p_terms_version'],xelay_apply_max_credit_event:['p_reference','p_mode','p_fingerprint','p_status','p_amount','p_currency'],xelay_max_credit_order_owned:['p_user_id','p_reference','p_mode'],xelay_claim_max_credit_reconciliation:['p_user_id','p_reference','p_mode']}
 const calls=[]
 async function rpc(name,values={}){calls.push({name,values});assert.ok(args[name],'Unexpected RPC '+name);await db.exec('set role service_role');await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({role:'service_role'})]);try{return{data:(await rows(`select public.${name}(${args[name].map((_,i)=>'$'+(i+1)).join(',')})v`,args[name].map(k=>values[k]??null)))[0].v,error:null}}catch(error){return{data:null,error}}finally{await db.exec('reset role')}}
 await rpc('xelay_student_audience_assign',{p_user_id:owner,p_audience:'student',p_reason:'Synthetic credit payment'})
 await rpc('xelay_student_plan_grant',{p_user_id:owner,p_plan_id:'max',p_valid_from:new Date(Date.now()-86400000).toISOString(),p_valid_until:new Date(Date.now()+29*86400000).toISOString(),p_reference:'synthetic-credit-payment-grant'})
 let user=owner,providerResponse=null,providerChecks=0
 const adapter={createClient(){return{auth:{async getUser(token){return token==='synthetic-token'?{data:{user:{id:user,email:'synthetic@example.test'}},error:null}:{data:{user:null},error:{message:'Invalid synthetic token'}}}},rpc,from(){throw Error('Credit flow must not change legacy billing tables')}}}}
 const packages=load('server/student-learning/aiCreditPrices.ts'),plans=load('server/student-learning/studentPlanPrices.ts',{}, {process:{env}}),legal={AI_CREDIT_TERMS_VERSION:'2026-11-17.1',legalMerchant:{ready:true}},support={SUPPORT_ORDER_REFERENCE:/^xelay_support_/}
 const billing=load('server/billing.ts',{'@supabase/supabase-js':adapter,'../src/lib/legal.js':legal,'../src/lib/teamSupport.js':support,'./student-learning/studentPlanPrices.js':plans,'./teacher-learning/teacherPlanPrices.js':load('server/teacher-learning/teacherPlanPrices.ts',{}, {process:{env}}), './student-learning/aiCreditPrices.js':packages},{process:{env},fetch:async(url,options)=>{assert.equal(url,'https://api.wayforpay.com/api');assert.equal(JSON.parse(options.body).transactionType,'CHECK_STATUS');providerChecks++;return new Response(JSON.stringify(providerResponse),{headers:{'content-type':'application/json'}})}})
 const shared={'../../server/billing.js':billing,'../../server/student-learning/aiCreditPrices.js':packages,'../../server/teacher-learning/teacherPlanPrices.js':load('server/teacher-learning/teacherPlanPrices.ts',{}, {process:{env}}), '../../server/student-learning/studentPlanPrices.js':plans,'../../src/lib/legal.js':legal,'../../src/lib/aiCreditTerms.js':{AI_CREDIT_TERMS_VERSION:'2026-11-17.1'},'../../src/lib/teamSupport.js':support}
 const handlers={credits:load('api/billing/credits.ts',shared).default,webhook:load('api/billing/webhook.ts',shared).default,reconcile:load('api/billing/reconcile.ts',shared).default,return:load('api/billing/return.ts',shared).default}
 async function call(which,{method='POST',body={},query={},auth=true,origin=env.XELAY_PUBLIC_URL}={}){const req={method,body,query,headers:{...(auth?{authorization:'Bearer synthetic-token'}:{}),origin}},res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v},status(n){this.statusCode=n;return this},json(value){this.body=value;return this},end(){}};await handlers[which](req,res);return res}
 function payload(order,status='Approved',changes={}){const p={merchantAccount:env.WAYFORPAY_MERCHANT_ACCOUNT,orderReference:order.orderReference,amount:order.checkout.fields.amount,currency:'UAH',authCode:'LOCALONLY',cardPan:'411111******1111',transactionStatus:status,reasonCode:status==='Approved'?1100:1101,...changes};p.merchantSignature=billing.signature(['merchantAccount','orderReference','amount','currency','authCode','cardPan','transactionStatus','reasonCode'].map(k=>p[k]),env.WAYFORPAY_SECRET_KEY);return p}
 const consent={packageId:'credits_1000',acceptedTerms:true,termsVersion:'2026-11-17.1',recurring:false}
 let order
 try{
  await t.test('checkout requires owner, current consent, known server package and same origin',async()=>{
   assert.equal((await call('credits',{body:consent,auth:false})).statusCode,401)
   assert.equal((await call('credits',{body:consent,origin:'https://attacker.invalid'})).statusCode,403)
   for(const body of[{...consent,termsVersion:'old-terms'},{...consent,acceptedTerms:false},{...consent,amount:1},{...consent,creditMicros:999999999},{...consent,packageId:'constructor'}])assert.equal((await call('credits',{body})).statusCode,400)
   const response=await call('credits',{body:consent});assert.equal(response.statusCode,200);order=response.body
   assert.equal(order.checkout.fields.amount,99);assert.equal(order.checkout.fields.regularMode,'none');assert.equal(order.checkout.action,'https://secure.wayforpay.com/pay')
   const f=order.checkout.fields;assert.equal(f.merchantSignature,billing.signature([env.WAYFORPAY_MERCHANT_ACCOUNT,env.WAYFORPAY_MERCHANT_DOMAIN,order.orderReference,f.orderDate,99,'UAH',f.productName[0],1,99],env.WAYFORPAY_SECRET_KEY))
   assert.equal((await call('credits',{method:'GET'})).body.wallet.balanceCredits,0)
  })
  await t.test('browser return never approves a payment; only verified exact-amount callbacks credit once',async()=>{
   const returned=await call('return',{query:{orderReference:order.orderReference},body:payload(order)});assert.equal(returned.statusCode,303);assert.match(returned.headers.Location,/^\/learning\?payment=returned&orderReference=xtop_/)
   assert.equal((await call('credits',{method:'GET'})).body.wallet.balanceCredits,0)
   const tampered=payload(order);tampered.amount=1;assert.equal((await call('webhook',{body:tampered,auth:false})).statusCode,403)
   assert.equal((await call('webhook',{body:payload(order,'Approved',{amount:1}),auth:false})).statusCode,409)
   const paid=payload(order);assert.equal((await call('webhook',{body:paid,auth:false})).statusCode,200);assert.equal((await call('webhook',{body:paid,auth:false})).statusCode,200)
   const state=(await call('credits',{method:'GET'})).body;assert.equal(state.wallet.balanceCredits,1000);assert.equal(state.orders[0].status,'approved');assert.equal(state.eligible,true)
   assert.equal(calls.filter(c=>c.name==='xelay_apply_billing_event').length,0)
  })
  await t.test('only the owner can reconcile and cooldown blocks repeated provider requests',async()=>{
   user=other;assert.equal((await call('reconcile',{body:{orderReference:order.orderReference}})).statusCode,404);assert.equal(providerChecks,0)
   user=owner;providerResponse=payload(order);assert.equal((await call('reconcile',{body:{orderReference:order.orderReference}})).body.checked,true);assert.equal(providerChecks,1)
   assert.equal((await call('reconcile',{body:{orderReference:order.orderReference}})).body.checked,false);assert.equal(providerChecks,1)
   assert.equal((await call('credits',{method:'GET'})).body.wallet.balanceCredits,1000)
  })
  await t.test('signed refund removes the wallet grant and later approval cannot restore it',async()=>{
   assert.equal((await call('webhook',{body:payload(order,'Refunded'),auth:false})).statusCode,200)
   assert.equal((await call('webhook',{body:payload(order),auth:false})).statusCode,200)
   const state=(await call('credits',{method:'GET'})).body;assert.equal(state.wallet.balanceCredits,0);assert.equal(state.orders[0].status,'refunded')
  })
 }finally{await db.close()}
})
