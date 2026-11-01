import test from 'node:test'
import assert from 'node:assert/strict'
import { createFictionalAssistantWriteFixture } from '../assistant-full-fixture.mjs'

test('fictional preview caller stores actual confirmed homework and never mutates at prepare',async()=>{
 const f=await createFictionalAssistantWriteFixture({role:'headman'}),{LESSON}=f.ids
 const {draft}=await f.prepare('homework.upsert',{lessonId:LESSON,date:f.scope.date,topic:'Тема',body:'Якщо буде пара, прочитайте; інакше не здавайте.',dueAt:null})
 assert.equal(f.state.tables.study_group_homework.length,0);assert.equal((await f.confirm(draft)).status,'confirmed');assert.equal(f.state.tables.study_group_homework.length,1);assert.equal(f.state.tables.study_group_homework[0].body,draft.payload.body)
})
test('fictional teacher confirmed grades and coefficients are visible from the same caller port',async()=>{
 const f=await createFictionalAssistantWriteFixture({role:'teacher'}),{ACTIVITY,ENTRY,COURSE}=f.ids
 const {draft}=await f.prepare('teaching.grades.save',{activityId:ACTIVITY,rows:[{entryId:ENTRY,score:4,comment:'Виступ',reason:'',version:0}]});assert.equal((await f.confirm(draft)).status,'confirmed')
 const snapshot=(await f.client.rpc('xelay_teaching_course',{p_course_id:COURSE})).data;assert.equal(snapshot.grades[0].draft_score,4);assert.equal(snapshot.grades[0].published_at,null)
 const gradeRules={categories:[{id:'seminar',name:'Семінари',max_points:50,coefficient:1.5}],total_max:100};const next=await f.prepare('teaching.grading.save',{rules:gradeRules});assert.equal((await f.confirm(next.draft)).status,'confirmed');assert.equal(f.state.groups[0].grading_rules_override.categories[0].coefficient,1.5)
})
test('fictional preview roles and credentials cannot accidentally become production authority',async()=>{
 const teacher=await createFictionalAssistantWriteFixture({role:'teacher'}),student=await createFictionalAssistantWriteFixture({role:'student'})
 assert.equal(await teacher.verifySession('unregistered-token'),null)
 await assert.rejects(teacher.form('seminar.prepare'),e=>e.code==='permission_required')
 await assert.rejects(student.prepare('homework.upsert',{lessonId:student.ids.LESSON,date:student.scope.date,topic:'Тема',body:'ДЗ'}),e=>e.code==='permission_required')
 await assert.rejects(student.form('teaching.grades.save'),e=>e.code==='permission_required')
 assert.equal(teacher.state.writes.length,0);assert.equal(student.state.writes.length,0)
})
test('fictional preview saves a seminar through real inspector and exposes persisted questions',async()=>{
 const f=await createFictionalAssistantWriteFixture({role:'headman'}),{SEMSCHEDULE}=f.ids
 const {draft}=await f.prepare('seminar.prepare',{scheduleId:SEMSCHEDULE,date:f.scope.date,title:'Тема',instructions:'Підготовка',format:'questions',questions:[{body:'Перше питання',primaryCapacity:1,supplementCapacity:2}],teams:[]});const result=await f.confirm(draft)
 assert.equal(result.status,'confirmed');assert.equal(f.state.tables.study_group_seminars.length,1);assert.equal(f.state.tables.study_group_seminar_questions[0].seminar_id,result.receipt.affectedIds[0]);assert.equal(f.state.tables.study_group_seminar_questions[0].body,'Перше питання')
})
