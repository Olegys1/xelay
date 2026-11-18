import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const native=createRequire(import.meta.url),source=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8'),compile=text=>ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,plain=v=>JSON.parse(JSON.stringify(v))
function load(file,imports={},globals={}){const module={exports:{}};vm.runInNewContext(compile(source(file)),{module,exports:module.exports,Buffer,URL,Date,Number,Math,JSON,process:{env:{}},...globals,require(name){if(Object.hasOwn(imports,name))return imports[name];if(name.startsWith('node:'))return native(name);throw Error('Unexpected module '+name)}});return module.exports}
const plans=load('server/student-learning/studentPlanPrices.ts'),OWNER='11111111-1111-4111-8111-111111111111',REFERENCE='xelay_22222222-2222-4222-8222-222222222222'
const paymentEnv={BILLING_MODE:'live',XELAY_PUBLIC_URL:'https://www.xelay.ink',WAYFORPAY_MERCHANT_ACCOUNT:'synthetic_merchant',WAYFORPAY_SECRET_KEY:'synthetic-signing-secret',WAYFORPAY_MERCHANT_DOMAIN:'www.xelay.ink',SUPABASE_URL:'https://baohfpadxvhqhhjjqtil.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-server-key',BILLING_CHECKOUT_ENABLED:'true',WAYFORPAY_LIVE_APPROVED:'true'}
const merchant={ready:true},support={SUPPORT_ORDER_REFERENCE:/^xelay_support_/}
function signer(env={}){const variables={...paymentEnv,...env},helpers=load('server/student-learning/studentPlanPrices.ts',{}, {process:{env:variables}});return load('server/billing.ts',{'@supabase/supabase-js':{createClient(){throw Error('No live database')}} ,'../src/lib/legal.js':{legalMerchant:merchant},'../src/lib/teamSupport.js':support,'./student-learning/studentPlanPrices.js':helpers,'./teacher-learning/teacherPlanPrices.js':load('server/teacher-learning/teacherPlanPrices.ts'), './student-learning/aiCreditPrices.js':load('server/student-learning/aiCreditPrices.ts')},{process:{env:variables}})}
const baseOrder={id:'owned-order',user_id:OWNER,product:'participant',student_plan_id:null,mode:'live',amount:100,currency:'UAH',group_id:null,status:'pending',order_reference:REFERENCE,created_at:'2026-11-16T12:00:00Z'}

test('prices are exact server values, and unknown/prototype/client values never become a tariff',()=>{
 assert.deepEqual(plain(plans.STUDENT_PLAN_PRICES),{start:149,plus:399,max:999})
 for(const [plan,amount] of Object.entries({start:149,plus:399,max:999})){assert.equal(plans.paidStudentPlan(plan),true);assert.equal(plans.studentOrderPrice({student_plan_id:plan,amount}),amount);for(const wrong of [0,100,amount-1,amount+1,-1,'invalid'])assert.equal(plans.studentOrderPrice({student_plan_id:plan,amount:wrong}),null)}
 for(const plan of [null,undefined,'constructor','__proto__','premium','MAX',{},['max']])assert.equal(plans.paidStudentPlan(plan),false)
})
test('legacy pending100 orders remain valid without inventing a new plan or changing their amount',()=>{
 const billing=signer({STUDENT_PLANS_ENABLED:'false'});for(const student_plan_id of [null,undefined]){const checkout=billing.signedCheckout({...baseOrder,student_plan_id},{id:OWNER},{kind:'legacy'});assert.equal(checkout.fields.amount,100);assert.equal(checkout.fields.productPrice[0],100);assert.match(checkout.fields.productName[0],/Учасник/);assert.equal(checkout.fields.regularMode,'none')}
 for(const amount of [149,399,999,0])assert.equal(plans.studentOrderPrice({student_plan_id:null,amount}),null)
})
test('each signed student checkout binds its exact amount, currency and product to the merchant signature',()=>{
 const billing=signer({STUDENT_PLANS_ENABLED:'true'}),signatures=[]
 for(const [student_plan_id,amount]of Object.entries({start:149,plus:399,max:999})){const checkout=billing.signedCheckout({...baseOrder,student_plan_id,amount},{id:OWNER},{kind:'student',planId:student_plan_id}),f=checkout.fields;assert.equal(checkout.action,'https://secure.wayforpay.com/pay');assert.equal(f.amount,amount);assert.equal(f.currency,'UAH');assert.deepEqual(plain(f.productPrice),[amount]);assert.match(f.productName[0],new RegExp(plans.STUDENT_PLAN_NAMES[student_plan_id]));assert.equal(f.merchantSignature,billing.signature([paymentEnv.WAYFORPAY_MERCHANT_ACCOUNT,paymentEnv.WAYFORPAY_MERCHANT_DOMAIN,REFERENCE,f.orderDate,amount,'UAH',f.productName[0],1,amount],paymentEnv.WAYFORPAY_SECRET_KEY));signatures.push(f.merchantSignature)}
 assert.equal(new Set(signatures).size,3)
})
test('tampered database orders cannot obtain a payable signed form',()=>{
 const billing=signer();for(const change of [{student_plan_id:'max',amount:149},{student_plan_id:'plus',amount:999},{student_plan_id:'constructor',amount:100},{student_plan_id:'max',amount:999,currency:'USD'},{student_plan_id:'max',amount:999,group_id:OWNER},{student_plan_id:'max',amount:999,mode:'test'},{order_reference:'javascript:alert(1)'},{created_at:'invalid'}])assert.throws(()=>billing.signedCheckout({...baseOrder,...change},{id:OWNER},change.student_plan_id?{kind:'student',planId:change.student_plan_id}:{kind:'legacy'}),e=>e instanceof billing.BillingError)
})
test('new catalogue flag is literaltrue; disabling new sales keeps existing callback configuration intact',()=>{
 for(const value of [undefined,'false','1','TRUE','true '])assert.equal(plans.studentPlansEnabled({STUDENT_PLANS_ENABLED:value}),false)
 assert.equal(plans.studentPlansEnabled({STUDENT_PLANS_ENABLED:'true'}),true)
 assert.equal(signer({STUDENT_PLANS_ENABLED:'false'}).publicBillingConfiguration().studentPlansAvailable,undefined)
 assert.deepEqual(plain(signer({STUDENT_PLANS_ENABLED:'true'}).publicBillingConfiguration().studentPlanPrices),{start:149,plus:399,max:999})
 assert.equal(signer({BILLING_CHECKOUT_ENABLED:'false'}).billingConfiguration().callbacksAvailable,true)
})

