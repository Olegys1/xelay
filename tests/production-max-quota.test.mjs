import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {runInNewContext} from 'node:vm'
import ts from 'typescript'

const source=readFileSync(new URL('../src/components/student/ProductionMaxQuota.tsx',import.meta.url),'utf8')
const reference='xtop_11111111-1111-4111-8111-111111111111'
const packages=[{id:'credits_1000',credits:1000,priceUah:99},{id:'credits_3000',credits:3000,priceUah:249},{id:'credits_10000',credits:10000,priceUah:749}]
const scope={userId:'owner',sessionId:'session'}
const status=(wallet={balanceCredits:20,reservedCredits:2,debtCredits:0})=>({scope,audience:'student',planId:'max',canGenerate:true,budget:{limitUsd:10,remainingUsd:3,spentUsd:7,reservedUsd:0},budgetResetsAt:'2026-12-17T12:00:00Z',purchasedCredits:wallet})
const config=(extra={})=>({checkoutAvailable:true,mode:'live',eligible:true,packages,wallet:{balanceCredits:20,reservedCredits:2,debtCredits:0},orders:[],...extra})
const deferred=()=>{let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail});return{promise,resolve,reject}}
function harness({search='',confirm=true,configuration=config(),initialStatus=status(),methods={}}={}){
 let cursor=0,dirty=false,quota;const cells=[],effects=[],calls={status:[],checkout:[],reconcile:[],modelStatus:[],hosted:[],confirm:0,onStatus:[]}
 const same=(a,b)=>a&&b&&a.length===b.length&&a.every((item,index)=>Object.is(item,b[index]))
 const hooks={useState(initial){const at=cursor++;cells[at]??={value:typeof initial==='function'?initial():initial};return[cells[at].value,next=>{const value=typeof next==='function'?next(cells[at].value):next;if(!Object.is(cells[at].value,value)){cells[at].value=value;dirty=true}}]},useRef(initial){return cells[cursor++]??={current:initial}},useEffect(fn,deps){const at=cursor++,old=cells[at];if(!old||!same(old.deps,deps)){cells[at]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();cells[at].cleanup=fn()})}},useMemo(fn,deps){const at=cursor++;if(!cells[at]||!same(cells[at].deps,deps))cells[at]={deps,value:fn()};return cells[at].value}};hooks.useCallback=(fn,deps)=>hooks.useMemo(()=>fn,deps)
 const jsx=(type,props,key)=>({type,props:props||{},key}),module={exports:{}}
 const client={credits:{async status(signal){calls.status.push(signal);return methods.status?methods.status(signal):configuration},async checkout(id,signal){calls.checkout.push({id,signal});return methods.checkout?methods.checkout(id,signal):{mode:'live',orderReference:reference,checkout:{action:'https://secure.wayforpay.com/pay',fields:{orderReference:reference,amount:packages.find(item=>item.id===id)?.priceUah,currency:'UAH'}}}},async reconcile(ref,signal){calls.reconcile.push({ref,signal});return methods.reconcile?methods.reconcile(ref,signal):{checked:true,retryAfter:60}}},async status(signal){calls.modelStatus.push(signal);return methods.modelStatus?methods.modelStatus(signal):initialStatus}}
 const props={status:initialStatus,client,onStatus(value){calls.onStatus.push(value)}}
 runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{module,exports:module.exports,AbortController,URLSearchParams,Error,Set,window:{location:{search},confirm(){calls.confirm++;return confirm}},require(name){if(name==='react')return hooks;if(name==='react/jsx-runtime')return{jsx,jsxs:jsx,Fragment:'fragment'};if(name==='../../lib/billing')return{openHostedCheckout:value=>calls.hosted.push(value)};if(name==='../../lib/maxTutorCredits')return{validAiCreditPackageId:value=>['credits_1000','credits_3000','credits_10000'].includes(value),validAiCreditReference:value=>typeof value==='string'&&/^xtop_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)};if(name==='./StudentLearningQuota')return{StudentLearningQuota:child=>{quota=child;return null}};throw Error('Unexpected quota dependency '+name)}})
 function expand(node){if(node==null||typeof node!=='object')return node;if(Array.isArray(node))return node.map(expand);if(typeof node.type==='function')return expand(node.type(node.props));return{...node,props:{...node.props,children:expand(node.props.children)}}}
 function render(){for(let attempt=0;attempt<30;attempt++){dirty=false;cursor=0;expand(jsx(module.exports.ProductionMaxQuota,props));effects.splice(0).forEach(fn=>fn());if(!dirty)return}throw Error('Hooks did not settle')}
 render();return{props,client,calls,get quota(){return quota},render,async settle(){for(let i=0;i<4;i++){await new Promise(resolve=>setImmediate(resolve));render()}},unmount(){cells.forEach(cell=>cell?.cleanup?.())}}
}

