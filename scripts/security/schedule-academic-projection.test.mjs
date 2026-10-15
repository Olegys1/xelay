// Full migration chain and synthetic records in isolated PostgreSQL only.
// No hosted database, provider calls, messages, or physical file uploads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createFixture } from './fixture.mjs'

const first = result => result.rows[0]
const migration = await readFile(new URL('../../supabase/migrations/202610160002_schedule_academic_projection.sql', import.meta.url), 'utf8')

test('schedule subjects and seminar slots synchronize without copying homework or changing private content/access', async t => {
  const fx = await createFixture({ useStagingParity: true, through: '202610160001', beforeMigrationsSql: `
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;
    create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  ` })
  t.after(() => fx.close())
  const { db, asUser, seedUser } = fx
  const university=randomUUID(), unit=randomUUID(), specialty=randomUUID()
  const owner=randomUUID(), deputy=randomUUID(), member=randomUUID(), outsider=randomUUID(), pending=randomUUID()
  const username=id=>'proj_'+id.replaceAll('-','').slice(0,16)
  await db.query("insert into universities(id,name,slug) values($1,'Projection university',$2)",[university,'projection-'+university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Projection faculty',$3,'faculty')",[unit,university,'projection-'+unit])
  await db.query(`insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name)
    values($1,$2,$3,'PROJ','Projection program','Projection program')`,[specialty,university,unit])
  for(const id of [owner,deputy,member,outsider,pending]) await seedUser(id,{
    username:username(id),university_id:university,academic_unit_id:unit,specialty_id:specialty,
    study_year:1,experience:'bachelor',categories:['General'],
  })
  const request=randomUUID()
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
    specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    select $1,id,full_name,$3,$4,specialty,'PROJ-1','projection_fixture','approved',id,now() from profiles where id=$2`,
    [request,owner,university,unit])
  const group=first(await asUser(owner,'select xelay_create_study_group($1) as id',[request])).id
  for(const person of [deputy,member,pending]) {
    const invite=first(await asUser(owner,'select xelay_invite_to_study_group($1,$2) as id',[group,username(person)])).id
    if(person!==pending) await asUser(person,'select xelay_respond_study_group_invitation($1,true)',[invite])
  }
  await asUser(owner,"select xelay_assign_study_group_deputy($1,$2,array['schedule'])",[group,deputy])
  const lesson=async({subject='Economics',type='seminar',author=owner,from='2030-04-01',until='2030-04-29',pattern='every',anchor=null}={})=>
    first(await asUser(author,`insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,
      valid_from,valid_until,week_pattern,week_anchor_date,created_by)
      values($1,1,'08:00','09:20',$2,$3,$4,$5,$6,$7,$8) returning id`,[group,subject,type,from,until,pattern,anchor,author])).id
  const manualSubject=first(await asUser(owner,"select xelay_save_seminar_subject($1,null,'ECONOMICS') as id",[group])).id
  const manualSlot=first(await asUser(owner,"select xelay_save_seminar_schedule($1,null,$2,1,'08:00','09:20','2030-04-01','2030-04-29') as id",[group,manualSubject])).id
  const materialSubject=first(await asUser(owner,"select xelay_save_material_subject($1,null,'Economics') as data",[group])).data.id
  const materialPath=`${group}/${owner}/${randomUUID()}.pdf`
  await asUser(owner,`insert into storage.objects(bucket_id,name,owner,metadata)
    values('xelay-study-materials',$1,$2,'{"size":123,"mimetype":"application/pdf"}')`,[materialPath,owner])
  await asUser(owner,`select xelay_save_study_group_material($1,null,$2,'Retained material topic','2030-04-01','Retained material body',
    '[{"label":"Retained link","url":"https://example.test/material"}]',$3::jsonb)`,
    [group,materialSubject,JSON.stringify([{path:materialPath,file_name:'retained.pdf',mime_type:'application/pdf',file_size:123}])])
  const source=await lesson({subject:'  economics  '})
  const homework=first(await asUser(owner,`insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,lesson_topic,created_by)
    values($1,$2,'2030-04-01','DO NOT COPY homework instructions','DO NOT COPY homework title',$3) returning id`,[group,source,owner])).id
  const manualAssignment=first(await asUser(owner,`select xelay_save_seminar($1,null,$2,'2030-04-01','Manual assignment',
    'Manual instructions','questions','[{"body":"Manual question","primary_capacity":2}]','[]') as id`,[group,manualSlot])).id
  const notificationCount=async()=>first(await db.query('select count(*)::int as n from notifications')).n
  const outboxCount=async()=>first(await db.query('select count(*)::int as n from notification_email_outbox')).n
  const beforeNotice=await notificationCount(),beforeOutbox=await outboxCount()
  const immutableTables=['study_group_homework','study_group_materials','study_group_seminars','study_group_seminar_questions','study_group_seminar_teams','study_group_seminar_reservations','storage.objects']
  const snapshot=async()=>Object.fromEntries(await Promise.all(immutableTables.map(async table=>[table,(await db.query(`select to_jsonb(t) as value from ${table} t order by id`)).rows])))
  const before=await snapshot()
  const policies=async()=>(await db.query(`select schemaname,tablename,policyname,roles,cmd,qual,with_check from pg_policies
    where schemaname in('public','storage') and tablename<>'study_group_schedule_projection_context'
    order by schemaname,tablename,policyname`)).rows
  const beforePolicies=await policies()
  const classroomGetterAcl=first(await db.query("select proacl::text as acl from pg_proc where oid='public.xelay_classroom_seminars(uuid,uuid)'::regprocedure")).acl
  await db.exec(migration)
  const slots=async id=>(await db.query('select * from study_group_seminar_schedule where source_schedule_id=$1 order by created_at,id',[id])).rows
  const slotFor=async id=>(await slots(id)).find(row=>row.source_active)
  const row=async(table,id)=>first(await db.query(`select * from ${table} where id=$1`,[id]))
  const occurs=async(id,date)=>first(await db.query('select xelay_seminar_schedule_occurs_on_date(s,$2::date) as yes from study_group_seminar_schedule s where id=$1',[id,date])).yes
  const saveAssignment=async(slot,date,{id=null,title='Explicit seminar',instructions='Explicit instructions',questions=null}={})=>{
    const items=questions??[{body:'Explicit question',primary_capacity:2}]
    return first(await asUser(owner,`select xelay_save_seminar($1,$2,$3,$4::date,$5,$6,'questions',$7::jsonb,'[]') as id`,
      [group,id,slot,date,title,instructions,JSON.stringify(items)])).id
  }

  await t.test('backfill reuses normalized manual subjects, keeps all manual rows and content, and sends no historical notifications',async()=>{
    assert.deepEqual(await snapshot(),before)
    assert.deepEqual(await policies(),beforePolicies)
    assert.equal(first(await db.query("select proacl::text as acl from pg_proc where oid='public.xelay_classroom_seminars(uuid,uuid)'::regprocedure")).acl,classroomGetterAcl)
    assert.equal(await notificationCount(),beforeNotice)
    assert.equal(await outboxCount(),beforeOutbox)
    const automatic=await slotFor(source)
    assert.equal(automatic.subject_id,manualSubject)
    assert.equal(automatic.source_managed,true)
    assert.equal((await row('study_group_seminar_schedule',manualSlot)).source_managed,false)
    assert.equal((await row('study_group_seminar_subjects',manualSubject)).has_schedule_sources,true)
    assert.equal((await row('study_group_material_subjects',materialSubject)).has_schedule_sources,true)
    assert.equal((await row('study_group_homework',homework)).body,'DO NOT COPY homework instructions')
    assert.equal((await row('study_group_seminars',manualAssignment)).title,'Manual assignment')
    assert.equal((await db.query('select id from study_group_seminars')).rows.length,1)
  })

  let alternating,alternatingSlot,dated,question,attachment,storageId
  await t.test('schedule-only deputy creates both subject lists and only seminar slots; case and whitespace do not duplicate',async()=>{
    alternating=await lesson({subject:'  Business   Theory ',author:deputy,pattern:'upper',anchor:'2030-04-01'})
    alternatingSlot=(await slotFor(alternating)).id
    const lecture=await lesson({subject:'BUSINESS\u00a0THEORY',type:'lecture',author:deputy})
    assert.equal((await slots(lecture)).length,0)
    for(const table of ['study_group_material_subjects','study_group_seminar_subjects']) {
      const rows=(await db.query(`select * from ${table} where group_id=$1 and xelay_academic_subject_key(name)='business theory'`,[group])).rows
      assert.equal(rows.length,1)
      assert.equal(rows[0].name,'Business Theory')
      assert.equal(rows[0].created_by,deputy)
      assert.equal(rows[0].has_schedule_sources,true)
    }
    const single=await lesson({subject:'A',type:'lecture',author:deputy})
    assert.equal((await slots(single)).length,0)
    await assert.rejects(asUser(deputy,"select xelay_save_material_subject($1,null,'Unauthorized manual subject')",[group]),/STUDY_GROUP_PERMISSION_REQUIRED/)
    await assert.rejects(asUser(deputy,"select xelay_save_seminar_subject($1,null,'Unauthorized manual seminar')",[group]),/STUDY_GROUP_PERMISSION_REQUIRED/)
    await assert.rejects(asUser(deputy,`select xelay_save_study_group_material($1,null,$2,'Unauthorized topic','2030-04-01','','[]','[]')`,[group,materialSubject]),/STUDY_GROUP_PERMISSION_REQUIRED/)
  })

  await t.test('automatic slots use exact alternating weeks, exclusions and single dates; new assignments cannot bypass them',async()=>{
    assert.equal(await occurs(alternatingSlot,'2030-04-01'),true)
    assert.equal(await occurs(alternatingSlot,'2030-04-08'),false)
    assert.equal(await occurs(alternatingSlot,'2030-04-15'),true)
    await assert.rejects(saveAssignment(alternatingSlot,'2030-04-08'),/SEMINAR_DATE_MISMATCH/)
    await asUser(deputy,"select xelay_cancel_study_group_schedule_occurrence($1,$2,'2030-04-15')",[group,alternating])
    assert.equal(await occurs(alternatingSlot,'2030-04-15'),false)
    await assert.rejects(saveAssignment(alternatingSlot,'2030-04-15'),/SEMINAR_DATE_MISMATCH/)
    const single=await lesson({subject:'One time seminar',author:deputy,from:'2030-04-08',until:'2030-04-08'})
    const singleSlot=(await slotFor(single)).id
    assert.equal(await occurs(singleSlot,'2030-04-08'),true)
    assert.equal(await occurs(singleSlot,'2030-04-15'),false)
    const lower=await lesson({subject:'Lower week seminar',author:deputy,pattern:'lower',anchor:'2030-04-01'})
    assert.equal(await occurs((await slotFor(lower)).id,'2030-04-08'),true)
    assert.equal(await occurs((await slotFor(lower)).id,'2030-04-01'),false)
    const legacy=await lesson({subject:'Legacy open semester',from:'-infinity',until:'infinity'})
    const legacySlot=await slotFor(legacy)
    assert.deepEqual(first(await db.query('select valid_from::text as first,valid_until::text as last from study_group_seminar_schedule where id=$1',[legacySlot.id])),{first:'-infinity',last:'infinity'})
    assert.equal(await occurs(legacySlot.id,'2030-04-01'),true)
    await assert.rejects(asUser(owner,"select xelay_save_seminar_schedule($1,null,$2,1,'08:00','09:20','-infinity','infinity')",[group,legacySlot.subject_id]),/SEMINAR_INVALID_INPUT/)
  })

  await t.test('automatic calendars and source-bound names reject independent CRUD, manual calendars remain editable',async()=>{
    const automatic=await slotFor(source)
    await assert.rejects(asUser(owner,"select xelay_save_seminar_schedule($1,$2,$3,1,'10:00','11:20','2030-04-01','2030-04-29')",[group,automatic.id,manualSubject]),/SEMINAR_SOURCE_SCHEDULE_MANAGED/)
    await assert.rejects(asUser(owner,'select xelay_delete_seminar_schedule($1)',[automatic.id]),/SEMINAR_SOURCE_SCHEDULE_MANAGED/)
    await assert.rejects(asUser(owner,"select xelay_save_seminar_subject($1,$2,'Renamed separately')",[group,manualSubject]),/SUBJECT_SOURCE_MANAGED/)
    await assert.rejects(asUser(owner,'select xelay_delete_seminar_subject($1)',[manualSubject]),/SUBJECT_SOURCE_MANAGED/)
    await assert.rejects(asUser(owner,"select xelay_save_material_subject($1,$2,'Renamed separately')",[group,materialSubject]),/MATERIAL_SUBJECT_SOURCE_MANAGED/)
    await assert.rejects(asUser(owner,'select xelay_delete_material_subject($1,$2)',[group,materialSubject]),/MATERIAL_SUBJECT_SOURCE_MANAGED/)
    const free=first(await asUser(owner,"select xelay_save_seminar_subject($1,null,'Manual only') as id",[group])).id
    const freeSlot=first(await asUser(owner,"select xelay_save_seminar_schedule($1,null,$2,2,'08:00','09:20','2030-04-01','2030-04-29') as id",[group,free])).id
    await asUser(owner,"select xelay_save_seminar_schedule($1,$2,$3,2,'10:00','11:20','2030-04-01','2030-04-29')",[group,freeSlot,free])
    await asUser(owner,'select xelay_delete_seminar_schedule($1)',[freeSlot])
    await asUser(owner,"select xelay_save_seminar_subject($1,$2,'Manual renamed')",[group,free])
  })

  await t.test('source edits preserve dated assignment snapshots, questions, reservations, resources and private file records',async()=>{
    dated=await saveAssignment(alternatingSlot,'2030-04-01')
    question=first(await db.query('select id from study_group_seminar_questions where seminar_id=$1',[dated])).id
    await asUser(member,"select xelay_reserve_seminar($1,'primary',$2)",[dated,question])
    const path=`${group}/${owner}/${randomUUID()}-retained.pdf`
    storageId=first(await asUser(owner,`insert into storage.objects(bucket_id,name,owner,metadata)
      values('xelay-seminar-files',$1,$2,'{"size":123,"mimetype":"application/pdf"}') returning id`,[path,owner])).id
    attachment={storage_path:path,file_name:'retained.pdf',mime_type:'application/pdf',file_size:123}
    await asUser(owner,`select xelay_save_seminar_with_resources($1,$2,$3,'2030-04-01','Explicit seminar','Explicit instructions','questions',
      $4::jsonb,'[]','["https://example.test/retained"]',$5::jsonb)`,[group,dated,alternatingSlot,
      JSON.stringify([{id:question,body:'Explicit question',primary_capacity:2}]),JSON.stringify([attachment])])
    const beforeContent=await snapshot()
    await asUser(deputy,"update study_group_schedule set starts_at='10:00',ends_at='11:20' where id=$1",[alternating])
    assert.deepEqual(await snapshot(),beforeContent)
    assert.equal((await row('study_group_seminar_schedule',alternatingSlot)).starts_at,'10:00:00')
    await asUser(deputy,"select xelay_cancel_study_group_schedule_occurrence($1,$2,'2030-04-01')",[group,alternating])
    assert.equal(await occurs(alternatingSlot,'2030-04-01'),false)
    await saveAssignment(alternatingSlot,'2030-04-01',{id:dated,title:'Updated existing cancelled work',questions:[{id:question,body:'Explicit question',primary_capacity:2}]})
    const retained=await row('study_group_seminars',dated)
    assert.equal(retained.starts_at,'08:00:00')
    assert.equal(retained.ends_at,'09:20:00')
    assert.equal(retained.title,'Updated existing cancelled work')
    assert.deepEqual(retained.resource_attachments,[attachment])
    assert.equal(first(await db.query('select count(*)::int as n from study_group_seminar_reservations where seminar_id=$1',[dated])).n,1)
    assert.equal((await row('storage.objects',storageId)).name,path)
    await assert.rejects(asUser(owner,"select xelay_save_seminar_schedule($1,$2,$3,2,'10:00','11:20','2030-04-02','2030-04-02')",[group,alternatingSlot,retained.subject_id]),/SEMINAR_SOURCE_SCHEDULE_MANAGED/)
  })

  await t.test('renaming/type changes retire old slots and preserve work; deleting the source never cascades seminar content',async()=>{
    const beforeContent=await snapshot()
    await asUser(deputy,"update study_group_schedule set subject='New subject name' where id=$1",[alternating])
    assert.deepEqual(await snapshot(),beforeContent)
    assert.equal((await row('study_group_seminar_schedule',alternatingSlot)).source_active,false)
    await assert.rejects(saveAssignment(alternatingSlot,'2030-04-29'),/SEMINAR_DATE_MISMATCH/)
    const renamed=await slotFor(alternating)
    assert.notEqual(renamed.id,alternatingSlot)
    await asUser(deputy,"update study_group_schedule set lesson_type='lecture' where id=$1",[alternating])
    assert.equal(await slotFor(alternating),undefined)
    await asUser(deputy,'delete from study_group_schedule where id=$1',[alternating])
    const retired=await row('study_group_seminar_schedule',alternatingSlot)
    assert.equal(retired.source_schedule_id,null)
    assert.equal(retired.source_managed,true)
    assert.equal(retired.source_active,false)
    assert.deepEqual(await snapshot(),beforeContent)
    await saveAssignment(alternatingSlot,'2030-04-01',{id:dated,questions:[{id:question,body:'Explicit question',primary_capacity:2}]})
    assert.equal((await row('study_group_seminars',dated)).starts_at,'08:00:00')
  })

  await t.test('the teacher RPC also rejects off-week/new cancelled work, preserves dated snapshots and cannot edit automatic calendar templates',async()=>{
    const source=await lesson({subject:'Teacher projection',pattern:'upper',anchor:'2030-04-01'})
    const slot=await slotFor(source),course=randomUUID()
    await db.query(`insert into teacher_verification_requests(user_id,full_name,university_id,academic_unit_id,department,status)
      values($1,'Synthetic verified teacher',$2,$3,'Synthetic department','approved')`,[owner,university,unit])
    await db.query(`insert into teaching_courses(id,owner_id,university_id,academic_unit_id,title,semester,starts_on,ends_on)
      values($1,$2,$3,$4,'Teacher projection','Synthetic semester','2030-04-01','2030-05-01')`,[course,owner,university,unit])
    await db.query(`insert into teaching_course_groups(course_id,group_id,subject_id,status,invited_by,accepted_at)
      values($1,$2,$3,'accepted',$4,now())`,[course,group,slot.subject_id,owner])
    const payload=(id,date)=>({id,version:0,course_id:course,group_id:group,schedule_id:slot.id,lesson_date:date,
      title:'Teacher explicit title',instructions:'Teacher explicit instructions',format:'questions',
      questions:[{body:'Teacher explicit question',primary_capacity:2}],teams:[]})
    const mutate=async(action,body)=>first(await asUser(owner,'select xelay_classroom_mutate($1,$2::jsonb) as value',[action,JSON.stringify(body)])).value
    await assert.rejects(mutate('save_seminar',payload(randomUUID(),'2030-04-08')),/SEMINAR_DATE_MISMATCH/)
    const id=randomUUID(),created=await mutate('save_seminar',payload(id,'2030-04-01'))
    const question=first(await db.query('select id from study_group_seminar_questions where seminar_id=$1',[id])).id
    await asUser(deputy,"update study_group_schedule set starts_at='12:00',ends_at='13:20' where id=$1",[source])
    await asUser(deputy,"select xelay_cancel_study_group_schedule_occurrence($1,$2,'2030-04-01')",[group,source])
    await assert.rejects(mutate('save_seminar',payload(randomUUID(),'2030-04-01')),/SEMINAR_DATE_MISMATCH/)
    await mutate('save_seminar',{...payload(id,'2030-04-01'),version:created.version,title:'Teacher preserved edit',
      questions:[{id:question,body:'Teacher explicit question',primary_capacity:2}]})
    const retained=await row('study_group_seminars',id)
    assert.equal(retained.starts_at,'08:00:00')
    assert.equal(retained.ends_at,'09:20:00')
    assert.equal(retained.teaching_author_id,owner)
    assert.equal(retained.title,'Teacher preserved edit')
    const currentSlot=await row('study_group_seminar_schedule',slot.id)
    await assert.rejects(mutate('save_seminar_schedule',{id:slot.id,version:currentSlot.teaching_version,course_id:course,group_id:group,
      weekday:1,starts_at:'14:00',ends_at:'15:20',valid_from:'2030-04-01',valid_until:'2030-04-29'}),/SEMINAR_SOURCE_SCHEDULE_MANAGED/)
    await asUser(deputy,"update study_group_schedule set valid_from='2030-06-03',valid_until='2030-07-01' where id=$1",[source])
    const unrelated=await lesson({subject:'Teacher projection',from:'2030-06-03',until:'2030-07-01'})
    const unrelatedSlot=await slotFor(unrelated)
    const read=first(await asUser(owner,'select xelay_classroom_seminars($1,$2) as value',[course,group])).value
    assert.equal(read.seminars.some(item=>item.id===id),true)
    assert.equal(read.schedule.some(item=>item.id===slot.id),true,'Retained authorized dated session keeps its moved source slot visible')
    assert.equal(read.schedule.some(item=>item.id===unrelatedSlot.id),false,'Unreferenced out-of-course templates are not exposed')
    await assert.rejects(asUser(outsider,'select xelay_classroom_seminars($1,$2)',[course,group]),/TEACHING_FORBIDDEN/)
    await assert.rejects(mutate('save_seminar',payload(randomUUID(),'2030-06-03')),/SEMINAR_DATE_MISMATCH/)
    await mutate('save_seminar',{...payload(id,'2030-04-01'),version:retained.teaching_version,title:'Teacher moved-source edit',
      questions:[{id:question,body:'Teacher explicit question',primary_capacity:2}]})
    assert.equal((await row('study_group_seminars',id)).starts_at,'08:00:00')
  })

  await t.test('batch preview/save/retry after projection creates automatic one-off slots atomically and no seminar assignments',async()=>{
    const plan=[{source_date:'2030-04-15',target_date:'2030-04-20'},{source_date:'2030-04-22',target_date:'2030-04-27'}]
    const copy=async(preview,signature=null)=>first(await asUser(deputy,
      'select xelay_copy_study_group_schedule_sequence($1,$2::jsonb,$3,$4) as value',[group,JSON.stringify(plan),preview,signature])).value
    const before=await snapshot(),preview=await copy(true)
    assert.match(preview.source_signature,/^[a-f0-9]{32}$/)
    const count=preview.days.reduce((sum,day)=>sum+day.lessons.filter(lesson=>lesson.lesson_type==='seminar').length,0)
    assert.ok(count>0)
    const result=await copy(false,preview.source_signature)
    assert.equal(result.copied,preview.copied)
    const projected=(await db.query(`select s.*,s.valid_from=s.valid_until as one_off from study_group_seminar_schedule s join study_group_schedule x on x.id=s.source_schedule_id
      where x.group_id=$1 and x.valid_from in('2030-04-20','2030-04-27') and x.valid_from=x.valid_until`,[group])).rows
    assert.equal(projected.length,count)
    assert.ok(projected.every(slot=>slot.source_managed&&slot.source_active&&slot.one_off))
    assert.deepEqual(await snapshot(),before)
    assert.equal((await copy(false,preview.source_signature)).copied,0)
    assert.equal(first(await db.query(`select count(*)::int as n from study_group_seminar_schedule s join study_group_schedule x on x.id=s.source_schedule_id
      where x.group_id=$1 and x.valid_from in('2030-04-20','2030-04-27') and x.valid_from=x.valid_until`,[group])).n,count)
  })

  await t.test('a late batch failure rolls back source copies, automatic slots, contexts and all notification jobs together',async()=>{
    const plan=[{source_date:'2030-04-15',target_date:'2030-05-04'},{source_date:'2030-04-22',target_date:'2030-05-11'}]
    const copy=async(preview,signature=null)=>first(await asUser(deputy,
      'select xelay_copy_study_group_schedule_sequence($1,$2::jsonb,$3,$4) as value',[group,JSON.stringify(plan),preview,signature])).value
    const preview=await copy(true)
    const count=async table=>first(await db.query(`select count(*)::int as n from ${table}`)).n
    const tables=['study_group_schedule','study_group_seminar_schedule','study_group_seminar_subjects',
      'study_group_material_subjects','study_group_schedule_projection_context','notifications','notification_email_outbox']
    const before=await Promise.all(tables.map(count)),content=await snapshot()
    await db.exec(`create function public.fixture_projection_late_failure() returns trigger language plpgsql as $$
      begin if new.group_id='${group}'::uuid and new.valid_from=date '2030-05-11' then
        raise exception 'fixture_projection_late_failure'; end if; return new; end $$;
      create trigger zz_fixture_projection_late_failure before insert on study_group_schedule
        for each row execute function public.fixture_projection_late_failure();`)
    try {
      await assert.rejects(copy(false,preview.source_signature),/fixture_projection_late_failure/)
      assert.deepEqual(await Promise.all(tables.map(count)),before)
      assert.deepEqual(await snapshot(),content)
    } finally {
      await db.exec('drop trigger zz_fixture_projection_late_failure on study_group_schedule; drop function public.fixture_projection_late_failure()')
    }
  })

  await t.test('private context/helpers cannot be read, written or invoked through API roles and forged GUCs grant no access',async()=>{
    for(const role of ['anon','authenticated','service_role']) {
      await assert.rejects(asUser(member,'select * from study_group_schedule_projection_context',[],{role}),/permission denied/)
      await assert.rejects(asUser(member,`insert into study_group_schedule_projection_context values(txid_current(),pg_backend_pid(),$1,$2,$2,'Exploit',$3)`,[group,source,member],{role}),/permission denied/)
      await assert.rejects(asUser(member,'select xelay_private_sync_schedule_projection($1,$2,$3,$4,false)',[source,group,'Exploit',member],{role}),/permission denied/)
    }
    assert.equal(first(await db.query('select count(*)::int as n from study_group_schedule_projection_context')).n,0)
    await db.exec('grant insert on study_group_material_subjects to authenticated')
    try {
      await assert.rejects(asUser(deputy,`with forged as (select set_config('xelay.schedule_projection','true',false))
        insert into study_group_material_subjects(group_id,name,created_by,has_schedule_sources)
        select $1,'Exploit',$2,true from forged`,[group,deputy]),/ACADEMIC_PROJECTION_PROVENANCE_REQUIRED|STUDY_GROUP_PERMISSION_REQUIRED/)
    } finally { await db.exec('revoke insert on study_group_material_subjects from authenticated') }
    for(const actor of [member,pending,outsider]) {
      await assert.rejects(lesson({subject:'Forbidden source '+actor,author:actor}),/row-level security|STUDY_GROUP_PERMISSION_REQUIRED/)
    }
    for(const actor of [pending,outsider]) {
      assert.equal((await asUser(actor,'select id from study_group_seminar_subjects where group_id=$1',[group])).rows.length,0)
      assert.equal((await asUser(actor,'select id from study_group_material_subjects where group_id=$1',[group])).rows.length,0)
      assert.equal((await asUser(actor,'select id from study_group_seminars where id=$1',[dated])).rows.length,0)
      assert.equal((await asUser(actor,"select id from storage.objects where bucket_id='xelay-seminar-files' and id=$1",[storageId])).rows.length,0)
    }
  })

  await t.test('live projection deduplicates timetable notifications and migration reapply is content/idempotency safe',async()=>{
    const before=await notificationCount(),outboxBefore=await outboxCount()
    const sourceId=await lesson({subject:'One notification source',author:deputy})
    const notifications=(await db.query(`select * from notifications where academic_event_key like 'academic:timetable:%'
      and actor_id=$1 and created_at >= (select created_at from study_group_schedule where id=$2)`,[deputy,sourceId])).rows
    // Owner + accepted ordinary member, actor deputy excluded; no notification
    // for the automatic subject/slot in addition to the source event.
    assert.equal(await notificationCount()-before,2)
    assert.equal(notifications.length>=2,true)
    assert.equal(await outboxCount()-outboxBefore,2)
    const content=await snapshot(),slotIds=(await slots(sourceId)).map(x=>x.id)
    const notices=await notificationCount(),jobs=await outboxCount()
    await db.exec(migration)
    assert.deepEqual(await snapshot(),content)
    assert.deepEqual((await slots(sourceId)).map(x=>x.id),slotIds)
    assert.equal(await notificationCount(),notices)
    assert.equal(await outboxCount(),jobs)
    assert.deepEqual(await policies(),beforePolicies)
  })
})