function checkoutFixture(options={}){
 const env={STUDENT_PLANS_ENABLED:options.enabled===false?'false':'true'},calls=[]
 const helpers=load('server/student-learning/studentPlanPrices.ts',{}, {process:{env}}),billing=signer(),order={...baseOrder,student_plan_id:options.orderPlan??'max',amount:options.orderAmount??999}
 const service={async rpc(name,args){calls.push({name,args:plain(args)});return {data:options.order||order,error:null}},from(table){calls.push({table});const query={update(){return query},eq(){return query},select(){return query},async single(){return {data:{id:order.id},error:null}}};return query}}
 const imports={'../../server/billing.js':{...billing,privateResponse(){},authenticateRequest:async()=>({user:{id:OWNER,email:'synthetic@example.test'},userClient:{rpc:async()=>({data:{audience:options.audience||'student'},error:null})},service}),requestBody:req=>req.body,enforceSameOrigin:req=>{if(req.headers?.origin!=='https://www.xelay.ink')throw new billing.BillingError(403,'origin')},newOrderReference:()=>REFERENCE,sendError:(res,e)=>res.status(e.status||500).json({error:e.message})},'../../src/lib/legal.js':{LEGAL_TERMS_VERSION:'test-terms-version',legalMerchant:merchant},'../../server/teacher-learning/teacherPlanPrices.js':load('server/teacher-learning/teacherPlanPrices.ts'), '../../server/student-learning/studentPlanPrices.js':helpers}
 const handler=load('api/billing/checkout.ts',imports).default
 async function call(body,headers={origin:'https://www.xelay.ink'}){const res={statusCode:200,headers:{},setHeader(k,v){this.headers[k]=v},status(s){this.statusCode=s;return this},json(value){this.body=plain(value);return this}};await handler({method:'POST',headers,body},res);return res}
 return {calls,call}
}
const purchase={product:'participant',studentPlanId:'max',recurring:false,acceptedTerms:true,termsVersion:'test-terms-version'}

test('checkout uses verified identity, chosen allowlisted plan and database price; browser amount/audience cannot sign a cheaper order',async()=>{
 const f=checkoutFixture(),r=await f.call({...purchase,userId:'attacker',audience:'student',amount:1,price:1,studentMaxAiBudgetUsd:6000});assert.equal(r.statusCode,200);assert.equal(r.body.checkout.fields.amount,999);const rpc=f.calls.find(c=>c.name);assert.equal(rpc.name,'xelay_create_student_plan_order');assert.equal(rpc.args.p_user_id,OWNER);assert.equal(rpc.args.p_plan_id,'max');assert.equal(rpc.args.amount,undefined);assert.equal(rpc.args.audience,undefined)
})
test('invalid plans, recurring payments and missing legal/origin checks never create student orders',async()=>{
 for(const change of [{studentPlanId:undefined},{studentPlanId:'constructor'},{studentPlanId:'premium'},{recurring:true},{acceptedTerms:false},{termsVersion:'old'},{groupId:OWNER}]){const f=checkoutFixture(),r=await f.call({...purchase,...change});assert.equal(r.statusCode,400);assert.equal(f.calls.some(c=>c.name),false)}
 const f=checkoutFixture();assert.equal((await f.call(purchase,{origin:'https://evil.example'})).statusCode,403);assert.equal(f.calls.some(c=>c.name),false)
})
test('legacy mode can create only the old100 order and cannot silently issue a new student tariff',async()=>{
 const f=checkoutFixture({enabled:false,orderPlan:null,orderAmount:100,order:{...baseOrder}}),r=await f.call({product:'participant',recurring:false,acceptedTerms:true,termsVersion:'test-terms-version'});assert.equal(r.statusCode,200);assert.equal(r.body.checkout.fields.amount,100);assert.equal(f.calls.find(c=>c.name).name,'xelay_create_billing_order')
 const blocked=checkoutFixture({enabled:false});assert.equal((await blocked.call(purchase)).statusCode,503);assert.equal(blocked.calls.some(c=>c.name),false)
})

test('only an authoritative teacher audience can renew the legacy100 plan after new tiers launch',async()=>{
 const teacher=checkoutFixture({audience:'teacher',order:{...baseOrder}}),body={product:'participant',recurring:false,acceptedTerms:true,termsVersion:'test-terms-version'};const result=await teacher.call(body);assert.equal(result.statusCode,200);assert.equal(result.body.checkout.fields.amount,100);assert.equal(teacher.calls.find(c=>c.name).name,'xelay_create_billing_order');
 for(const audience of ['student','unresolved']){const f=checkoutFixture({audience}),r=await f.call({...body,audience:'teacher',isTeacher:true});assert.equal(r.statusCode,400);assert.equal(f.calls.some(c=>c.name),false)}
})
