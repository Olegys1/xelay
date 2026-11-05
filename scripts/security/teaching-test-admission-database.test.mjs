import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readCourseModuleMigration} from './teaching-course-modules-fixture.mjs'
import {teachingTestAdmissionFixture} from './teaching-test-admission-fixture.mjs'
import {syntheticTest} from './teaching-tests-fixture.mjs'

test('manual test admission is versioned, private and server-enforced while existing twenty-to-three variants and work remain intact',async t=>{
  const fx=await teachingTestAdmissionFixture({applyAdmission:false});t.after(()=>fx.close())
  const {ids,groups,db,rpc,mutate,testMutate,testDetail,testList}=fx
  const question=syntheticTest(ids.course,groups).questions[0]
  const pool=Array.from({length:20},(_,i)=>({...question,id:'q'+(i+1),text:'PRIVATE_POOL_QUESTION_'+(i+1),time_limit_seconds:null}))
  const legacy=syntheticTest(ids.course,groups,{title:'Synthetic twenty-question bank',description:'PRIVATE_TEST_DESCRIPTION',questions:pool,draw_count:3,shuffle_questions:true,shuffle_answers:true,bonus_percent:0,bonus_points:0})
  await testMutate(ids.owner,'save_test',legacy)
  const prior=await testMutate(ids.headA,'start',{id:legacy.id,group_id:groups[0]})
  const before=(await db.query('select to_jsonb(a) data from teaching_test_attempts a where id=$1',[prior.attempt.id])).rows[0].data
  const snapshots=async()=>{
    const result={};for(const table of ['teaching_tests','teaching_test_attempts','teaching_grades','teaching_grade_audit','teaching_submissions'])
      result[table]=(await db.query(`select to_jsonb(x) data from ${table} x order by to_jsonb(x)::text`)).rows
    return result
  }
  const allBefore=await snapshots()
  await db.exec(await readCourseModuleMigration('202611040060_teaching_test_admission.sql'))
  const override=(user,group,excluded=false,reason='')=>({user_id:user,group_id:group,opens_at:null,closes_at:null,duration_seconds:null,excluded,exclusion_reason:reason})
  let restricted,version,colleagueLink,dualLink,lockedDefinition,lockedVersion

  await t.test('migration preserves all existing rows and the old frozen three-question attempt',async()=>{
    assert.deepEqual(await snapshots(),allBefore)
    assert.deepEqual((await db.query('select to_jsonb(a) data from teaching_test_attempts a where id=$1',[prior.attempt.id])).rows[0].data,before)
    const detail=await testDetail(ids.headA,legacy.id)
    assert.equal(detail.attempt.id,prior.attempt.id);assert.equal(detail.attempt.expires_at,prior.attempt.expires_at)
    assert.equal(detail.attempt.question_count,3);assert.deepEqual(detail.attempt.current_question,prior.attempt.current_question)
    assert.deepEqual(detail.test.my_admission,{allowed:true,reason:''})
    assert.equal((await testDetail(ids.owner,legacy.id)).test.questions.length,20)
  })
  await t.test('excluded students receive only their own safe admission metadata, never descriptions or questions',async()=>{
    restricted=syntheticTest(ids.course,groups,{title:'Synthetic restricted test',description:'PRIVATE_ADMISSION_DESCRIPTION',questions:pool,draw_count:3,
      overrides:[override(ids.studentA,groups[0],true,'OWN_A_REASON'),override(ids.studentB,groups[1],true,'PRIVATE_B_REASON')]})
    const saved=await testMutate(ids.owner,'save_test',restricted);version=saved.test.version
    const own=await testDetail(ids.studentA,restricted.id)
    assert.deepEqual(own.test.my_admission,{allowed:false,reason:'OWN_A_REASON'})
    assert.equal(own.test.title,restricted.title);assert.deepEqual(own.test.questions,[]);assert.deepEqual(own.test.overrides,[])
    assert.equal(own.test.description,'');assert.equal(own.attempt,null);assert.deepEqual(own.attempts,[])
    assert.doesNotMatch(JSON.stringify(own),/PRIVATE_ADMISSION|PRIVATE_POOL|PRIVATE_B_REASON|"answer"|published_score/)
    const list=await testList(ids.studentA,ids.course,groups[0])
    assert.equal(list.tests.filter(x=>x.id===restricted.id).length,1)
    assert.deepEqual(list.tests.find(x=>x.id===restricted.id).my_admission,own.test.my_admission)
    await assert.rejects(testMutate(ids.studentA,'start',{id:restricted.id,group_id:groups[0]}),/TEST_NOT_ADMITTED/)
    for(const action of ['save_answer','navigate','finish']) await assert.rejects(testMutate(ids.studentA,action,{id:restricted.id,version:1,question_id:'q1',answer:'b',index:0}),/FORBIDDEN/)
    await assert.rejects(testDetail(ids.outsider,restricted.id),/FORBIDDEN/)
    const draft=syntheticTest(ids.course,[groups[0]],{status:'draft',overrides:[override(ids.studentA,groups[0],true,'PRIVATE_DRAFT_REASON')]})
    await testMutate(ids.owner,'save_test',draft)
    await assert.rejects(testDetail(ids.studentA,draft.id),/FORBIDDEN/)
    assert.ok(!(await testList(ids.studentA)).tests.some(x=>x.id===draft.id))
  })
  await t.test('older timing editors preserve exclusion; actor, type, stale version and target eligibility fail closed',async()=>{
    const oldEditor=override(ids.studentA,groups[0]);delete oldEditor.excluded;delete oldEditor.exclusion_reason
    let saved=await testMutate(ids.owner,'save_override',{id:restricted.id,version,override:{...oldEditor,duration_seconds:1800}});version=saved.test.version
    assert.equal(saved.test.overrides.find(o=>o.user_id===ids.studentA).excluded,true)
    assert.equal((await testDetail(ids.studentA,restricted.id)).test.my_admission.reason,'OWN_A_REASON')
    await assert.rejects(testMutate(ids.owner,'save_override',{id:restricted.id,version:version-1,override:override(ids.studentA,groups[0])}),/CONFLICT/)
    await assert.rejects(testMutate(ids.owner,'save_override',{id:restricted.id,version,expected_user_id:ids.studentA,override:override(ids.studentA,groups[0])}),/ACTOR_CHANGED/)
    await assert.rejects(rpc(ids.owner,'xelay_teaching_test_mutate',['save_override',JSON.stringify({id:restricted.id,version,override:oldEditor})]),/ACTOR_CHANGED/)
    for(const extra of [{excluded:'true'},{excluded:null},{exclusion_reason:{html:'x'}},{exclusion_reason:'x'.repeat(501)}])
      await assert.rejects(testMutate(ids.owner,'save_override',{id:restricted.id,version,override:{...override(ids.studentA,groups[0],true),...extra}}),/INVALID_INPUT/)
    await assert.rejects(testMutate(ids.owner,'save_override',{id:restricted.id,version,override:override(ids.outsider,groups[0],true)}),/INVALID_INPUT/)
    assert.equal((await testDetail(ids.owner,restricted.id)).test.version,version)
    saved=await testMutate(ids.owner,'save_override',{id:restricted.id,version,override:override(ids.studentA,groups[0],false,'stale reason is cleared')});version=saved.test.version
    assert.deepEqual((await testDetail(ids.studentA,restricted.id)).test.my_admission,{allowed:true,reason:''})
    assert.equal(saved.test.overrides.find(o=>o.user_id===ids.studentA).exclusion_reason,'')
  })
  await t.test('one actual attempt receives exactly three unique questions from twenty and survives reload without exposing solutions',async()=>{
    let detail=await testMutate(ids.studentA,'start',{id:restricted.id,group_id:groups[0]})
    const canonical=(await db.query('select questions from teaching_test_attempts where id=$1',[detail.attempt.id])).rows[0].questions
    assert.equal(canonical.length,3);assert.equal(new Set(canonical.map(q=>q.id)).size,3)
    assert.ok(canonical.every(q=>pool.some(original=>original.id===q.id)))
    assert.equal((await testDetail(ids.owner,restricted.id)).test.questions.length,20)
    assert.equal(detail.test.question_count,3);assert.equal(detail.attempt.question_count,3)
    assert.equal(detail.attempt.questions,undefined);assert.equal(detail.attempt.current_question.answer,undefined)
    assert.deepEqual((await testDetail(ids.studentA,restricted.id)).attempt.current_question,detail.attempt.current_question)
    await assert.rejects(testMutate(ids.owner,'save_override',{id:restricted.id,version,override:override(ids.studentA,groups[0],true,'Too late')}),/TEST_OVERRIDE_STARTED/)
    await assert.rejects(testMutate(ids.owner,'save_test',{...restricted,version,overrides:[override(ids.studentA,groups[0],true)]}),/IMMUTABLE/)
    for(let i=0;i<canonical.length;i++) {
      detail=await testMutate(ids.studentA,'save_answer',{id:restricted.id,version:detail.attempt.version,question_id:canonical[i].id,answer:canonical[i].answer})
      if(i<canonical.length-1)detail=await testMutate(ids.studentA,'navigate',{id:restricted.id,version:detail.attempt.version,index:i+1})
    }
    detail=await testMutate(ids.studentA,'finish',{id:restricted.id,version:detail.attempt.version})
    assert.equal(detail.attempt.status,'submitted');assert.equal(detail.attempt.published_score,undefined)
    assert.deepEqual((await db.query('select questions from teaching_test_attempts where id=$1',[detail.attempt.id])).rows[0].questions,canonical)
  })
  await t.test('scoped teachers can admit only their own recipients and never see another group exclusion reason',async()=>{
    colleagueLink=await mutate(ids.owner,'invite_teacher',{course_id:ids.course,user_id:ids.colleague,permissions:['assignments','grades'],group_scope:'selected',group_ids:[groups[0]]})
    await mutate(ids.colleague,'respond_teacher',{teacher_link_id:colleagueLink.id,accept:true})
    const view=await testDetail(ids.colleague,restricted.id)
    assert.ok(view.test.overrides.every(o=>o.group_id===groups[0]));assert.doesNotMatch(JSON.stringify(view.test.overrides),/PRIVATE_B_REASON/)
    await assert.rejects(testMutate(ids.colleague,'save_override',{id:restricted.id,version,override:override(ids.studentB,groups[1],false)}),/FORBIDDEN/)
    const fresh=syntheticTest(ids.course,groups)
    await testMutate(ids.owner,'save_test',fresh)
    const scoped=await testMutate(ids.colleague,'save_override',{id:fresh.id,version:1,override:override(ids.studentA,groups[0],true,'Scoped own student')})
    assert.equal(scoped.test.version,2)
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now()),($4,$2,$5,'accepted',now())",[groups[0],ids.outsider,ids.headA,groups[1],ids.headB])
    await assert.rejects(testMutate(ids.colleague,'save_override',{id:fresh.id,version:2,override:override(ids.outsider,groups[0],true,'Cross-group exclusion')}),/FORBIDDEN/)
    const sameAdmission=await testMutate(ids.colleague,'save_override',{id:fresh.id,version:2,override:override(ids.outsider,groups[0],false)})
    assert.equal(sameAdmission.test.version,3,'an unchanged allowed flag does not require unrelated group permissions')
    await mutate(ids.owner,'update_teacher',{teacher_link_id:colleagueLink.id,status:'removed'})
    await assert.rejects(testMutate(ids.colleague,'save_override',{id:fresh.id,version:3,override:override(ids.studentA,groups[0],false)}),/FORBIDDEN/)
  })
  await t.test('restoring admission cannot bypass course module prerequisites or original group audiences',async()=>{
    lockedDefinition=syntheticTest(ids.course,[groups[1]],{overrides:[override(ids.studentB,groups[1],true,'Wait for admission')]})
    const published=await testMutate(ids.owner,'save_test',lockedDefinition);lockedVersion=published.test.version
    const material=randomUUID()
    await mutate(ids.owner,'save_library_material',{id:material,version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic admission prerequisite',body:'Read this first',links:[],attachments:[],status:'published',rights_accepted:true,rights_terms_version:'2026-10-27.1',target_group_ids:[groups[1]]})
    const readId=randomUUID(),testId=randomUUID()
    await rpc(ids.owner,'xelay_teaching_course_module_save',[JSON.stringify({id:randomUUID(),course_id:ids.course,title:'Synthetic gated admission',description:'',status:'published',group_ids:[groups[1]],position:0,version:0,expected_user_id:ids.owner,prerequisite_item_ids:[],items:[
      {id:readId,resource_type:'material',resource_id:material,required:true,completion:'acknowledged',pass_percent:null,prerequisite_item_ids:[],position:0},
      {id:testId,resource_type:'test',resource_id:lockedDefinition.id,required:true,completion:'submitted',pass_percent:null,prerequisite_item_ids:[readId],position:1}]} )])
    await assert.rejects(testMutate(ids.studentB,'start',{id:lockedDefinition.id,group_id:groups[1]}),/NOT_ADMITTED/)
    const restored=await testMutate(ids.owner,'save_override',{id:lockedDefinition.id,version:lockedVersion,override:override(ids.studentB,groups[1],false)});lockedVersion=restored.test.version
    await assert.rejects(testMutate(ids.studentB,'start',{id:lockedDefinition.id,group_id:groups[1]}),/FORBIDDEN/)
    await assert.rejects(testDetail(ids.studentB,lockedDefinition.id),/FORBIDDEN/)
    await rpc(ids.studentB,'xelay_student_module_acknowledge',[readId,groups[1],ids.studentB])
    assert.ok((await testMutate(ids.studentB,'start',{id:lockedDefinition.id,group_id:groups[1]})).attempt.id)
    await db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[groups[1],ids.studentB])
    await assert.rejects(testDetail(ids.studentB,lockedDefinition.id),/FORBIDDEN/,'an existing attempt never overrides revoked membership')
  })
  await t.test('old started work can never be reset by admission and private implementation helpers stay inaccessible',async()=>{
    let detail=await testDetail(ids.headA,legacy.id)
    await assert.rejects(testMutate(ids.owner,'save_override',{id:legacy.id,version:1,override:override(ids.headA,groups[0],true)}),/OVERRIDE_STARTED/)
    detail=await testMutate(ids.headA,'save_answer',{id:legacy.id,version:detail.attempt.version,question_id:detail.attempt.current_question.id,answer:'b'})
    assert.equal(detail.attempt.id,prior.attempt.id)
    assert.equal(detail.attempt.expires_at,prior.attempt.expires_at)
    assert.equal((await db.query("select count(*)::int n from pg_proc p where pronamespace='public'::regnamespace and(proname like '%before_admission_20261105' or proname='xelay_private_test_admission') and has_function_privilege('authenticated',oid,'execute')")).rows[0].n,0)
    await assert.rejects(fx.asUser(ids.studentA,'select * from teaching_tests'),/permission denied/)
    for(const name of ['xelay_teaching_test(uuid)','xelay_teaching_tests(uuid,uuid)','xelay_teaching_test_mutate(text,jsonb)'])
      assert.equal((await db.query("select has_function_privilege('anon',$1,'execute') allowed",[name])).rows[0].allowed,false)
  })
})
