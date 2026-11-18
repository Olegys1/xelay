import test from'node:test'
import assert from'node:assert/strict'
import{randomUUID}from'node:crypto'
import{createTeacherArchiveFixture,teacherArchiveMigration}from'./helpers/teacherArchiveFixture.mjs'

test('personal completed-test archive preserves real published results, student paths and colleague scopes',{timeout:120000},async t=>{
 const fx=await createTeacherArchiveFixture({applyArchive:false});t.after(()=>fx.close())
 const{db,ids,groups}=fx
 const {definition}=await fx.createTest();const id=definition.id
 await fx.complete(ids.studentA,id,{correctCount:1});await fx.publishOriginal(id)
 const originalGrade=await fx.grade(id);assert.ok(Number(originalGrade.published_score)>0)
 const snapshot=async()=>(await db.query(`select jsonb_build_object(
  'tests',(select jsonb_agg(to_jsonb(x)order by id)from teaching_tests x),
  'attempts',(select jsonb_agg(to_jsonb(x)order by id)from teaching_test_attempts x),
  'grades',(select jsonb_agg(to_jsonb(x)order by id)from teaching_grades x),
  'gradeAudit',(select jsonb_agg(to_jsonb(x)order by id)from teaching_grade_audit x),
  'retakes',(select jsonb_agg(to_jsonb(x)order by id)from teaching_test_retake_grants x),
  'publications',(select jsonb_agg(to_jsonb(x)order by attempt_id)from teaching_test_attempt_publications x))v`)).rows[0].v
 const publicFunctions=async()=>(await db.query(`select oid::text,md5(pg_get_functiondef(oid)) body from pg_proc where oid in('public.xelay_teaching_tests(uuid,uuid)'::regprocedure,'public.xelay_teaching_test(uuid)'::regprocedure,'public.xelay_teaching_test_mutate(text,jsonb)'::regprocedure)order by oid`)).rows
 const beforeDdl=await snapshot(),functionsBefore=await publicFunctions()
 await db.exec(await fx.readMigration(teacherArchiveMigration))
 const state=(user=ids.owner,course=ids.course,group=null)=>fx.archiveState(user,course,group)
 await t.test('migration is additive: canonical functions, nonempty grades, attempts and originals are byte-for-byte unchanged',async()=>{
  assert.deepEqual(await snapshot(),beforeDdl);assert.deepEqual(await publicFunctions(),functionsBefore)
  assert.equal((await state()).canArchive,false);assert.deepEqual((await state()).items,[])
  assert.deepEqual((await state(ids.owner,ids.course,groups[1])).items,[],'accepted permitted group with no tests has an empty archive rather than a false access error')
  await assert.rejects(fx.archiveSet(id,true),error=>error.code==='42501'&&/PLAN_REQUIRED/.test(error.message))
  await assert.rejects(fx.asUser(ids.owner,'select*from xelay_teacher_private.test_archives'),error=>error.code==='42501')
  await assert.rejects(fx.serviceCall('xelay_teaching_test_archive_set',[id,ids.course,null,true,0,ids.owner]),error=>error.code==='42501')
 })
 await t.test('NULL, missing or unknown paid entitlement fails closed for both state and direct archive RPC',async()=>{
  const original=(await db.query("select pg_get_functiondef('xelay_teacher_private.entitlement(uuid)'::regprocedure)body")).rows[0].body
  try{for(const value of ["null::jsonb","'{}'::jsonb","'{\"planId\":null}'::jsonb","'{\"planId\":\"student_max\"}'::jsonb"]){
   await db.exec(`create or replace function xelay_teacher_private.entitlement(p_user_id uuid)returns jsonb language sql stable security definer set search_path=''as $$select ${value}$$`)
   assert.equal((await state()).canArchive,false)
   await assert.rejects(fx.archiveSet(id,true),error=>error.code==='42501'&&/PLAN_REQUIRED/.test(error.message))
  }}finally{await db.exec(original)}
  assert.equal((await db.query('select count(*)::int n from xelay_teacher_private.test_archives')).rows[0].n,0)
 })
 let item
 await t.test('all three paid teacher tiers may file and restore with version-safe idempotence and no assessment changes',async()=>{
  const studentBefore=await fx.testDetail(ids.studentA,id),assessmentBefore=await snapshot()
  for(const[iteration,plan]of ['teacher_start','teacher_plus','teacher_max'].entries()){
   await fx.createPaidTeacher(plan);assert.equal((await state()).canArchive,true)
   item=await fx.archiveSet(id,true,item?.version??0);assert.ok(item.archivedAt);assert.equal(item.version,iteration*2+1)
   assert.deepEqual(await fx.archiveSet(id,true,0),item,'same-state retry adds no version or extra record')
   assert.equal((await state(ids.owner,ids.course,groups[0])).items[0].testId,id)
   if(iteration<2){item=await fx.archiveSet(id,false,item.version);assert.equal(item.archivedAt,null)}
  }
  await assert.rejects(fx.archiveSet(id,false,1),error=>error.code==='PT409')
  const studentAfter=await fx.testDetail(ids.studentA,id)
  assert.equal(studentAfter.attempt.id,studentBefore.attempt.id);assert.equal(studentAfter.attempt.published_score,studentBefore.attempt.published_score)
  assert.deepEqual(await snapshot(),assessmentBefore)
  assert.deepEqual(await publicFunctions(),functionsBefore)
 })
 await t.test('wrong actor, test, subject or group never changes filing metadata',async()=>{
  const before=(await state()).items
  for(const options of [{course:randomUUID()},{group:groups[1]},{expectedUser:ids.colleague},{user:ids.studentA},{user:ids.outsider},{user:ids.otherTeacher}])await assert.rejects(fx.archiveSet(id,false,item.version,options),error=>error.code==='42501')
  await assert.rejects(fx.archiveSet(randomUUID(),true),error=>error.code==='42501')
  await assert.rejects(state(ids.owner,randomUUID()),error=>error.code==='42501')
  await assert.rejects(state(ids.owner,ids.course,randomUUID()),error=>error.code==='42501')
  assert.deepEqual((await state()).items,before)
 })
 await t.test('a scoped colleague files only their own list; a fresh permission revocation closes both read and restore',async()=>{
  await db.query("insert into teaching_course_teachers(course_id,user_id,permissions,status,invited_by,group_scope,group_ids)values($1,$2,array['grades'],'accepted',$3,'selected',$4::uuid[])",[ids.course,ids.colleague,ids.owner,[groups[0]]])
  await fx.createPaidTeacher('teacher_start',ids.colleague)
  const colleague=await fx.archiveSet(id,true,0,{user:ids.colleague,group:groups[0]});assert.equal(colleague.version,1)
  item=await fx.archiveSet(id,false,item.version)
  assert.equal((await state()).items[0].archivedAt,null)
  assert.ok((await state(ids.colleague)).items[0].archivedAt,'owner restore cannot alter colleague archive')
  await assert.rejects(fx.archiveSet(id,false,colleague.version,{user:ids.colleague,group:groups[1]}),error=>error.code==='42501')
  await db.query("update teaching_course_teachers set permissions=array['materials']where course_id=$1 and user_id=$2",[ids.course,ids.colleague])
  await assert.rejects(state(ids.colleague),error=>error.code==='42501')
  assert.deepEqual((await state(ids.colleague,null)).items,[])
  await assert.rejects(fx.archiveSet(id,false,colleague.version,{user:ids.colleague}),error=>error.code==='42501')
  await db.query("update teaching_course_teachers set permissions=array['grades']where course_id=$1 and user_id=$2",[ids.course,ids.colleague])
  assert.equal((await fx.archiveSet(id,false,colleague.version,{user:ids.colleague})).archivedAt,null)
 })
 await t.test('draft, future common window, future individual window and an unexpired issued attempt are not completed',async()=>{
  for(const changes of [{status:'draft'},{opens_at:new Date(Date.now()+60000).toISOString(),closes_at:new Date(Date.now()+3600000).toISOString()},
   {opens_at:new Date(Date.now()-86400000).toISOString(),closes_at:new Date(Date.now()-60000).toISOString(),overrides:[{user_id:ids.studentA,group_id:groups[0],opens_at:null,closes_at:new Date(Date.now()+3600000).toISOString(),duration_seconds:null}]}]){
   const entry=await fx.createTest(changes);await assert.rejects(fx.archiveSet(entry.definition.id,true),error=>error.code==='PT409'&&/NOT_COMPLETED/.test(error.message))
  }
  const active=await fx.createTest();let attempt=await fx.testMutate(ids.studentA,'start',{id:active.definition.id,group_id:groups[0]})
  await db.query("update teaching_tests set opens_at=clock_timestamp()-interval'1 day',closes_at=clock_timestamp()-interval'1 second'where id=$1",[active.definition.id])
  const before=(await db.query('select to_jsonb(a)v from teaching_test_attempts a where test_id=$1',[active.definition.id])).rows
  await assert.rejects(fx.archiveSet(active.definition.id,true),error=>error.code==='PT409'&&/NOT_COMPLETED/.test(error.message))
  assert.deepEqual((await db.query('select to_jsonb(a)v from teaching_test_attempts a where test_id=$1',[active.definition.id])).rows,before)
  await db.query("update teaching_test_attempts set expires_at=clock_timestamp()-interval'1 second'where id=$1",[attempt.attempt.id])
  const expiredAttempt=(await db.query('select to_jsonb(a)v from teaching_test_attempts a where id=$1',[attempt.attempt.id])).rows
  assert.ok((await fx.archiveSet(active.definition.id,true)).archivedAt,'expired stale in_progress row needs no destructive finalization to file')
  assert.deepEqual((await db.query('select to_jsonb(a)v from teaching_test_attempts a where id=$1',[attempt.attempt.id])).rows,expiredAttempt)
 })
 await t.test('an active personal retake blocks a new parent filing without changing retake access or original results',async()=>{
  const detail=await fx.testDetail(ids.owner,id),source=(await db.query('select id from teaching_test_attempts where test_id=$1 and user_id=$2',[id,ids.studentA])).rows[0]
  const granted=await fx.testMutate(ids.owner,'grant_retake',{id,version:detail.test.version,request_id:randomUUID(),user_id:ids.studentA,group_id:groups[0],source_attempt_id:source.id,variant_choice:'base',opens_at:new Date(Date.now()-60000).toISOString(),closes_at:new Date(Date.now()+3600000).toISOString(),duration_seconds:600,confirm_retake:true})
  const retake=(await db.query('select*from teaching_test_retake_grants where parent_test_id=$1',[id])).rows[0]
  assert.ok(retake);assert.ok(granted.test)
  const before=await snapshot(),studentBefore=await fx.testDetail(ids.studentA,retake.child_test_id)
  await assert.rejects(fx.archiveSet(id,true,item.version),error=>error.code==='PT409'&&/NOT_COMPLETED/.test(error.message))
  const after=await fx.testDetail(ids.studentA,retake.child_test_id)
  assert.equal(after.test.id,studentBefore.test.id);assert.equal(after.test.closes_at,studentBefore.test.closes_at)
  assert.deepEqual(await snapshot(),before)
  await db.query('update teaching_test_retake_grants set revoked_at=clock_timestamp()where id=$1',[retake.id])
  item=await fx.archiveSet(id,true,item.version);assert.ok(item.archivedAt)
 })
 await t.test('a newly published revision is never implicitly filed with its older personal archive entry',async()=>{
  const created=await fx.createTest();await fx.complete(ids.studentA,created.definition.id);await fx.publishOriginal(created.definition.id)
  const older=await fx.archiveSet(created.definition.id,true)
  const oldDetail=await fx.testDetail(ids.owner,created.definition.id)
  await fx.stage(created.definition.id,{questions:oldDetail.test.questions.map((q,i)=>i?q:{...q,text:q.text+' Нова редакція.'}),opens_at:new Date(Date.now()-60000).toISOString(),closes_at:new Date(Date.now()+3600000).toISOString()})
  const published=await fx.publish(created.definition.id);const current=published.detail.test.id;assert.notEqual(current,created.definition.id)
  const metadata=(await state()).items;assert.deepEqual(metadata.find(x=>x.testId===created.definition.id),older);assert.equal(metadata.some(x=>x.testId===current),false)
  assert.ok((await fx.testList(ids.owner)).tests.some(x=>x.id===current),'ordinary teacher list still exposes the new current revision')
  assert.equal((await fx.archiveSet(created.definition.id,false,older.version)).archivedAt,null)
  await assert.rejects(fx.archiveSet(created.definition.id,true,2),error=>error.code==='PT409'&&/NOT_COMPLETED/.test(error.message))
 })
 await t.test('paid expiry retains reading and restoring, while new filing remains unavailable and stale sessions cannot act',async()=>{
  const before=await snapshot()
  await db.query("update xelay_teacher_private.periods set valid_from=clock_timestamp()-interval'2 days',valid_until=clock_timestamp()-interval'1 day'where grant_id in(select id from xelay_teacher_private.grants where user_id=$1)",[ids.owner])
  const expired=await state();assert.equal(expired.canArchive,false);assert.ok(expired.items.some(x=>x.testId===id&&x.archivedAt))
  item=await fx.archiveSet(id,false,item.version);assert.equal(item.archivedAt,null)
  await assert.rejects(fx.archiveSet(id,true,item.version),error=>error.code==='42501'&&/PLAN_REQUIRED/.test(error.message))
  assert.deepEqual(await snapshot(),before)
  await db.query("update auth.sessions set not_after=clock_timestamp()-interval'1 second'where id=$1",[fx.sessions[ids.owner]])
  await assert.rejects(state(),error=>error.code==='42501')
  await assert.rejects(fx.archiveSet(id,false,item.version),error=>error.code==='42501')
 })
})
