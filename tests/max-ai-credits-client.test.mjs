import test from'node:test'
import assert from'node:assert/strict'
import{readFileSync}from'node:fs'
import path from'node:path'
import{fileURLToPath}from'node:url'
import vm from'node:vm'
import ts from'typescript'
const root=fileURLToPath(new URL('../',import.meta.url)),cache=new Map()
function load(file){const absolute=path.resolve(root,file);if(cache.has(absolute))return cache.get(absolute).exports;const module={exports:{}};cache.set(absolute,module);vm.runInNewContext(ts.transpileModule(readFileSync(absolute,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,TextEncoder,TextDecoder,Uint8Array,JSON,Date,Number,Set,Map,Promise,fetch,require(name){name=name.replace(/\.(?:js|ts)$/,'');if(!name.startsWith('.'))throw Error('Unexpected '+name);return load(path.resolve(path.dirname(absolute),name)+'.ts')}});return module.exports}
const helpers=load('src/lib/maxTutorCredits.ts'),client=load('src/lib/maxTutorProductionClient.ts'),plain=x=>JSON.parse(JSON.stringify(x)),reference='xtop_76000000-0000-4000-8000-000000000004'
const status=()=>({checkoutAvailable:true,mode:'live',eligible:true,packages:[{id:'credits_1000',credits:1000,priceUah:99},{id:'credits_3000',credits:3000,priceUah:249},{id:'credits_10000',credits:10000,priceUah:749}],wallet:{balanceCredits:123.456,reservedCredits:10,debtCredits:0},orders:[]})
const checkout=()=>({mode:'live',orderReference:reference,checkout:{action:'https://secure.wayforpay.com/pay',fields:{orderReference:reference,currency:'UAH',amount:99,regularMode:'none'}}})
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}})
test('credit contracts reject unsafe checkout destinations, balances and unknown catalogue entries',()=>{
 assert.equal(helpers.parseAiCreditStatus(status()).wallet.balanceCredits,123.456)
 for(const v of[{...status(),apiKey:'forbidden'},{...status(),wallet:{balanceCredits:-1,reservedCredits:0,debtCredits:0}},{...status(),wallet:null},{...status(),packages:[...status().packages,status().packages[0]]},{...status(),packages:status().packages.map((p,i)=>i? p:{...p,id:'__proto__'})}])assert.throws(()=>helpers.parseAiCreditStatus(v))
 assert.equal(helpers.parseAiCreditCheckout(checkout()).orderReference,reference)
 for(const v of[{...checkout(),orderReference:'xelay_76000000-0000-4000-8000-000000000004'},{...checkout(),checkout:{...checkout().checkout,action:'https://attacker.invalid/pay'}},{...checkout(),checkout:{...checkout().checkout,fields:{...checkout().checkout.fields,regularMode:'monthly'}}}])assert.throws(()=>helpers.parseAiCreditCheckout(v))
})
test('credit client uses fixed authenticated routes and dedicated terms without caller-supplied prices',async()=>{
 const calls=[],credential={userId:'owner-1',sessionId:'session-1',accessToken:'synthetic-token'}
 const api=client.createMaxTutorProductionClient({ownerId:'owner-1',credential:async()=>credential,fetcher:async(url,options)=>{calls.push({url,options});return json(options.method==='GET'?status():url.endsWith('reconcile')?{checked:true,retryAfter:60}:checkout())}})
 await api.credits.status();await api.credits.checkout('credits_1000');await api.credits.reconcile(reference)
 assert.deepEqual(calls.map(c=>c.url),['/api/billing/credits','/api/billing/credits','/api/billing/reconcile'])
 assert.deepEqual(JSON.parse(calls[1].options.body),{packageId:'credits_1000',acceptedTerms:true,termsVersion:'2026-11-17.1',recurring:false})
 for(const {options}of calls){assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.headers.Authorization,'Bearer synthetic-token')}
 const before=calls.length;await assert.rejects(api.credits.checkout('credits_1000000'));await assert.rejects(api.credits.reconcile('other-reference'));assert.equal(calls.length,before)
})
test('credit response cannot cross an owner or login-session boundary',async()=>{
 for(const changed of[{userId:'owner-2',sessionId:'session-1',accessToken:'synthetic-token'},{userId:'owner-1',sessionId:'session-2',accessToken:'synthetic-token'},null]){
  let credential={userId:'owner-1',sessionId:'session-1',accessToken:'synthetic-token'}
  const api=client.createMaxTutorProductionClient({ownerId:'owner-1',credential:async()=>credential,fetcher:async()=>{credential=changed;return json(status())}})
  await assert.rejects(api.credits.status(),e=>e.code==='identity_changed')
 }
})
test('purchased wallet is optional on rolling status and never changes the strict ten-unit base cap',()=>{
 const base={status:'ready',scope:{userId:'owner-1',sessionId:'session-1'},audience:'student',planId:'max',canGenerate:true,canEdit:true,available:true,model:'gpt-6.1-sol',budget:{limitUsd:10,spentUsd:10,reservedUsd:0,remainingUsd:0},localOnly:false,budgetPeriod:'subscription_month',budgetResetsAt:'2026-12-01T00:00:00Z'}
 assert.equal(client.parseProductionMaxStatus(base,'owner-1').purchasedCredits,undefined)
 assert.deepEqual(plain(client.parseProductionMaxStatus({...base,purchasedCredits:status().wallet},'owner-1').purchasedCredits),status().wallet)
 assert.throws(()=>client.parseProductionMaxStatus({...base,budget:{...base.budget,limitUsd:11}},'owner-1'))
 assert.throws(()=>client.parseProductionMaxStatus({...base,purchasedCredits:{...status().wallet,email:'forbidden'}},'owner-1'))
})
