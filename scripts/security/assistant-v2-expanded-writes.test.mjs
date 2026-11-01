import test from 'node:test'
import assert from 'node:assert/strict'
import { createConfirmedAssistantWrites, createLocalConfirmedWriteStore } from '../../server/assistant-v2/confirmedWrites.ts'

// Schema-shaped caller port, fictional data, no environment/provider/network.
// Existing RPCs stay the mutation boundary; these tests exercise real inspector,
// confirmation, version/rights recheck and dispatcher behavior, not text matching.
const id = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const USER=id(1), OTHER=id(2), GROUP=id(10), GROUP2=id(11), FOREIGN=id(12), COURSE=id(20), LESSON=id(30), SEMSCHEDULE=id(40), SEM=id(41), QUESTION=id(42), TEAM=id(43), ACTIVITY=id(50), ENTRY=id(51), GRADE=id(52), MATERIAL=id(60), LINK=id(61)
const TOKEN='fictional-expanded-write-session', NOW=Date.parse('2026-11-02T10:00:00Z'), STAMP='2026-11-02T09:00:00Z', DAY='2026-11-03'
const scope={groupId:GROUP,courseId:COURSE,date:DAY}, binding=d=>({id:d.id,revision:d.revision,confirmationToken:d.confirmationToken})
const deny=(op,code)=>assert.rejects(op,e=>e.code===code)
const rules={categories:[{id:'seminar',name:'Семінари',max_points:50,coefficient:2}],total_max:100,rounding:'hundredth',presets:[]}
const originalLesson=()=>({id:LESSON,group_id:GROUP,weekday:2,starts_at:'08:30:00',ends_at:'09:50:00',subject:'Вища математика',teacher_name:'Викладач',lesson_type:'lecture',location:'101',valid_from:DAY,valid_until:DAY,week_pattern:'every',week_anchor_date:null,excluded_dates:[],updated_at:STAMP,created_by:USER,online_url:null,online_url_secondary:null,online_links_extra:[],conference_id:null,conference_access_code:null})

