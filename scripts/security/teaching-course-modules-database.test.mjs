import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {courseModulesFixture,readCourseModuleMigration} from './teaching-course-modules-fixture.mjs'
import {syntheticTest} from './teaching-tests-fixture.mjs'
import {verifyStoredBytes} from './upload-content-workflow-bridge.mjs'

test('course modules enforce real server prerequisites without resetting work, attempts, published grades or file protection',async t=>{
  const fx=await courseModulesFixture({applyModules:false});t.after(()=>fx.close())
  const {db,ids,groups,rpc,mutate,classroom}=fx
  const target=group=>({group_id:group,audience_mode:'all',subgroup_ids:[],team_ids:[],placement_mode:'unplaced',lesson_date:fx.dates.lesson_a,due_at:null,closes_at:null})
  const bytes=Buffer.from('Synthetic module reading. No personal or real course content.\n')
  const filePath=`${ids.course}/${ids.owner}/${randomUUID()}.txt`
  await fx.asUser(ids.owner,'insert into storage.objects(bucket_id,name,owner,owner_id,metadata) values($1,$2,$3::uuid,$3::text,$4::jsonb)',
    ['xelay-teaching-files',filePath,ids.owner,JSON.stringify({size:bytes.length,mimetype:'text/plain'})])
  assert.equal((await verifyStoredBytes({db,asUser:fx.asUser,actor:ids.owner,bucket:'xelay-teaching-files',path:filePath,bytes})).statusCode,200)
  const material=async(title,status='published',attachments=[])=>{
    const id=randomUUID();await mutate(ids.owner,'save_library_material',{id,version:0,expected_user_id:ids.owner,course_id:ids.course,title,
      body:`PRIVATE_${title}`,links:[],attachments,status,rights_accepted:true,rights_terms_version:'2026-10-27.1',target_group_ids:groups})
    return id
  }
  const first=await material('First reading'),last=await material('Locked reading','published',[{storage_path:filePath,name:'reading.txt',size:bytes.length,mime_type:'text/plain'}])
  const draft=await material('SECRET_DRAFT_TITLE','draft')
  const work={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic assessed module work',body:'PRIVATE_ASSIGNMENT_BODY',status:'published',
    links:[],attachments:[],max_points:10,category:'',submission_mode:'individual',targets:groups.map(target)}
  await rpc(ids.owner,'xelay_teaching_save_multi_assignment',[JSON.stringify(work)])
  const definition=syntheticTest(ids.course,groups,{title:'Synthetic module test',description:'PRIVATE_TEST_DESCRIPTION',bonus_percent:0,bonus_points:0})
  await rpc(ids.owner,'xelay_teaching_test_mutate',['save_test',JSON.stringify(definition)])
  let priorAttempt=await rpc(ids.headA,'xelay_teaching_test_mutate',['start',JSON.stringify({id:definition.id,group_id:groups[0]})])
  let priorWork=await classroom(ids.headA,'reserve_submission',{id:randomUUID(),item_id:work.id,group_id:groups[0],version:0})
  priorWork=await classroom(ids.headA,'save_submission',{id:priorWork.id,version:priorWork.version,body:'Preserved existing draft',links:[],attachments:[]})
  const legacyActivity=await mutate(ids.owner,'save_activity',{id:randomUUID(),version:0,course_id:ids.course,group_id:groups[0],title:'Synthetic prior published result',activity_date:fx.dates.lesson_a,category:'',max_points:5})
  const legacyEntry=(await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3',[ids.course,groups[0],ids.headA])).rows[0].id
  const legacyGrade=await mutate(ids.owner,'save_grade',{activity_id:legacyActivity.id,entry_id:legacyEntry,version:0,score:4,comment:'Preserved prior feedback',reason:''})
  await mutate(ids.owner,'publish_grades',{activity_id:legacyActivity.id,expected_versions:[{entry_id:legacyEntry,version:legacyGrade.version}]})
  const snapshot=async()=>{
    const result={}
    for(const table of ['teaching_items','teaching_item_targets','teaching_submissions','teaching_submission_history','teaching_grades','teaching_grade_audit','teaching_test_attempts','teaching_tests','storage.objects','xelay_upload_content_receipts']) {
      result[table]=(await db.query(`select to_jsonb(x) data from ${table} x order by to_jsonb(x)::text`)).rows
    }return result
  }
  const before=await snapshot()
  await db.exec(await readCourseModuleMigration('202611040050_teaching_course_modules.sql'))
  await db.exec(await readCourseModuleMigration('202611060055_teaching_module_prerequisite_diagnostics.sql'))
  const teacher=(who=ids.owner)=>rpc(who,'xelay_teaching_course_modules',[ids.course])
  const student=(who=ids.studentA,group=groups[0])=>rpc(who,'xelay_student_course_modules',[ids.course,group])
  const save=(payload,who=ids.owner)=>rpc(who,'xelay_teaching_course_module_save',[JSON.stringify({...payload,expected_user_id:who})])
  const acknowledge=(item,who=ids.studentA,group=groups[0],expected=who)=>rpc(who,'xelay_student_module_acknowledge',[item,group,expected])
  const item=(type,id,rule,dependencies=[],extra={})=>({id:randomUUID(),resource_type:type,resource_id:id,required:true,completion:rule,pass_percent:rule==='passed'?60:null,
    prerequisite_item_ids:dependencies,position:0,...extra})
  const reading=item('material',first,'acknowledged'),assignment=item('assignment',work.id,'passed',[reading.id],{position:1}),assessment=item('test',definition.id,'submitted',[assignment.id],{position:2})
  const lastItem=item('material',last,'acknowledged')
  let one={id:randomUUID(),course_id:ids.course,title:'Synthetic foundation',description:'Module description',status:'published',group_ids:groups,position:0,version:0,prerequisite_item_ids:[],items:[reading,assignment,assessment]}
  let two={id:randomUUID(),course_id:ids.course,title:'Synthetic next module',description:'PRIVATE_LOCKED_MODULE_DESCRIPTION',status:'published',group_ids:[groups[0]],position:1,version:0,
    prerequisite_item_ids:[assessment.id],items:[lastItem]}
  const current=(data,id)=>data.modules.find(m=>m.id===id)
  const request=m=>({...m,items:m.items.map(({title,...i})=>i)})
  const learningItem=(data,id)=>data.modules.flatMap(m=>m.items).find(i=>i.id===id)
  const prerequisiteFailure=(reason, expected={})=>failure=>{
    assert.match(failure.message,/COURSE_MODULE_TARGET_MISMATCH/)
    const details=JSON.parse(failure.detail)
    assert.equal(details.reason,reason)
    for(const [key,value] of Object.entries(expected)) assert.equal(details[key],value)
    assert.ok(Object.keys(details).every(key=>['reason','module_title','prerequisite_module_title','prerequisite_title','group_name'].includes(key)))
    return true
  }
  let colleagueLink,submission,grade

  await t.test('additive migration preserves all existing content, attempt snapshots, draft work, file receipts and grade history',async()=>{
    assert.deepEqual(await snapshot(),before)
    assert.equal((await teacher()).modules.length,0)
    const data=await save(one);one=request(current(data,one.id));assert.equal(one.version,1)
    two=request(current(await save(two),two.id));assert.equal(two.version,1)
    assert.deepEqual(await snapshot(),before,'module metadata is not copied into canonical work or journal rows')
  })
  await t.test('locked student output has no content and direct work/test/file APIs cannot bypass prerequisites',async()=>{
    const data=await student();assert.equal(data.total,4);assert.equal(data.completed,0)
    assert.equal(learningItem(data,reading.id).locked,false)
    assert.equal(learningItem(data,assignment.id).locked,true);assert.equal(learningItem(data,assessment.id).locked,true)
    assert.equal(current(data,two.id).description,'')
    assert.doesNotMatch(JSON.stringify(data),/PRIVATE_|SECRET_DRAFT|storage_path|current_question|"answer"|"attachments"|"body"/)
    await assert.rejects(rpc(ids.studentA,'xelay_classroom_assignment',[work.id,groups[0]]),/FORBIDDEN/)
    await assert.rejects(classroom(ids.studentA,'reserve_submission',{id:randomUUID(),item_id:work.id,group_id:groups[0]}),/FORBIDDEN/)
    await assert.rejects(rpc(ids.studentA,'xelay_teaching_test',[definition.id]),/FORBIDDEN/)
    await assert.rejects(rpc(ids.studentA,'xelay_teaching_test_mutate',['start',JSON.stringify({id:definition.id,group_id:groups[0]})]),/FORBIDDEN/)
    assert.ok(!(await rpc(ids.studentA,'xelay_teaching_tests',[ids.course,groups[0]])).tests.some(x=>x.id===definition.id))
    assert.deepEqual((await fx.asUser(ids.studentA,'select name from storage.objects where bucket_id=$1 and name=$2',['xelay-teaching-files',filePath])).rows,[])
    await assert.rejects(rpc(ids.studentA,'xelay_teaching_material_file_access',[last,filePath]),/FORBIDDEN/)
    const aggregate=await rpc(ids.studentA,'xelay_teaching_group',[groups[0]])
    assert.doesNotMatch(JSON.stringify(aggregate),/PRIVATE_ASSIGNMENT_BODY|PRIVATE_Locked reading|reading\.txt/)
    const original=await rpc(ids.owner,'xelay_classroom_assignment',[work.id,groups[0]])
    assert.equal(original.item.body,'PRIVATE_ASSIGNMENT_BODY','teacher preview and grading permissions are unchanged')
  })
  await t.test('only own explicit acknowledgement opens work; draft scores, absence and below-threshold published marks do not open test',async()=>{
    await assert.rejects(acknowledge(reading.id,ids.studentA,groups[0],ids.headA),/ACTOR_CHANGED/)
    await assert.rejects(acknowledge(reading.id,ids.studentB,groups[0]),/FORBIDDEN/)
    await assert.rejects(acknowledge(assignment.id),/FORBIDDEN/)
    await acknowledge(reading.id);await acknowledge(reading.id)
    assert.equal((await db.query('select count(*)::int n from teaching_course_module_acknowledgements where item_id=$1 and user_id=$2',[reading.id,ids.studentA])).rows[0].n,1)
    assert.equal(learningItem(await student(),assignment.id).locked,false)
    assert.equal(learningItem(await student(ids.headA),reading.id).completed,false)
    submission=await classroom(ids.studentA,'reserve_submission',{id:randomUUID(),item_id:work.id,group_id:groups[0]})
    submission=await classroom(ids.studentA,'save_submission',{id:submission.id,version:submission.version,body:'Synthetic submitted reasoning',links:[],attachments:[]})
    submission=await classroom(ids.studentA,'submit_submission',{id:submission.id,version:submission.version})
    const activity=(await db.query('select id from teaching_activities where item_id=$1 and group_id=$2',[work.id,groups[0]])).rows[0].id
    const entry=(await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3',[ids.course,groups[0],ids.studentA])).rows[0].id
    const update=async(score,absent=false)=>{
      grade=await mutate(ids.owner,'save_grade',{activity_id:activity,entry_id:entry,version:grade?.version||0,score,absent,comment:'Synthetic review',reason:'Synthetic reviewed correction'})
      return (await db.query('select * from teaching_grades where id=$1',[grade.id])).rows[0]
    }
    const publish=async()=>{
      await mutate(ids.owner,'publish_grades',{activity_id:activity,expected_versions:[{entry_id:entry,version:grade.version}]})
      grade=(await db.query('select * from teaching_grades where id=$1',[grade.id])).rows[0]
    }
    await update(9)
    let view=await student();assert.equal(learningItem(view,assignment.id).completed,false);assert.equal(learningItem(view,assignment.id).score,null)
    await assert.rejects(rpc(ids.studentA,'xelay_teaching_test_mutate',['start',JSON.stringify({id:definition.id,group_id:groups[0]})]),/FORBIDDEN/)
    await update(null,true);await publish()
    assert.equal(learningItem(await student(),assignment.id).completed,false,'Н is never a numeric published completion')
    await update(5);await publish()
    assert.equal(learningItem(await student(),assignment.id).completed,false,'published 50% is below authored 60%')
    await update(6);await publish()
    view=await student();assert.equal(learningItem(view,assignment.id).completed,true);assert.equal(learningItem(view,assessment.id).locked,false)
    assert.equal(learningItem(view,assignment.id).score,6)
  })
  await t.test('completed test opens next module/file and every existing attempt or private work remains resumable',async()=>{
    let detail=await rpc(ids.studentA,'xelay_teaching_test_mutate',['start',JSON.stringify({id:definition.id,group_id:groups[0]})])
    detail=await rpc(ids.studentA,'xelay_teaching_test_mutate',['finish',JSON.stringify({id:definition.id,version:detail.attempt.version})])
    assert.equal(detail.attempt.status,'submitted')
    const view=await student();assert.equal(current(view,two.id).locked,false)
    assert.equal((await fx.asUser(ids.studentA,'select name from storage.objects where bucket_id=$1 and name=$2',['xelay-teaching-files',filePath])).rows.length,1)
    assert.ok((await rpc(ids.studentA,'xelay_teaching_material_file_access',[last,filePath])).storage_path)
    let legacy=await rpc(ids.headA,'xelay_teaching_test',[definition.id])
    assert.equal(legacy.attempt.id,priorAttempt.attempt.id);assert.equal(legacy.attempt.expires_at,priorAttempt.attempt.expires_at)
    assert.equal((await rpc(ids.headA,'xelay_classroom_assignment',[work.id,groups[0]])).my_submission.body,'Preserved existing draft')
    legacy=await rpc(ids.headA,'xelay_teaching_test_mutate',['save_answer',JSON.stringify({id:definition.id,version:legacy.attempt.version,question_id:'choice',answer:'b'})])
    assert.equal(legacy.attempt.id,priorAttempt.attempt.id)
    const kept=await classroom(ids.headA,'save_submission',{id:priorWork.id,version:priorWork.version,body:'Existing work continues safely',links:[],attachments:[]})
    assert.ok(kept.version>priorWork.version)
  })
  await t.test('owner-only versioned structure rejects impersonation, wrong resources, duplicates, cycles and target mismatches atomically',async()=>{
    colleagueLink=await mutate(ids.owner,'invite_teacher',{course_id:ids.course,user_id:ids.colleague,permissions:['assignments'],group_scope:'selected',group_ids:[groups[0]]})
    await mutate(ids.colleague,'respond_teacher',{teacher_link_id:colleagueLink.id,accept:true})
    for(const who of [ids.colleague,ids.studentA,ids.admin,ids.otherTeacher]) await assert.rejects(save(one,who),/FORBIDDEN/)
    await assert.rejects(rpc(ids.owner,'xelay_teaching_course_module_save',[JSON.stringify({...one,expected_user_id:ids.studentA})]),/ACTOR_CHANGED/)
    await assert.rejects(save({...one,version:0}),/CONFLICT/)
    await assert.rejects(save({...one,items:[{...reading,resource_id:last},assignment,assessment]}),/INVALID/)
    await assert.rejects(save({...one,items:[reading,assignment,{...assessment,prerequisite_item_ids:[assessment.id]}]}),/CYCLE/)
    await assert.rejects(save({...one,prerequisite_item_ids:[reading.id]}),/CYCLE/)
    await assert.rejects(save({...one,items:[{...reading,prerequisite_item_ids:[assessment.id]},assignment,assessment]}),/CYCLE/)
    await assert.rejects(save({...one,items:[reading,assignment,{...assessment,prerequisite_item_ids:[randomUUID()]}]}),/TARGET_MISMATCH/)
    await assert.rejects(save({...one,items:[],prerequisite_item_ids:[randomUUID()]}),prerequisiteFailure('missing',{module_title:one.title}),'empty modules cannot hide an invalid prerequisite reference')
    const groupName=(await teacher()).groups.find(group=>group.id===groups[0]).name
    await assert.rejects(save({...one,group_ids:[groups[1]]}),prerequisiteFailure('groups',{module_title:two.title,prerequisite_module_title:one.title,prerequisite_title:definition.title,group_name:groupName}),'next module group A cannot depend on an item available only in group B')
    const duplicate={...two,id:randomUUID(),version:0,prerequisite_item_ids:[],items:[{...lastItem,id:randomUUID()}]}
    await assert.rejects(save(duplicate),/RESOURCE_USED/)
    assert.equal(current(await teacher(),one.id).version,one.version,'every rejected save rolls back module/item versions')
  })
  await t.test('scoped assignments staff see structure but no progress; grades staff see only their accepted group',async()=>{
    const noGrades=await teacher(ids.colleague)
    assert.equal(noGrades.can_manage,false);assert.deepEqual(noGrades.progress,[])
    assert.deepEqual(noGrades.groups.map(g=>g.id),[groups[0]])
    assert.ok(noGrades.modules.every(m=>m.group_ids.every(g=>g===groups[0])))
    await mutate(ids.owner,'update_teacher',{teacher_link_id:colleagueLink.id,permissions:['grades'],group_scope:'selected',group_ids:[groups[0]]})
    const scoped=await teacher(ids.colleague)
    assert.ok(scoped.progress.length>=2);assert.ok(scoped.progress.every(p=>p.group_id===groups[0]))
    assert.equal(scoped.progress.find(p=>p.user_id===ids.studentA).items.find(i=>i.item_id===assignment.id).score,6)
    await mutate(ids.owner,'update_teacher',{teacher_link_id:colleagueLink.id,status:'removed'})
    await assert.rejects(teacher(ids.colleague),/FORBIDDEN/)
    await assert.rejects(student(ids.studentB,groups[0]),/FORBIDDEN/)
  })
  await t.test('draft and archived modules never gate; published draft resources are preparing without leaking title or auto-publishing',async()=>{
    const pendingItem=item('material',draft,'acknowledged')
    let pending={id:randomUUID(),course_id:ids.course,title:'Synthetic preparing module',description:'Draft placeholder',status:'published',group_ids:[groups[0]],position:2,version:0,prerequisite_item_ids:[],items:[pendingItem]}
    pending=request(current(await save(pending),pending.id))
    const view=await student();assert.equal(learningItem(view,pendingItem.id).available,false);assert.equal(learningItem(view,pendingItem.id).completed,false)
    assert.doesNotMatch(JSON.stringify(view),/SECRET_DRAFT_TITLE/)
    assert.equal((await fx.item(draft)).status,'draft')
    await assert.rejects(acknowledge(pendingItem.id),/FORBIDDEN/)
    pending=request(current(await save({...pending,status:'draft'}),pending.id))
    await assert.rejects(save({...two,prerequisite_item_ids:[pendingItem.id]}),prerequisiteFailure('draft',{
      module_title:two.title,prerequisite_module_title:pending.title,prerequisite_title:'SECRET_DRAFT_TITLE',
    }))
    assert.equal(current(await teacher(),two.id).version,two.version,'rejected publication preserves the previous version')
    pending=request(current(await save({...pending,status:'archived'}),pending.id))
    assert.ok(!(await student()).modules.some(m=>m.id===pending.id))
    // Active-only ordering does not require archived IDs or overwrite history.
    const order=[two.id,one.id],versions={[one.id]:one.version,[two.id]:two.version}
    const reordered=await rpc(ids.owner,'xelay_teaching_course_modules_reorder',[ids.course,order,JSON.stringify(versions),ids.owner])
    one=request(current(reordered,one.id));two=request(current(reordered,two.id))
    assert.equal(one.position,1);assert.equal(two.position,0)
    await assert.rejects(rpc(ids.owner,'xelay_teaching_course_modules_reorder',[ids.course,order,JSON.stringify(versions),ids.owner]),/CONFLICT/)
    await assert.rejects(rpc(ids.studentA,'xelay_teaching_course_modules_reorder',[ids.course,order,JSON.stringify(versions),ids.studentA]),/FORBIDDEN/)
    assert.equal(current(await teacher(),pending.id).version,pending.version)
  })
  await t.test('private tables/helpers are closed and logged-in RPCs cannot be used by anonymous or service roles',async()=>{
    for(const role of ['anon','authenticated','service_role']) for(const table of ['teaching_course_modules','teaching_course_module_items','teaching_course_module_acknowledgements'])
      assert.equal((await db.query('select has_table_privilege($1,$2,\'select,insert,update,delete\') allowed',[role,table])).rows[0].allowed,false)
    assert.deepEqual((await db.query("select proname from pg_proc where proname like 'xelay_private_module_%' and has_function_privilege('authenticated',oid,'execute')")).rows,[])
    await assert.rejects(fx.asUser(ids.studentA,'select * from teaching_course_modules'),/permission denied/)
    await assert.rejects(fx.asUser(ids.studentA,'insert into teaching_course_module_acknowledgements(item_id,group_id,user_id) values($1,$2,$3)',[reading.id,groups[0],ids.headA]),/permission denied/)
    assert.equal((await db.query("select has_function_privilege('anon','xelay_student_course_modules(uuid,uuid)','execute') allowed")).rows[0].allowed,false)
    assert.equal((await db.query("select has_function_privilege('service_role','xelay_teaching_item_email_context(uuid,uuid)','execute') allowed")).rows[0].allowed,true)
  })
  await t.test('server rejects unreachable subgroup prerequisites and ungraded work grade-rules; archived resources can be reused',async()=>{
    const subgroup=randomUUID()
    await db.query('insert into teaching_subgroups(id,course_id,group_id,name,user_ids,created_by) values($1,$2,$3,$4,$5,$6)',[subgroup,ids.course,groups[0],'Synthetic subgroup',[ids.studentA],ids.owner])
    const restricted=randomUUID()
    await mutate(ids.owner,'save_library_material',{id:restricted,version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic subgroup-only prerequisite',body:'Synthetic subset',links:[],attachments:[],status:'published',
      rights_accepted:true,rights_terms_version:'2026-10-27.1',target_group_ids:[groups[0]],target_audiences:[{group_id:groups[0],audience_mode:'subgroups',subgroup_ids:[subgroup],team_ids:[]}]})
    const noGrade={...work,id:randomUUID(),title:'Synthetic ungraded work',max_points:null,targets:[target(groups[0])]}
    await classroom(ids.owner,'save_group_assignment',noGrade)
    const pre=item('material',restricted,'acknowledged'),after=item('assignment',noGrade.id,'submitted',[pre.id],{position:1})
    const invalid={id:randomUUID(),course_id:ids.course,title:'Synthetic invalid audience',description:'',status:'published',group_ids:[groups[0]],position:3,version:0,prerequisite_item_ids:[],items:[pre,after]}
    await assert.rejects(save(invalid),prerequisiteFailure('audience',{
      module_title:invalid.title,prerequisite_title:'Synthetic subgroup-only prerequisite',
    }),'head is a work recipient but cannot read its subgroup-only prerequisite')
    await assert.rejects(save({...invalid,items:[{...after,completion:'graded',prerequisite_item_ids:[]}]}),/INVALID/)
    const reuse={...invalid,id:randomUUID(),title:'Synthetic resource reused from archive',status:'draft',items:[item('material',draft,'acknowledged')]}
    assert.ok(current(await save(reuse),reuse.id),'archiving releases active resource reservation without deleting old item history')
    const unattached=await rpc(ids.headA,'xelay_classroom_assignment',[noGrade.id,groups[0]])
    assert.equal(unattached.item.id,noGrade.id,'unattached work still follows its original authorization')
  })
  await t.test('numeric published zero counts as graded, threshold zero is valid, historical ACK survives expiry',async()=>{
    let currentGrade=(await db.query('select * from teaching_grades where id=$1',[grade.id])).rows[0]
    const saved=await mutate(ids.owner,'save_grade',{activity_id:currentGrade.activity_id,entry_id:currentGrade.entry_id,version:currentGrade.version,score:0,absent:false,comment:'Synthetic zero',reason:'Synthetic numeric correction'})
    await mutate(ids.owner,'publish_grades',{activity_id:currentGrade.activity_id,expected_versions:[{entry_id:currentGrade.entry_id,version:saved.version}]})
    one=request(current(await save({...one,items:one.items.map(i=>i.id===assignment.id?{...i,completion:'graded',pass_percent:null}:i)}),one.id))
    assert.equal(learningItem(await student(),assignment.id).completed,true);assert.equal(learningItem(await student(),assignment.id).score,0)
    one=request(current(await save({...one,items:one.items.map(i=>i.id===assignment.id?{...i,completion:'passed',pass_percent:0}:i)}),one.id))
    assert.equal(learningItem(await student(),assignment.id).completed,true)
    const actual=await fx.item(first)
    await mutate(ids.owner,'save_library_material',{id:first,version:actual.version,expected_user_id:ids.owner,access_until:new Date(Date.now()+60000).toISOString(),rights_accepted:true,rights_terms_version:'2026-10-27.1'})
    // Advance only this synthetic stored expiry; no clock/auth helper is stubbed.
    await db.query("update teaching_items set access_until=clock_timestamp()-interval '1 second' where id=$1",[first])
    const view=await student();assert.equal(learningItem(view,reading.id).completed,true,'recorded reading completion is not erased by later file expiry')
    await assert.rejects(acknowledge(reading.id),/FORBIDDEN/,'expiry still prevents new acknowledgement/content access')
    assert.equal((await rpc(ids.studentA,'xelay_teaching_test',[definition.id])).attempt.status,'submitted','published own test history remains visible after a predecessor changes')
  })
  await t.test('queued generic publication email checks the recipient gate and exact unexpired service lease',async()=>{
    const notices=async(recipient,noticeGroup=groups[0])=>{
      const existing=(await db.query('select id from notifications where recipient_id=$1 and teaching_event_key=$2',[recipient,`teaching-item:${last}:1`])).rows[0]
      let notice=existing?.id
      if(!notice) notice=(await db.query(`insert into notifications(recipient_id,actor_id,actor_name,type,message,teaching_course_id,teaching_event_key,study_group_id)
        values($1,$2,'Synthetic teacher','teaching_update','Synthetic publication',$3,$4,$5) returning id`,[recipient,recipient===ids.owner?ids.headA:ids.owner,ids.course,`teaching-item:${last}:1`,noticeGroup])).rows[0].id
      const token=randomUUID()
      const job=(await db.query(`insert into notification_email_outbox(notification_id,recipient_id,actor_id,notification_type,event_key,status,locked_until,lock_token)
        values($1,$2,$3,'teaching_update',$4,'processing',clock_timestamp()+interval '1 minute',$5)
        on conflict(notification_id) do update set status='processing',locked_until=excluded.locked_until,lock_token=excluded.lock_token returning id`,[String(notice),recipient,ids.owner,`synthetic-module-email:${notice}`,token])).rows[0].id
      return {job,token}
    }
    const blocked=await notices(ids.headA),allowed=await notices(ids.studentA)
    const context=(job,token)=>rpc(ids.owner,'xelay_teaching_item_email_context',[job,token],{role:'service_role'})
    assert.equal((await context(blocked.job,blocked.token)).eligible,false,'queued item is rechecked after module conditions change')
    const valid=await context(allowed.job,allowed.token);assert.equal(valid.eligible,true);assert.equal(valid.group_id,groups[0]);assert.equal(valid.source_id,last)
    const staff=await notices(ids.owner,null)
    assert.equal((await context(staff.job,staff.token)).eligible,true);assert.equal((await context(staff.job,staff.token)).group_id,null)
    assert.doesNotMatch(JSON.stringify(valid),/PRIVATE_|body|attachments|title/)
    assert.equal((await context(allowed.job,randomUUID())).eligible,false)
    await db.query("update notification_email_outbox set locked_until=clock_timestamp()-interval '1 second' where id=$1",[allowed.job])
    assert.equal((await context(allowed.job,allowed.token)).eligible,false)
    await assert.rejects(rpc(ids.studentA,'xelay_teaching_item_email_context',[blocked.job,blocked.token]),/permission denied/)
    const beforeCount=(await db.query('select count(*)::int n from notifications where recipient_id=$1',[ids.headA])).rows[0].n
    await fx.asUser(ids.owner,'select xelay_teaching_notify($1,$2,$3,$4,$5)',[ids.headA,`teaching-item:${last}:777`,'PRIVATE_LOCKED_MESSAGE',ids.course,groups[0]],{role:'service_role'}).catch(error=>{
      // The producer helper is intentionally private to server writers. Exercise
      // it through a superuser transaction with the synthetic actor instead.
      assert.match(error.message,/permission denied/)
    })
    await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:ids.owner,role:'authenticated',aal:'aal1'})])
    try {await db.query('select xelay_teaching_notify($1,$2,$3,$4,$5)',[ids.headA,`teaching-item:${last}:777`,'PRIVATE_LOCKED_MESSAGE',ids.course,groups[0]])}
    finally {await db.exec('reset "request.jwt.claims"')}
    assert.equal((await db.query('select count(*)::int n from notifications where recipient_id=$1',[ids.headA])).rows[0].n,beforeCount)
  })
  await t.test('existing shared team draft remains accessible to its current teammate after a new module condition',async()=>{
    await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at) values($1,$2,$3,'accepted',now())",[groups[0],ids.outsider,ids.headA])
    const teamWork={...work,id:randomUUID(),title:'Synthetic shared draft',submission_mode:'team',targets:[target(groups[0])]}
    await classroom(ids.owner,'save_group_assignment',teamWork)
    const team=randomUUID()
    await db.query('insert into teaching_lab_teams(id,item_id,course_id,group_id,name,user_ids,created_by) values($1,$2,$3,$4,$5,$6,$7)',[team,teamWork.id,ids.course,groups[0],'Synthetic existing team',[ids.headA,ids.outsider],ids.owner])
    let shared=await classroom(ids.headA,'reserve_submission',{id:randomUUID(),item_id:teamWork.id,group_id:groups[0]})
    shared=await classroom(ids.headA,'save_submission',{id:shared.id,version:shared.version,body:'Preserved shared draft',links:[],attachments:[]})
    const fresh=await material('Synthetic new team prerequisite'),pre=item('material',fresh,'acknowledged'),teamItem=item('assignment',teamWork.id,'submitted',[pre.id],{position:1})
    await save({id:randomUUID(),course_id:ids.course,title:'Synthetic team module',description:'',status:'published',group_ids:[groups[0]],position:5,version:0,prerequisite_item_ids:[],items:[pre,teamItem]})
    const view=await rpc(ids.outsider,'xelay_classroom_assignment',[teamWork.id,groups[0]])
    assert.equal(view.my_submission.id,shared.id);assert.equal(view.my_submission.body,'Preserved shared draft')
    assert.equal(learningItem(await student(ids.outsider),teamItem.id).locked,false)
    const changed=await classroom(ids.outsider,'save_submission',{id:shared.id,version:shared.version,body:'Current teammate continues shared work',links:[],attachments:[]})
    assert.ok(changed.version>shared.version)
  })
})
