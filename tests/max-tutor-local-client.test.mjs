import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import {readFileSync} from 'node:fs'
const compile=file=>ts.transpileModule(readFileSync(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
const study={};vm.runInNewContext(compile('src/lib/maxTutorStudy.ts'),{exports:study,TextEncoder})
const tutor={},client={}
vm.runInNewContext(compile('src/lib/maxTutor.ts'),{exports:tutor,TextEncoder,Date,Number,Math,Set,Map,JSON,Promise,require(name){if(name==='./maxTutorStudy.js')return study;throw Error('Unexpected '+name)}})
vm.runInNewContext(compile('src/lib/maxTutorLocalClient.ts'),{exports:client,TextDecoder,TextEncoder,Response,fetch,JSON,Set,Map,Promise,require(name){if(name==='./maxTutor')return tutor;throw Error('Unexpected '+name)}})
const plain=v=>JSON.parse(JSON.stringify(v)),json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}})
const status=(extra={})=>({status:'ready',connected:false,model:'gpt-6.1-sol',scope:{userId:'local-owner',sessionId:'session-1'},csrfToken:'a'.repeat(48),budget:{limitUsd:1,spentUsd:0,reservedUsd:0,remainingUsd:1},models:[{id:'gpt-6.1-sol',label:'GPT-6.1 Sol'},{id:'gpt-5.4-mini',label:'GPT-5.4 mini'},{id:'gpt-5.4',label:'GPT-5.4'}],localOnly:true,estimatedAccounting:true,...extra})
const request=()=>({requestId:'run-1',mode:'explain',prompt:'Поясни джерело.',sources:[{id:'own-note',title:'Моя нотатка',text:'Попит відображає кількість товару, яку покупці готові придбати.',page:null,kind:'own_note'}]})
test('Auto chooses only explicit artifact requests and keeps ordinary or negated test questions as explanations',()=>{
 for(const prompt of ['Поясни що таке тест гіпотези','Объясни, как создать тест','Не треба тест. Поясни тему','Не делай тест','Що таке план навчання?','Як підготувати тест?','Скажи, що означає попит','Можеш пояснити, як створити тест гіпотези?','Розкажи, як створити тест за конспектом','Чи можете пояснити як створити тест?','Можна пояснити як зробити тест?','Можешь объяснить как создать тест?','Пожалуйста, расскажи как создать тест','Please could you explain how to create a quiz?'])assert.equal(client.inferTutorLocalMode(prompt,'explain'),'explain',prompt)
 for(const [prompt,mode]of [['Зроби мені тест за матеріалом','quiz'],['Сделай карточки за моим конспектом','cards'],['Склади план на завтра','plan'],['Розв’яжи задачу зі джерела','math']])assert.equal(client.inferTutorLocalMode(prompt,'explain'),mode)
 const ui=readFileSync(new URL('../src/components/student/MaxTutorAssistant.tsx',import.meta.url),'utf8');assert.match(ui,/inferTutorConversationMode\(prompt, currentSources\.length\)/);assert.doesNotMatch(ui,/mta-modes|Режим навчального агента|setComposerMode/);assert.match(ui,/Повідомлення навчальному помічнику/)
})
test('explicit source snapshots survive a generated follow-up while opening history never imports context',()=>{
 const original=request(),other=request();other.requestId='history-2';other.sources[0].text='OTHER_HISTORY_MATERIAL';other.sources[0].title='Інша історія'
 assert.equal(client.advanceTutorSelectedContext(null,{type:'history',request:other}),null)
 const selected=client.advanceTutorSelectedContext(null,{type:'follow_up',request:original});assert.deepEqual(plain(selected),original.sources)
 original.sources[0].text='MUTATED_ORIGINAL';assert.notEqual(selected[0].text,original.sources[0].text)
 const afterGeneration=client.advanceTutorSelectedContext(selected,{type:'generated'}),afterHistory=client.advanceTutorSelectedContext(afterGeneration,{type:'history',request:other});assert.deepEqual(plain(afterHistory),plain(selected));assert.notEqual(afterHistory[0].text,other.sources[0].text)
 assert.equal(client.advanceTutorSelectedContext(afterHistory,{type:'clear'}),null)
 assert.throws(()=>client.advanceTutorSelectedContext(null,{type:'follow_up',request:{...other,sources:[{...other.sources[0],kind:'official_test_key'}]}}))
 const ui=readFileSync(new URL('../src/components/student/MaxTutorAssistant.tsx',import.meta.url),'utf8');assert.match(ui,/reuseSources && explicitSources \? explicitSources\.map/);assert.match(ui,/advanceTutorSelectedContext\(previous, \{ type: 'follow_up', request: run\.request \}\)/);assert.match(ui,/currentSources\.length && \(!consent \|\| consentSignature\.current !== sourceSignature\)/);assert.match(ui,/consentSignature\.current = ''; setConsent\(false\) \}, \[sourceSignature\]\)/);assert.ok(!ui.match(/useEffect\(\(\)=>\{[^\n]+setReuseSources\(false\)[^\n]+\},\[run\?\.id\]\)/))
})

