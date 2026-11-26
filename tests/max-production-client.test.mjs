import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import ts from 'typescript'
import {readFileSync} from 'node:fs'
const compile=path=>ts.transpileModule(readFileSync(new URL('../'+path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText
const progress={};vm.runInNewContext(compile('src/lib/maxTutorProgress.ts'),{exports:progress,TextDecoder,TextEncoder,Uint8Array,JSON,Number});
const tutor={},study={},client={},credits={};vm.runInNewContext(compile('src/lib/maxTutorCredits.ts'),{exports:credits,JSON,Date,Number,Set,Map,require(name){if(name==='./aiCreditTerms')return {AI_CREDIT_TERMS_VERSION:'2026-11-17.1'};throw Error('Unexpected '+name)}});vm.runInNewContext(compile('src/lib/maxTutorStudy.ts'),{exports:study,TextEncoder});vm.runInNewContext(compile('src/lib/maxTutor.ts'),{exports:tutor,JSON,Date,Math,Number,Set,Map,TextEncoder,Promise,require(name){if(name==='./maxTutorStudy.js')return study;throw Error('Unexpected '+name)}});const groupMaterials={};vm.runInNewContext(compile('src/lib/studentGroupMaterials.ts'),{exports:groupMaterials,Set,Map,TextEncoder,require(name){if(name==='./maxTutor.js')return tutor;throw Error(name)}});vm.runInNewContext(compile('src/lib/maxTutorProductionClient.ts'),{exports:client,JSON,Date,Math,Number,Set,Map,TextEncoder,TextDecoder,Promise,fetch,require(name){if(name==='./studentGroupMaterials')return groupMaterials;if(name==='./maxTutor')return tutor;if(name==='./maxTutorProgress')return progress;if(name==='./maxTutorCredits')return credits;throw Error('Unexpected '+name)}})
const plain=x=>JSON.parse(JSON.stringify(x)),json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}}),scope={userId:'owner-1',sessionId:'session-1'}
const run=()=>{const example=plain(tutor.createTutorDemo('run-1','quiz'));return {id:'run-1',createdAt:'2026-11-16T12:00:00Z',demo:false,...example,progress:plain(tutor.emptyTutorProgress()),revision:1}}
const status=(extra={})=>({status:'ready',scope,audience:'student',planId:'max',canGenerate:true,canEdit:true,available:true,model:'gpt-6.1-sol',budget:{limitUsd:10,spentUsd:0,reservedUsd:0,remainingUsd:10},localOnly:false,budgetPeriod:'subscription_month',budgetResetsAt:'2026-12-01T00:00:00Z',...extra})
const history=(runs=[run()])=>({status:'ready',scope,runs,activeRunId:runs[0]?.id||''})

test('production status rejects local mode, credentials, foreign identities and forged tier permissions',()=>{
 assert.equal(client.parseProductionMaxStatus(status(),'owner-1').planId,'max')
 for(const extra of [{apiKey:'never-return-this'},{localOnly:true},{scope:{userId:'owner-2',sessionId:'session-1'}},{audience:'unresolved'},{planId:'start'},{available:false},{budgetPeriod:'paid_anniversary'},{budgetResetsAt:'invalid'},{budgetResetsAt:null},{budgetPeriod:'utc_calendar_month'},{budget:{limitUsd:11,spentUsd:0,reservedUsd:0,remainingUsd:11}}])assert.throws(()=>client.parseProductionMaxStatus(status(extra),'owner-1'))
 assert.equal(client.parseProductionMaxStatus(status({planId:'free',canGenerate:false}),'owner-1').canEdit,true)
})

test('group material client uses the authenticated endpoint and discards a response after account/session replacement',async()=>{
 const group='22222222-2222-4222-8222-222222222222',material='33333333-3333-4333-8333-333333333333',id='gm_s_'+group+'_'+material
 let credential={userId:scope.userId,sessionId:scope.sessionId,accessToken:'synthetic-token'},change=false
 const calls=[],source={id,title:'Попит',text:'Попит залежить від ціни.',page:null,kind:'own_excerpt'}
 const api=client.createMaxTutorProductionClient({ownerId:scope.userId,credential:async()=>credential,fetcher:async(url,init)=>{
  calls.push({url,...init});const op=JSON.parse(init.body)
  const value=op.operation==='groups'?[{id:group,name:'Група'}]:op.operation==='list'?{items:[{id,title:'Попит',subject:'Економіка',allowAi:true}],truncated:false}:{source,truncated:false}
  if(change)credential={...credential,sessionId:'other-session'}
  return json({status:'ready',scope,value})
 }})
 assert.equal((await api.materials.groups())[0].id,group);assert.equal((await api.materials.list(group)).items[0].id,id)
 assert.deepEqual(plain(await api.materials.preview(id)),{source,truncated:false})
 for(const call of calls){assert.equal(call.url,'/api/student-learning?action=materials');assert.equal(call.method,'POST');assert.equal(call.headers.Authorization,'Bearer synthetic-token');assert.equal(call.cache,'no-store')}
 change=true;await assert.rejects(api.materials.preview(id),e=>e.code==='identity_changed')
})