async function setup() {
  const course={id:COURSE,owner_id:USER,title:'Вища математика',version:3,archived_at:null,permissions:['assignments','materials','grades','manage'],grading_rules:rules}
  const groups=[{id:LINK,course_id:COURSE,group_id:GROUP,group_name:'ЕУБ-1',status:'accepted',permissions:['assignments','materials','grades','manage'],grading_version:2,grading_rules_override:null}, {id:id(62),course_id:COURSE,group_id:GROUP2,group_name:'ЕУБ-2',status:'accepted',permissions:['assignments','materials','grades','manage']}]
  const activity={id:ACTIVITY,course_id:COURSE,group_id:GROUP,title:'Семінар 1',activity_date:DAY,max_points:5,version:1}
  const entry={id:ENTRY,course_id:COURSE,group_id:GROUP,full_name:'Тестова студентка',active:true,version:1}
  const material={id:MATERIAL,course_id:COURSE,version:2,created_by:USER,title:'Лекція',body:'Текст автора',status:'published',attachments:[],links:[],targets:[{group_id:GROUP}],allow_download:true,is_owner:true,can_edit:true,can_manage_groups:true,can_manage_collaborators:true,hidden_target_count:0,collaborators:[],updated_at:STAMP}
  const state={userId:USER,active:true,participant:true,rights:['schedule','homework','seminars'],writes:[],reads:[],signature:'a'.repeat(64),ai:{id:MATERIAL,sourceKind:'teaching',rightsVersion:'b'.repeat(32),materialVersion:'2',allowAi:false,canChange:true},verifiedFiles:new Set(),course,groups,activity,entry,material,
    tables:{study_groups:[{id:GROUP,representative_id:USER},{id:GROUP2,representative_id:USER}],study_group_members:[],study_group_schedule:[originalLesson()],study_group_homework:[],organizer_tasks:[],study_group_seminar_subjects:[{id:id(39),group_id:GROUP,name:'Вища математика',updated_at:STAMP}],study_group_seminar_schedule:[{id:SEMSCHEDULE,group_id:GROUP,subject_id:id(39),weekday:2,starts_at:'11:20',ends_at:'12:40',valid_from:'2026-10-01',valid_until:'2026-12-31'}],study_group_seminars:[],study_group_seminar_questions:[],study_group_seminar_teams:[],study_group_seminar_reservations:[],teaching_course_groups:groups,teaching_items:[],teaching_grades:[]}}
  class Query {
    constructor(table){this.table=table;this.filters={};this.bounds=[];this.count=Infinity;this.op='read'}
    select(){return this} eq(k,v){this.filters[k]=v;return this} lte(k,v){this.bounds.push(r=>r[k]<=v);return this} gte(k,v){this.bounds.push(r=>r[k]>=v);return this} order(){return this} limit(n){this.count=n;return this} single(){this.singular=true;return this}
    insert(v){this.op='insert';this.value=v;return this} update(v){this.op='update';this.value=v;return this}
    then(resolve,reject){return this.execute().then(resolve,reject)}
    async execute(){const rows=state.tables[this.table];assert.ok(rows,'mapped table '+this.table);const found=rows.filter(r=>Object.entries(this.filters).every(([k,v])=>r[k]===v)&&this.bounds.every(f=>f(r))).slice(0,this.count)
      if(this.op==='read'){state.reads.push(this.table);return {data:structuredClone(this.singular?found[0]??null:found),error:null}}
      state.writes.push({table:this.table,op:this.op,value:structuredClone(this.value)});let row;if(this.op==='insert'){row=structuredClone(this.value);rows.push(row)}else{row=found[0];if(!row)return {data:null,error:{code:'PT409'}};Object.assign(row,this.value)};return {data:{id:row.id},error:null}}
  }
  const client={from:t=>new Query(t),async rpc(name,args={}){
    if(name==='xelay_study_group_permissions')return {data:[GROUP,GROUP2].includes(args.p_group_id)?state.rights:[],error:null}
    if(name==='xelay_has_participant_access')return {data:state.participant,error:null}
    if(name==='xelay_teaching_group_context')return {data:{courses:[GROUP,GROUP2].includes(args.p_group_id)?[state.course]:[]},error:null}
    if(name==='xelay_teaching_course')return {data:{course:state.course,groups:state.groups,activities:[state.activity],entries:[state.entry],grades:state.tables.teaching_grades},error:null}
    if(name==='xelay_teaching_material_library')return {data:{materials:[state.material],courses:[{course:state.course,groups:state.groups,colleagues:[{user_id:OTHER,full_name:'Тестовий колега',status:'accepted',permissions:['materials']}]}]},error:null}
    if(name==='xelay_teaching_assignment_lessons')return {data:{lessons:state.tables.study_group_schedule.filter(row=>row.group_id===args.p_group_id)},error:null}
    if(name==='xelay_assistant_material_ai')return {data:structuredClone(state.ai),error:null}
    if(name.startsWith('xelay_copy_')&&args.p_preview===true)return {data:{source_signature:state.signature,copied:1,skipped:0,lessons:[originalLesson()],...(args.p_first_shift_start?{first_shift_start:args.p_first_shift_start,settings_revision:1}: {})},error:null}
    state.writes.push({rpc:name,args:structuredClone(args)})
    if(name==='xelay_assistant_save_seminar')return {data:args.p_action==='subject'?(args.p_values.p_subject_id??id(70)):args.p_action==='schedule'?(args.p_values.p_schedule_id??id(71)):(args.p_values.p_seminar_id??SEM),error:null}
    if(name.startsWith('xelay_copy_'))return {data:{source_signature:state.signature,copied:1,skipped:0,lessons:[]},error:null}
    if(name==='xelay_assistant_move_schedule')return {data:{id:args.p_new_id},error:null}
    if(name==='xelay_save_seminar_with_resources')return {data:args.p_seminar_id??SEM,error:null}
    if(name==='xelay_save_seminar_subject')return {data:args.p_subject_id??id(70),error:null}
    if(name==='xelay_save_seminar_schedule')return {data:args.p_schedule_id??id(71),error:null}
    if(name==='xelay_save_teaching_grades_batch')return {data:{id:args.p_activity_id,count:args.p_rows.length,request_id:args.p_request_id},error:null}
    if(name==='xelay_teaching_save_group_grading')return {data:{id:LINK,version:args.p_version+1},error:null}
    if(name==='xelay_teaching_mutate'){
      const p=args.p_payload;for(const file of p.attachments??[])if(!state.verifiedFiles.has(file.storage_path)&&!state.material.attachments.some(old=>old.storage_path===file.storage_path))return {data:null,error:{code:'42501'}}
      return {data:{id:p.id,version:p.version+1},error:null}}
    if(name==='xelay_assistant_set_material_ai')return {data:{...state.ai,allowAi:args.p_allow,rightsVersion:'c'.repeat(32)},error:null}
    if(name==='xelay_teaching_classified_assignment'||name==='xelay_teaching_save_multi_assignment')return {data:{id:args.p_payload.id,version:1},error:null}
    assert.fail('unmapped RPC '+name)
  }}
  const service=createConfirmedAssistantWrites({store:await createLocalConfirmedWriteStore(),now:()=>NOW,verifySession:async token=>{assert.equal(token,TOKEN);return {userId:state.userId,accountActive:state.active,emailConfirmed:true,expiresAt:'2026-11-02T14:00:00Z',sessionId:'fictional'}},createCallerClient:()=>client})
  return {state,client,service,prepare:(action,payload,s=scope)=>service.prepare(TOKEN,{action,scope:s,payload}),confirm:(draft,extra={})=>service.confirm(TOKEN,{...binding(draft),...extra}),form:(action,payload={},s=scope)=>service.form(TOKEN,{action,scope:s,payload})}
}

