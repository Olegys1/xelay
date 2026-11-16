import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as React from 'react'
import * as JSXRuntime from 'react/jsx-runtime'
import * as Lucide from 'lucide-react'
import {renderToStaticMarkup} from 'react-dom/server'
const module={exports:{}}
vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/maxTutor.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports,Date,Math,Number,JSON,Set,Map,TextEncoder,Promise})
const a=module.exports,plain=v=>JSON.parse(JSON.stringify(v)),demo=(mode='explain')=>a.createTutorDemo('own-run',mode)
const run=()=>({id:'own-run',createdAt:'2026-11-16T10:00:00.000Z',demo:true,...demo(),progress:a.emptyTutorProgress()})

test('all five modes have working synthetic artifacts with literal, attributable sources',()=>{
 for(const mode of ['explain','quiz','cards','plan','math']){const {request,bundle}=demo(mode);assert.equal(bundle.mode,mode);assert.equal(a.validateTutorBundle(plain(bundle),plain(request)).mode,mode);assert.ok(bundle.questions.length);assert.ok(bundle.cards.length);assert.ok(bundle.plan.length);assert.ok(bundle.math.points.length>=2);for(const c of bundle.citations)assert.ok(request.sources.find(s=>s.id===c.sourceId).text.includes(c.quote))}
})
test('request cannot choose identity, paid access or protected teacher sources and bounds actual UTF8 text',()=>{
 const {request}=demo();for(const bad of [{...request,userId:'foreign'},{...request,plan:'max'},{...request,sources:[{...request.sources[0],kind:'official_test_key'}]},{...request,sources:[request.sources[0],request.sources[0]]},{...request,prompt:'<img src=x onerror=alert(1)>'},{...request,sources:[{...request.sources[0],text:'ї'.repeat(13000)}]},{...request,sources:[{...request.sources[0],url:'https://private.invalid'}]}])assert.throws(()=>a.validateTutorRequest(bad))
 assert.doesNotThrow(()=>a.validateTutorRequest({...request,sources:[{...request.sources[0],text:'ї'.repeat(12000)}]}))
})
test('model output cannot invent source quotations, foreign references, executable tags or invalid keys',()=>{
 const {request,bundle}=demo();for(const bad of [{...bundle,mode:'quiz'},{...bundle,citations:[{sourceId:'foreign',quote:'secret'}]},{...bundle,citations:[{sourceId:'demo-demand',quote:'Not in the source'}]},{...bundle,title:'<script>alert(1)</script>'},{...bundle,questions:[{...bundle.questions[0],correctIndex:9}]},{...bundle,questions:[bundle.questions[0],bundle.questions[0]]},{...bundle,questions:[{...bundle.questions[0],sourceId:'hidden-test'}]},{...bundle,questions:[{...bundle.questions[0],options:['Same',' same ']}]},{...bundle,html:'arbitrary widget'},{...bundle,math:{...bundle.math,points:[{x:NaN,y:0},{x:1,y:2}]}}])assert.throws(()=>a.validateTutorBundle(bad,request))
})
test('each artifact type fails visibly if required selected-mode content is missing',()=>{
 for(const [mode,key,empty] of [['explain','steps',[]],['quiz','questions',[]],['cards','cards',[]],['plan','plan',[]],['math','math',null]]){const {request,bundle}=demo(mode);assert.throws(()=>a.validateTutorBundle({...bundle,[key]:empty},request))}
})
test('quiz accepts explicit option zero, locks submitted answers and cannot count foreign or incomplete questions',()=>{
 const {bundle}=demo('quiz');let p=a.emptyTutorProgress();assert.equal(a.submitTutorQuestion(p,bundle,'q-price'),p);assert.equal(a.answerTutorQuestion(p,bundle,'foreign',0),p);p=a.answerTutorQuestion(p,bundle,'q-price',0);p=a.submitTutorQuestion(p,bundle,'q-price');assert.equal(a.answerTutorQuestion(p,bundle,'q-price',1),p);assert.equal(a.submitTutorQuestion(p,bundle,'q-price'),p);assert.deepEqual(plain(a.tutorQuizResult(bundle,p)),{answered:1,total:3,correct:1,mistakes:[]})
})
test('mistake-only review snapshots its question list before unlocking and retains already correct answers',()=>{
 const {bundle}=demo('quiz');let p=a.emptyTutorProgress();p=a.answerTutorQuestion(p,bundle,'q-price',0);p=a.submitTutorQuestion(p,bundle,'q-price');p=a.answerTutorQuestion(p,bundle,'q-value',0);p=a.submitTutorQuestion(p,bundle,'q-value');const review=a.beginTutorMistakeReview(bundle,p);assert.deepEqual(plain(review.questionIds),['q-value']);assert.equal(review.progress.submitted.includes('q-price'),true);assert.equal(review.progress.submitted.includes('q-value'),false);assert.equal(a.tutorQuizResult(bundle,review.progress).mistakes.length,0);assert.equal(review.questionIds.length,1);let fixed=a.answerTutorQuestion(review.progress,bundle,'q-value',2);fixed=a.submitTutorQuestion(fixed,bundle,'q-value');assert.equal(a.tutorQuizResult(bundle,fixed).correct,2);assert.equal(a.tutorQuizResult(bundle,p).correct,1)
})
test('reload preserves quiz, card and plan progress while rejecting foreign identifiers or forged content',()=>{
 const r=run();r.progress=a.submitTutorQuestion(a.answerTutorQuestion(r.progress,r.bundle,'q-price',0),r.bundle,'q-price');r.progress.cardRatings['card-demand']='known';r.progress.doneTasks=['day-understand:0'];const state={version:1,runs:[r],activeRunId:r.id};assert.deepEqual(plain(a.parseTutorState(a.storeTutorState(state))),plain(state));const forged=plain(state);forged.runs[0].progress.answers.foreign=100;forged.runs[0].progress.submitted.push('foreign');forged.runs[0].progress.cardRatings.foreign='known';forged.runs[0].progress.doneTasks.push('foreign:0');const safe=a.parseTutorState(JSON.stringify(forged)).runs[0];assert.equal(safe.progress.answers.foreign,undefined);assert.equal(safe.progress.cardRatings.foreign,undefined);assert.equal(safe.progress.submitted.length,1);assert.equal(safe.progress.doneTasks.length,1);forged.runs[0].bundle.citations[0].quote='Forged quote';assert.equal(a.parseTutorState(JSON.stringify(forged)).runs.length,0)
})
test('oversized, malformed, duplicate or unsupported history cannot overwrite a valid-looking active session',()=>{
 assert.equal(a.parseTutorState('{').runs.length,0);assert.equal(a.parseTutorState('x'.repeat(1500001)).runs.length,0);assert.equal(a.parseTutorState(JSON.stringify({version:2,runs:[run()],activeRunId:'own-run'})).runs.length,0);assert.equal(a.parseTutorState(JSON.stringify({version:1,runs:[run(),run()],activeRunId:'foreign'})).runs.length,1);assert.equal(a.parseTutorState(JSON.stringify({version:1,runs:Array.from({length:13},run),activeRunId:'own-run'})).runs.length,0)
})
test('local UI distinguishes its demo from live model calls and contains no network or executable output rendering',()=>{
 const ui=readFileSync(new URL('../src/components/student/MaxTutorAssistant.tsx',import.meta.url),'utf8');assert.match(ui,/Модель не підключена/);assert.match(ui,/Жоден демонстраційний результат не підставляється замість відповіді моделі/);assert.ok(ui.includes('if(!consent)'));assert.match(ui,/mta-source-consent/);assert.match(ui,/disabled=\{!enabled\|\|!transport\|\|!prompt\.trim\(\)\}/);assert.match(ui,/receiveTutorBundle\(transport,request/);assert.match(ui,/abort.signal.aborted\|\|current!==sequence.current/);assert.match(ui,/window.addEventListener\('pagehide',flush\)/);assert.doesNotMatch(ui,/dangerouslySetInnerHTML|\bfetch\(|supabase\.|eval\(|new Function|document\.write|api\.openai|iframe/)
})

test('cancelled transports cannot keep the UI pending or return late unvalidated output',async()=>{const {request,bundle}=demo();let calls=0,resolveLate;const abort=new AbortController(),pending=a.receiveTutorBundle(()=>{calls++;return new Promise(resolve=>{resolveLate=resolve})},request,{signal:abort.signal});await Promise.resolve();assert.equal(calls,1);abort.abort();await assert.rejects(pending,error=>error.name==='AbortError');resolveLate(bundle);await Promise.resolve();const already=new AbortController();already.abort();await assert.rejects(a.receiveTutorBundle(async()=>{calls++;return bundle},request,{signal:already.signal}));assert.equal(calls,1);await assert.rejects(a.receiveTutorBundle(async()=>({...bundle,title:'<script>bad</script>'}),request,{signal:new AbortController().signal}))})

test('scope validation separates live owners and sessions from the synthetic preview without inferring paid authorization',()=>{
 const one=a.createTutorStorageBoundary({userId:'owner-a',sessionId:'session-1'}),sameOwner=a.createTutorStorageBoundary({userId:'owner-a',sessionId:'session-2'}),other=a.createTutorStorageBoundary({userId:'owner-b',sessionId:'session-1'}),synthetic=a.createTutorStorageBoundary(undefined)
 assert.equal(one.mode,'live');assert.equal(one.storageKey,sameOwner.storageKey);assert.notEqual(one.runtimeKey,sameOwner.runtimeKey);assert.notEqual(one.storageKey,other.storageKey);assert.notEqual(one.storageKey,synthetic.storageKey)
 for(const bad of [undefined,null,{},[],{userId:'owner-a',sessionId:''},{userId:'owner-a',sessionId:'session-1',plan:'max'},{userId:'__proto__',sessionId:'s'},{userId:'a',sessionId:'x'.repeat(81)}])assert.equal(a.createTutorStorageBoundary(bad).mode,'synthetic')
})
test('owner history envelopes reject copied data from another account and never import synthetic data automatically',()=>{
 const one=a.createTutorStorageBoundary({userId:'owner-a',sessionId:'session-1'}),two=a.createTutorStorageBoundary({userId:'owner-b',sessionId:'session-2'}),synthetic=a.createTutorStorageBoundary(undefined),r=run();r.demo=false;r.request.prompt='OWNER_A_PRIVATE_PROMPT';r.bundle.introduction='OWNER_A_PRIVATE_EXPLANATION';const privateState={version:1,runs:[r],activeRunId:r.id},sampleState={version:1,runs:[run()],activeRunId:'own-run'}
 const storage=new Map([[one.storageKey,a.storeScopedTutorState(privateState,one)],[synthetic.storageKey,a.storeScopedTutorState(sampleState,synthetic)]])
 assert.equal(a.parseScopedTutorState(storage.get(one.storageKey),one).runs[0].request.prompt,'OWNER_A_PRIVATE_PROMPT');assert.equal(a.parseScopedTutorState(storage.get(two.storageKey)||null,two).runs.length,0)
 assert.equal(a.parseScopedTutorState(storage.get(one.storageKey),two).runs.length,0);assert.equal(a.parseScopedTutorState(storage.get(synthetic.storageKey),one).runs.length,0);assert.equal(a.parseScopedTutorState(storage.get(one.storageKey),synthetic).runs.length,0)
 const refreshed=a.createTutorStorageBoundary({userId:'owner-a',sessionId:'session-new'});assert.equal(a.parseScopedTutorState(storage.get(refreshed.storageKey),refreshed).runs[0].request.prompt,'OWNER_A_PRIVATE_PROMPT');assert.equal(storage.get(synthetic.storageKey).includes('OWNER_A_PRIVATE'),false)
})
test('live source excerpts require matching owner and session metadata; unscoped demo sources cannot cross to a live account',()=>{
 const scope={userId:'owner-a',sessionId:'session-1'},boundary=a.createTutorStorageBoundary(scope),synthetic=a.createTutorStorageBoundary(undefined)
 assert.equal(a.canUseTutorCaptures(boundary,scope,scope),true);for(const bad of [undefined,null,{userId:'owner-b',sessionId:'session-1'},{userId:'owner-a',sessionId:'session-old'},{...scope,plan:'max'}])assert.equal(a.canUseTutorCaptures(boundary,scope,bad),false)
 assert.equal(a.canUseTutorCaptures(synthetic,undefined,undefined),true);assert.equal(a.canUseTutorCaptures(synthetic,{userId:'owner-a',sessionId:''},undefined),false)
})
test('rendered client cannot enable transport without a valid scope and keeps disabled own-scope reading semantics',()=>{
 const uiSource=readFileSync(new URL('../src/components/student/MaxTutorAssistant.tsx',import.meta.url),'utf8'),uiModule={exports:{}}
 const localClient={};vm.runInNewContext(ts.transpileModule(readFileSync(new URL('../src/lib/maxTutorLocalClient.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText,{exports:localClient,TextDecoder,TextEncoder,Response,fetch,require(name){if(name==='./maxTutor')return a;throw Error('Unexpected local dependency '+name)}})
 const compiled=ts.transpileModule(uiSource,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText
 vm.runInNewContext(compiled,{module:uiModule,exports:uiModule.exports,require(name){if(name==='react')return React;if(name==='react/jsx-runtime')return JSXRuntime;if(name==='lucide-react')return Lucide;if(name==='../../lib/maxTutor')return a;if(name==='../../lib/maxTutorLocalClient')return localClient;if(name==='../../lib/maxTutorCoach')return {sendMaxTutorCoachEvent(){return false}};if(name==='./maxTutorAssistant.css')return {};throw Error('Unexpected component dependency '+name)}})
 let calls=0;const transport=async()=>{calls++;return demo().bundle},Component=uiModule.exports.MaxTutorAssistant
 for(const scope of [undefined,{userId:'owner-a',sessionId:''},{userId:'owner-a',sessionId:'s',plan:'max'}]){const html=renderToStaticMarkup(React.createElement(Component,{transport,scope}));assert.ok(html.includes('Демонстраційний режим'));assert.ok(html.includes('Модель не підключена'));assert.equal(html.includes('Навчальний сервіс підключено'),false)}
 const disabled=renderToStaticMarkup(React.createElement(Component,{transport,scope:{userId:'owner-a',sessionId:'session-1'},enabled:false}));assert.ok(disabled.includes('Збережені матеріали залишаються доступними для читання й експорту'));assert.equal(calls,0)
 const connected=renderToStaticMarkup(React.createElement(Component,{transport,scope:{userId:'owner-a',sessionId:'session-1'},localMode:true}));assert.ok(connected.includes('Навчальний сервіс підключено'));assert.ok(connected.includes('Дозволяю надіслати до OpenAI'));assert.ok(connected.includes('Окремий навчальний приклад'));assert.equal(calls,0)
 assert.match(uiSource,/key=\{boundary.runtimeKey\}/);assert.match(uiSource,/useLayoutEffect\(/);assert.match(uiSource,/controller.current\?\.abort\(\);sequence.current\+\+;flush\(\)/);assert.match(uiSource,/localStorage.setItem\(boundary.storageKey,storeScopedTutorState/);assert.doesNotMatch(uiSource,/localStorage\.(?:getItem|setItem)\(TUTOR_STORAGE_KEY/)
})