test('verified optional profile label is backward compatible and cannot smuggle markup or contact fields',()=>{
 assert.equal(client.parseProductionMaxStatus(status({profileDisplayName:'Олег'}),'owner-1').profileDisplayName,'Олег')
 assert.equal(client.parseProductionMaxStatus(status(),'owner-1').profileDisplayName,undefined)
 for(const profileDisplayName of['',null,'<img src=x>','x'.repeat(121),'bad\nname'])assert.throws(()=>client.parseProductionMaxStatus(status({profileDisplayName}),'owner-1'))
 assert.throws(()=>client.parseProductionMaxStatus(status({profileDisplayName:'Олег',email:'private@example.org'}),'owner-1'))
})
test('history validates real owner runs, literal source references and complete progress without dropping malformed answers',()=>{
 const r=run(),q=r.bundle.questions[0];r.progress.answers[q.id]=1;r.progress.submitted=[q.id]
 const result=client.parseProductionTutorHistory(history([r]),'owner-1');assert.deepEqual(plain(result.runs[0].progress),r.progress)
 for(const bad of [{...r,demo:true},{...r,id:'other'},{...r,revision:-1},{...r,progress:{...r.progress,answers:{foreign:0}}},{...r,progress:{...r.progress,submitted:['foreign']}},{...r,progress:{...r.progress,doneTasks:['foreign:0']}},{...r,progress:{...r.progress,answers:{[q.id]:9}}}])assert.throws(()=>client.parseProductionTutorHistory(history([bad]),'owner-1'))
 assert.throws(()=>client.parseProductionTutorHistory({...history(),scope:{userId:'other',sessionId:'session-1'}},'owner-1'))
})