test('copy prepares a real read-only preview; explicit confirm pins signature and dispatches once',async()=>{
  const h=await setup(),{draft}=await h.prepare('schedule.copy',{sourceDate:DAY,targetDate:'2026-11-07',timeMode:'first_shift',firstShiftStart:'08:30',rememberFirstShiftStart:true,slotAssignments:[]})
  assert.equal(h.state.writes.length,0);const saved=await h.confirm(draft);assert.equal(saved.status,'confirmed');assert.equal(h.state.writes[0].args.p_preview,false);assert.equal(h.state.writes[0].args.p_expected_signature,'a'.repeat(64));assert.equal(h.state.writes[0].args.p_first_shift_start,'08:30');await h.confirm(draft);assert.equal(h.state.writes.length,1)
})
test('copy refuses changed source signature, wrong group, invalid custom time and Sunday memory',async()=>{
  const h=await setup(),{draft}=await h.prepare('schedule.copy',{sourceDate:DAY,targetDate:'2026-11-07'});h.state.signature='d'.repeat(64);await deny(h.confirm(draft),'draft_conflict')
  await deny(h.prepare('schedule.copy',{sourceDate:DAY,targetDate:'2026-11-08',timeMode:'first_shift',firstShiftStart:'08:30',rememberFirstShiftStart:true}),'remember_saturday_only')
  await deny(h.prepare('schedule.copy',{sourceDate:DAY,targetDate:'2026-11-07',timeMode:'first_shift',firstShiftStart:'25:00'}),'invalid_first_shift_start')
  await deny(h.prepare('schedule.copy',{sourceDate:DAY,targetDate:'2026-11-07'},{groupId:FOREIGN}),'permission_required');assert.equal(h.state.writes.length,0)
})
test('occurrence move binds fresh source version, actual date and target collision before mutation',async()=>{
  const h=await setup(),{draft}=await h.prepare('schedule.move',{id:LESSON,sourceDate:DAY,date:'2026-11-04',startsAt:'10:00',endsAt:'11:20'});assert.equal(h.state.writes.length,0)
  h.state.tables.study_group_schedule[0].updated_at='2026-11-02T09:01:00Z';await deny(h.confirm(draft),'draft_conflict');assert.equal(h.state.writes.length,0)
  const next=await h.prepare('schedule.move',{id:LESSON,sourceDate:DAY,date:'2026-11-04',startsAt:'10:00',endsAt:'11:20'});assert.equal((await h.confirm(next.draft)).status,'confirmed');assert.equal(h.state.writes[0].rpc,'xelay_assistant_move_schedule');assert.notEqual(h.state.writes[0].args.p_new_id,LESSON)
})
test('seminar creation uses existing RPC with null create ID; questions never get invented retained IDs',async()=>{
  const h=await setup(),{draft}=await h.prepare('seminar.prepare',{scheduleId:SEMSCHEDULE,date:DAY,title:'Тема семінару',instructions:'Підготуйте питання',format:'questions',questions:[{body:'Питання 1',primaryCapacity:1,supplementCapacity:2}],teams:[]})
  assert.equal(h.state.writes.length,0);const result=await h.confirm(draft);assert.equal(result.status,'confirmed');assert.deepEqual(result.receipt.affectedIds,[SEM]);const args=h.state.writes[0].args.p_values;assert.equal(args.p_seminar_id,null);assert.equal(args.p_questions[0].id,undefined);assert.deepEqual(args.p_questions[0],{body:'Питання 1',primary_capacity:1,supplement_capacity:2})
})
test('seminar update preserves resources, blocks closed choices and foreign retained question IDs',async()=>{
  const h=await setup();h.state.tables.study_group_seminars.push({id:SEM,group_id:GROUP,schedule_id:SEMSCHEDULE,lesson_date:DAY,format:'questions',resource_links:['https://example.com/notes'],resource_attachments:[],selection_deadline_at:'2026-11-04T12:00:00Z',updated_at:STAMP});h.state.tables.study_group_seminar_questions.push({id:QUESTION,seminar_id:SEM,body:'Старе питання'})
  const p={id:SEM,scheduleId:SEMSCHEDULE,date:DAY,title:'Оновлена тема',instructions:'Текст',format:'questions',questions:[{id:QUESTION,body:'Старе питання',primaryCapacity:1,supplementCapacity:1}],teams:[]};const {draft}=await h.prepare('seminar.prepare',p);assert.equal((await h.confirm(draft)).status,'confirmed');assert.deepEqual(h.state.writes[0].args.p_values.p_resource_links,['https://example.com/notes'])
  await deny(h.prepare('seminar.prepare',{...p,questions:[{...p.questions[0],id:id(999)}]}),'invalid_seminar_targets');h.state.tables.study_group_seminars[0].selection_deadline_at='2026-11-01T00:00:00Z';await deny(h.prepare('seminar.prepare',p),'seminar_reopen_required')
})
test('new seminar subject and schedule return actual generated IDs in receipts',async()=>{
  const h=await setup();const subject=await h.prepare('seminar.subject.upsert',{name:'Економіка'});assert.deepEqual((await h.confirm(subject.draft)).receipt.affectedIds,[id(70)])
  const schedule=await h.prepare('seminar.schedule.upsert',{subjectId:id(39),weekday:2,startsAt:'11:20',endsAt:'12:40',validFrom:DAY,validUntil:'2026-12-31'});assert.deepEqual((await h.confirm(schedule.draft)).receipt.affectedIds,[id(71)])
})
test('manual grades dispatch only supplied changed own-course rows and never publish them',async()=>{
  const h=await setup(),{draft}=await h.prepare('teaching.grades.save',{activityId:ACTIVITY,rows:[{entryId:ENTRY,score:4.5,comment:'Виступ',reason:'',version:0}]});assert.equal(h.state.writes.length,0);assert.equal((await h.confirm(draft)).status,'confirmed');assert.equal(h.state.writes[0].rpc,'xelay_save_teaching_grades_batch');assert.equal(h.state.writes[0].args.p_expected_user_id,USER);assert.equal(h.state.writes[0].args.p_rows[0].score,4.5)
  await deny(h.prepare('teaching.grades.save',{activityId:ACTIVITY,rows:[{entryId:ENTRY,score:null,comment:'',version:0}]}),'grades_have_no_changes')
})
test('grades reject foreign entries, invalid maximum, stale grade versions and unexplained published revision',async()=>{
  const h=await setup(),p={activityId:ACTIVITY,rows:[{entryId:ENTRY,score:4,comment:'',version:0}]}
  await deny(h.prepare('teaching.grades.save',{...p,rows:[{...p.rows[0],entryId:id(999)}]}),'permission_required');await deny(h.prepare('teaching.grades.save',{...p,rows:[{...p.rows[0],score:6}]}),'invalid_grade')
  h.state.tables.teaching_grades.push({id:GRADE,activity_id:ACTIVITY,entry_id:ENTRY,version:2,published_at:STAMP,published_score:3,published_comment:''})
  await deny(h.prepare('teaching.grades.save',p),'grade_conflict');await deny(h.prepare('teaching.grades.save',{...p,rows:[{...p.rows[0],version:2}]}),'grade_revision_reason_required');assert.equal(h.state.writes.length,0)
})
test('grading coefficients use versioned group rules RPC and fresh manage right',async()=>{
  const h=await setup(),{draft}=await h.prepare('teaching.grading.save',{rules});h.state.course.permissions=['grades'];await deny(h.confirm(draft),'permission_required');assert.equal(h.state.writes.length,0)
  h.state.course.permissions.push('manage');const next=await h.prepare('teaching.grading.save',{rules});assert.equal((await h.confirm(next.draft)).status,'confirmed');assert.equal(h.state.writes[0].args.p_version,2);assert.equal(h.state.writes[0].args.p_course_version,3);assert.equal(h.state.writes[0].args.p_rules.categories[0].coefficient,2)
  await deny(h.prepare('teaching.grading.save',{rules:{...rules,categories:[{...rules.categories[0],coefficient:1000}]}}),'invalid_grading_rules')
})
test('published material requires human rights checkbox; same journal cannot send it twice',async()=>{
  const h=await setup(),{draft}=await h.prepare('teaching.material.upsert',{id:MATERIAL,version:2,title:'Оновлена лекція'});assert.equal(draft.requiresMaterialRights,true);assert.equal(h.state.writes.length,0)
  await deny(h.confirm(draft),'material_rights_acceptance_required');assert.equal(h.state.writes.length,0);assert.equal((await h.confirm(draft,{acceptMaterialRights:true})).status,'confirmed')
  const p=h.state.writes[0].args.p_payload;assert.equal(p.rights_accepted,true);assert.equal(p.rights_terms_version,'2026-10-27.1');assert.equal(p.expected_user_id,USER);await h.confirm(draft,{acceptMaterialRights:true});assert.equal(h.state.writes.length,1)
})
test('material content and group permissions are independent and foreign groups cannot be attached',async()=>{
  const h=await setup();h.state.material.can_edit=false;await deny(h.prepare('teaching.material.upsert',{id:MATERIAL,version:2,title:'Спроба'}),'material_edit_permission_required')
  const {draft}=await h.prepare('teaching.material.visibility',{id:MATERIAL,version:2,groupIds:[GROUP2]});assert.equal((await h.confirm(draft)).status,'confirmed');assert.deepEqual(h.state.writes[0].args.p_payload.target_group_ids,[GROUP2]);assert.equal(h.state.writes[0].args.p_payload.body,undefined)
  await deny(h.prepare('teaching.material.visibility',{id:MATERIAL,version:2,groupIds:[FOREIGN]}),'permission_required');h.state.material.can_manage_groups=false;await deny(h.prepare('teaching.material.visibility',{id:MATERIAL,version:2,groupIds:[]}),'material_group_permission_required')
})
test('material files reject foreign ownership, immutable metadata, unverified actual objects and unsupported no-download formats',async()=>{
  const h=await setup(),file={storage_path:`${COURSE}/${USER}/${id(99)}.pdf`,name:'Лекція.pdf',mime_type:'application/pdf',size:1234}
  await deny(h.prepare('teaching.material.upsert',{id:MATERIAL,version:2,attachments:[{...file,storage_path:`${COURSE}/${OTHER}/${id(99)}.pdf`}]}),'attachment_owner_required')
  h.state.material.attachments=[file];await deny(h.prepare('teaching.material.upsert',{id:MATERIAL,version:2,attachments:[{...file,size:999}]}),'attachment_metadata_immutable')
  await deny(h.prepare('teaching.material.upsert',{id:MATERIAL,version:2,allowDownload:false,links:['https://example.com']}),'material_preview_format_required')
  h.state.material.attachments=[];const {draft}=await h.prepare('teaching.material.upsert',{id:MATERIAL,version:2,attachments:[file]});assert.equal((await h.confirm(draft,{acceptMaterialRights:true})).status,'unknown');await deny(h.confirm(draft,{acceptMaterialRights:true}),'execution_unknown');assert.equal(h.state.writes.length,1)
})
test('verified own file can replace a material while author source/hidden targets remain server-controlled',async()=>{
  const h=await setup(),file={storage_path:`${COURSE}/${USER}/${id(99)}.pdf`,name:'Лекція.pdf',mime_type:'application/pdf',size:1234};h.state.verifiedFiles.add(file.storage_path)
  const {draft}=await h.prepare('teaching.material.upsert',{id:MATERIAL,version:2,attachments:[file],allowDownload:false});assert.equal((await h.confirm(draft,{acceptMaterialRights:true})).status,'confirmed');assert.equal(h.state.writes[0].args.p_payload.created_by,undefined);assert.equal(h.state.writes[0].args.p_payload.target_group_ids,undefined)
})
test('AI permission is separate owner-only consent with version conflict and no content mutation',async()=>{
  const h=await setup(),p={id:MATERIAL,rightsVersion:'b'.repeat(32),allow:true};const {draft}=await h.prepare('teaching.material.ai',p);assert.equal((await h.confirm(draft)).status,'confirmed');assert.equal(h.state.writes[0].rpc,'xelay_assistant_set_material_ai')
  h.state.ai.canChange=false;await deny(h.prepare('teaching.material.ai',p),'material_author_required');h.state.ai.canChange=true;h.state.ai.rightsVersion='d'.repeat(32);await deny(h.prepare('teaching.material.ai',p),'material_conflict')
})
test('personal due time/reminders persist exact caller-owned settings and deny invalid repeats',async()=>{
  const h=await setup(),{draft}=await h.prepare('organizer.task.create',{title:'Прочитати конспект',dueAt:'2026-11-03T18:00:00+02:00',reminderAt:'2026-11-03T15:00:00Z',reminderOffsetsMinutes:[60,1440],recurrence:'weekly',recurrenceUntil:'2026-12-31'},{})
  assert.equal((await h.confirm(draft)).status,'confirmed');assert.equal(h.state.tables.organizer_tasks[0].user_id,USER);assert.deepEqual(h.state.tables.organizer_tasks[0].reminder_offsets_minutes,[60,1440]);assert.equal(h.state.tables.organizer_tasks[0].recurrence_rule,'weekly')
  await deny(h.prepare('organizer.task.create',{title:'Спроба',recurrence:'weekly'},{}),'invalid_recurrence');h.state.participant=false;await deny(h.form('organizer.task.create',{},{}),'participant_required')
})
test('group homework persists explicit deadline and preserves a free/null deadline',async()=>{
  const h=await setup(),p={lessonId:LESSON,date:DAY,topic:'Завдання',body:'Якщо відбудеться пара, прочитайте приклад; інакше нічого не здавайте.',dueAt:'2026-11-04T12:00:00Z'};const {draft}=await h.prepare('homework.upsert',p);assert.equal((await h.confirm(draft)).status,'confirmed');assert.equal(h.state.tables.study_group_homework[0].due_at,p.dueAt);assert.equal(h.state.tables.study_group_homework[0].body,p.body)
})
test('recurring create validates every actual upper/lower occurrence and bounds the period',async()=>{
  const h=await setup(),p={date:DAY,subject:'Економіка',startsAt:'11:20',endsAt:'12:40',lessonType:'lecture',recurring:true,validFrom:'2026-11-01',validUntil:'2026-12-31',weekday:2,weekPattern:'upper',weekAnchorDate:'2026-11-02'}
  const {draft}=await h.prepare('schedule.create',p);assert.equal((await h.confirm(draft)).status,'confirmed');assert.equal(h.state.tables.study_group_schedule.at(-1).week_pattern,'upper')
  await deny(h.prepare('schedule.create',{...p,startsAt:'08:30',endsAt:'09:50'}),'schedule_overlap');await deny(h.prepare('schedule.create',{...p,validUntil:'2028-01-01'}),'invalid_recurrence');await deny(h.prepare('schedule.create',{...p,weekAnchorDate:'2026-11-03'}),'invalid_recurrence')
})
test('forms return only authorized selector labels; changing identity or right blocks further access',async()=>{
  const h=await setup(),form=await h.form('teaching.grades.save',{activityId:ACTIVITY});assert.equal(form.form.fields.find(f=>f.key==='rows').type,'grade-rows');assert.deepEqual(form.form.fields.find(f=>f.key==='rows').options,[{value:ENTRY,label:'Тестова студентка'}]);assert.equal(h.state.writes.length,0)
  const material=await h.form('teaching.material.upsert',{id:MATERIAL});assert.equal(material.form.fields.find(f=>f.key==='attachments').type,'files');assert.equal(material.form.payload.version,2)
  h.state.rights=[];await deny(h.form('schedule.copy'),'permission_required');h.state.active=false;await deny(h.form('teaching.grades.save'),'session_invalid')
})

