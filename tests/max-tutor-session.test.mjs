import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import * as crypto from 'node:crypto'
import {readFileSync} from 'node:fs'
const compile=file=>ts.transpileModule(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
const budget={},tutor={},api={}
vm.runInNewContext(compile('src/lib/studentAiBudget.ts'),{exports:budget})
vm.runInNewContext(compile('src/lib/maxTutor.ts'),{exports:tutor,TextEncoder,Date,Number,Math,Set,Map,JSON,Promise})
vm.runInNewContext(compile('server/student-learning/maxTutorSession.ts'),{exports:api,AbortController,setTimeout,clearTimeout,require(name){if(name.startsWith('.')&&name.endsWith('.js'))name=name.slice(0,-3);if(name==='node:crypto')return crypto;if(name==='../../src/lib/maxTutor')return tutor;if(name==='../../src/lib/studentAiBudget')return budget;throw Error('Unexpected dependency '+name)}})
const copy=v=>JSON.parse(JSON.stringify(v)),raw=(extra={})=>({requestId:'request-1',mode:'explain',prompt:'Поясни навчальний матеріал з точними посиланнями.',sourceRefs:['source-1'],...extra})
const usage={inputTokens:100,cachedInputTokens:0,outputTokens:20},rates={inputUsdPerMillion:2,cachedInputUsdPerMillion:0.1,outputUsdPerMillion:10},reserve=50000
function response(request){const bundle=copy(tutor.createTutorDemo(request.requestId,request.mode).bundle);for(const q of bundle.questions)q.sourceId=request.sources[0].id;for(const c of bundle.cards)c.sourceId=request.sources[0].id;for(const c of bundle.citations)c.sourceId=request.sources[0].id;return {bundle,usage}}
function fixture(options={}){
 const calls={session:0,authorize:0,entitlement:0,begin:[],generate:[],finish:[],moderate:[]},ledger=new Map();let identity={userId:'student-1',sessionId:'session-1'},source={},entitlement={};let spent=options.spent||0,reserved=0
 const fx={calls,ledger,setIdentity(v){identity=v},setSource(v){source=v},setEntitlement(v){entitlement=v},usage:()=>({spent,reserved})}
 const ports={async currentSession(){calls.session++;if(options.sessionError)throw Error('private provider detail');return options.signedOut?null:identity},async authorize(who,refs){calls.authorize++;if(options.authorizeError)throw Error('private database detail');return {userId:options.foreignOwner?'other':who.userId,sources:refs.map(id=>({id,title:tutor.DEMO_TUTOR_SOURCE.title,text:tutor.DEMO_TUTOR_SOURCE.text,page:1,kind:'own_excerpt',canRead:true,aiAllowed:true,...options.source,...source}))}},async resolveEntitlements(who){calls.entitlement++;return {userId:who.userId,audience:'student',planId:'max',aiAllowance:'available',monthlyAiBudgetUsd:6,...options.entitlement,...entitlement}},async moderate(text,settings){calls.moderate.push(text);if(options.moderate)return options.moderate(text,calls.moderate.length,fx,settings);return true},budget:{async begin(input){calls.begin.push(copy(input));if(Object.prototype.hasOwnProperty.call(options,'reservationResult'))return options.reservationResult;const key=input.userId+'|'+input.requestId,existing=ledger.get(key);if(existing){if(existing.fingerprint!==input.fingerprint)return {state:'conflict'};return existing.state==='pending'?{state:'pending'}:existing.bundle?{state:'replay',bundle:copy(existing.bundle)}:{state:'conflict'}}if(!budget.evaluateAiReservation({limitMicros:input.monthlyLimitMicros,spentMicros:spent,reservedMicros:reserved},input.reserveMicros).allowed)return {state:'denied'};const row={...input,state:'pending',reservationId:'reservation-'+(ledger.size+1),bundle:null};ledger.set(key,row);reserved+=input.reserveMicros;options.onReserve?.(fx);return {state:'reserved',reservationId:row.reservationId}},async finish(input){calls.finish.push(copy(input));if(options.finishError)throw Error('private storage detail');const row=ledger.get(input.userId+'|'+input.requestId);assert.ok(row);assert.equal(input.reservationId,row.reservationId);assert.equal(input.fingerprint,row.fingerprint);if(row.state==='done')return;const result=budget.settleAiReservation({limitMicros:row.monthlyLimitMicros,spentMicros:spent,reservedMicros:reserved},row.reserveMicros,input.chargeMicros);spent=result.spentMicros;reserved=result.reservedMicros;row.state='done';row.bundle=input.bundle&&copy(input.bundle);options.onFinish?.(fx)}},async generate(request,settings){calls.generate.push(request);if(options.generate)return options.generate(request,fx,settings);return response(request)}}
 const gateway=api.createMaxTutorSession(ports,{reserveMicros:reserve,tokenRates:rates,timeoutMs:options.timeoutMs??1000,...options.config});return {...fx,ports,run:gateway.run}
}

test('server identity and Max entitlement cannot be chosen through client fields or profile teaching flags',async()=>{
 for(const options of [{signedOut:true},{sessionError:true}]){const fx=fixture(options);assert.equal((await fx.run(raw())).status,'signed_out');assert.equal(fx.calls.generate.length,0);assert.equal(fx.calls.begin.length,0)}
 const fx=fixture();for(const extra of [{userId:'admin'},{planId:'max'},{sources:[tutor.DEMO_TUTOR_SOURCE]},{endpoint:'https://evil.invalid'},{model:'unlimited'}])assert.equal((await fx.run(raw(extra))).status,'invalid_request');assert.equal(fx.calls.begin.length,0)
})
test('audience, authoritative plan, legacy allowance and exact source rights fail closed before paid work',async()=>{
 for(const options of [{entitlement:{audience:'teacher'}},{entitlement:{audience:'unresolved'}},{entitlement:{planId:'plus'}},{entitlement:{aiAllowance:'pending_legacy_policy'}},{entitlement:{userId:'foreign'}},{foreignOwner:true},{source:{kind:'official_test'}},{source:{kind:'official_test_key'}},{source:{aiAllowed:false}},{source:{canRead:false}},{source:{id:'unrequested'}},{authorizeError:true}]){const fx=fixture(options);assert.equal((await fx.run(raw())).status,'forbidden');assert.equal(fx.calls.generate.length,0);assert.equal(fx.calls.begin.length,0)}
})
test('server source resolution caps three sources, actual UTF8 size and monthly budget at the six-dollar hypothesis',async()=>{
 for(const request of [raw({sourceRefs:['s1','s1']}),raw({sourceRefs:['s1','s2','s3'],ownNote:{title:'Own',text:'Note'}}),raw({sourceRefs:['own-note']}),raw({ownNote:{title:'Own',text:'<script>unsafe</script>'}})]){const fx=fixture();assert.equal((await fx.run(request)).status,'invalid_request');assert.equal(fx.calls.begin.length,0)}
 const tooLarge=fixture({source:{text:'ї'.repeat(13000)}});assert.equal((await tooLarge.run(raw())).status,'invalid_request');assert.equal(tooLarge.calls.generate.length,0)
 const capped=fixture({entitlement:{monthlyAiBudgetUsd:999}});assert.equal((await capped.run(raw())).status,'ready');assert.equal(capped.calls.begin[0].monthlyLimitMicros,6000000)
 const zero=fixture({entitlement:{monthlyAiBudgetUsd:0}});assert.equal((await zero.run(raw())).status,'quota_exhausted');assert.equal(zero.calls.begin.length,0)
})
test('valid generation is moderated twice, charged exactly once and stored only for the original owner',async()=>{
 const fx=fixture(),result=await fx.run(raw());assert.equal(result.status,'ready');assert.equal(result.replayed,false);assert.equal(fx.calls.moderate.length,2);assert.equal(fx.calls.generate.length,1);assert.equal(fx.calls.finish[0].userId,'student-1');assert.equal(fx.calls.finish[0].sessionId,'session-1');assert.equal(fx.calls.finish[0].chargeMicros,400);assert.equal(fx.calls.finish[0].bundle.title,result.bundle.title);assert.equal(fx.usage().reserved,0);assert.equal(fx.usage().spent,400);assert.equal(Object.isFrozen(fx.calls.generate[0]),true);assert.equal(Object.isFrozen(fx.calls.generate[0].sources[0]),true)
})
test('input safety refusal or moderation failure never starts generation and cannot fall through on malformed approval',async()=>{
 for(const moderate of [async()=>false,async()=>{throw Error('secret safety configuration')},async()=>({approved:true})]){const fx=fixture({moderate}),result=await fx.run(raw());assert.ok(['refused','moderation_failed'].includes(result.status));assert.equal(fx.calls.generate.length,0);assert.equal(fx.calls.begin.length,0);assert.equal(JSON.stringify(result).includes('secret'),false)}
})
test('output moderation refusal still charges actual generation and exposes no rejected bundle',async()=>{
 const fx=fixture({moderate:async(_text,index)=>index===1}),result=await fx.run(raw());assert.deepEqual(copy(result),{status:'refused'});assert.equal(fx.calls.finish.length,1);assert.equal(fx.calls.finish[0].chargeMicros,400);assert.equal(fx.calls.finish[0].bundle,null)
})
test('replayed bundle is authorized, validated and moderated again without extra generation or charge',async()=>{
 const fx=fixture();assert.equal((await fx.run(raw())).status,'ready');const firstSpent=fx.usage().spent;assert.equal((await fx.run(raw())).replayed,true);assert.equal(fx.calls.generate.length,1);assert.equal(fx.calls.finish.length,1);assert.equal(fx.usage().spent,firstSpent);fx.setSource({canRead:false});assert.equal((await fx.run(raw())).status,'forbidden');assert.equal(fx.calls.generate.length,1)
})
test('source text and requested mode are in idempotency fingerprint; another user cannot replay an owner record',async()=>{
 const fx=fixture();await fx.run(raw());assert.equal((await fx.run(raw({mode:'quiz'}))).status,'conflict');fx.setIdentity({userId:'student-2',sessionId:'session-2'});const other=await fx.run(raw());assert.equal(other.replayed,false);assert.equal(fx.calls.generate.length,2);assert.equal(fx.calls.finish[1].userId,'student-2');fx.setSource({text:tutor.DEMO_TUTOR_SOURCE.text+' Changed.'});assert.equal((await fx.run(raw())).status,'conflict')
})
test('concurrent identical requests stay pending and cannot start a second paid operation',async()=>{
 let started,release;const ready=new Promise(resolve=>{started=resolve});const fx=fixture({generate:request=>new Promise(resolve=>{release=()=>resolve(response(request));started()})});const first=fx.run(raw());await ready;assert.equal((await fx.run(raw())).status,'pending');assert.equal(fx.calls.generate.length,1);release();assert.equal((await first).status,'ready');assert.equal(fx.calls.finish.length,1)
})
test('identity or permission changes during reservation release only their unused reservation before generation',async()=>{
 for(const onReserve of [fx=>fx.setIdentity({userId:'foreign',sessionId:'different'}),fx=>fx.setSource({aiAllowed:false}),fx=>fx.setEntitlement({planId:'start'})]){const fx=fixture({onReserve}),result=await fx.run(raw());assert.ok(['identity_changed','forbidden'].includes(result.status));assert.equal(fx.calls.generate.length,0);assert.equal(fx.calls.finish[0].chargeMicros,0);assert.equal(fx.calls.finish[0].bundle,null);assert.equal(fx.usage().reserved,0)}
})
test('expired access, switched identity or changed source content after generation deny presentation while settling cost',async()=>{
 for(const change of [fx=>fx.setEntitlement({planId:'plus'}),fx=>fx.setIdentity({userId:'foreign',sessionId:'different'}),fx=>fx.setSource({text:tutor.DEMO_TUTOR_SOURCE.text+' Changed.'})]){const fx=fixture({generate:async(request,fx)=>{const result=response(request);change(fx);return result}}),result=await fx.run(raw());assert.ok(['forbidden','identity_changed','context_changed'].includes(result.status));assert.equal(fx.calls.finish[0].chargeMicros,400);assert.equal(fx.calls.finish[0].bundle,null);assert.equal(fx.calls.finish[0].userId,'student-1')}
})
test('the final pre-persist check catches revocation during output moderation and preserves paid accounting',async()=>{
 const fx=fixture({moderate:async(_text,index,fx)=>{if(index===2)fx.setSource({canRead:false});return true}});assert.equal((await fx.run(raw())).status,'forbidden');assert.equal(fx.calls.finish[0].bundle,null);assert.equal(fx.calls.finish[0].chargeMicros,400)
})
test('HTML, invented key references and forged citations never become executable output or stored results',async()=>{
 for(const mutate of [b=>{b.title='<img src=x onerror=alert(1)>'},b=>{b.questions[0].sourceId='official-key'},b=>{b.citations[0].quote='Invented secret quote'},b=>{b.widget='<iframe src=evil>'}]){const fx=fixture({generate:async request=>{const r=response(request);mutate(r.bundle);return r}}),result=await fx.run(raw());assert.equal(result.status,'invalid_output');assert.equal(fx.calls.finish[0].bundle,null);assert.equal(fx.calls.finish[0].chargeMicros,400)}
})
test('unknown usage, provider errors and malformed usage conservatively consume reservation; known overspend is kept',async()=>{
 for(const generate of [async request=>({...response(request),usage:null}),async()=>{throw Error('private provider key')},async request=>({...response(request),usage:{inputTokens:-1,cachedInputTokens:0,outputTokens:1}})]){const fx=fixture({generate});await fx.run(raw());assert.equal(fx.calls.finish[0].chargeMicros,reserve)}
 const fx=fixture({generate:async request=>({...response(request),usage:{inputTokens:100,cachedInputTokens:0,outputTokens:9000}})});assert.equal((await fx.run(raw())).status,'ready');assert.equal(fx.calls.finish[0].chargeMicros,90200);assert.ok(fx.usage().spent>reserve)
})
test('timeouts and cancellation cannot yield a late response or free retry of a paid operation',async()=>{
 let finishLate;const fx=fixture({timeoutMs:8,generate:request=>new Promise(resolve=>{finishLate=()=>resolve(response(request))})}),result=await fx.run(raw());assert.equal(result.status,'timeout');assert.equal(fx.calls.finish[0].chargeMicros,reserve);assert.equal(fx.calls.finish[0].bundle,null);finishLate();await Promise.resolve();assert.equal(fx.calls.finish.length,1);assert.equal((await fx.run(raw())).status,'conflict')
 const aborted=new AbortController();aborted.abort();const before=fixture();assert.equal((await before.run(raw(),{signal:aborted.signal})).status,'cancelled');assert.equal(before.calls.generate.length,0)
})
test('storage failures and unknown atomic responses fail closed without a second generation',async()=>{
 for(const reservationResult of [null,{state:'reserved'},{state:'reserved',reservationId:'__proto__'},{state:'replay'},{state:'denied',extra:true}]){const fx=fixture({reservationResult});assert.equal((await fx.run(raw())).status,'storage_failed');assert.equal(fx.calls.generate.length,0)}
 const fx=fixture({finishError:true});assert.equal((await fx.run(raw())).status,'storage_failed');assert.equal((await fx.run(raw())).status,'pending');assert.equal(fx.calls.generate.length,1);assert.equal(fx.usage().reserved,reserve)
})
test('server caps and mandatory moderation cannot be disabled by configuration',()=>{
 const fx=fixture();for(const config of [{reserveMicros:0,tokenRates:rates},{reserveMicros:reserve,tokenRates:rates,maxMonthlyBudgetUsd:7},{reserveMicros:reserve,tokenRates:rates,timeoutMs:60001},{reserveMicros:reserve,tokenRates:{...rates,inputUsdPerMillion:-1}}])assert.throws(()=>api.createMaxTutorSession(fx.ports,config));assert.throws(()=>api.createMaxTutorSession({...fx.ports,moderate:undefined},{reserveMicros:reserve,tokenRates:rates}))
})