test('normal mounting makes no credit request; opening coalesces a pending configuration fetch and preserves the base quota',async()=>{
 const wait=deferred(),h=harness({methods:{status:()=>wait.promise}});assert.equal(h.calls.status.length,0);assert.equal(h.quota.budget.remainingUsd,3);assert.equal(h.quota.credits.balanceCredits,20);h.quota.onOpen();h.quota.onOpen();await h.settle();assert.equal(h.calls.status.length,1);assert.equal(h.quota.credits.loading,true);wait.resolve(config());await h.settle();assert.equal(h.quota.credits.loading,false);assert.equal(h.quota.credits.packages[0].priceUah,99);assert.equal(h.quota.budget.limitUsd,10);h.unmount()
})

test('checkout uses only a configured package and the existing hosted checkout after a current-owner response',async()=>{
 const h=harness();h.quota.onOpen();await h.settle();await assert.rejects(h.quota.credits.onPurchase('attacker-package'),/недоступна/);assert.equal(h.calls.checkout.length,0);await h.quota.credits.onPurchase('credits_3000');assert.equal(h.calls.checkout.length,1);assert.equal(h.calls.checkout[0].id,'credits_3000');assert.equal(h.calls.hosted.length,1);assert.equal(h.quota.credits.balanceCredits,20);h.unmount()
})

test('changing the account or session while checkout is pending prevents navigation and aborts the old request',async()=>{
 for(const changedScope of[{userId:'other',sessionId:'other-session'},{userId:'owner',sessionId:'new-session'}]){const wait=deferred(),h=harness({methods:{checkout:()=>wait.promise}});h.quota.onOpen();await h.settle();const paid=h.quota.credits.onPurchase('credits_1000');const signal=h.calls.checkout[0].signal;h.props.status={...h.props.status,scope:changedScope};h.render();assert.equal(signal.aborted,true);wait.resolve({mode:'live',orderReference:reference,checkout:{action:'https://secure.wayforpay.com/pay',fields:{}}});await paid;await h.settle();assert.equal(h.calls.hosted.length,0);h.unmount()}
})

test('unmount aborts credit loading and suppresses a delayed checkout navigation',async()=>{
 const wait=deferred(),h=harness({methods:{checkout:()=>wait.promise}});h.quota.onOpen();await h.settle();const purchase=h.quota.credits.onPurchase('credits_1000'),signal=h.calls.checkout[0].signal;h.unmount();assert.equal(signal.aborted,true);wait.resolve({checkout:{action:'https://secure.wayforpay.com/pay',fields:{}}});await purchase;assert.equal(h.calls.hosted.length,0)
})

test('test checkout requires confirmation and a cancelled confirmation does not create an order',async()=>{
 const h=harness({confirm:false,configuration:config({mode:'test'})});h.quota.onOpen();await h.settle();await h.quota.credits.onPurchase('credits_1000');assert.equal(h.calls.confirm,1);assert.equal(h.calls.checkout.length,0);assert.equal(h.calls.hosted.length,0);h.unmount()
})

