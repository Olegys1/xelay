import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lessonRoleFixture, readLessonRoleMigration } from './teaching-lesson-roles-fixture.mjs'

test('personal lesson responsibility keeps current scoped authority, manual choices, homework and grade history', async t => {
  const fx = await lessonRoleFixture(); t.after(() => fx.close())
  const { db, ids, groups, dates, rpc, mutate } = fx
  const day = dates.lesson_a
  const datePlus = async n => (await db.query('select ($1::date+$2::int)::text d', [day,n])).rows[0].d
  const next = await datePlus(7), end = await datePlus(21), emptyDay = await datePlus(1)
  const subject = (await db.query('select coalesce(s.name,c.title) name from teaching_course_groups l join teaching_courses c on c.id=l.course_id left join study_group_seminar_subjects s on s.id=l.subject_id where l.course_id=$1 and l.group_id=$2', [ids.course,groups[0]])).rows[0].name
  const schedule = async (group,type,start,finish,from=day) => {
    const id=randomUUID(), head=group===groups[0]?ids.headA:ids.headB
    await fx.asUser(head,`insert into study_group_schedule(id,group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,created_by)
      values($1,$2,extract(isodow from $3::date),$4,$5,$6,$7,$3,$8,$9)`, [id,group,from,start,finish,subject,type,end,head])
    return id
  }
  const lecture=await schedule(groups[0],'lecture','08:00','09:20')
  const seminar=await schedule(groups[0],'seminar','09:40','11:00')
  const lab=await schedule(groups[0],'lab','11:20','12:40')
  const groupBLecture=await schedule(groups[1],'lecture','08:00','09:20')
  await db.query(`update teaching_course_groups l set subject_id=s.id from study_group_seminar_subjects s
    where l.course_id=$1 and s.group_id=l.group_id and s.name=$2`,[ids.course,subject])
  const obsoleteSeminar=randomUUID(), deletedTimetable=randomUUID()
  await rpc(ids.owner,'xelay_teaching_calendar_assign',[ids.course,groups[0],seminar,'timetable',true])
  await db.query(`insert into teaching_calendar_assignments(user_id,course_id,group_id,schedule_id,source) values
    ($1,$2,$3,$4,'seminar'),($1,$2,$3,$5,'timetable')`,[ids.owner,ids.course,groups[0],obsoleteSeminar,deletedTimetable])
  await fx.asUser(ids.headA,'insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,$3,$4,$5)',[groups[0],lecture,day,'Synthetic group preparation',ids.headA])
  const assignment={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic teacher preparation',body:'Synthetic teacher homework body',status:'published',links:[],attachments:[],max_points:null,category:'',submission_mode:'individual',targets:[{group_id:groups[0],lesson_date:day,schedule_item_id:lecture,placement_mode:'lesson',due_at:null,audience_mode:'all',subgroup_ids:[],team_ids:[]}]}
  await fx.classroom(ids.owner,'save_group_assignment',assignment)
  const activity=await mutate(ids.owner,'save_activity',{id:randomUUID(),version:0,course_id:ids.course,group_id:groups[0],title:'Synthetic preserved score',category:'',activity_date:day,max_points:5})
  const entry=(await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3',[ids.course,groups[0],ids.studentA])).rows[0].id
  const grade=await mutate(ids.owner,'save_grade',{activity_id:activity.id,entry_id:entry,version:0,score:3,comment:'Synthetic private feedback',reason:''})
  await mutate(ids.owner,'publish_grades',{activity_id:activity.id,expected_versions:[{entry_id:entry,version:grade.version}]})
  const snapshot = async () => {
    const result={}
    for (const table of ['teaching_grades','teaching_grade_audit','teaching_activities','teaching_entries','teaching_items','teaching_item_targets','study_group_homework','study_group_members']) {
      result[table]=(await db.query(`select to_jsonb(r) data from ${table} r order by to_jsonb(r)::text`)).rows
    }
    return result
  }
  const preserved=await snapshot()
  const calendarBefore=await rpc(ids.owner,'xelay_teaching_calendar',[day,end])
  const oldCalendar=(await db.query("select prosrc from pg_proc where oid='public.xelay_teaching_calendar(date,date)'::regprocedure")).rows[0].prosrc
  const oldAssignments=(await db.query('select to_jsonb(a) data from teaching_calendar_assignments a order by source,schedule_id')).rows
  await db.exec(await readLessonRoleMigration('202611040040_teaching_lesson_roles.sql'))
  const calendar=(who=ids.owner,from=day,to=end) => rpc(who,'xelay_teaching_calendar',[from,to])
  const save=(who,group,types,version,expected=who) => rpc(who,'xelay_teaching_lesson_role_save',[ids.course,group,types,version,expected])
  const mark=(who,id,assigned,group=groups[0],source='timetable') => rpc(who,'xelay_teaching_calendar_assign',[ids.course,group,id,source,assigned])
  const lesson=(view,id,date=day) => view.lessons.find(l=>l.id===id && l.lesson_date===date)
  const role=(view,group=groups[0]) => view.teaching_roles.find(r=>r.course_id===ids.course && r.group_id===group)
  let ownerVersion=0, colleagueLink

  await t.test('additive migration preserves legacy markers, full calendar fields, homework and published grades', async () => {
    assert.deepEqual(await snapshot(),preserved)
    const rows=(await db.query('select to_jsonb(a)-\'assigned\' data,assigned from teaching_calendar_assignments a order by source,schedule_id')).rows
    assert.deepEqual(rows.map(r=>({data:r.data})),oldAssignments);assert.ok(rows.every(r=>r.assigned))
    const after=await calendar()
    assert.deepEqual(after.lessons.map(({assignment_source,...l})=>l),calendarBefore.lessons)
    assert.equal(lesson(after,lecture).homework_count,2)
    assert.deepEqual(lesson(after,lecture).homework.map(h=>h.source),['teacher','group'])
    assert.deepEqual(lesson(after,seminar).assigned_to_me,true)
    assert.equal(lesson(after,seminar).assignment_source,'manual')
    assert.equal(lesson(after,lecture).assignment_source,'none')
    assert.equal((await db.query("select prosrc from pg_proc where oid='public.xelay_private_calendar_before_lesson_roles_20261104(date,date)'::regprocedure")).rows[0].prosrc,oldCalendar)
    assert.equal(after.teaching_roles.length,2)
    assert.ok(after.teaching_roles.every(r=>r.version===0 && r.lesson_types.length===0))
    const noLessons=await calendar(ids.owner,emptyDay,emptyDay)
    assert.deepEqual(noLessons.lessons,[]);assert.deepEqual(noLessons.teaching_roles,after.teaching_roles)
  })
  await t.test('self role saves canonical types and covers recurring and newly added future rows without marker writes', async () => {
    const saved=await save(ids.owner,groups[0],['seminar','lecture'],ownerVersion)
    ownerVersion=saved.version
    assert.equal(ownerVersion,1);assert.deepEqual(saved.lesson_types,['lecture','seminar'])
    assert.deepEqual(Object.keys(saved).sort(),['course_id','course_title','group_id','group_name','lesson_types','version'])
    let view=await calendar();assert.deepEqual(role(view),saved)
    assert.equal(lesson(view,lecture).assigned_to_me,true);assert.equal(lesson(view,lecture).assignment_source,'role')
    assert.equal(lesson(view,lecture,next).assignment_source,'role')
    assert.equal(lesson(view,seminar).assignment_source,'manual');assert.equal(lesson(view,lab).assigned_to_me,false)
    assert.equal(lesson(view,groupBLecture).assigned_to_me,false)
    const count=(await db.query('select count(*)::int n from teaching_calendar_assignments')).rows[0].n
    const added=await schedule(groups[0],'lecture','13:00','14:20',next)
    view=await calendar();assert.equal(lesson(view,added,next).assignment_source,'role')
    assert.equal((await db.query('select count(*)::int n from teaching_calendar_assignments')).rows[0].n,count)
    await fx.asUser(ids.headA,"update study_group_schedule set lesson_type='lecture' where id=$1",[lab])
    assert.equal(lesson(await calendar(),lab).assignment_source,'role')
    await fx.asUser(ids.headA,"update study_group_schedule set lesson_type='lab' where id=$1",[lab])
    assert.equal(lesson(await calendar(),lab).assignment_source,'none')
    assert.deepEqual(await snapshot(),preserved,'responsibility never writes grades, homework or student records')
  })
  await t.test('version, actor, supported type, duplicates, null and non-vector input fail closed', async () => {
    await assert.rejects(save(ids.owner,groups[0],['lab'],0),/TEACHING_LESSON_ROLE_VERSION_CONFLICT/)
    await assert.rejects(save(ids.owner,groups[0],['lab'],ownerVersion,ids.colleague),/TEACHING_ACTOR_CHANGED/)
    for (const types of [null,['lecture','lecture'],['lecture',null],[' Lecture'],['unknown'],Array(11).fill('lecture'),[['lecture','seminar'],['lab','test']]]) {
      await assert.rejects(save(ids.owner,groups[0],types,ownerVersion),/TEACHING_LESSON_ROLE_INVALID/)
    }
    for (const version of [null,-1,2147483647]) await assert.rejects(save(ids.owner,groups[0],[],version),/TEACHING_LESSON_ROLE_INVALID/)
    await assert.rejects(fx.asUser(ids.owner,"select xelay_teaching_lesson_role_save($1,$2,'[0:0]={lecture}'::text[],$3,$4)",[ids.course,groups[0],ownerVersion,ids.owner]),/TEACHING_LESSON_ROLE_INVALID/)
    assert.equal(role(await calendar()).version,ownerVersion)
    const allowed=['lecture','seminar','practical','lab','makeup','replacement','module','final_assessment','test','other']
    ownerVersion=(await save(ids.owner,groups[0],allowed,ownerVersion)).version
    assert.deepEqual(role(await calendar()).lesson_types,allowed)
    ownerVersion=(await save(ids.owner,groups[0],['lecture','seminar'],ownerVersion)).version
    const firstEmpty=await save(ids.owner,groups[1],[],0)
    assert.equal(firstEmpty.version,1);assert.deepEqual(firstEmpty.lesson_types,[])
    assert.deepEqual(role(await calendar(),groups[1]),firstEmpty,'saved empty responsibility is distinct from never configured')
  })
  await t.test('selected material-only colleague can configure self but gains no group or grading authority', async () => {
    colleagueLink=await mutate(ids.owner,'invite_teacher',{course_id:ids.course,user_id:ids.colleague,permissions:['materials'],group_scope:'selected',group_ids:[groups[0]]})
    await mutate(ids.colleague,'respond_teacher',{teacher_link_id:colleagueLink.id,accept:true})
    const saved=await save(ids.colleague,groups[0],['lab'],0)
    assert.equal(saved.version,1)
    let view=await calendar(ids.colleague)
    assert.equal(view.teaching_roles.length,1);assert.equal(role(view).group_id,groups[0])
    assert.ok(view.lessons.every(l=>l.group_id===groups[0] && !l.can_grade))
    assert.equal(lesson(view,lab).assignment_source,'role')
    await assert.rejects(save(ids.colleague,groups[1],['lecture'],0),/TEACHING_FORBIDDEN/)
    await assert.rejects(save(ids.colleague,groups[0],['lecture'],1,ids.owner),/TEACHING_ACTOR_CHANGED/)
    for (const who of [ids.studentA,ids.otherTeacher,ids.outsider,ids.admin]) {
      await assert.rejects(save(who,groups[0],['lecture'],0),/FORBIDDEN|UNVERIFIED/)
      assert.deepEqual((await calendar(who)).teaching_roles,[])
    }
    assert.deepEqual(role(await calendar()).lesson_types,['lecture','seminar'])
  })
  await t.test('manual include/exclude overrides responsibility, survives reload and clearing/reassigning role', async () => {
    assert.deepEqual(await mark(ids.owner,lecture,false),{assigned:false,assignment_source:'manual'})
    let view=await calendar();assert.equal(lesson(view,lecture).assigned_to_me,false);assert.equal(lesson(view,lecture).assignment_source,'manual')
    assert.equal(lesson(view,lecture,next).assigned_to_me,false,'existing per-row personal marker covers its recurring occurrences')
    ownerVersion=(await save(ids.owner,groups[0],[],ownerVersion)).version
    view=await calendar();assert.deepEqual(role(view).lesson_types,[]);assert.ok(role(view).version>0)
    assert.equal(lesson(view,seminar).assigned_to_me,true,'legacy positive marker survives cleared role')
    assert.equal(lesson(view,lecture).assignment_source,'manual')
    ownerVersion=(await save(ids.owner,groups[0],['lecture'],ownerVersion)).version
    assert.equal(lesson(await calendar(),lecture).assigned_to_me,false,'negative marker survives role re-selection')
    assert.deepEqual(await mark(ids.owner,lecture,true),{assigned:true,assignment_source:'manual'})
    assert.equal(lesson(await calendar(),lecture).assigned_to_me,true)
    assert.equal(lesson(await calendar(ids.colleague),lecture).assignment_source,'none','manual preference is per user')
  })
  await t.test('invalid tuples cannot create phantom negative markers; legacy obsolete rows remain removable', async () => {
    const before=(await db.query('select count(*)::int n from teaching_calendar_assignments')).rows[0].n
    assert.equal((await mark(ids.owner,randomUUID(),false)).assignment_source,'none')
    assert.equal((await mark(ids.owner,groupBLecture,false)).assignment_source,'none')
    await assert.rejects(mark(ids.owner,groupBLecture,true),/INVALID|FORBIDDEN|NOT_FOUND/)
    await assert.rejects(mark(ids.colleague,groupBLecture,false,groups[1]),/FORBIDDEN/)
    assert.equal((await db.query('select count(*)::int n from teaching_calendar_assignments')).rows[0].n,before)
    assert.equal((await mark(ids.owner,obsoleteSeminar,false,groups[0],'seminar')).assignment_source,'none')
    assert.equal((await mark(ids.owner,deletedTimetable,false)).assignment_source,'none')
    assert.equal((await db.query('select count(*)::int n from teaching_calendar_assignments')).rows[0].n,before-2)
    await assert.rejects(mark(ids.owner,randomUUID(),true,groups[0],'seminar'),/INVALID|FORBIDDEN|NOT_FOUND/)
  })
  await t.test('table and private helpers remain inaccessible to all external roles; public RPCs only authenticated', async () => {
    for (const who of ['anon','authenticated','service_role']) {
      for (const fn of ['xelay_private_teaching_lesson_roles(uuid)','xelay_private_calendar_before_lesson_roles_20261104(date,date)','xelay_private_calendar_assign_before_lesson_roles_20261104(uuid,uuid,uuid,text,boolean)']) {
        assert.equal((await db.query('select has_function_privilege($1,$2,\'execute\') allowed',[who,fn])).rows[0].allowed,false)
      }
      assert.equal((await db.query("select has_table_privilege($1,'teaching_lesson_roles','select,insert,update,delete') allowed",[who])).rows[0].allowed,false)
      const allowed=(await db.query("select has_function_privilege($1,'xelay_teaching_lesson_role_save(uuid,uuid,text[],integer,uuid)','execute') allowed",[who])).rows[0].allowed
      assert.equal(allowed,who==='authenticated')
    }
    await assert.rejects(fx.asUser(ids.owner,'select * from teaching_lesson_roles'),/permission denied/)
    await assert.rejects(fx.asUser(ids.owner,'update teaching_lesson_roles set version=1'),/permission denied/)
    const unsafe=(await db.query("select proname from pg_proc where proname in('xelay_teaching_lesson_role_save','xelay_teaching_calendar','xelay_teaching_calendar_assign','xelay_private_teaching_lesson_roles') and (not prosecdef or not('search_path=\"\"'=any(proconfig)))")).rows
    assert.deepEqual(unsafe,[])
  })
  await t.test('revoked selected group and current verification remove automatic responsibility and block writes', async () => {
    await mutate(ids.owner,'update_teacher',{teacher_link_id:colleagueLink.id,permissions:['materials'],group_scope:'selected',group_ids:[groups[1]]})
    let view=await calendar(ids.colleague);assert.equal(view.teaching_roles.length,1);assert.equal(view.teaching_roles[0].group_id,groups[1])
    await assert.rejects(save(ids.colleague,groups[0],['lecture'],1),/TEACHING_FORBIDDEN/)
    assert.equal((await db.query('select count(*)::int n from teaching_lesson_roles where user_id=$1',[ids.colleague])).rows[0].n,1,'revocation keeps preference history but never uses it for authority')
    await db.query("update teaching_course_teachers set status='removed' where id=$1",[colleagueLink.id])
    assert.deepEqual((await calendar(ids.colleague)).teaching_roles,[])
    await assert.rejects(save(ids.colleague,groups[1],['lecture'],0),/TEACHING_FORBIDDEN/)
    await db.query('insert into teacher_academic_profiles(user_id,approved_valid_until) values($1,current_date-1)',[ids.owner])
    assert.deepEqual((await calendar()).teaching_roles,[])
    await assert.rejects(save(ids.owner,groups[0],['lab'],ownerVersion),/EXPIRED_OR_UNVERIFIED/)
    await assert.rejects(mark(ids.owner,lecture,false),/EXPIRED_OR_UNVERIFIED/)
    await db.query('update teacher_academic_profiles set approved_valid_until=null where user_id=$1',[ids.owner])
    await db.query("update teacher_verification_requests set status='rejected' where user_id=$1",[ids.owner])
    assert.deepEqual((await calendar()).teaching_roles,[])
    await assert.rejects(save(ids.owner,groups[0],['lab'],ownerVersion),/EXPIRED_OR_UNVERIFIED/)
    await db.query("update teacher_verification_requests set status='approved' where user_id=$1",[ids.owner])
    assert.equal(role(await calendar()).version,ownerVersion)
    assert.deepEqual(await snapshot(),preserved)
  })
  await t.test('future accepted pairs are configurable without lessons; pending, archived and hidden directory pairs stay excluded', async () => {
    const future=randomUUID(),starts=await datePlus(35),ends=await datePlus(70)
    await mutate(ids.owner,'create_course',{id:future,version:0,title:'Synthetic future responsibility',semester:'Future synthetic semester',starts_on:starts,ends_on:ends})
    const accepted=await mutate(ids.owner,'invite_group',{course_id:future,group_id:groups[1]})
    await mutate(ids.headB,'respond_group',{link_id:accepted.id,accept:true})
    await mutate(ids.owner,'invite_group',{course_id:future,group_id:groups[0]})
    let view=await calendar(ids.owner,emptyDay,emptyDay)
    assert.deepEqual(view.lessons,[])
    const pairs=view.teaching_roles.filter(r=>r.course_id===future)
    assert.equal(pairs.length,1);assert.equal(pairs[0].group_id,groups[1]);assert.equal(pairs[0].version,0)
    const saved=await rpc(ids.owner,'xelay_teaching_lesson_role_save',[future,groups[1],['lecture'],0,ids.owner])
    assert.equal(saved.version,1)
    await assert.rejects(rpc(ids.owner,'xelay_teaching_lesson_role_save',[future,groups[0],['lecture'],0,ids.owner]),/TEACHING_FORBIDDEN/)
    await db.query('update teaching_courses set archived_at=now() where id=$1',[future])
    assert.ok((await calendar()).teaching_roles.every(r=>r.course_id!==future))
    await assert.rejects(rpc(ids.owner,'xelay_teaching_lesson_role_save',[future,groups[1],[],1,ids.owner]),/TEACHING_FORBIDDEN/)
    // Use only the repository's fixed policy identifier with fictional fixture
    // data. The test account is deliberately not a directory exception account.
    const hidden='437c96ae-19d1-4bed-ae69-0b83ae9ec1b4',head=randomUUID(),request=randomUUID()
    await fx.seedUser(head,{full_name:'Synthetic hidden head',university_id:fx.scope.university_id,academic_unit_id:fx.scope.id,account_type:'teacher'})
    await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
      values($1,$2,'Synthetic hidden head',$3,$4,'Synthetic programme','Synthetic hidden group','synthetic_hidden','approved',$5,now())`,[request,head,fx.scope.university_id,fx.scope.id,ids.admin])
    await db.query(`insert into study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name)
      values($1,$2,$3,$4,$5,'Synthetic programme','Synthetic hidden group')`,[hidden,request,head,fx.scope.university_id,fx.scope.id])
    await db.query("insert into teaching_course_groups(course_id,group_id,status,invited_by,accepted_at) values($1,$2,'accepted',$3,now())",[ids.course,hidden,ids.owner])
    await db.query("insert into teaching_lesson_roles(user_id,course_id,group_id,lesson_types) values($1,$2,$3,array['lecture'])",[ids.owner,ids.course,hidden])
    assert.equal((await fx.asUser(ids.owner,'select xelay_study_group_is_listed($1) allowed',[hidden])).rows[0].allowed,false)
    assert.ok((await calendar()).teaching_roles.every(r=>r.group_id!==hidden))
    await assert.rejects(save(ids.owner,hidden,['lecture'],1),/TEACHING_FORBIDDEN/)
  })
})
