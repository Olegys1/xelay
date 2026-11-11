import test from 'node:test'
import assert from 'node:assert/strict'
import { createOpenAiCloudTaskModel,assistantImageTokenUpperBound } from '../../server/assistant-v2/cloudTaskModel.ts'
import { createAssistantCloudTools } from '../../server/assistant-v2/cloudTools.ts'
import { allowedCloudSkillActions,routeCloudSkill,cloudSubjectEvidence } from '../../server/assistant-v2/cloudSkills.ts'
import { parseCloudAssistantDate,parseCloudAssistantDeadline } from '../../server/assistant-v2/cloudDates.ts'
const owner='10000000-0000-4000-8000-000000000001',group='20000000-0000-4000-8000-000000000001',subject='30000000-0000-4000-8000-000000000001',lesson='40000000-0000-4000-8000-000000000001',material='50000000-0000-4000-8000-000000000001',request='60000000-0000-4000-8000-000000000001'
const now=Date.parse('2026-11-01T10:00:00Z'),session={userId:owner,sessionId:'synthetic-session',accountActive:true,emailConfirmed:true,expiresAt:'2026-12-01T00:00:00Z'}
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'content-type':'application/json'}})
const moderation=(flagged=false)=>({results:[{flagged,categories:{violence:flagged}}]})
const response=value=>({status:'completed',service_tier:'default',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{input_tokens:100,output_tokens:50}})
const task={task:'explain',data:{material:'Похідна x² дорівнює 2x.',question:'Поясни похідну'}}
const explanation={safe:true,answer:'Похідна показує швидкість зміни.',quotes:['Похідна']}
test('question recognition uses the fixed tool-free model schema and moderates both boundaries', async () => {
  const calls = [], recognized = { draftText: '1. Що таке похідна?\nТип: есе', notes: [] }
  const model = createOpenAiCloudTaskModel({ apiKey: 'sk-' + 'test'.repeat(12), enabled: true, billingApproved: true, fetchImpl: async (url, init) => {
    calls.push({ url, payload: JSON.parse(init.body) })
    return json(url.endsWith('/moderations') ? moderation() : response(recognized))
  } })
  assert.deepEqual((await model.generate({ task: 'test-import', data: { source: 'Що таке похідна?' } })).value, recognized)
  assert.deepEqual(calls.map(call => call.url.split('/').at(-1)), ['moderations', 'responses', 'moderations'])
  assert.equal(calls[1].payload.store, false)
  assert.equal(calls[1].payload.tools, undefined)
  assert.equal(calls[1].payload.text.format.name, 'xelay_test_import')
  assert.match(calls[1].payload.instructions, /Never generate new questions, solve the test, guess a key/)
  assert.match(calls[1].payload.instructions, /Missing types or keys are NOT a reason to omit a readable question/)
  assert.match(calls[1].payload.instructions, /teacher will set all absent answer keys in preview/)
})
test('task generation is one Standard stored=false response between two safety checks',async()=>{
  const calls=[];const model=createOpenAiCloudTaskModel({apiKey:'sk-'+ 'test'.repeat(12),enabled:true,billingApproved:true,fetchImpl:async(url,init)=>{calls.push({url,payload:JSON.parse(init.body),redirect:init.redirect});return json(url.endsWith('/moderations')?moderation():response(explanation))}})
  const result=await model.generate(task)
  assert.equal(calls.filter(c=>c.url.endsWith('/responses')).length,1);assert.equal(calls.length,3)
  const paid=calls[1];assert.equal(paid.payload.store,false);assert.equal(paid.payload.service_tier,'default');assert.equal(paid.payload.tools,undefined);assert.equal(paid.redirect,'error');assert.deepEqual(result.usage,{inputTokens:100,outputTokens:50})
})
test('unsafe or unavailable input moderation cannot dispatch the paid model',async()=>{
  for(const unavailable of [false,true]){let calls=0;const model=createOpenAiCloudTaskModel({apiKey:'sk-'+ 'test'.repeat(12),enabled:true,billingApproved:true,fetchImpl:async()=>{calls++;return unavailable?json({},403):json(moderation(true))}});await assert.rejects(model.generate(task),{code:unavailable?'model_safety_unavailable':'model_refused'});assert.equal(calls,1)}
})
test('unsafe generated content is never returned',async()=>{
  let calls=0;const model=createOpenAiCloudTaskModel({apiKey:'sk-'+ 'test'.repeat(12),enabled:true,billingApproved:true,fetchImpl:async()=>json(++calls===2?response(explanation):moderation(calls===3))});await assert.rejects(model.generate(task),{code:'model_refused'});assert.equal(calls,3)
})
test('task model rejects remote images and oversized text before any network call',async()=>{
  let calls=0;const model=createOpenAiCloudTaskModel({apiKey:'sk-'+ 'test'.repeat(12),enabled:true,billingApproved:true,fetchImpl:async()=>{calls++;throw Error('must not fetch')}})
  await assert.rejects(model.generate({...task,images:[{mimeType:'image/png',data:'https://attacker.invalid/file'}]}),{code:'invalid_request'})
  await assert.rejects(model.generate({...task,data:{text:'x'.repeat(49000)}}),{code:'model_context_too_large'});assert.equal(calls,0)
})
test('server pixel and combined UTF8/vision bounds reject a costly image request before network',async()=>{
  const header=(w,h)=>{const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(w,16);b.writeUInt32BE(h,20);return{mimeType:'image/png',data:b.toString('base64')}}
  assert.equal(assistantImageTokenUpperBound(header(1280,1280)),1921)
  assert.throws(()=>assistantImageTokenUpperBound(header(1281,1280)),{code:'model_context_too_large'})
  let calls=0;const model=createOpenAiCloudTaskModel({apiKey:'sk-'+ 'test'.repeat(12),enabled:true,billingApproved:true,fetchImpl:async()=>{calls++;throw Error('must not fetch')}})
  await assert.rejects(model.generate({task:'timetable',data:{text:'x'.repeat(21000)},images:Array.from({length:10},()=>header(1280,1280))}),{code:'model_context_too_large'});assert.equal(calls,0)
})
function toolFixture(overrides={}){
  const prepared=[],modelCalls=[]
  const deps={verifySession:async()=>session,catalog:async()=>({userId:owner,groups:[{id:group,name:'ЕУБ-1',course:1,learning:true,permissions:['schedule','homework']}],subjects:[{id:subject,groupId:group,kind:'study',name:'Вища математика'}]}),read:async()=>({userId:owner,records:[{kind:'lesson',groupId:group,subjectId:subject,scheduleId:lesson,date:'2026-11-02'}]}),prepare:async(_c,p)=>{prepared.push(p);return{draft:{id:'draft-'+prepared.length,status:'pending',...p}}},model:async(_c,_id,t)=>{modelCalls.push(t);return t.task==='timetable'?{needsClarification:false,groups:[],questions:[],rowsTsv:'1\t08:30\t09:50\tВища математика\tlecture\tboth\t203\tІрина Прикладова'}:t.task==='explain'?explanation:{needsClarification:false,items:[{subject:'subject1',dateSource:'на завтра',bodyQuote:'Вправа 5',topic:'Вправа 5',deadlineSource:''}]}},materialContent:async()=>({userId:owner,allowAi:true,title:'Похідна',text:'Похідна x² дорівнює 2x.',rightsVersion:'version1',sources:[]}),now:()=>now,...overrides}
  return{tools:createAssistantCloudTools(deps),prepared,modelCalls}
}
const source='Вища математика на завтра: Вправа 5. Якщо пару перенесуть, нічого не здавайте.'
test('question recognition rejects mixed sources, invalid images and revoked course permissions', async () => {
  let permissionChecks = 0, modelCalls = 0
  const f = toolFixture({ canImportTestQuestions: async () => ++permissionChecks === 1, model: async () => {
    modelCalls++; return { draftText: '1. Що таке похідна?\nТип: есе', notes: [] }
  } })
  const body = { requestId: request, courseId: subject, consent: true, sourceText: 'Що таке похідна?' }
  await assert.rejects(f.tools.importTestQuestions('credential', { ...body, image: 'AAAA' }), { code: 'invalid_request' })
  await assert.rejects(f.tools.importTestQuestions('credential', body), { code: 'permission_required' })
  assert.equal(permissionChecks, 2)
  assert.equal(modelCalls, 1)
  const permitted = toolFixture({ canImportTestQuestions: async () => true })
  await assert.rejects(permitted.tools.importTestQuestions('credential', { requestId: request, courseId: subject, consent: true, image: 'AAAA' }), { code: 'attachment_content_invalid' })
  assert.equal(permitted.modelCalls.length, 0)
})
test('batch homework keeps the complete conditional source and binds actual lesson/date',async()=>{
  const f=toolFixture(),r=await f.tools.batchHomework('credential',{requestId:request,scope:{groupId:group},source})
  assert.equal(r.drafts.length,1);assert.equal(f.prepared[0].payload.body,source);assert.equal(f.prepared[0].payload.lessonId,lesson);assert.equal(f.prepared[0].payload.date,'2026-11-02');assert.equal(f.prepared[0].payload.dueAt,null)
})
test('a valid batch subject slot cannot replace the different subject actually named in the teacher source',async()=>{
  const f=toolFixture(),otherSource='Економічна теорія на завтра: Вправа 5.'
  const result=await f.tools.batchHomework('credential',{requestId:request,scope:{groupId:group},source:otherSource})
  assert.equal(result.drafts.length,0);assert.equal(f.prepared.length,0)
})
test('grounded higher-math aliases and a selected subject remain usable without inventing the subject',async()=>{
  for(const [copy,scope] of [['Вышмату на завтра: Вправа 5.',{groupId:group}],['Завдання на завтра: Вправа 5.',{groupId:group,subjectId:subject}]]){
    const f=toolFixture(),result=await f.tools.batchHomework('credential',{requestId:request,scope,source:copy})
    assert.equal(result.drafts.length,1);assert.equal(f.prepared[0].payload.body,copy)
  }
  assert.equal(cloudSubjectEvidence('Економічна теорія','Економічна',['Економічна на завтра']),true)
  assert.equal(cloudSubjectEvidence('Економічна теорія','subject1',['Назавтра Вправа 5']),false)
  assert.equal(cloudSubjectEvidence('Економічна теорія','Економічна',['Вища математика на завтра']),false)
  assert.equal(cloudSubjectEvidence('Економічна теорія','те',['те на завтра']),false)
  assert.equal(cloudSubjectEvidence('Вища математика для економістів','subject1',['Вышмат на завтра'],['Вища математика для економістів','Вища математика для менеджерів']),false)
  assert.equal(cloudSubjectEvidence('Економічна теорія','Економічна',['Економічна на завтра'],['Економічна теорія','Економічна історія']),false)
})
test('a useful literal batch subject alias must uniquely match the real catalog and the source',async()=>{
  const f=toolFixture({catalog:async()=>({userId:owner,groups:[{id:group,learning:true,permissions:['homework']}],subjects:[{id:subject,groupId:group,kind:'study',name:'Економічна теорія'}]}),model:async()=>({needsClarification:false,items:[{subject:'Економічна',dateSource:'на завтра',bodyQuote:'Вправа 5',topic:'Вправа 5',deadlineSource:''}]})})
  const result=await f.tools.batchHomework('credential',{requestId:request,scope:{groupId:group},source:'Економічна на завтра: Вправа 5.'})
  assert.equal(result.drafts.length,1);assert.equal(f.prepared[0].payload.lessonId,lesson)
})
test('partially prepared batch returns only completed review links, with no automatic retry or write',async()=>{
  let attempts=0,modelCalls=0
  const f=toolFixture({read:async(_c,p)=>({userId:owner,records:[{kind:'lesson',groupId:group,subjectId:subject,scheduleId:lesson,date:p.scope.from}]}),prepare:async(_c,p)=>{if(++attempts===2)throw Object.assign(Error('private backend detail'),{code:'too_many_pending_drafts'});return{draft:{id:'first-review-link',status:'pending',...p}}},model:async()=>{modelCalls++;return{needsClarification:false,items:[{subject:'subject1',dateSource:'на завтра',bodyQuote:'Вправа 5',topic:'Вправа 5',deadlineSource:''},{subject:'subject1',dateSource:'на післязавтра',bodyQuote:'Вправа 6',topic:'Вправа 6',deadlineSource:''}]}}})
  const result=await f.tools.batchHomework('credential',{requestId:request,scope:{groupId:group},source:'Вища математика на завтра: Вправа 5; на післязавтра: Вправа 6.'})
  assert.equal(result.drafts.length,1);assert.equal(result.drafts[0].id,'first-review-link');assert.equal(result.drafts[0].status,'pending')
  assert.equal(attempts,2);assert.equal(modelCalls,1);assert.ok(!JSON.stringify(result).includes('private backend detail'))
  assert.match(result.text,/автоматичних повторів немає/)
})
test('a session switched during a partial batch cannot receive the previous owner review links',async()=>{
  let attempts=0,switched=false
  const f=toolFixture({verifySession:async()=>({...session,...(switched?{userId:'10000000-0000-4000-8000-000000000002'}:{})}),read:async(_c,p)=>({userId:owner,records:[{kind:'lesson',groupId:group,subjectId:subject,scheduleId:lesson,date:p.scope.from}]}),prepare:async(_c,p)=>{if(++attempts===2){switched=true;throw Error('private detail')}return{draft:{id:'private-owner-review',status:'pending',...p}}},model:async()=>({needsClarification:false,items:[{subject:'subject1',dateSource:'на завтра',bodyQuote:'Вправа 5',topic:'Вправа 5',deadlineSource:''},{subject:'subject1',dateSource:'на післязавтра',bodyQuote:'Вправа 6',topic:'Вправа 6',deadlineSource:''}]})})
  await assert.rejects(f.tools.batchHomework('credential',{requestId:request,scope:{groupId:group},source:'Вища математика на завтра: Вправа 5; на післязавтра: Вправа 6.'}),{code:'session_changed'})
  assert.equal(attempts,2)
})
test('a forged date quote or invented subject cannot create homework',async()=>{
  for(const forged of [{subject:'foreign',dateSource:'на завтра'},{subject:'subject1',dateSource:'у наступному місяці'}]){const f=toolFixture({model:async()=>({needsClarification:false,items:[{...forged,bodyQuote:'Вправа 5',topic:'Вправа 5',deadlineSource:''}]})});try{await f.tools.batchHomework('credential',{requestId:request,scope:{groupId:group},source})}catch(error){assert.equal(error.code,'model_invalid_response')}assert.equal(f.prepared.length,0)}
})
test('ambiguous duplicate lessons are clarified before any batch draft',async()=>{
  const f=toolFixture({read:async()=>({userId:owner,records:[{kind:'lesson',subjectId:subject,scheduleId:lesson,date:'2026-11-02'},{kind:'lesson',subjectId:subject,scheduleId:'40000000-0000-4000-8000-000000000002',date:'2026-11-02'}]})})
  const r=await f.tools.batchHomework('credential',{requestId:request,scope:{groupId:group},source});assert.equal(r.drafts.length,0);assert.equal(f.prepared.length,0)
})
test('student without schedule permission cannot parse or send an import source',async()=>{
  const f=toolFixture({catalog:async()=>({userId:owner,groups:[{id:group,learning:true,permissions:[]}],subjects:[]})})
  await assert.rejects(f.tools.importSchedule('credential',{requestId:request,scope:{groupId:group},files:[],googleSheetUrl:'https://docs.google.com/spreadsheets/d/abcdefghijk/edit',validFrom:'2026-11-02',validUntil:'2026-12-01'}),{code:'permission_required'});assert.equal(f.modelCalls.length,0)
})
test('a non-Monday upper-week anchor is rejected before recognition or draft preparation',async()=>{
  const f=toolFixture()
  await assert.rejects(f.tools.importSchedule('credential',{requestId:request,scope:{groupId:group},files:[{name:'table.csv',mimeType:'text/csv',data:Buffer.from('Day,Subject\nMon,Math').toString('base64')}],validFrom:'2026-11-02',validUntil:'2026-12-01',weekAnchorDate:'2026-11-03'}),{code:'invalid_date_range'})
  assert.equal(f.modelCalls.length,0);assert.equal(f.prepared.length,0)
})
test('initial import returns prepared review links and unprepared queue after a partial failure',async()=>{
  let attempts=0
  const f=toolFixture({prepare:async(_c,plan)=>{if(++attempts===3)throw Object.assign(Error('pending limit'),{code:'too_many_pending_drafts'});return{draft:{id:'draft-'+attempts,status:'pending',...plan}}},model:async()=>({needsClarification:false,groups:[],questions:[],rowsTsv:[1,2,3,4].map((d)=>`${d}\t08:30\t09:50\tВища математика\tlecture\tboth\t203\tПриклад`).join('\n')})})
  const file={name:'schedule.csv',mimeType:'text/csv',data:Buffer.from('День,Предмет\nПонеділок,Вища математика').toString('base64')}
  const result=await f.tools.importSchedule('credential',{requestId:request,scope:{groupId:group},files:[file],validFrom:'2026-11-02',validUntil:'2026-12-01'})
  assert.equal(result.drafts.length,2);assert.equal(result.remaining.length,2);assert.equal(result.remaining[0].payload.weekday,3);assert.equal(attempts,3)
})
test('the last imported row preserves empty trailing room and teacher cells',async()=>{
  const f=toolFixture({model:async()=>({needsClarification:false,groups:[],questions:[],rowsTsv:'1\t08:30\t09:50\tВища математика\tlecture\tboth\t\t\n'})})
  const result=await f.tools.importSchedule('credential',{requestId:request,scope:{groupId:group},files:[{name:'table.csv',mimeType:'text/csv',data:Buffer.from('Day,Subject\nMon,Math').toString('base64')}],validFrom:'2026-11-02',validUntil:'2026-12-01'})
  assert.equal(result.drafts.length,1);assert.equal(result.drafts[0].payload.location,'');assert.equal(result.drafts[0].payload.teacherName,'')
})
test('overlapping model rows from mixed groups or wrongly equal weeks require clarification before any draft',async()=>{
  const f=toolFixture({model:async()=>({needsClarification:false,groups:[],questions:[],rowsTsv:'5\t08:30\t09:50\tВища математика\tpractical\tupper\t301\t\n5\t08:30\t09:50\tЕкономічна теорія\tseminar\tupper\t302\t'})})
  const result=await f.tools.importSchedule('credential',{requestId:request,scope:{groupId:group},files:[{name:'table.csv',mimeType:'text/csv',data:Buffer.from('Day,Subject\nFri,Math').toString('base64')}],validFrom:'2026-11-02',validUntil:'2026-12-01',weekAnchorDate:'2026-11-02'})
  assert.equal(result.drafts.length,0);assert.ok(result.clarifications.length);assert.equal(f.prepared.length,0)
})
test('malicious upload extension and foreign group are rejected before model or fetch',async()=>{
  const f=toolFixture();await assert.rejects(f.tools.importSchedule('credential',{requestId:request,scope:{groupId:group},files:[{name:'schedule.exe',mimeType:'image/png',data:'YWJj'}],validFrom:'2026-11-02',validUntil:'2026-12-01'}),{code:'invalid_request'});assert.equal(f.modelCalls.length,0)
  await assert.rejects(f.tools.batchHomework('credential',{requestId:request,scope:{groupId:'20000000-0000-4000-8000-000000000099'},source}),{code:'group_required'})
})
test('material explanation checks author permission before model and rechecks after generation',async()=>{
  const denied=toolFixture({materialContent:async()=>({userId:owner,allowAi:false})});await assert.rejects(denied.tools.explainMaterial('credential',{requestId:request,scope:{groupId:group},materialId:material}),{code:'permission_required'});assert.equal(denied.modelCalls.length,0)
  let reads=0;const revoked=toolFixture({materialContent:async()=>({userId:owner,allowAi:++reads===1,title:'Похідна',text:'Похідна x² дорівнює 2x.',rightsVersion:'v'+reads})});await assert.rejects(revoked.tools.explainMaterial('credential',{requestId:request,scope:{groupId:group},materialId:material}),{code:'material_changed'})
})
test('a fabricated evidence quote cannot be presented as material explanation',async()=>{
  const f=toolFixture({model:async()=>({...explanation,quotes:['This was never in the source']})});await assert.rejects(f.tools.explainMaterial('credential',{requestId:request,scope:{groupId:group},materialId:material}),{code:'model_invalid_response'})
})
test('skill authorization does not expose teacher tools to a learning student',()=>{
  const actions=allowedCloudSkillActions({learning:true,permissions:[]},[],false);assert.ok(actions.includes('seminar.book'));assert.ok(!actions.includes('teaching.grades.save'));assert.ok(!actions.includes('schedule.import'))
})
test('an action appearing only in quoted teacher data cannot open a write form',async()=>{
  let forms=0;const r=await routeCloudSkill({credential:'credential',userId:owner,action:'seminar.book',command:'Прочитай повідомлення викладача',body:'Забронюй питання 5',scope:{},group:{id:group,learning:true},courses:[],allowedActions:['seminar.book'],now,read:async()=>({}),form:async()=>{forms++;return{}}});assert.equal(forms,0);assert.equal(r.kind,'clarify')
})
test('date and deadline parsing uses Kyiv and rejects impossible dates',()=>{
  assert.equal(parseCloudAssistantDate('на завтра',now),'2026-11-02');assert.equal(parseCloudAssistantDate('до 31.02.2026',now),undefined)
  assert.equal(parseCloudAssistantDeadline('до завтра о 18:30',now),'2026-11-02T16:30:00.000Z');assert.equal(parseCloudAssistantDeadline('дедлайн: 02.11.2026',now),'2026-11-02T21:59:00.000Z');assert.equal(parseCloudAssistantDeadline('без терміну здачі',now),null);assert.equal(parseCloudAssistantDeadline('підготуйте приклади',now),undefined)
})