test('status is strict about local-only scope, models, accounting and never accepts a returned secret',()=>{
 assert.deepEqual(plain(client.parseMaxTutorLocalStatus(status())),status())
 for(const changed of [{apiKey:'private-secret'}, {localOnly:false},{estimatedAccounting:false},{model:'https://untrusted.example'}, {scope:{userId:'__proto__',sessionId:'session-1'}},{models:[{id:'gpt-6.1-sol',label:'<script>alert(1)</script>'}]},{budget:{limitUsd:7,spentUsd:0,reservedUsd:0,remainingUsd:7}},{csrfToken:'short'}])assert.throws(()=>client.parseMaxTutorLocalStatus(status(changed)),error=>error.name==='MaxTutorLocalClientError')
})
test('the only secret-bearing request is explicit configuration; generation uses bounded sources and CSRF',async()=>{
 const calls=[];const api=client.createMaxTutorLocalClient(async(url,options)=>{calls.push({url,...options});if(url.endsWith('/run'))return json({status:'ready',bundle:{syntheticResponse:true},replayed:false});return json(status({connected:url.endsWith('/configure')}))})
 await api.status();await api.configure({apiKey:'synthetic-private-key',model:'gpt-6.1-sol',limitUsd:1});const result=await api.transport(request(),{signal:new AbortController().signal});assert.deepEqual(plain(result),{syntheticResponse:true})
 assert.deepEqual(calls.map(c=>c.url),['/api/local-max/status','/api/local-max/configure','/api/local-max/run'])
 for(const call of calls){assert.equal(call.credentials,'same-origin');assert.equal(call.redirect,'error');assert.equal(call.cache,'no-store');assert.equal(call.headers.Accept,'application/json')}
 assert.equal(calls[0].method,'GET');assert.equal(calls[0].body,undefined);assert.equal(calls[1].headers['X-Xelay-CSRF'],'a'.repeat(48));assert.equal(calls[2].headers['X-Xelay-CSRF'],'a'.repeat(48))
 assert.equal(JSON.parse(calls[1].body).apiKey,'synthetic-private-key');assert.deepEqual(JSON.parse(calls[2].body),request());assert.ok(!calls[2].body.includes('synthetic-private-key'));assert.equal(calls[2].headers.Authorization,undefined)
})
test('unconfigured, malformed and foreign payloads cannot make a generation request or silently use a demo',async()=>{
 const calls=[];const api=client.createMaxTutorLocalClient(async(url)=>{calls.push(url);return json(status())})
 await assert.rejects(async()=>api.transport(request(),{signal:new AbortController().signal}),e=>e.code==='not_configured');assert.equal(calls.length,0)
 await api.status();await assert.rejects(async()=>api.transport(request(),{signal:new AbortController().signal}),e=>e.code==='not_configured')
 for(const value of [{...request(),apiKey:'not-allowed'},{...request(),sources:[{...request().sources[0],kind:'teacher_key'}]}])await assert.rejects(async()=>api.transport(value,{signal:new AbortController().signal}))
 await assert.rejects(()=>api.configure({apiKey:'bad\nkey',model:'gpt-6.1-sol',limitUsd:1}),e=>e.code==='invalid_request');assert.equal(calls.length,1)
})
test('server errors never echo provider content and a disconnect rotates the active CSRF/session',async()=>{
 const calls=[];let phase='initial';const api=client.createMaxTutorLocalClient(async(url,options)=>{calls.push({url,...options});if(url.endsWith('/run'))return json({status:'generation_failed',error:'sk-private-provider-details'},503);if(url.endsWith('/disconnect')){phase='disconnected';return json(status({scope:{userId:'local-owner',sessionId:'session-2'},csrfToken:'b'.repeat(48)}))}return json(status({connected:true}))})
 await api.status();await assert.rejects(()=>api.transport(request(),{signal:new AbortController().signal}),e=>{assert.doesNotMatch(e.message,/private|sk-/);return e.code==='generation_failed'})
 const disconnected=await api.disconnect();assert.equal(disconnected.scope.sessionId,'session-2');assert.equal(phase,'disconnected');await assert.rejects(async()=>api.transport(request(),{signal:new AbortController().signal}),e=>e.code==='not_configured')
})
test('HTML, oversized and malformed local responses fail closed',async()=>{
 for(const factory of [()=>new Response('<html>error</html>',{headers:{'content-type':'text/html'}}),()=>new Response('x'.repeat(9000),{headers:{'content-type':'application/json'}}),()=>json(status(),200,{'content-length':'9000'}),()=>new Response('{bad',{headers:{'content-type':'application/json'}})]){const api=client.createMaxTutorLocalClient(async()=>factory());await assert.rejects(()=>api.status(),e=>e.name==='MaxTutorLocalClientError')}
})
test('capture identifiers with punctuation are normalized without dropping quote, page or explicit source selection',()=>{
 const captures=[{id:'pdf:1:page-2',sourceTitle:'Попит',quote:'Вибраний уривок.',page:2},{id:'source:2',sourceTitle:'Інше',quote:'Не вибрано.',page:3}]
 const sources=client.makeTutorOwnSources(' Мій текст. ',captures,['pdf:1:page-2']);assert.deepEqual(plain(sources),[{id:'own-note',title:'Моя навчальна нотатка',text:'Мій текст.',page:null,kind:'own_note'},{id:'excerpt-2',title:'Попит',text:'Вибраний уривок.',page:2,kind:'own_excerpt'}]);assert.equal(sources.length,2)
 assert.equal(client.makeTutorOwnSources('',captures,[]).length,0)
})
test('local drafts retain only allowed prompt/source selection/completion fields and reject credentials',()=>{
 const draft={version:1,prompt:'Моя мета',note:'Власний навчальний текст',mode:'quiz',selected:['pdf:1:page-2'],completedRuns:['run-1']};assert.deepEqual(plain(client.parseTutorLocalDraft(JSON.stringify(draft))),draft)
 for(const input of [JSON.stringify({...draft,apiKey:'private'}),JSON.stringify({...draft,ownerId:'other'}),JSON.stringify({...draft,completedRuns:['__proto__']}),'broken','x'.repeat(32001)]){const safe=client.parseTutorLocalDraft(input);assert.equal(safe.prompt,'');assert.equal(safe.note,'');assert.equal('apiKey' in safe,false)}
})
test('aborted network requests produce cancellation without raw exception details',async()=>{
 const abort=new AbortController(),api=client.createMaxTutorLocalClient(async()=>{abort.abort();throw Error('private network detail')});await assert.rejects(()=>api.status(abort.signal),e=>e.code==='cancelled'&&!e.message.includes('private'))
})


