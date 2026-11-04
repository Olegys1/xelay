import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { audienceFixture } from './teaching-audience-fixture.mjs'
const read = name => readFile(new URL('../../supabase/migrations/' + name, import.meta.url), 'utf8')

test('schedule journal sync and calendar homework use real SQL, exact occurrences and existing authorization', async t => {
  const fx = await audienceFixture();t.after(() => fx.close())
  const { db,ids,groups,dates,rpc,mutate } = fx
  for (const migration of ['202611030104_academic_notification_priority.sql','202611030106_teaching_common_deadline_notifications.sql','202611040001_fix_teaching_gradebook_dispatch.sql']) await db.exec(await read(migration))
  const initial = (await db.query('select (select count(*) from teaching_activities)::int activities,(select count(*) from teaching_grades)::int grades,(select count(*) from study_group_schedule)::int schedule')).rows
  for (const migration of ['202611040030_teaching_journal_schedule.sql','202611040031_teacher_calendar_homework.sql']) await db.exec(await read(migration))
  assert.deepEqual((await db.query('select (select count(*) from teaching_activities)::int activities,(select count(*) from teaching_grades)::int grades,(select count(*) from study_group_schedule)::int schedule')).rows, initial)
  const day = dates.lesson_a
  const next = (await db.query('select ($1::date+7)::text d',[day])).rows[0].d
  const tomorrow = (await db.query('select ($1::date+1)::text d',[day])).rows[0].d
  const end = (await db.query('select ($1::date+14)::text d',[day])).rows[0].d
  const subject = (await db.query('select coalesce(s.name,c.title) name from teaching_course_groups g join teaching_courses c on c.id=g.course_id left join study_group_seminar_subjects s on s.id=g.subject_id where g.course_id=$1 and g.group_id=$2',[ids.course,groups[0]])).rows[0].name
  const schedule = async (group, lessonType, start='09:40',finish='11:00') => {
    const id = randomUUID()
    const head=group===groups[0]?ids.headA:ids.headB
    await fx.asUser(head,`insert into study_group_schedule(id,group_id,weekday,starts_at,ends_at,subject,lesson_type,valid_from,valid_until,created_by)
      values($1,$2,extract(isodow from $3::date),$4,$5,$6,$7,$3,$8,$9)`,[id,group,day,start,finish,subject,lessonType,end,head])
    return id
  }
  const seminar = await schedule(groups[0],'seminar')
  const lecture = await schedule(groups[0],'lecture','08:00','09:20')
  await schedule(groups[1],'seminar')
  const subjectId=(await db.query('select id from study_group_seminar_subjects where group_id=$1 and name=$2',[groups[0],subject])).rows[0].id
  await db.query('update teaching_course_groups set subject_id=$3 where course_id=$1 and group_id=$2',[ids.course,groups[0],subjectId])
  const sync = (who=ids.owner,group=groups[0],from=day,to=end,expected=who) => rpc(who,'xelay_teaching_sync_journal_schedule',[ids.course,group,from,to,expected])
  await db.query(`update teaching_courses set grading_rules=jsonb_set(grading_rules,'{presets}',$2::jsonb) where id=$1`,[ids.course,JSON.stringify([{id:'seminar',name:'Семінар',work_type:'Семінар',category:'',max_points:7.5}])])
  let activityId, gradeId, publishedBefore

  await t.test('first sync creates one column per real occurrence using preset or explicit default; repeated sync is a no-op', async () => {
    const first = await sync()
    assert.equal(first.created,6);assert.equal(first.defaulted,3);assert.equal(first.default_max_points,5)
    const rows = (await db.query('select to_jsonb(a) data from teaching_activities a where course_id=$1 and group_id=$2 order by schedule_lesson_date,schedule_starts_at',[ids.course,groups[0]])).rows.map(row=>row.data)
    assert.equal(rows.length,6);assert.equal(rows.filter(row=>row.schedule_lesson_type==='seminar').length,3)
    assert.ok(rows.filter(row=>row.schedule_lesson_type==='seminar').every(row=>Number(row.max_points)===7.5 && !row.schedule_default_max_points && row.work_type==='Семінар'))
    assert.ok(rows.filter(row=>row.schedule_lesson_type==='lecture').every(row=>Number(row.max_points)===5 && row.schedule_default_max_points))
    activityId=rows.find(row=>row.schedule_item_id===seminar && row.schedule_lesson_date===day).id
    const before = (await db.query('select to_jsonb(a) data from teaching_activities a order by id')).rows
    const second = await sync();assert.equal(second.created,0);assert.equal(second.updated,0);assert.equal(second.retained,0)
    assert.deepEqual((await db.query('select to_jsonb(a) data from teaching_activities a order by id')).rows,before)
    const snapshot = await rpc(ids.owner,'xelay_teaching_course',[ids.course])
    assert.equal(snapshot.activities.find(row=>row.id===activityId).schedule_item_id,seminar)
    assert.equal((await db.query('select count(*)::int n from teaching_grades')).rows[0].n,0,'sync never fabricates scores or absences')
  })
  await t.test('only current graders of the exact group can synchronize; actor, date bounds, revoked and direct writes fail closed', async () => {
    for(const who of [ids.studentA,ids.outsider,ids.otherTeacher,ids.admin]) await assert.rejects(sync(who),/FORBIDDEN|UNVERIFIED/)
    await assert.rejects(sync(ids.owner,groups[0],day,end,ids.studentA),/ACTOR_CHANGED/)
    await assert.rejects(sync(ids.owner,groups[0],end,day),/RANGE_INVALID/)
    await assert.rejects(sync(ids.owner,groups[0],'2025-01-01','2027-01-01'),/RANGE_INVALID/)
    const link=await mutate(ids.owner,'invite_teacher',{course_id:ids.course,user_id:ids.colleague,permissions:['grades'],group_scope:'selected',group_ids:[groups[0]]})
    await mutate(ids.colleague,'respond_teacher',{teacher_link_id:link.id,accept:true})
    assert.equal((await sync(ids.colleague)).created,0)
    await assert.rejects(sync(ids.colleague,groups[1]),/FORBIDDEN/)
    await mutate(ids.owner,'update_teacher',{teacher_link_id:link.id,permissions:['materials'],group_scope:'selected',group_ids:[groups[0]]})
    await assert.rejects(sync(ids.colleague),/FORBIDDEN/)
    await assert.rejects(fx.asUser(ids.studentA,'update teaching_activities set schedule_missing=true where id=$1',[activityId]),/permission denied/)
    assert.equal((await db.query("select has_function_privilege('anon','xelay_teaching_sync_journal_schedule(uuid,uuid,date,date,uuid)','execute') allowed")).rows[0].allowed,false)
  })
  await t.test('time edits, exclusions, deletion and rescheduling preserve custom column settings, published grades and history', async () => {
    const entry = (await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3',[ids.course,groups[0],ids.studentA])).rows[0].id
    const saved=await mutate(ids.owner,'save_grade',{activity_id:activityId,entry_id:entry,version:0,score:6,comment:'Synthetic saved score',reason:''})
    gradeId=saved.id
    await mutate(ids.owner,'publish_grades',{activity_id:activityId,expected_versions:[{entry_id:entry,version:saved.version}]})
    publishedBefore=(await db.query('select to_jsonb(g) data from teaching_grades g where id=$1',[gradeId])).rows[0].data
    const auditBefore=(await db.query('select to_jsonb(a) data from teaching_grade_audit a where activity_id=$1 order by id',[activityId])).rows
    await db.query("update teaching_activities set title='Власна назва',work_type='Усна відповідь',max_points=9 where id=$1",[activityId])
    await fx.asUser(ids.headA,"update study_group_schedule set starts_at='10:00',ends_at='11:20',lesson_type='practical' where id=$1",[seminar])
    const result=await sync();assert.equal(result.updated,3)
    let current=(await db.query('select * from teaching_activities where id=$1',[activityId])).rows[0]
    assert.equal(current.title,'Власна назва');assert.equal(current.work_type,'Усна відповідь');assert.equal(Number(current.max_points),9)
    assert.equal(current.schedule_lesson_type,'practical');assert.equal(current.schedule_starts_at,'10:00:00')
    await fx.asUser(ids.headA,'update study_group_schedule set excluded_dates=array[$2::date] where id=$1',[seminar,day])
    assert.equal((await sync()).retained,1)
    assert.equal((await db.query('select schedule_missing from teaching_activities where id=$1',[activityId])).rows[0].schedule_missing,true)
    await fx.asUser(ids.headA,'update study_group_schedule set excluded_dates=array[]::date[] where id=$1',[seminar])
    assert.equal((await sync()).created,0)
    assert.equal((await db.query('select schedule_missing from teaching_activities where id=$1',[activityId])).rows[0].schedule_missing,false)
    await fx.asUser(ids.headA,'delete from study_group_schedule where id=$1',[seminar])
    assert.equal((await sync()).retained,3)
    assert.equal((await db.query('select count(*)::int n from teaching_activities where id=$1',[activityId])).rows[0].n,1)
    assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g where id=$1',[gradeId])).rows[0].data,publishedBefore)
    assert.deepEqual((await db.query('select to_jsonb(a) data from teaching_grade_audit a where activity_id=$1 order by id',[activityId])).rows,auditBefore)
    const moved=await schedule(groups[0],'seminar','10:00','11:20')
    await fx.asUser(ids.headA,'update study_group_schedule set weekday=extract(isodow from $2::date),valid_from=$2 where id=$1',[moved,tomorrow])
    assert.equal((await sync()).created,2)
    assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g where id=$1',[gradeId])).rows[0].data,publishedBefore)
  })
  let assignment
  await t.test('exact explicitly placed assessed assignment reuses its existing column; unrelated manual work stays independent', async () => {
    const boundSchedule=await schedule(groups[0],'lab','12:50','14:10')
    assignment={id:randomUUID(),version:0,expected_user_id:ids.owner,course_id:ids.course,title:'Synthetic lab preparation',body:'PRIVATE_ASSIGNED_HOMEWORK',status:'published',links:[],attachments:[],max_points:12,category:'',submission_mode:'individual',targets:[{group_id:groups[0],lesson_date:day,schedule_item_id:boundSchedule,placement_mode:'lesson',due_at:null,audience_mode:'all',subgroup_ids:[],team_ids:[]}]}
    await fx.classroom(ids.owner,'save_group_assignment',assignment)
    const assessed=(await db.query('select * from teaching_activities where item_id=$1',[assignment.id])).rows[0]
    const result=await sync(ids.owner,groups[0],day,day)
    assert.equal(result.linked,1);assert.equal(result.created,0)
    const after=(await db.query('select * from teaching_activities where item_id=$1',[assignment.id])).rows[0]
    assert.equal(after.id,assessed.id);assert.equal(after.title,assessed.title);assert.equal(after.max_points,assessed.max_points)
    assert.equal(after.schedule_item_id,boundSchedule)
    assert.equal((await sync(ids.owner,groups[0],day,day)).created,0)
    await mutate(ids.owner,'save_activity',{id:randomUUID(),version:0,course_id:ids.course,group_id:groups[0],title:'Independent manual lesson',category:'',activity_date:next,max_points:3})
    const beforeManual=(await db.query("select to_jsonb(a) data from teaching_activities a where title='Independent manual lesson'")).rows[0].data
    await sync()
    assert.deepEqual((await db.query("select to_jsonb(a) data from teaching_activities a where title='Independent manual lesson'")).rows[0].data,beforeManual)
  })
  await t.test('calendar automatically carries only published, exact visible homework; no cross-group or draft leakage', async () => {
    const bound=assignment.targets[0].schedule_item_id
    await fx.asUser(ids.headA,'insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by) values($1,$2,$3,$4,$5)',[groups[0],bound,day,'GROUP_HOMEWORK_TEXT',ids.headA])
    const draft={...assignment,id:randomUUID(),title:'SECRET_DRAFT',body:'SECRET_DRAFT_BODY',status:'draft',max_points:null,targets:[...assignment.targets]}
    await fx.classroom(ids.owner,'save_group_assignment',draft)
    const view=await rpc(ids.owner,'xelay_teaching_calendar',[day,end])
    const lesson=view.lessons.find(row=>row.id===bound && row.lesson_date===day)
    assert.equal(lesson.homework_count,2)
    assert.deepEqual(lesson.homework.map(row=>row.source),['teacher','group'])
    assert.equal(lesson.homework[0].body,'PRIVATE_ASSIGNED_HOMEWORK')
    assert.equal(lesson.homework[1].body,'GROUP_HOMEWORK_TEXT')
    assert.doesNotMatch(JSON.stringify(view),/SECRET_DRAFT/)
    assert.ok(view.lessons.filter(row=>row.lesson_date===next || row.id!==bound).every(row=>!row.homework.some(item=>item.id===assignment.id)))
    const colleague=await rpc(ids.colleague,'xelay_teaching_calendar',[day,end])
    assert.ok(colleague.lessons.every(row=>row.group_id===groups[0]));assert.ok(colleague.lessons.every(row=>row.homework_count===0))
    assert.deepEqual((await rpc(ids.studentA,'xelay_teaching_calendar',[day,end])).lessons,[])
    assert.equal((await db.query("select has_function_privilege('authenticated','xelay_private_calendar_before_homework_20261104(date,date)','execute') allowed")).rows[0].allowed,false)
    assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g where id=$1',[gradeId])).rows[0].data,publishedBefore,'reading calendar never changes grades')
  })
  await t.test('homework payloads have deterministic count and bounds, and revoked access empties the view', async () => {
    for(let n=0;n<12;n++) await fx.classroom(ids.owner,'save_group_assignment',{...assignment,id:randomUUID(),title:'Synthetic '+String(n).padStart(2,'0'),body:'x'.repeat(2500),max_points:null})
    const view=await rpc(ids.owner,'xelay_teaching_calendar',[day,day])
    const lesson=view.lessons.find(row=>row.id===assignment.targets[0].schedule_item_id)
    assert.equal(lesson.homework_count,14);assert.equal(lesson.homework.length,10)
    assert.ok(lesson.homework.every(row=>row.body.length<=2000));assert.ok(lesson.homework.some(row=>row.body_truncated))
    assert.deepEqual((await rpc(ids.owner,'xelay_teaching_calendar',[day,day])).lessons,view.lessons)
    await db.query("update teaching_course_teachers set status='removed' where user_id=$1 and course_id=$2",[ids.colleague,ids.course])
    assert.deepEqual((await rpc(ids.colleague,'xelay_teaching_calendar',[day,end])).lessons,[])
  })
  await t.test('alternating weeks and exclusions are shared with the calendar; mapped lesson categories stay explicit', async () => {
    const alternating=await schedule(groups[0],'module','15:00','16:20')
    await fx.asUser(ids.headA,"update study_group_schedule set week_pattern='upper',week_anchor_date=$2::date-(extract(isodow from $2::date)::int-1) where id=$1",[alternating,day])
    const result=await sync();assert.equal(result.created,2)
    let datesFound=(await db.query('select schedule_lesson_date::text d,work_type from teaching_activities where schedule_item_id=$1 order by d',[alternating])).rows
    assert.deepEqual(datesFound,[{d:day,work_type:'МКР'},{d:end,work_type:'МКР'}])
    await fx.asUser(ids.headA,'update study_group_schedule set excluded_dates=array[$2::date] where id=$1',[alternating,end])
    assert.equal((await sync()).retained,1)
    const calendar=await rpc(ids.owner,'xelay_teaching_calendar',[day,end])
    assert.deepEqual(calendar.lessons.filter(row=>row.id===alternating).map(row=>row.lesson_date),[day])
    assert.equal((await db.query('select schedule_missing from teaching_activities where schedule_item_id=$1 and schedule_lesson_date=$2',[alternating,end])).rows[0].schedule_missing,true)
  })
  await t.test('several assessed assignments on one lesson do not manufacture or rebind a third grade column', async () => {
    const exact=await schedule(groups[0],'test','16:30','17:50')
    const authored=[]
    for(let n=0;n<2;n++) {
      const item={...assignment,id:randomUUID(),title:'Two assessed works '+n,max_points:4,targets:[{...assignment.targets[0],schedule_item_id:exact}]}
      await fx.classroom(ids.owner,'save_group_assignment',item);authored.push(item.id)
    }
    const before=(await db.query('select to_jsonb(a) data from teaching_activities a where item_id=any($1::uuid[]) order by id',[authored])).rows
    const result=await sync(ids.owner,groups[0],day,day)
    assert.equal(result.created,0);assert.equal(result.linked,0);assert.ok(result.represented>=1)
    assert.deepEqual((await db.query('select to_jsonb(a) data from teaching_activities a where item_id=any($1::uuid[]) order by id',[authored])).rows,before)
    assert.equal((await db.query('select count(*)::int n from teaching_activities where schedule_item_id=$1',[exact])).rows[0].n,0)
  })
  await t.test('moving a recurring row to another weekday keeps the old occurrence and published result intact', async () => {
    await sync()
    const old=(await db.query('select id from teaching_activities where schedule_item_id=$1 and schedule_lesson_date=$2',[lecture,day])).rows[0].id
    const entry=(await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3',[ids.course,groups[0],ids.studentA])).rows[0].id
    const saved=await mutate(ids.owner,'save_grade',{activity_id:old,entry_id:entry,version:0,score:3,comment:'Grade stays at the original occurrence',reason:''})
    await mutate(ids.owner,'publish_grades',{activity_id:old,expected_versions:[{entry_id:entry,version:saved.version}]})
    const before=(await db.query('select to_jsonb(g) data from teaching_grades g where activity_id=$1',[old])).rows
    await fx.asUser(ids.headA,'update study_group_schedule set weekday=extract(isodow from $2::date),valid_from=$2 where id=$1',[lecture,tomorrow])
    const result=await sync();assert.equal(result.created,2);assert.equal(result.retained,3)
    assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g where activity_id=$1',[old])).rows,before)
    const metadata=(await db.query('select activity_date::text d,schedule_missing from teaching_activities where id=$1',[old])).rows[0]
    assert.deepEqual(metadata,{d:day,schedule_missing:true})
    assert.ok((await db.query('select id from teaching_activities where schedule_item_id=$1 and schedule_lesson_date=$2',[lecture,tomorrow])).rows[0].id!==old)
  })
  await t.test('a moved assessed assignment does not rebind its graded occurrence; the new lesson receives an empty column', async () => {
    const source=await schedule(groups[0],'lab','18:00','19:20')
    const item={...assignment,id:randomUUID(),title:'Moved assessed assignment',max_points:8,targets:[{...assignment.targets[0],schedule_item_id:source}]}
    await fx.classroom(ids.owner,'save_group_assignment',item)
    await sync(ids.owner,groups[0],day,day)
    const original=(await db.query('select to_jsonb(a) data from teaching_activities a where item_id=$1',[item.id])).rows[0].data
    const entry=(await db.query('select id from teaching_entries where course_id=$1 and group_id=$2 and user_id=$3',[ids.course,groups[0],ids.studentA])).rows[0].id
    const saved=await mutate(ids.owner,'save_grade',{activity_id:original.id,entry_id:entry,version:0,score:4,comment:'Original assessed work',reason:''})
    await mutate(ids.owner,'publish_grades',{activity_id:original.id,expected_versions:[{entry_id:entry,version:saved.version}]})
    const grade=(await db.query('select to_jsonb(g) data from teaching_grades g where activity_id=$1',[original.id])).rows
    const version=(await fx.item(item.id)).version
    await fx.classroom(ids.owner,'save_group_assignment',{...item,version,targets:[{...item.targets[0],lesson_date:next}]})
    const result=await sync(ids.owner,groups[0],next,next)
    assert.equal(result.created,1);assert.equal(result.linked,0)
    const newColumn=(await db.query('select to_jsonb(a) data from teaching_activities a where schedule_item_id=$1 and schedule_lesson_date=$2',[source,next])).rows[0].data
    assert.notEqual(newColumn.id,original.id);assert.equal(newColumn.item_id,null)
    assert.equal((await db.query('select count(*)::int n from teaching_grades where activity_id=$1',[newColumn.id])).rows[0].n,0)
    const historical=(await db.query('select to_jsonb(a) data from teaching_activities a where id=$1',[original.id])).rows[0].data
    assert.equal(historical.schedule_item_id,original.schedule_item_id);assert.equal(historical.schedule_lesson_date,original.schedule_lesson_date)
    assert.deepEqual((await db.query('select to_jsonb(g) data from teaching_grades g where activity_id=$1',[original.id])).rows,grade)
    assert.equal((await sync(ids.owner,groups[0],next,next)).created,0)
  })
})
