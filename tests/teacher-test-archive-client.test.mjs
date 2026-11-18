import test from'node:test'
import assert from'node:assert/strict'
import{teacherModuleLoader}from'./helpers/loadTeacherModule.mjs'
const api=teacherModuleLoader()('src/lib/teachingTestArchive.ts')
const actor='83000000-0000-4000-8000-000000000001',course='83000000-0000-4000-8000-000000000002',group='83000000-0000-4000-8000-000000000003',id='83000000-0000-4000-8000-000000000004',now='2026-11-18T09:00:00Z'
const archived={testId:id,courseId:course,archivedAt:now,version:1}
test('archive client uses caller RPCs, explicit expected actor/version, subject/group scope and no grade/test mutation',async()=>{
 const calls=[],repo=api.createSupabaseTeachingTestArchiveRepository({async rpc(name,args){calls.push({name,args});return{data:name.endsWith('_state')?{userId:actor,canArchive:true,items:[archived],serverNow:now}:archived,error:null}}})
 assert.equal((await repo.state(course,group)).items[0].testId,id)
 assert.equal((await repo.set({testId:id,courseId:course,groupId:group,archived:true,expectedVersion:0,expectedUserId:actor})).version,1)
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{name:'xelay_teaching_test_archive_state',args:{p_course_id:course,p_group_id:group}},{name:'xelay_teaching_test_archive_set',args:{p_test_id:id,p_course_id:course,p_group_id:group,p_archived:true,p_expected_version:0,p_expected_user_id:actor}}])
})
test('invalid scope or actor never leaves client and foreign/mismatched response is not accepted',async()=>{
 let calls=0;const repo=api.createSupabaseTeachingTestArchiveRepository({async rpc(){calls++;return{data:{...archived,testId:course},error:null}}})
 await assert.rejects(repo.state('bad'));await assert.rejects(repo.set({testId:id,courseId:course,archived:true,expectedVersion:0,expectedUserId:'bad'}));assert.equal(calls,0)
 await assert.rejects(repo.set({testId:id,courseId:course,archived:true,expectedVersion:0,expectedUserId:actor}),/INVALID_RESPONSE/)
})
test('restored entries retain their version and canArchive false does not hide existing archive',async()=>{
 const restored={...archived,archivedAt:null,version:2},repo=api.createSupabaseTeachingTestArchiveRepository({async rpc(name){return{data:name.endsWith('_state')?{userId:actor,canArchive:false,items:[restored],serverNow:now}:restored,error:null}}})
 const state=await repo.state();assert.equal(state.canArchive,false);assert.equal(state.items[0].version,2)
 assert.equal((await repo.set({testId:id,courseId:course,archived:false,expectedVersion:1,expectedUserId:actor})).archivedAt,null)
})
test('completed hint rejects draft/future tests and invalid clock; backend remains authority for personal windows',()=>{
 assert.equal(api.teachingTestArchiveEligible({status:'draft',closes_at:'2026-11-17T00:00:00Z'},now),false)
 assert.equal(api.teachingTestArchiveEligible({status:'published',closes_at:'2026-11-19T00:00:00Z'},now),false)
 assert.equal(api.teachingTestArchiveEligible({status:'published',closes_at:'2026-11-17T00:00:00Z'},now),true)
 assert.equal(api.teachingTestArchiveEligible({status:'closed',closes_at:'2026-11-19T00:00:00Z'},now),true)
 assert.equal(api.teachingTestArchiveEligible({status:'closed',closes_at:now},'invalid'),false)
})
test('missing migration/schema-cache error is a safe setup notice and never leaks database details',()=>{
 const error=api.teachingTestArchiveError({code:'PGRST202',message:'sensitive internal SQL details'})
 assert.match(error,/ще не підключений/);assert.match(error,/Звичайні тести/);assert.doesNotMatch(error,/sensitive|SQL|PGRST/)
 assert.match(api.teachingTestArchiveError({code:'42883',message:'private.function'}),/ще не підключений/)
})
