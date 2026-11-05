import test from 'node:test'
import assert from 'node:assert/strict'
import { courseModulesFixture, readCourseModuleMigration } from './teaching-course-modules-fixture.mjs'
import { syntheticTest } from './teaching-tests-fixture.mjs'

test('explicit owner closure preserves history and keeps bonus review, transfer and publication separate', async t => {
  const fx=await courseModulesFixture()
  try {
    for(const name of ['202611040060_teaching_test_admission.sql','202611050061_teaching_test_explicit_close.sql']) await fx.db.exec(await readCourseModuleMigration(name))
    const {ids,groups,db,rpc}=fx
    const mutate=(who,action,payload)=>rpc(who,'xelay_teaching_test_mutate',[action,JSON.stringify({...payload,expected_user_id:who})])
    const detail=()=>rpc(ids.owner,'xelay_teaching_test',[definition.id])
    const definition=syntheticTest(ids.course,groups,{overrides:[{user_id:ids.studentA,group_id:groups[0],opens_at:null,closes_at:new Date(Date.now()+172800000).toISOString(),duration_seconds:null}]})
    let current=await mutate(ids.owner,'save_test',definition)
    const original=(await db.query('select opens_at,closes_at,overrides,duration_seconds from teaching_tests where id=$1',[definition.id])).rows[0]
    const close=patch=>mutate(ids.owner,'close_test',{id:definition.id,version:current.test.version,confirm_close_all:true,...patch})

    await t.test('confirmation, owner, current version and at least one submission are required',async()=>{
      assert.equal(current.test.can_close,true)
      await assert.rejects(close({confirm_close_all:false}),/TEST_CLOSE_CONFIRM_REQUIRED/)
      await assert.rejects(close(),/TEST_NO_SUBMITTED_ATTEMPTS/)
      await assert.rejects(mutate(ids.studentA,'close_test',{id:definition.id,version:current.test.version,confirm_close_all:true}),/TEST_FORBIDDEN/)
      await assert.rejects(close({version:999}),/TEST_CONFLICT/)
      assert.equal((await detail()).test.status,'published')
    })

    let a=await mutate(ids.studentA,'start',{id:definition.id,group_id:groups[0]})
    a=await mutate(ids.studentA,'save_answer',{id:definition.id,version:a.attempt.version,question_id:'choice',answer:'b'})
    await mutate(ids.studentA,'finish',{id:definition.id,version:a.attempt.version})
    let active=await mutate(ids.studentB,'start',{id:definition.id,group_id:groups[1]})
    current=await detail()
    await t.test('live attempts prevent closure and pending approval still cannot finalize early',async()=>{
      await assert.rejects(close(),/TEST_ACTIVE_ATTEMPTS/)
      await assert.rejects(mutate(ids.owner,'finalize_results',{id:definition.id,version:current.test.version}),/TEST_RESULTS_NOT_READY/)
      assert.equal((await detail()).attempts.find(row=>row.id===active.attempt.id).status,'in_progress')
    })
    await db.query("update teaching_test_attempts set started_at=clock_timestamp()-interval '10 minutes',expires_at=clock_timestamp()-interval '1 minute' where id=$1",[active.attempt.id])
    const answers=(await db.query('select id,questions,answers,opened_at from teaching_test_attempts where test_id=$1 order by id',[definition.id])).rows
    const grades=(await db.query('select to_jsonb(g) data from teaching_grades g order by id')).rows
    current=await close()
    await t.test('closure finishes only naturally expired work, caps effective access and does not approve or grade',async()=>{
      assert.equal(current.test.status,'closed')
      assert.equal(current.test.can_close,false)
      assert.ok(current.test.closed_early_at)
      assert.equal(current.test.results_finalized_at,null)
      assert.equal(current.test.approved_revision,null)
      assert.ok(current.attempts.every(row=>row.status==='submitted'&&row.final_score==null))
      assert.ok(Date.parse(current.test.results_ready_at)<=Date.parse(current.server_now))
      assert.deepEqual((await db.query('select opens_at,closes_at,overrides,duration_seconds from teaching_tests where id=$1',[definition.id])).rows[0],original)
      assert.deepEqual((await db.query('select id,questions,answers,opened_at from teaching_test_attempts where test_id=$1 order by id',[definition.id])).rows,answers)
      assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g order by id')).rows,grades)
      await assert.rejects(mutate(ids.owner,'review_results',{id:definition.id,version:current.test.version}),/TEST_REVIEW_REQUIRED/)
      await assert.rejects(mutate(ids.headA,'start',{id:definition.id,group_id:groups[0]}),/TEST_NOT_OPEN/)
    })

    current=await mutate(ids.owner,'finalize_results',{id:definition.id,version:current.test.version})
    await t.test('a deliberate later review calculates bonuses before a separate journal transfer',async()=>{
      assert.equal(current.test.approved_revision,current.test.review_revision)
      assert.ok(current.test.results_finalized_at)
      assert.ok(current.attempts.every(row=>typeof row.final_score==='number'))
      assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g order by id')).rows,grades)
      current=await mutate(ids.owner,'review_results',{id:definition.id,version:current.test.version})
      const transferred=(await db.query('select draft_score,published_at from teaching_grades g join teaching_test_activities a on a.activity_id=g.activity_id where a.test_id=$1',[definition.id])).rows
      assert.equal(transferred.length,2)
      assert.ok(transferred.every(row=>row.draft_score!==null&&row.published_at===null))
      assert.equal((await db.query("select has_function_privilege('anon','xelay_teaching_test_mutate(text,jsonb)','execute') allowed")).rows[0].allowed,false)
      assert.equal((await db.query("select has_function_privilege('authenticated','xelay_private_test_mutate_before_close_20261105(text,jsonb)','execute') allowed")).rows[0].allowed,false)
    })
    await t.test('early closure never bypasses manual essay review',async()=>{
      const essay=syntheticTest(ids.course,[groups[0]],{bonus_percent:0,bonus_points:0,questions:[{id:'essay',kind:'essay',text:'Поясніть своїми словами.',points:5,time_limit_seconds:null,partial_credit:false,options:[],buckets:[]}]})
      let work=await mutate(ids.owner,'save_test',essay)
      let student=await mutate(ids.studentA,'start',{id:essay.id,group_id:groups[0]})
      student=await mutate(ids.studentA,'save_answer',{id:essay.id,version:student.attempt.version,question_id:'essay',answer:'Вигадана розгорнута відповідь.'})
      await mutate(ids.studentA,'finish',{id:essay.id,version:student.attempt.version})
      work=await mutate(ids.owner,'close_test',{id:essay.id,version:work.test.version,confirm_close_all:true})
      await assert.rejects(mutate(ids.owner,'finalize_results',{id:essay.id,version:work.test.version}),/TEST_MANUAL_REVIEW_REQUIRED/)
      assert.equal(work.test.approved_revision,null)
      assert.equal(work.attempts[0].final_score,null)
      work=await mutate(ids.owner,'save_review',{id:essay.id,attempt_id:work.attempts[0].id,version:work.attempts[0].version,
        marks:[{question_id:'essay',mode:'full',reason:'Відповідь перевірено викладачем.'}]})
      assert.equal(work.test.approved_revision,null)
      work=await mutate(ids.owner,'finalize_results',{id:essay.id,version:work.test.version})
      assert.equal(work.test.approved_revision,work.test.review_revision)
      assert.equal(work.attempts[0].final_score,20)
    })
  } finally {await fx.close()}
})