test('explicit natural-language creation requests select the actual structured artifact without reading sources',()=>{
 for(const prompt of ['Зроби мені тест на п’ять запитань за моїм матеріалом.','Сделай мне большой тест по материалу','Create a practice test'])assert.equal(client.inferTutorLocalMode(prompt,'explain'),'quiz')
 assert.equal(client.inferTutorLocalMode('Створи навчальні картки за конспектом','explain'),'cards');assert.equal(client.inferTutorLocalMode('Склади план підготовки','quiz'),'plan');assert.equal(client.inferTutorLocalMode('Розв’яжи задачу з джерела','explain'),'math');assert.equal(client.inferTutorLocalMode('Поясни чому в тесті є помилка','quiz'),'explain');assert.equal(client.inferTutorLocalMode('Матеріал містить слово тест','cards'),'cards')
})

test('a broken response stream cannot leak a raw error to the configuration UI',async()=>{
 const api=client.createMaxTutorLocalClient(async()=>new Response(new ReadableStream({start(controller){controller.error(Error('private-provider-stream-secret'))}}),{headers:{'content-type':'application/json'}}));await assert.rejects(()=>api.status(),error=>error.name==='MaxTutorLocalClientError'&&!error.message.includes('private'))
})


test('personal follow-up includes actual submitted wrong choice, generated key and score without expanding sources',()=>{
 const example=plain(tutor.createTutorDemo('personal-followup','quiz')),run={id:'personal-followup',createdAt:'2026-11-16T10:00:00Z',demo:false,...example,progress:plain(tutor.emptyTutorProgress())},[first,second,third]=run.bundle.questions;
 run.request.sources[0].text+=' SOURCE_BODY_NOT_IN_PROMPT';run.progress.answers[first.id]=(first.correctIndex+1)%first.options.length;run.progress.answers[second.id]=second.correctIndex;run.progress.submitted=[first.id,second.id];const before=JSON.stringify(run);
 for(const mode of ['explain','cards','quiz']){const prompt=client.buildTutorPersonalFollowUp(run,mode);assert.ok(prompt.includes(first.text));assert.ok(prompt.includes('Моя перевірена відповідь: '+first.options[run.progress.answers[first.id]]));assert.ok(prompt.includes('Відповідь за згенерованим ключем: '+first.options[first.correctIndex]));assert.ok(prompt.includes('1 правильних із 3 запитань; перевірено 2'));assert.ok(prompt.includes('модель може помилятися'));assert.ok(!prompt.includes(third.text));assert.ok(!prompt.includes('SOURCE_BODY_NOT_IN_PROMPT'));assert.ok(prompt.length<=2400)}
 assert.equal(JSON.stringify(run),before)
})

