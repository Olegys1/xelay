import test from'node:test'
import assert from'node:assert/strict'
import{randomUUID}from'node:crypto'
import{createTeacherBackendFixture}from'./helpers/teacherBackendFixture.mjs'
import{teacherModuleLoader,apiCall,syntheticTeacherModel}from'./helpers/loadTeacherModule.mjs'
import{syntheticTest}from'../scripts/security/teaching-tests-fixture.mjs'

test('actual teacher API → provider boundary → PostgreSQL private draft workflow',{timeout:120000},async t=>{
 const fx=await createTeacherBackendFixture();t.after(()=>fx.close());const{db,ids,groups}=fx
 const model=syntheticTeacherModel(),api=teacherModuleLoader()('server/teacher-learning/teacherLearningProduction.ts')
 const handler=api.createTeacherLearningProduction({environment:fx.environment,clientFactory:fx.clientFactory,fetcher:model.fetcher})
 const call=(action,extra={},user=ids.owner)=>apiCall(handler,{action,...extra},{token:fx.token(user)})
 const req=(kind='questions',extra={})=>({requestId:randomUUID(),kind,courseId:ids.course,groupIds:[groups[0]],prompt:'Підготуйте навчальні запитання за темою проєктів.',consent:true,questionCount:2,...extra})
 const providerCount=()=>model.calls.filter(c=>c.url.endsWith('/responses')).length
 const journal=async()=>(await db.query(`select jsonb_build_object('grades',coalesce((select jsonb_agg(to_jsonb(g)order by g.id)from public.teaching_grades g),'[]'),'marks',coalesce((select jsonb_agg(to_jsonb(m)order by m.id)from public.teaching_rubric_marks m),'[]'),'audits',coalesce((select jsonb_agg(to_jsonb(a)order by a.id)from public.teaching_grade_audit a),'[]'))v`)).rows[0].v
 let questionDraft,submission,assignment,officialBefore,testId
 await t.test('origin, authentication, inactive plan, forged model and explicit consent are enforced before provider calls',async()=>{
  assert.equal((await apiCall(handler,{action:'status'},{token:fx.token(),origin:'https://evil.example'})).status,403)
  assert.equal((await apiCall(handler,{action:'status'},{token:'invalid-credential'})).status,401)
  assert.equal((await call('status')).body.planId,'free');assert.equal((await call('generate',{request:req()})).status,403)
  await fx.createPaidTeacher('teacher_start')
  assert.equal((await call('generate',{request:{...req(),consent:false}})).status,400)
  assert.equal((await call('generate',{request:{...req(),model:'gpt-5.4'}})).status,400)
  assert.equal(providerCount(),0)
 })
 await t.test('Start creates and persists new questions and draft keys; refresh/replay do not call model twice',async()=>{
  const r=req(),result=await call('generate',{request:r});assert.equal(result.status,200,JSON.stringify(result.body));questionDraft=result.body.draft
  assert.equal(questionDraft.bundle.questions.length,2);assert.equal(questionDraft.bundle.questions[0].correctIndex,0)
  assert.equal((await call('history')).body.drafts[0].id,r.requestId)
  const calls=providerCount(),spent=(await fx.ownerCall('xelay_teacher_workspace_status')).budget.spentMicros
  const replay=await call('generate',{request:r});assert.equal(replay.status,200);assert.equal(replay.body.draft.id,r.requestId);assert.equal(providerCount(),calls)
  assert.equal((await fx.ownerCall('xelay_teacher_workspace_status')).budget.spentMicros,spent)
  const changed={...questionDraft.bundle,questions:questionDraft.bundle.questions.map((q,i)=>i? q:{...q,correctIndex:1,explanation:'Преподаватель перевірив власну чернетку.'})}
  const saved=await call('save_draft',{save:{id:questionDraft.id,expectedRevision:1,bundle:changed,teacherNotes:'Потрібна остаточна перевірка.',status:'accepted'}})
  assert.equal(saved.status,200);assert.equal(saved.body.draft.revision,2);assert.equal(saved.body.draft.bundle.questions[0].correctIndex,1)
  assert.equal((await call('generate',{request:r})).body.draft.revision,2,'idempotent replay returns the current teacher-edited draft')
  assert.equal((await call('save_draft',{save:{id:questionDraft.id,expectedRevision:1,bundle:changed,teacherNotes:'',status:'draft'}})).status,409)
  assert.equal((await call('generate',{request:req('variants',{variantCount:2})})).body.draft.bundle.questions.length,4)
  assert.equal((await call('generate',{request:req('tasks')})).body.draft.bundle.tasks.length,1)
 })
 await t.test('direct authenticated malformed draft RPC is rejected; legacy invalid own rows cannot poison history',async()=>{
  for(const bundle of [{kind:'questions'},{...questionDraft.bundle,title:123},{...questionDraft.bundle,questions:[{...questionDraft.bundle.questions[0],correctIndex:9}]}]){
   await assert.rejects(fx.ownerCall('xelay_teacher_ai_draft_save',[questionDraft.id,2,bundle,'','accepted']),error=>error.code==='22023')
  }
  await assert.rejects(fx.ownerCall('xelay_teacher_ai_draft_save',[questionDraft.id,2,questionDraft.bundle,'<script>own poison</script>','draft']),error=>error.code==='22023')
  const poisoned=randomUUID()
  await db.query(`insert into xelay_teacher_private.requests(user_id,id,session_hash,fingerprint,grant_id,reserve_micros,charge_micros,request,context_hash,state,bundle,settled_at)
   select user_id,$2::uuid,session_hash,fingerprint,grant_id,reserve_micros,0,jsonb_set(request,'{requestId}',to_jsonb($2::uuid::text)),context_hash,'done','{"kind":"questions"}',clock_timestamp()from xelay_teacher_private.requests where user_id=$1 and id=$3`,[ids.owner,poisoned,questionDraft.id])
  await db.query(`insert into xelay_teacher_private.drafts(user_id,id,request,bundle)select user_id,id,request,bundle from xelay_teacher_private.requests where user_id=$1 and id=$2`,[ids.owner,poisoned])
  const history=await call('history');assert.equal(history.status,200);assert.ok(history.body.drafts.some(d=>d.id===questionDraft.id));assert.equal(history.body.drafts.some(d=>d.id===poisoned),false)
  assert.equal((await fx.ownerCall('xelay_teacher_ai_draft',[questionDraft.id])).revision,2)
 })
 await t.test('Plus review uses actual submitted text and saved criteria; a pre-existing published grade is untouched',async()=>{
  assignment={id:randomUUID(),course_id:ids.course,version:0,title:'Навчальний проєкт',body:'Опишіть мету та приклад.',links:[],attachments:[],status:'published',submission_mode:'individual',max_points:10,category:'',targets:[{group_id:groups[0],audience_mode:'all',subgroup_ids:[],team_ids:[],placement_mode:'unplaced',lesson_date:fx.dates.lesson_a,due_at:null,closes_at:null}]}
  await fx.classroom(ids.owner,'save_group_assignment',assignment)
  const rubric={criteria:[{id:'content',title:'Зміст',levels:[{id:'none',label:'Не розкрито',points:0},{id:'full',label:'Повністю',points:4}]},{id:'example',title:'Приклад',levels:[{id:'none',label:'Немає',points:0},{id:'full',label:'Наведено',points:1}]}]}
  await fx.rpc(ids.owner,'xelay_teaching_rubric_mutate',['save_rubric',JSON.stringify({assignment_id:assignment.id,group_id:groups[0],expected_user_id:ids.owner,version:0,rubric})])
  submission=await fx.classroom(ids.studentA,'reserve_submission',{id:randomUUID(),version:0,item_id:assignment.id,group_id:groups[0]})
  submission=await fx.classroom(ids.studentA,'save_submission',{id:submission.id,version:submission.version,body:'Мета проєкту визначається під час підготовки. Далі створюють результат.',links:[],attachments:[]})
  submission=await fx.classroom(ids.studentA,'submit_submission',{id:submission.id,version:submission.version})
  await fx.mutate(ids.owner,'sync_roster',{course_id:ids.course,group_id:groups[0]})
  const marked=await fx.rpc(ids.owner,'xelay_teaching_rubric_mutate',['assess_submission',JSON.stringify({assignment_id:assignment.id,group_id:groups[0],submission_id:submission.id,submission_version:submission.version,rubric_version:1,version:0,grade_version:0,levels:{content:'full',example:'none'},feedback:'Раніше опублікований результат.',reason:'Оцінювання викладачем',expected_user_id:ids.owner})])
  const grade=(await db.query('select g.*from teaching_grades g join teaching_activities a on a.id=g.activity_id where a.item_id=$1',[assignment.id])).rows[0]
  await fx.mutate(ids.owner,'publish_grades',{activity_id:grade.activity_id,expected_versions:[{entry_id:grade.entry_id,version:grade.version}]})
  officialBefore=await journal();assert.equal(Number(officialBefore.grades[0].published_score),8);assert.ok(marked.marks.length)
  const r=req('rubric_review',{submissionId:submission.id});assert.equal((await call('generate',{request:r})).status,403)
  await fx.createPaidTeacher('teacher_plus')
  const candidates=await call('candidates',{scope:{courseId:ids.course,groupIds:[groups[0]]}});assert.equal(candidates.status,200);assert.ok(candidates.body.submissions.some(s=>s.id===submission.id))
  const review=await call('generate',{request:r});assert.equal(review.status,200,JSON.stringify(review.body));assert.equal(review.body.draft.bundle.review.suggestedScore,4)
  const accepted=await call('save_draft',{save:{id:r.requestId,expectedRevision:1,bundle:review.body.draft.bundle,teacherNotes:'Попередній висновок переглянуто.',status:'accepted'}});assert.equal(accepted.status,200)
  assert.deepEqual(await journal(),officialBefore,'accepting AI review never changes official grade, rubric marks or grade audit')
  const payload=model.calls.filter(c=>c.url.endsWith('/responses')).at(-1).payload
  assert.equal(payload.model,'gpt-5.4-mini');assert.equal(payload.store,false)
  const context=JSON.parse(payload.input[0].content[0].text).context
  assert.equal(context.submission.body,(await db.query('select body from teaching_submissions where id=$1',[submission.id])).rows[0].body);assert.equal(context.submission.userId,undefined);assert.equal(context.submission.full_name,undefined)
 })
 await t.test('Plus cannot use Max-only modes or multiple groups, even through forged direct API requests',async()=>{
  const count=providerCount()
  assert.equal((await call('generate',{request:req('questions',{groupIds:groups})})).status,403)
  assert.equal((await call('generate',{request:req('quality',{testId:randomUUID()})})).status,403)
  assert.equal((await call('generate',{request:req('error_practice',{testId:randomUUID()})})).status,403)
  assert.equal(providerCount(),count)
 })
 await t.test('fabricated evidence and source changes fail closed while actual incurred costs remain accounted',async()=>{
  model.setMode('invented_evidence');const invalid=req('rubric_review',{submissionId:submission.id}),before=(await fx.ownerCall('xelay_teacher_workspace_status')).budget.spentMicros
  assert.equal((await call('generate',{request:invalid})).status,503);assert.ok((await fx.ownerCall('xelay_teacher_workspace_status')).budget.spentMicros>before)
  assert.equal((await call('history')).body.drafts.some(d=>d.id===invalid.requestId),false);model.setMode('normal')
  model.setBeforeResponse(()=>db.query('update teaching_submissions set version=version+1 where id=$1',[submission.id]))
  const stale=req('rubric_review',{submissionId:submission.id}),result=await call('generate',{request:stale});assert.equal(result.status,409);assert.equal(result.body.code,'context_changed')
  assert.equal((await call('history')).body.drafts.some(d=>d.id===stale.requestId),false);assert.deepEqual(await journal(),officialBefore)
  const oldReview=(await call('history')).body.drafts.find(d=>d.request.kind==='rubric_review')
  assert.ok(oldReview,'earlier review remains readable after resubmission')
  const staleAccept=await call('save_draft',{save:{id:oldReview.id,expectedRevision:oldReview.revision,bundle:oldReview.bundle,teacherNotes:'',status:'accepted'}})
  assert.equal(staleAccept.status,409);assert.equal((await fx.ownerCall('xelay_teacher_ai_draft',[oldReview.id])).revision,oldReview.revision)
 })
 await t.test('Max quality and recovery practice use actual closed-test errors across permitted groups',async()=>{
  await fx.createPaidTeacher('teacher_max')
  const definition=syntheticTest(ids.course,[groups[0]],{questions:syntheticTest(ids.course,[groups[0]]).questions.slice(0,2),max_points:10,bonus_percent:0,bonus_points:0})
  await fx.rpc(ids.owner,'xelay_teaching_test_mutate',['save_test',JSON.stringify(definition)]);testId=definition.id
  let attempt=await fx.rpc(ids.studentA,'xelay_teaching_test_mutate',['start',JSON.stringify({id:testId,group_id:groups[0]})])
  attempt=await fx.rpc(ids.studentA,'xelay_teaching_test_mutate',['save_answer',JSON.stringify({id:testId,version:attempt.attempt.version,question_id:'choice',answer:'a'})])
  attempt=await fx.rpc(ids.studentA,'xelay_teaching_test_mutate',['finish',JSON.stringify({id:testId,version:attempt.attempt.version})])
  const errorRequest=req('error_practice',{testId,groupIds:groups})
  assert.equal((await call('generate',{request:errorRequest})).status,409)
  await db.query("update teaching_tests set opens_at=clock_timestamp()-interval'1 day',closes_at=clock_timestamp()-interval'1 second'where id=$1",[testId])
  const practice=await call('generate',{request:errorRequest});assert.equal(practice.status,200,JSON.stringify(practice.body));assert.equal(practice.body.draft.bundle.questions.length,2)
  const provider=model.calls.filter(c=>c.url.endsWith('/responses')).at(-1),context=JSON.parse(provider.payload.input[0].content[0].text).context
  assert.ok(context.actualErrors.length>0);assert.ok(context.actualErrors.every(e=>e.errors>0&&e.responses>=e.errors));assert.equal(JSON.stringify(context).includes(ids.studentA),false)
  const quality=await call('generate',{request:req('quality',{testId})});assert.equal(quality.status,200);assert.equal(quality.body.draft.bundle.quality[0].questionId,'choice')
  assert.equal((await call('generate',{request:req('questions',{groupIds:groups})})).status,200)
 })
 await t.test('50 large valid drafts stay stored while recent history fits2MiB; an older known draft still saves through its owner-scoped loader',async()=>{
  const template=(await fx.ownerCall('xelay_teacher_ai_draft',[questionDraft.id])),requestsBefore=(await db.query('select count(*)::int n from xelay_teacher_private.drafts where user_id=$1',[ids.owner])).rows[0].n
  const bigBundle={...template.bundle,title:'Велика чернетка',summary:'П'.repeat(700),questions:Array.from({length:10},(_,i)=>({id:'long_'+i,type:'single',text:'П'.repeat(1850)+i,choices:Array.from({length:4},(_,j)=>`${i}-${j} `+'В'.repeat(460)),correctIndex:0,explanation:'Р'.repeat(850),points:1,topic:'Тема '+i,variant:1})),warnings:[]}
  assert.ok(Buffer.byteLength(JSON.stringify(bigBundle))<100000)
  let combined=0
  for(let i=0;i<50;i++){
   const id=randomUUID(),request={...template.request,requestId:id,questionCount:10,sourceText:'М'.repeat(11000)}
   combined+=Buffer.byteLength(JSON.stringify({request,bundle:bigBundle}))
   await db.query(`insert into xelay_teacher_private.requests(user_id,id,session_hash,fingerprint,grant_id,reserve_micros,charge_micros,request,context_hash,state,bundle,settled_at)
    select user_id,$2,session_hash,fingerprint,grant_id,reserve_micros,0,$4::jsonb,context_hash,'done',$5::jsonb,clock_timestamp()from xelay_teacher_private.requests where user_id=$1 and id=$3`,[ids.owner,id,questionDraft.id,JSON.stringify(request),JSON.stringify(bigBundle)])
   await db.query('insert into xelay_teacher_private.drafts(user_id,id,request,bundle)select user_id,id,request,bundle from xelay_teacher_private.requests where user_id=$1 and id=$2',[ids.owner,id])
  }
  assert.ok(combined>4.5*1024*1024,'fixture exceeds the deployment response boundary without aggregate bounding')
  const history=await call('history');assert.equal(history.status,200);assert.ok(Buffer.byteLength(JSON.stringify(history.body))<2097200)
  assert.ok(history.body.drafts.length>0&&history.body.drafts.length<50);assert.equal(history.body.drafts.some(d=>d.id===questionDraft.id),false)
  assert.equal((await db.query('select count(*)::int n from xelay_teacher_private.drafts where user_id=$1',[ids.owner])).rows[0].n,requestsBefore+50,'history bounding never deletes saved drafts')
  const saved=await call('save_draft',{save:{id:template.id,expectedRevision:template.revision,bundle:template.bundle,teacherNotes:'Старіша чернетка доступна власнику.',status:'accepted'}})
  assert.equal(saved.status,200);assert.equal(saved.body.draft.revision,template.revision+1)
  await assert.rejects(fx.ownerCall('xelay_teacher_ai_draft',[template.id],ids.otherTeacher),error=>error.code==='42501')
 })
 await t.test('private history survives paid expiry but scope revocation and other users cannot read copied submissions',async()=>{
  assert.equal((await call('history',{},ids.otherTeacher)).body.drafts.length,0)
  const count=(await call('history')).body.drafts.length;assert.ok(count>4)
  await db.query("update xelay_teacher_private.periods set valid_until=clock_timestamp()-interval'1 second'where grant_id in(select id from xelay_teacher_private.grants where user_id=$1)and valid_from<clock_timestamp()-interval'1 second'",[ids.owner])
  // Set only the current period to an already-ended but valid interval.
  await db.query("update xelay_teacher_private.periods set valid_from=clock_timestamp()-interval'2 days',valid_until=clock_timestamp()-interval'1 day'where grant_id in(select id from xelay_teacher_private.grants where user_id=$1)",[ids.owner])
  assert.equal((await call('status')).body.planId,'free');assert.equal((await call('history')).body.drafts.length,count)
  await db.query("update teaching_course_groups set status='removed'where course_id=$1 and group_id=any($2::uuid[])",[ids.course,groups])
  assert.deepEqual((await call('history')).body.drafts,[])
  assert.equal((await call('save_draft',{save:{id:questionDraft.id,expectedRevision:2,bundle:questionDraft.bundle,teacherNotes:'',status:'draft'}})).status,403)
 })
})
