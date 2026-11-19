import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFile} from 'node:fs/promises'
import ts from 'typescript'
const source=await readFile(new URL('../server/adminPurchaseAlerts.ts',import.meta.url),'utf8')
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const token='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222'
const purchase={lease_token:token,order_id:id,plan_id:'max',amount:999,currency:'UAH',approved_at:'2026-11-19T08:30:00Z',username:'synthetic_buyer'}
function fixture(options={}) {
 const calls=[],sent=[];const exports={}
 const service={rpc:async(name,args)=>{calls.push({name,args});if(name==='xelay_claim_admin_purchase_alert')return{data:Object.hasOwn(options,'claim')?options.claim:purchase,error:null}
  if(name==='xelay_admin_purchase_alert_delivery_context')return{data:Object.hasOwn(options,'live')?options.live:purchase,error:null}
  if(name==='xelay_finish_admin_purchase_alert')return{data:!options.receiptFailure,error:null};throw Error('unexpected RPC')}}
 vm.runInNewContext(compiled,{exports,require:name=>{assert.equal(name,'@supabase/supabase-js');return{createClient:()=>service}},Date,Intl,AbortSignal,Uint8Array,TextDecoder,
  process:{env:{ADMIN_ALERT_TELEGRAM_ENABLED:'true',ADMIN_ALERT_TELEGRAM_BOT_TOKEN:'123456:'+ 'S'.repeat(35),ADMIN_ALERT_TELEGRAM_CHAT_ID:'-123456',SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-key',...options.env}},
  fetch:async(url,init)=>{sent.push({method:url.split('/').at(-1),body:JSON.parse(init.body)});assert.equal(init.redirect,'error');if(options.throw)throw Error('PRIVATE_TOKEN')
   const chat=url.endsWith('/getChat');const body=chat?{ok:true,result:options.chat??{id:-123456,type:'supergroup'}}:{ok:true,result:{message_id:1,chat:{id:-123456}}}
   return new Response(JSON.stringify(options.response??body),{status:options.status??200})}})
 return{calls,sent,module:exports,run:()=>exports.deliverAdminPurchaseAlert(Date.now()+53000)}
}
test('successful message uses a fixed catalogue, actual charged amount and Kyiv time without private data',async()=>{
 const fx=fixture({live:{...purchase,amount:799.20,email:'PRIVATE_EMAIL',card:'PRIVATE_CARD',raw:'PRIVATE_ERROR'}})
 assert.equal((await fx.run()).state,'sent')
 const m=fx.sent.at(-1).body
 assert.match(m.text,/Студентський Макс/);assert.match(m.text,/799.20/);assert.match(m.text,/10:30/)
 assert.doesNotMatch(m.text,/PRIVATE/);assert.equal(m.parse_mode,undefined);assert.equal(m.protect_content,true)
 assert.equal(fx.calls.at(-1).args.p_status,'sent')
 for(const plan_id of ['start','plus','max','teacher_start','teacher_plus','teacher_max','participant','group']) assert.ok(fx.module.formatAdminPurchaseAlert({...purchase,plan_id}))
})
test('no sending before privacy, live order, context and deadline checks',async()=>{
 for(const chat of [{id:-123456,type:'channel'},{id:7,type:'supergroup'},{id:-123456,type:'supergroup',username:'public'},{id:-123456,type:'supergroup',active_usernames:'malformed'},{id:-123456,type:'supergroup',active_usernames:['public']}]){
  const fx=fixture({chat});assert.equal((await fx.run()).state,'retry');assert.equal(fx.sent.length,1)
 }
 for(const live of [null,{...purchase,lease_token:id},{...purchase,order_id:token},{...purchase,plan_id:'arbitrary'},{...purchase,username:'malicious\ntext'},{...purchase,amount:NaN}]){
  const fx=fixture({live});assert.ok(['skipped','retry'].includes((await fx.run()).state));assert.equal(fx.sent.length,1)
 }
 const disabled=fixture({env:{ADMIN_ALERT_TELEGRAM_ENABLED:'false'}});assert.equal((await disabled.run()).state,'disabled');assert.equal(disabled.calls.length,0)
 const deadline=fixture();assert.equal((await deadline.module.deliverAdminPurchaseAlert(Date.now()+100)).state,'deadline');assert.equal(deadline.calls.length,0)
})
test('rate limits, lost receipts and network failures remain retryable and never expose a token',async()=>{
 const limited=fixture({status:429,response:{ok:false,error_code:429,parameters:{retry_after:999999},description:'PRIVATE_TOKEN'}})
 assert.equal((await limited.run()).state,'retry');assert.equal(limited.calls.at(-1).args.p_retry_after_seconds,86400)
 const lost=fixture({receiptFailure:true});assert.equal((await lost.run()).state,'receipt_unavailable')
 const failed=fixture({throw:true});assert.equal((await failed.run()).state,'retry');assert.doesNotMatch(JSON.stringify(failed.calls),/PRIVATE/)
})