test('empty material AI form offers only owned material names before binding explicit current consent',async()=>{
 const h=await setup(),initial=await h.form('teaching.material.ai');assert.deepEqual(initial.form.fields.find(row=>row.key==='id').options,[{value:MATERIAL,label:'Лекція'}]);assert.equal(initial.form.fields.some(row=>row.key==='allow'),false)
 const selected=await h.form('teaching.material.ai',{id:MATERIAL});assert.equal(selected.form.payload.rightsVersion,'b'.repeat(32));assert.equal(selected.form.payload.allow,false)
 h.state.material.created_by=OTHER;const nonowner=await h.form('teaching.material.ai');assert.deepEqual(nonowner.form.fields.find(row=>row.key==='id').options,[]);await deny(h.form('teaching.material.ai',{id:MATERIAL}),'material_author_required')
})
test('material collaborators require the current author and show each grant and revocation before dispatch',async()=>{
 const h=await setup(),form=await h.form('teaching.material.collaborators',{id:MATERIAL});assert.equal(form.form.fields.find(row=>row.key==='grants').type,'material-grants');assert.deepEqual(form.form.fields.find(row=>row.key==='grants').options,[{value:OTHER,label:'Тестовий колега'}]);assert.equal(h.state.writes.length,0)
 const {draft}=await h.prepare('teaching.material.collaborators',{id:MATERIAL,version:2,grants:[{userId:OTHER,canEdit:true,canDelete:false,canManageGroups:true}]});assert.ok(draft.items.some(row=>row.label==='Тестовий колега'&&row.after.includes('Редагування: так; видалення: ні; вибір груп: так')));assert.equal((await h.confirm(draft)).status,'confirmed')
 assert.equal(h.state.writes[0].args.p_action,'set_material_collaborators');assert.deepEqual(h.state.writes[0].args.p_payload.grants,[{user_id:OTHER,can_edit:true,can_delete:false,can_manage_groups:true}]);assert.equal(h.state.writes[0].args.p_payload.expected_user_id,USER)
 h.state.material.collaborators=[{user_id:OTHER,full_name:'Тестовий колега',can_edit:true,can_delete:false,can_manage_groups:true}];const revoked=await h.prepare('teaching.material.collaborators',{id:MATERIAL,version:2,grants:[]});assert.ok(revoked.draft.items.some(row=>row.label==='Тестовий колега'&&row.after.includes('Відкликати всі')))
 h.state.material.can_manage_collaborators=false;await deny(h.confirm(revoked.draft),'material_author_required');assert.equal(h.state.writes.length,1)
})
test('material delegation cannot grant self/foreign identities, stale versions or impersonated author rights',async()=>{
 const h=await setup(),grant={userId:OTHER,canEdit:true,canDelete:false,canManageGroups:false},p={id:MATERIAL,version:2,grants:[grant]}
 await deny(h.prepare('teaching.material.collaborators',{...p,grants:[{...grant,userId:USER}]}),'invalid_material_grant');await deny(h.prepare('teaching.material.collaborators',{...p,grants:[{...grant,userId:id(999)}]}),'permission_required');await deny(h.prepare('teaching.material.collaborators',{...p,version:1}),'material_conflict')
 h.state.material.created_by=OTHER;await deny(h.prepare('teaching.material.collaborators',p),'material_author_required');assert.equal(h.state.writes.length,0)
})
test('forms prefill the selected lesson and material groups without dropping existing link labels',async()=>{
 const h=await setup(),lesson=await h.form('schedule.update',{id:LESSON});assert.equal(lesson.form.payload.subject,'Вища математика');assert.equal(lesson.form.payload.startsAt,'08:30');assert.equal(lesson.form.payload.lessonType,'lecture');assert.ok(lesson.form.fields.find(row=>row.key==='lessonType').options.some(row=>row.value==='final_assessment'))
 const material=await h.form('teaching.material.upsert',{id:MATERIAL});assert.deepEqual(material.form.payload.groupIds,[GROUP]);h.state.material.links=['https://example.com'];h.state.material.link_labels={'https://example.com':'Конспект'};const prepared=await h.prepare('teaching.material.upsert',{id:MATERIAL,version:2,title:'Оновлена назва',links:['https://example.com']});await h.confirm(prepared.draft,{acceptMaterialRights:true});assert.deepEqual(h.state.writes[0].args.p_payload.link_labels,{'https://example.com':'Конспект'})
})
test('organizer reminder settings match the production presets, date-only anchor and normalized order',async()=>{
 const h=await setup(),p={title:'Підготовка',dueDate:'2026-11-04',reminderOffsetsMinutes:[1440,60],recurrence:'weekly',recurrenceUntil:'2026-12-31'};const {draft}=await h.prepare('organizer.task.create',p,{});assert.equal((await h.confirm(draft)).status,'confirmed');assert.deepEqual(h.state.tables.organizer_tasks[0].reminder_offsets_minutes,[60,1440])
 for(const invalid of [{...p,reminderOffsetsMinutes:[30]},{title:'Нагадати',reminderAt:'2026-11-04T12:00:00Z'},{...p,dueDate:'2026-11-02',reminderOffsetsMinutes:[1440]}])await deny(h.prepare('organizer.task.create',invalid,{}),'invalid_reminder')
 await deny(h.prepare('organizer.task.create',{title:'Справи',dueAt:'2026-11-03T23:30:00Z',recurrence:'weekly',recurrenceUntil:'2026-11-03'},{}),'invalid_recurrence')
})
test('explicit free deadline in one teaching target never inherits the global deadline',async()=>{
 const h=await setup(),deadline='2026-11-04T12:00:00Z',prepared=await h.prepare('teaching.assignment.upsert',{title:'Спільне завдання',groupIds:[GROUP,GROUP2],dueAt:deadline,targets:[{groupId:GROUP,lessonDate:DAY,placementMode:'unplaced',dueAt:null},{groupId:GROUP2,lessonDate:DAY,placementMode:'unplaced'}]});assert.equal((await h.confirm(prepared.draft)).status,'confirmed');assert.equal(h.state.writes[0].args.p_payload.targets[0].due_at,null);assert.equal(h.state.writes[0].args.p_payload.targets[1].due_at,deadline)
})
test('editing a copied one-off pair retains its source provenance and omitted links',async()=>{
 const h=await setup(),source=h.state.tables.study_group_schedule[0];source.copied_from_schedule_id=id(909);source.inherit_source_links=true;source.online_url='https://example.com/source';const {draft}=await h.prepare('schedule.update',{id:LESSON,date:DAY,subject:source.subject,startsAt:'10:00',endsAt:'11:20',lessonType:source.lesson_type});assert.equal((await h.confirm(draft)).status,'confirmed');assert.equal(source.copied_from_schedule_id,id(909));assert.equal(source.inherit_source_links,true);assert.equal(source.online_url,'https://example.com/source')
})