test('a return URL cannot grant credits, runs one owner-scoped reconciliation, and leaves pending payment for manual retry',async()=>{
 const h=harness({search:`?payment=returned&orderReference=${reference}&credits=999999&status=approved`});await h.settle();assert.equal(h.quota.initialOpen,true);assert.equal(h.calls.reconcile.length,1);assert.equal(h.calls.reconcile[0].ref,reference);assert.equal(h.calls.status.length,1);assert.equal(h.calls.modelStatus.length,1);assert.equal(h.quota.credits.balanceCredits,20);assert.match(h.quota.credits.notice,/не знайдено/);await h.settle();assert.equal(h.calls.reconcile.length,1);h.quota.credits.onCheckPayment();await h.settle();assert.equal(h.calls.reconcile.length,2);assert.equal(h.quota.credits.balanceCredits,20);h.unmount()
})

test('invalid or unrelated return references never trigger reconciliation or configuration requests',async()=>{
 for(const search of['?payment=returned&orderReference=xelay_old','?payment=returned&orderReference=xtop_invalid',`?payment=approved&orderReference=${reference}`]){const h=harness({search});await h.settle();assert.equal(h.calls.reconcile.length,0);assert.equal(h.calls.status.length,0);assert.equal(h.quota.initialOpen,false);h.unmount()}
})

test('confirmed test payment is labelled and actual balances only come from authenticated server responses',async()=>{
 const serverWallet={balanceCredits:21,reservedCredits:0,debtCredits:0},h=harness({search:`?payment=returned&orderReference=${reference}`,configuration:config({mode:'test',orders:[{order_reference:reference,status:'approved',mode:'test'}]}),methods:{modelStatus:()=>status(serverWallet)}});await h.settle();assert.match(h.quota.credits.notice,/Тестову оплату/);assert.equal(h.quota.credits.balanceCredits,21);assert.equal(h.calls.onStatus.length,1);assert.equal(h.calls.hosted.length,0);h.unmount()
})

test('model-completion wallet refresh wins over an older, delayed configuration response',async()=>{
 const wait=deferred(),h=harness({methods:{status:()=>wait.promise}});h.quota.onOpen();h.render();h.props.status={...h.props.status,purchasedCredits:{balanceCredits:7,reservedCredits:1,debtCredits:0}};h.render();wait.resolve(config({wallet:{balanceCredits:99,reservedCredits:0,debtCredits:0}}));await h.settle();assert.equal(h.quota.credits.balanceCredits,7);h.unmount()
})

test('failed balance checks and payment checks remain explicit errors with no credit grant',async()=>{
 const h=harness({search:`?payment=returned&orderReference=${reference}`,methods:{reconcile:async()=>{throw Error('network')}}});await h.settle();assert.match(h.quota.credits.notice,/Не вдалося перевірити оплату/);assert.equal(h.quota.credits.balanceCredits,20);assert.equal(h.calls.modelStatus.length,0);h.unmount()
 const failed=harness({methods:{status:async()=>{throw Error('network')}}});failed.quota.onOpen();await failed.settle();assert.match(failed.quota.credits.error,/Не вдалося оновити баланс/);assert.equal(failed.quota.credits.checkoutAvailable,false);failed.unmount()
})

test('a checkout with a changed price or test/live mode cannot open the payment form',async()=>{for(const result of[{mode:'live',checkout:{action:'https://secure.wayforpay.com/pay',fields:{amount:100,currency:'UAH'}}},{mode:'test',checkout:{action:'https://secure.wayforpay.com/pay',fields:{amount:99,currency:'UAH'}}}]){const h=harness({methods:{checkout:async()=>result}});h.quota.onOpen();await h.settle();await assert.rejects(h.quota.credits.onPurchase('credits_1000'),/Умови оплати змінилися/);assert.equal(h.calls.hosted.length,0);h.unmount()}})

test('a missing rollout client settles as unavailable and can be retried after the client becomes available',async()=>{const h=harness(),api=h.client.credits;h.client.credits=undefined;h.quota.onOpen();await h.settle();assert.equal(h.quota.credits.loading,false);assert.match(h.quota.credits.error,/Не вдалося оновити баланс/);h.client.credits=api;h.quota.credits.onRefresh();await h.settle();assert.equal(h.quota.credits.loading,false);assert.equal(h.quota.credits.error,'');assert.equal(h.quota.credits.packages.length,3);h.unmount()})