test('personal follow-up is bounded to three mistakes and preserves the warning with maximum-length questions',()=>{
 const example=plain(tutor.createTutorDemo('long-followup','quiz')),run={id:'long-followup',createdAt:'2026-11-16T10:00:00Z',demo:false,...example,progress:plain(tutor.emptyTutorProgress())};run.bundle.questions=Array.from({length:12},(_,i)=>({id:'question-'+i,text:('QUESTION_'+i+' ').repeat(90).slice(0,1000),options:[('CORRECT_'+i+' ').repeat(90).slice(0,500),('WRONG_'+i+' ').repeat(90).slice(0,500)],correctIndex:0,explanation:'Звірся з джерелом.',sourceId:run.request.sources[0].id}));for(const question of run.bundle.questions){run.progress.answers[question.id]=1;run.progress.submitted.push(question.id)}const prompt=client.buildTutorPersonalFollowUp(run,'quiz');assert.ok(prompt.length<=2400);assert.equal((prompt.match(/Моя перевірена відповідь:/g)||[]).length,3);assert.ok(prompt.includes('QUESTION_2'));assert.ok(!prompt.includes('QUESTION_3'));assert.ok(prompt.includes('модель може помилятися'))
})

test('demo or unsubmitted attempts do not become personal feedback or reveal untouched answer keys',()=>{
 const example=plain(tutor.createTutorDemo('unsubmitted','quiz')),run={id:'unsubmitted',createdAt:'2026-11-16T10:00:00Z',demo:false,...example,progress:plain(tutor.emptyTutorProgress())};const first=run.bundle.questions[0];run.progress.answers[first.id]=(first.correctIndex+1)%first.options.length;assert.ok(!client.buildTutorPersonalFollowUp(run,'explain').includes('Моя перевірена відповідь'));run.progress.submitted=[first.id];run.demo=true;assert.ok(!client.buildTutorPersonalFollowUp(run,'explain').includes(first.text));assert.ok(!client.buildTutorPersonalFollowUp(run,'plan').includes('Моя перевірена відповідь'))
})