test('rolling deployment accepts only the old six-unit calendar contract until paid-period migration is active',()=>{
 const legacy=status({budgetPeriod:'utc_calendar_month',budget:{limitUsd:6,spentUsd:1,reservedUsd:0,remainingUsd:5}})
 assert.equal(client.parseProductionMaxStatus(legacy,'owner-1').budget.limitUsd,6)
 assert.throws(()=>client.parseProductionMaxStatus({...legacy,budget:{limitUsd:10,spentUsd:0,reservedUsd:0,remainingUsd:10}},'owner-1'))
})
test('production network uses one fixed authenticated endpoint and never accepts key or plan configuration',async()=>{
 const calls=[],r=run(),api=client.createMaxTutorProductionClient({ownerId:'owner-1',credential:async()=>({userId:'owner-1',accessToken:'synthetic-access-token'}),fetcher:async(url,options)=>{calls.push({url,options});if(url.endsWith('status'))return json(status());if(url.endsWith('history'))return json(history([r]));if(url.endsWith('generate'))return json({status:'ready',bundle:r.bundle,run:r,replayed:false});const p=JSON.parse(options.body).progress;return json({status:'ready',run:{...r,progress:p,revision:2}})}})
 await api.status();await api.history();await api.generate(r.request);const p={...r.progress,answers:{[r.bundle.questions[0].id]:0}};const saved=await api.progress(r,p);assert.equal(saved.revision,2)
 assert.deepEqual(calls.map(c=>c.url),['/api/student-learning?action=status','/api/student-learning?action=history','/api/student-learning?action=generate','/api/student-learning?action=progress'])
 for(const call of calls){assert.equal(call.options.credentials,'omit');assert.equal(call.options.cache,'no-store');assert.equal(call.options.redirect,'error');assert.equal(call.options.headers.Authorization,'Bearer synthetic-access-token');assert.ok(!call.options.body?.includes('synthetic-access-token'))}
 const body=JSON.parse(calls[3].options.body);assert.deepEqual(Object.keys(body).sort(),['expectedRevision','progress','runId']);assert.equal(body.expectedRevision,1)
})
test('an account change before or during a request cannot expose the previous owner response',async()=>{
 let owner='owner-2',calls=0;const api=client.createMaxTutorProductionClient({ownerId:'owner-1',credential:async()=>({userId:owner,accessToken:'synthetic'}),fetcher:async()=>{calls++;owner='owner-2';return json(status())}})
 await assert.rejects(()=>api.status(),e=>e.code==='signed_out');assert.equal(calls,0);owner='owner-1';await assert.rejects(()=>api.status(),e=>e.code==='identity_changed');assert.equal(calls,1)
})
test('revision conflicts retain current server data and cannot become a silent successful overwrite',async()=>{
 const r=run(),current={...r,revision:3},api=client.createMaxTutorProductionClient({ownerId:'owner-1',credential:async()=>({userId:'owner-1',accessToken:'synthetic'}),fetcher:async()=>json({status:'conflict',run:current},409)})
 await assert.rejects(()=>api.progress(r,r.progress),e=>e.code==='conflict'&&e.currentRun.revision===3)
})
test('reload restores queued own answers while stale revisions and old unknown runs remain explicit conflicts',()=>{
 const r=run(),h=client.parseProductionTutorHistory(history([r]),'owner-1'),progress={...r.progress,answers:{[r.bundle.questions[0].id]:2},submitted:[r.bundle.questions[0].id]},raw=revision=>JSON.stringify({version:1,ownerId:'owner-1',items:{'run-1':{revision,progress}}})
 const ok=client.restoreProductionProgress(h,raw(1));assert.equal(ok.conflict,false);assert.deepEqual(plain(ok.state.runs[0].progress),progress);assert.equal(ok.pending['run-1'].revision,1)
 const rebased=client.restoreProductionProgress(h,raw(0));assert.equal(rebased.conflict,false);assert.equal(rebased.pending['run-1'].revision,1)
 const remote=run();remote.progress.answers[remote.bundle.questions[0].id]=0;remote.progress.submitted=[remote.bundle.questions[0].id];remote.revision=2;const stale=client.restoreProductionProgress(client.parseProductionTutorHistory(history([remote]),'owner-1'),raw(1));assert.equal(stale.conflict,true);assert.deepEqual(plain(stale.state.runs[0].progress),progress)
 const other=client.restoreProductionProgress(h,raw(1).replace('owner-1','owner-2'));assert.deepEqual(plain(other.pending),{});assert.deepEqual(plain(other.state.runs[0].progress),r.progress)
 const old=client.restoreProductionProgress(h,JSON.stringify({version:1,ownerId:'owner-1',items:{'older-run':{revision:1,progress}}}));assert.equal(old.conflict,true);assert.ok(old.pending['older-run'])
})
test('production UI has no model key form, delegates cloud save and retains explicit source permission',()=>{
 const page=readFileSync(new URL('../src/pages/StudentLearningPage.tsx',import.meta.url),'utf8'),wrapper=readFileSync(new URL('../src/components/student/ProductionMaxTutorAssistant.tsx',import.meta.url),'utf8'),ui=readFileSync(new URL('../src/components/student/MaxTutorAssistant.tsx',import.meta.url),'utf8')
 const compact=ui.replace(/\s+/g,'')
 assert.ok(page.includes('supabase.auth.getSession()'));assert.ok(!wrapper.includes('apiKey'));assert.ok(wrapper.includes('client.progress('));assert.match(wrapper, /productionMode\b[^>]*\binitialState=\{initial\}/);assert.ok(wrapper.includes('saveState={{saving,error}}'));assert.ok(compact.includes('!productionMode&&<>'));assert.ok(compact.includes('if(!social&&currentSources.length&&(!consent||consentSignature.current!==sourceSignature))'));assert.ok(!wrapper.includes('/api/local-max/'))
})
test('same-owner session replacement and broken response streams discard output without leaking raw exceptions',async()=>{
 let sessionId='session-1';const api=client.createMaxTutorProductionClient({ownerId:'owner-1',credential:async()=>({userId:'owner-1',accessToken:'synthetic',sessionId}),fetcher:async()=>{sessionId='session-2';return json(status())}})
 await assert.rejects(()=>api.status(),e=>e.code==='identity_changed')
 const broken=client.createMaxTutorProductionClient({ownerId:'owner-1',credential:async()=>({userId:'owner-1',accessToken:'synthetic'}),fetcher:async()=>new Response(new ReadableStream({start(c){c.error(Error('private-response-secret'))}}),{headers:{'content-type':'application/json'}})})
 await assert.rejects(()=>broken.status(),e=>e.name==='MaxTutorProductionError'&&!e.message.includes('private-response'))
})
test('semantic answer updates enter the durable outbox synchronously before navigation, while replay preserves server progress',()=>{
 const ui=readFileSync(new URL('../src/components/student/MaxTutorAssistant.tsx',import.meta.url),'utf8'),wrapper=readFileSync(new URL('../src/components/student/ProductionMaxTutorAssistant.tsx',import.meta.url),'utf8')
 const compact=ui.replace(/\s+/g,''),update=compact.slice(compact.indexOf('functionupdateProgress('),compact.indexOf('functionaddRun('))
 assert.ok(compact.includes('constnext=update(latest.current);latest.current=next;setState(next)'))
 assert.ok(update.includes('onProgressChange?.(runId,progress)'));assert.ok(update.indexOf('commit(')<update.indexOf('onProgressChange?.('))
 assert.ok(wrapper.includes('pending.current[runId]={revision:saved.revision,progress};persist()'))
 assert.ok(compact.includes('constsaved=resolveGeneratedRun?.(request)'))
 assert.ok(wrapper.includes('resolveGeneratedRun={request=>runs.current.get(request.requestId)}'))
})
test('production tool defaults and corrupt own storage stay empty instead of resurrecting fictional records',()=>{
 const modules={};for(const [name,file]of Object.entries({desk:'studentDeskTools',academic:'maxAcademic',coursework:'maxCourseworkStudio',planner:'studentSessionPlanner',research:'maxResearchStudio'})){const exports={};vm.runInNewContext(compile('src/lib/'+file+'.ts'),{exports,Date,Math,Number,JSON,Set,Map,TextEncoder,URL,Blob,ArrayBuffer,Uint8Array,Promise});modules[name]=exports}
 const day='2026-11-16';for(const raw of [null,'{broken']){
  const desk=modules.desk.parseDeskState(raw,day,Date.now(),true);assert.equal(desk.tasks.length,0);assert.equal(desk.saved.length,0)
  assert.equal(modules.academic.parseAcademicState(raw,true).courses.length,0)
  assert.equal(modules.coursework.parseCourseworkState(raw,day,true).projects.length,0)
  assert.equal(modules.planner.parseSessionPlanner(raw,day,true).exams.length,0)
  const research=modules.research.parseResearchState(raw,true);assert.equal(research.sources.length,0);assert.equal(research.activeId,'')
 }
 assert.notEqual(modules.research.researchOwnerDatabaseName('owner-a'),modules.research.researchOwnerDatabaseName('owner-b'))
 assert.notEqual(modules.research.researchOwnerDatabaseName('owner-a'),modules.research.researchOwnerDatabaseName())
 assert.throws(()=>modules.research.researchOwnerDatabaseName('../owner'))
 for(const file of ['StudentDeskTools','StudentPracticeLab','StudentSessionPlanner','MaxResearchStudio','MaxCourseworkStudio','MaxAcademicStudio']){const source=readFileSync(new URL('../src/components/student/'+file+'.tsx',import.meta.url),'utf8');assert.ok(source.includes("':owner:'+storageOwner"),file);assert.ok(source.includes('emptyStart'),file)}
})
test('expired subscriptions keep every owned tool mounted for reading and export without write actions',()=>{
 const page=readFileSync(new URL('../src/pages/StudentLearningPage.tsx',import.meta.url),'utf8'),desk=readFileSync(new URL('../src/components/student/StudentDeskTools.tsx',import.meta.url),'utf8'),practice=readFileSync(new URL('../src/components/student/StudentPracticeLab.tsx',import.meta.url),'utf8')
 assert.ok(page.includes('<StudentDeskTools storageOwner={userId} emptyStart enabled={paid}/>'))
 assert.ok(page.includes("<StudentPracticeLab plan={paid&&['plus','max'].includes(status.planId)?plan:'start'}"))
 assert.ok(!page.includes("{tab==='tools'&&(paid?"));assert.ok(!page.includes("{tab==='practice'&&(paid"))
 assert.ok(desk.includes('function mutate(update:(value:DeskState)=>DeskState){if(enabled)setState(update)}'));assert.ok(desk.includes('onClick={downloadOwn}'))
 assert.ok(practice.includes('function chooseAnswer(index: number) { if (!canCreate'))
})
