import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'
const read=file=>readFile(new URL('../../'+file,import.meta.url),'utf8')
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
function moduleFrom(source,imports={}){const module={exports:{}};vm.runInNewContext(compile(source),{module,exports:module.exports,require:name=>{if(!(name in imports))throw Error(name);return imports[name]}});return module.exports}
const tiers=moduleFrom(await read('src/lib/supporterTiers.ts'))
const support=moduleFrom(await read('src/lib/teamSupport.ts'))
const source=await read('api/billing/support.ts')
const plain=value=>JSON.parse(JSON.stringify(value))
class BillingError extends Error{constructor(status,message){super(message);this.status=status}}
function fixture(options={}){
  const calls=[]
  const config={mode:'live',checkoutAvailable:true,minKopiykas:100,maxKopiykas:14999900}
  const user={id:'verified-owner',email:'synthetic@example.test'}
  const service={from(table){calls.push(['table',table]);const query={select(columns){calls.push(['select',columns]);return query},eq(key,value){calls.push(['eq',key,value]);return query},order(key,value){calls.push(['order',key,value]);return query},limit(value){calls.push(['limit',value]);return Promise.resolve(options.history||{data:[{id:'owned-order'}],error:null})}};return query},
    rpc(name,args){calls.push(['rpc',name,plain(args)]);if(name==='xelay_supporter_summary')return options.summaryReject?Promise.reject(Error('offline')):Promise.resolve(options.summary||{data:{tier:3,totalKopiykas:25000},error:null});
      return Promise.resolve({data:{id:'new-owned-order',...args},error:null})}}
  const handler=moduleFrom(source,{
    '../../server/billing.js':{BillingError,authenticateRequest:async(req,optional)=>{calls.push(['auth',optional===true]);if(options.authError)throw new BillingError(401,'expired');return options.guest?null:{user,service}},
      enforceSameOrigin:req=>{calls.push(['origin']);if(req.headers?.origin==='bad')throw new BillingError(403,'origin')},privateResponse:()=>calls.push(['private']),requestBody:req=>req.body,
      sendError:(res,error)=>res.status(error.status||500).json({error:error.message})},
    '../../server/teamSupport.js':{publicSupportConfiguration:()=>({...config,...options.config}),newSupportReference:()=> 'xelay_support_11111111-1111-4111-8111-111111111111',signedSupportCheckout:(order,email)=>{calls.push(['signed',order.p_user_id,email]);return{action:'synthetic-checkout'}}},
    '../../src/lib/teamSupport.js':support,'../../src/lib/supporterTiers.js':tiers,
  }).default
  const res={statusCode:200,headers:{},setHeader(key,value){this.headers[key]=value},status(value){this.statusCode=value;return this},json(value){this.body=plain(value);return this}}
  return {calls,res,request:async(req={method:'GET',headers:{},query:{userId:'attacker-target'}})=>{await handler(req,res);return res}}
}
test('the private support endpoint returns a lifetime summary only for the verified owner',async()=>{
  const fx=fixture();const result=await fx.request()
  assert.equal(result.statusCode,200);assert.deepEqual(result.body.supporter,{tier:3,totalKopiykas:25000})
  assert.deepEqual(fx.calls.find(row=>row[0]==='rpc'),['rpc','xelay_supporter_summary',{p_user_id:'verified-owner'}])
  assert.ok(fx.calls.some(row=>row[0]==='eq'&&row[1]==='user_id'&&row[2]==='verified-owner'))
  assert.ok(fx.calls.some(row=>row[0]==='limit'&&row[1]===20))
  assert.equal(fx.calls.filter(row=>row[0]==='private').length,1)
  assert.ok(!JSON.stringify(fx.calls).includes('attacker-target'))
})
test('guests receive no total, payment history or server-side financial query',async()=>{
  const fx=fixture({guest:true});const result=await fx.request()
  assert.deepEqual(result.body.orders,[]);assert.equal(result.body.supporter,null)
  assert.equal(fx.calls.some(row=>['table','rpc'].includes(row[0])),false)
})
test('expired sessions fail rather than return another owner’s financial data',async()=>{
  const fx=fixture({authError:true});const result=await fx.request();assert.equal(result.statusCode,401)
  assert.equal(fx.calls.some(row=>['table','rpc'].includes(row[0])),false)
})
test('optional unavailable or malformed badge summaries never invent a balance or interrupt order history',async()=>{
  for(const options of [{summary:{data:null,error:{code:'PGRST202'}}},{summaryReject:true},
    {summary:{data:{tier:5,totalKopiykas:100},error:null}},{summary:{data:{tier:2,totalKopiykas:'10000'},error:null}}]){
    const result=await fixture(options).request();assert.equal(result.statusCode,200);assert.equal(result.body.supporter,null);assert.deepEqual(result.body.orders,[{id:'owned-order'}])
  }
})
test('valid private summaries strip unexpected fields before reaching the browser',async()=>{
  const result=await fixture({summary:{data:{tier:1,totalKopiykas:100,otherAccount:'never publish',order_reference:'private-extra'},error:null}}).request()
  assert.deepEqual(result.body.supporter,{tier:1,totalKopiykas:100})
})
test('history failure does not leak a separately retrieved lifetime summary',async()=>{
  const result=await fixture({history:{data:null,error:{code:'42501'}}}).request()
  assert.equal(result.statusCode,503);assert.equal(result.body.supporter,undefined)
})
const body={amountKopiykas:10000,recurring:false,acceptedTerms:true,termsVersion:support.SUPPORT_TERMS_VERSION}
test('checkout still uses the verified owner and amount; a client-provided badge/total/user cannot grant a tier',async()=>{
  const fx=fixture();const result=await fx.request({method:'POST',headers:{},body:{...body,userId:'other',tier:5,totalKopiykas:1000000}})
  assert.equal(result.statusCode,200)
  const call=fx.calls.find(row=>row[0]==='rpc');assert.equal(call[1],'xelay_create_support_order')
  assert.equal(call[2].p_user_id,'verified-owner');assert.equal(call[2].p_amount_kopiykas,10000)
  assert.equal(call[2].p_terms_version,'2026-10-16.support.2');assert.equal(call[2].tier,undefined)
  assert.equal(fx.calls.some(row=>row[0]==='rpc'&&row[1]==='xelay_supporter_summary'),false)
})
test('payment amount, consent, nonrecurring rule and same-origin controls remain enforced',async()=>{
  for(const change of [{amountKopiykas:99},{amountKopiykas:15000000},{amountKopiykas:100.1},{amountKopiykas:'10000'},
    {acceptedTerms:false},{termsVersion:'old-support-version'},{recurring:true}]){
    const fx=fixture();const result=await fx.request({method:'POST',headers:{},body:{...body,...change}})
    assert.equal(result.statusCode,400);assert.equal(fx.calls.some(row=>row[0]==='rpc'),false)
  }
  const fx=fixture();assert.equal((await fx.request({method:'POST',headers:{origin:'bad'},body})).statusCode,403)
  assert.equal(fx.calls.some(row=>row[0]==='rpc'),false)
})
test('disabled checkout and unsupported methods cannot create or modify payments',async()=>{
  const disabled=fixture({config:{checkoutAvailable:false}});assert.equal((await disabled.request({method:'POST',headers:{},body})).statusCode,503)
  assert.equal(disabled.calls.some(row=>row[0]==='rpc'),false)
  const fx=fixture();assert.equal((await fx.request({method:'DELETE',headers:{}})).statusCode,405);assert.equal(fx.res.headers.Allow,'GET, POST')
})
