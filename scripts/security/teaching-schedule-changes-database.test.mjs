import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { lessonRoleFixture, readLessonRoleMigration } from './teaching-lesson-roles-fixture.mjs'

const migration = '20261116155612_teacher_schedule_changes.sql'
test('teacher schedule writes use exact scoped authority; group managers review one occurrence without changing grade history', async t => {
  const fx = await lessonRoleFixture(); t.after(() => fx.close())
  const { db, ids, groups, dates, rpc, mutate } = fx
  // Install the real timetable/link migrations on the saved base calendar,
  // then restore the actual homework wrapper. No authorization stub is used.
  await db.exec('alter function public.xelay_teaching_calendar(date,date) rename to xelay_fixture_calendar_homework; alter function public.xelay_private_calendar_before_homework_20261104(date,date) rename to xelay_teaching_calendar;')
  for (const name of ['202610230004_schedule_copy_first_shift_order.sql','202610240007_schedule_copy_link_inheritance.sql','202610240008_schedule_copy_link_repair.sql','202610240009_schedule_copy_link_self_repair.sql','202610260003_schedule_conference_access.sql','202610260005_schedule_copy_custom_times.sql','202610290001_home_teacher_conference.sql','202610290005_schedule_additional_links.sql']) await db.exec(await readLessonRoleMigration(name))
  await db.exec('alter function public.xelay_teaching_calendar(date,date) rename to xelay_private_calendar_before_homework_20261104; alter function public.xelay_fixture_calendar_homework(date,date) rename to xelay_teaching_calendar;')
  await db.exec(await readLessonRoleMigration('202611040040_teaching_lesson_roles.sql'))
  const beforeInstall = (await db.query('select (select count(*) from study_group_schedule)::int schedule,(select count(*) from teaching_grades)::int grades')).rows
  await db.exec(await readLessonRoleMigration(migration))
  assert.deepEqual((await db.query('select (select count(*) from study_group_schedule)::int schedule,(select count(*) from teaching_grades)::int grades')).rows, beforeInstall)
  const day = dates.lesson_a, end = (await db.query('select ($1::date+28)::text d',[day])).rows[0].d
  const tomorrow=(await db.query('select ($1::date+1)::text d',[day])).rows[0].d
  const following=(await db.query('select ($1::date+7)::text d',[day])).rows[0].d
  const subject=(await db.query('select title from teaching_courses where id=$1',[ids.course])).rows[0].title
  const row = async id => (await db.query('select to_jsonb(s) data from study_group_schedule s where id=$1',[id])).rows[0].data
  const schedule=async (group=groups[0], start='09:40', finish='11:00', subjectName=subject) => {
    const id=randomUUID(), head=group===groups[0]?ids.headA:ids.headB
    await fx.asUser(head,`insert into study_group_schedule(id,group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,created_by)
      values($1,$2,extract(isodow from $3::date),$4,$5,$6,'lecture',$3,$7,$8)`,[id,group,day,start,finish,subjectName,end,head])
    return id
  }
  const lesson=await schedule(), foreign=await schedule(groups[1]), otherSubject=await schedule(groups[0],'12:00','13:20','Unrelated subject')
  await rpc(ids.owner,'xelay_teaching_calendar_assign',[ids.course,groups[0],lesson,'timetable',true])
  const edit=async (who, id=lesson, links={online_url:'https://meet.example.test/updated'}, stamp, group=groups[0], expected=who) => rpc(who,'xelay_teaching_schedule_links_save',[ids.course,group,id,stamp ?? (await row(id)).updated_at,JSON.stringify(links),expected])
  const request=async (kind='move',id=lesson, lessonDay=day, patch={}, who=ids.owner, group=groups[0]) => rpc(who,'xelay_teaching_schedule_change_request',[ids.course,group,id,lessonDay,(await row(id)).updated_at,JSON.stringify({kind,date:tomorrow,starts_at:'11:20',ends_at:'12:40',reason:'Synthetic approved change',...patch}),who])
  const review=(id,approve=true,who=ids.headA,expected=who)=>rpc(who,'xelay_teaching_schedule_change_review',[id,approve,expected])
  const snapshot=async()=>{
    const result={}
    for(const table of ['teaching_grades','teaching_grade_audit','teaching_activities','teaching_entries','teaching_items','teaching_item_targets','study_group_homework','study_group_members']) result[table]=(await db.query(`select to_jsonb(r) data from ${table} r order by to_jsonb(r)::text`)).rows
    return result
  }
  const activity=await mutate(ids.owner,'save_activity',{id:randomUUID(),version:0,course_id:ids.course,group_id:groups[0],title:'Preserved published grade',category:'',activity_date:day,max_points:5})
  const entry=(await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3',[ids.course,groups[0],ids.studentA])).rows[0].id
  const grade=await mutate(ids.owner,'save_grade',{activity_id:activity.id,entry_id:entry,version:0,score:4,comment:'Synthetic preserved feedback',reason:''})
  await mutate(ids.owner,'publish_grades',{activity_id:activity.id,expected_versions:[{entry_id:entry,version:grade.version}]})
  await fx.asUser(ids.headA,'insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,$3,$4,$5)',[groups[0],lesson,day,'Retained original preparation',ids.headA])
  const childId=randomUUID()
  const childDate=(await db.query('select ($1::date+2)::text d',[day])).rows[0].d
  const source=await row(lesson)
  await fx.asUser(ids.headA,'insert into study_group_schedule select r.* from jsonb_populate_record(null::study_group_schedule,$1::jsonb) r',[JSON.stringify({...source,id:childId,weekday:Number((await db.query('select extract(isodow from $1::date)::int d',[childDate])).rows[0].d),valid_from:childDate,valid_until:childDate,copied_from_schedule_id:lesson,inherit_source_links:true,created_by:ids.headA})])
  const preserved=await snapshot()
  await t.test('private tables and helpers are inaccessible; anonymous/student/foreign teacher cannot write',async()=>{
    for(const who of [ids.studentA,ids.otherTeacher,ids.outsider,ids.colleague]) await assert.rejects(edit(who),/TEACHING_(SCHEDULE_FORBIDDEN|FORBIDDEN|ACCESS_EXPIRED_OR_UNVERIFIED)|TEACHER_/)
    await assert.rejects(edit(ids.owner,foreign,{},undefined,groups[1]),/TEACHING_SCHEDULE_FORBIDDEN/)
    await assert.rejects(edit(ids.owner,otherSubject),/TEACHING_SCHEDULE_FORBIDDEN/)
    await assert.rejects(edit(ids.owner,lesson,{},undefined,groups[0],ids.studentA),/TEACHING_ACTOR_CHANGED/)
    await assert.rejects(rpc(ids.studentA,'xelay_teaching_schedule_requests',[groups[0]]),/STUDY_GROUP_PERMISSION_REQUIRED/)
    await assert.rejects(fx.asUser(ids.owner,'select * from teaching_schedule_change_requests'),/permission denied/)
    await assert.rejects(fx.asUser(ids.owner,'select * from teaching_schedule_link_audit'),/permission denied/)
    await assert.rejects(fx.asUser(ids.owner,'insert into teaching_schedule_link_write_context(backend_pid) values(pg_backend_pid())'),/permission denied/)
    const grants=(await db.query(`select has_function_privilege('anon','xelay_teaching_schedule_links_save(uuid,uuid,uuid,timestamptz,jsonb,uuid)','execute') anon,
      has_function_privilege('authenticated','xelay_private_teacher_owns_schedule(uuid,uuid,uuid,uuid)','execute') private,
      (select relrowsecurity from pg_class where oid='teaching_schedule_change_requests'::regclass) rls`)).rows[0]
    assert.deepEqual(grants,{anon:false,private:false,rls:true})
  })
  await t.test('only whitelisted safe links change the same shared row, with conflict protection and audit',async()=>{
    const old=await row(lesson), count=(await db.query('select count(*)::int n from study_group_schedule')).rows[0].n
    for(const links of [{online_url:'javascript:alert(1)'},{online_url:'https://user:pass@example.test/'},{starts_at:'00:00'},{online_url:['https://example.test']},{online_url:'https://example.test/\u202Ehidden'},{online_url_label:'x'.repeat(81)},{conference_access_code:'x'.repeat(121)}]) await assert.rejects(edit(ids.owner,lesson,links),/TEACHING_SCHEDULE_LINKS_INVALID/)
    const saved=await edit(ids.owner,lesson,{online_url:'https://meet.example.test/updated',online_url_label:'Заняття',online_url_secondary:'https://meet.example.test/backup',online_links_extra:[{url:'https://meet.example.test/third',label:'Третє'}],conference_id:'123 456',conference_access_code:'abc123'})
    assert.equal(saved.saved,true)
    const updated=await row(lesson);assert.equal(updated.online_url,'https://meet.example.test/updated');assert.equal(updated.conference_id,'123 456')
    const child=await row(childId);assert.equal(child.online_url,updated.online_url);assert.equal(child.conference_id,updated.conference_id);assert.deepEqual(child.online_links_extra,updated.online_links_extra);assert.equal(child.inherit_source_links,true)
    assert.equal((await db.query('select count(*)::int n from teaching_schedule_link_write_context')).rows[0].n,0)
    for(const key of ['id','group_id','subject','starts_at','ends_at','weekday','valid_from','valid_until','created_by']) assert.deepEqual(updated[key],old[key])
    assert.equal((await db.query('select count(*)::int n from study_group_schedule')).rows[0].n,count)
    assert.equal((await db.query('select count(*)::int n from teaching_schedule_link_audit where schedule_id=$1',[lesson])).rows[0].n,1)
    await assert.rejects(edit(ids.owner,lesson,{online_url:'https://meet.example.test/stale'},old.updated_at),/TEACHING_SCHEDULE_CONFLICT/)
    await fx.asUser(ids.owner,"select set_config('xelay.teacher_schedule_links','true',true)");
    const direct=await fx.asUser(ids.owner,"update study_group_schedule set online_url='https://attacker.example.test' where id=$1 returning id",[lesson]);assert.equal(direct.rows.length,0);assert.equal((await row(lesson)).online_url,updated.online_url)
    const view=await rpc(ids.owner,'xelay_teaching_calendar',[day,day]);const visible=view.lessons.find(l=>l.id===lesson)
    assert.equal(visible.can_edit_schedule,true);assert.equal(visible.online_url,'https://meet.example.test/updated');assert.equal(visible.online_url_label,'Заняття');assert.ok(visible.schedule_updated_at)
    assert.equal(view.lessons.find(l=>l.id===otherSubject),undefined)
  })
  await t.test('a proposal alone never changes schedule; only its own group manager approves the single replacement',async()=>{
    const before=await row(lesson);const result=await request()
    assert.deepEqual(await row(lesson),before)
    for(const who of [ids.owner,ids.otherTeacher,ids.studentA,ids.headB,ids.admin]) await assert.rejects(review(result.id,true,who),/STUDY_GROUP_PERMISSION_REQUIRED/)
    await assert.rejects(review(result.id,true,ids.headA,ids.studentA),/TEACHING_ACTOR_CHANGED/)
    assert.equal((await rpc(ids.headA,'xelay_teaching_schedule_requests',[groups[0]])).requests[0].id,result.id)
    await assert.rejects(request(),/TEACHING_SCHEDULE_REQUEST_EXISTS/)
    const approved=await review(result.id);assert.equal(approved.status,'approved');assert.ok(approved.replacement_id)
    const original=await row(lesson), replacement=await row(approved.replacement_id)
    assert.deepEqual(original.excluded_dates,[day]);assert.equal(original.valid_from,before.valid_from);assert.equal(original.valid_until,before.valid_until)
    assert.equal(replacement.valid_from,tomorrow);assert.equal(replacement.valid_until,tomorrow);assert.equal(replacement.online_url,before.online_url)
    assert.deepEqual(await snapshot(),preserved)
    const view=await rpc(ids.owner,'xelay_teaching_calendar',[day,following])
    assert.equal(view.lessons.some(l=>l.id===lesson && l.lesson_date===day),false)
    assert.ok(view.lessons.some(l=>l.id===lesson && l.lesson_date===following))
    assert.ok(view.lessons.some(l=>l.id===replacement.id && l.lesson_date===tomorrow))
    await assert.rejects(review(result.id),/TEACHING_SCHEDULE_CONFLICT/)
  })
  await t.test('rejection and stale-source checks do not overwrite schedule; invalid occurrences are denied',async()=>{
    const before=await row(lesson), rejected=await request('cancel',lesson,following)
    assert.equal((await review(rejected.id,false)).status,'rejected');assert.deepEqual(await row(lesson),before)
    const stale=await request('cancel',lesson,following)
    await edit(ids.owner,lesson,{online_url:'https://meet.example.test/changed-again'})
    const current=await row(lesson)
    assert.equal((await review(stale.id)).status,'stale');assert.deepEqual(await row(lesson),current)
    const headChange=await request('cancel',lesson,following);await fx.asUser(ids.headA,"update study_group_schedule set location='Updated by headman' where id=$1",[lesson]);const headEdited=await row(lesson);assert.equal(headEdited.location,'Updated by headman');assert.equal((await review(headChange.id)).status,'stale');assert.deepEqual(await row(lesson),headEdited)
    await assert.rejects(request('cancel',lesson,tomorrow),/TEACHING_SCHEDULE_CHANGE_INVALID/)
    await assert.rejects(request('move',lesson,following,{date:'2099-01-01'}),/TEACHING_SCHEDULE_CHANGE_INVALID/)
    await assert.rejects(request('move',lesson,following,{starts_at:'14:00',ends_at:'13:00'}),/TEACHING_SCHEDULE_CHANGE_INVALID/)
  })
  await t.test('an appointed schedule deputy can cancel one occurrence; unrelated deputies cannot',async()=>{
    const pending=await request('cancel',lesson,following)
    await fx.asUser(ids.headA,"select xelay_assign_study_group_deputy($1,$2,array['schedule'])",[groups[0],ids.studentA])
    await assert.rejects(review(pending.id,true,ids.studentB),/STUDY_GROUP_PERMISSION_REQUIRED/)
    assert.equal((await review(pending.id,true,ids.studentA)).status,'approved')
    assert.deepEqual((await row(lesson)).excluded_dates,[day,following])
    assert.deepEqual(await snapshot(),preserved)
  })
  const later=(await db.query('select ($1::date+14)::text d',[day])).rows[0].d
  await t.test('overlap blocks approval and later loss of teacher access makes the request stale',async()=>{
    const pending=await request('move',lesson,later,{date:tomorrow,starts_at:'11:30',ends_at:'12:00'})
    const before=await row(lesson)
    await assert.rejects(review(pending.id),/TEACHING_SCHEDULE_OVERLAP/)
    assert.deepEqual(await row(lesson),before)
    assert.equal((await review(pending.id,false)).status,'rejected')
    const lost=await request('cancel',lesson,later)
    await db.query("update teaching_course_groups set status='removed' where course_id=$1 and group_id=$2",[ids.course,groups[0]])
    assert.equal((await review(lost.id)).status,'stale');assert.deepEqual(await row(lesson),before)
    assert.deepEqual(await snapshot(),preserved)
  })
})
