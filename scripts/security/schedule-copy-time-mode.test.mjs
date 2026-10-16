// Full real migration chain; synthetic records in local PostgreSQL, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import vm from 'node:vm'
import ts from 'typescript'
import {createFixture} from './fixture.mjs'
const root=new URL('../../',import.meta.url),first=result=>result.rows[0]
const migration=await readFile(new URL('supabase/migrations/202610160008_schedule_copy_time_mode.sql',root),'utf8')
const audit=await readFile(new URL('supabase/audits/202610160008_schedule_copy_time_mode.sql',root),'utf8')

test('first-shift day/sequence copies preserve source, academic content, permissions and signed approvals',async t=>{
  const fx=await createFixture({useStagingParity:true,through:'202610160007',beforeMigrationsSql:`
    alter table auth.users add column if not exists banned_until timestamptz;
    create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$ select 1::bigint $$;
  `});t.after(()=>fx.close())
  const {db,asUser,seedUser}=fx
  const university=randomUUID(),unit=randomUUID(),specialty=randomUUID()
  const owner=randomUUID(),deputy=randomUUID(),member=randomUUID(),outsider=randomUUID(),admin=randomUUID(),hwDeputy=randomUUID()
  const username=id=>'shift_'+id.replaceAll('-','').slice(0,16)
  await db.query("insert into universities(id,name,slug) values($1,'First shift fixture',$2)",[university,'shift-'+university])
  await db.query("insert into academic_units(id,university_id,name,slug,unit_type) values($1,$2,'Shift faculty',$3,'faculty')",[unit,university,'shift-'+unit])
  await db.query("insert into academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name) values($1,$2,$3,'SHIFT','Shift program','Shift program')",[specialty,university,unit])
  for(const id of [owner,deputy,member,outsider,admin,hwDeputy])await seedUser(id,{username:username(id),university_id:university,academic_unit_id:unit,specialty_id:specialty,study_year:1,experience:'bachelor',categories:['General']})
  await db.query("insert into user_roles(user_id,role) values($1,'ADMIN')",[admin]);await db.query("insert into auth.mfa_factors(user_id,status) values($1,'verified')",[admin])
  const request=randomUUID()
  await db.query(`insert into class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
    select $1,id,full_name,university_id,academic_unit_id,specialty,'SHIFT-1','shift_fixture','approved',id,now() from profiles where id=$2`,[request,owner])
  const group=first(await asUser(owner,'select xelay_create_study_group($1) as id',[request])).id
  for(const id of [deputy,member,hwDeputy]){const invitation=first(await asUser(owner,'select xelay_invite_to_study_group($1,$2) as id',[group,username(id)])).id;await asUser(id,'select xelay_respond_study_group_invitation($1,true)',[invitation])}
  await asUser(owner,"select xelay_assign_study_group_deputy($1,$2,array['schedule'])",[group,deputy])
  await asUser(owner,"select xelay_assign_study_group_deputy($1,$2,array['homework'])",[group,hwDeputy])
  const insert=async({subject,weekday=1,starts='14:30',ends='15:50',number=null,type='lecture',pattern='every',anchor=null,from='2026-10-12',until='2026-11-30'})=>
    first(await asUser(owner,`insert into study_group_schedule(group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_url,online_url_secondary,
      online_url_label,online_url_secondary_label,valid_from,valid_until,week_pattern,week_anchor_date,lesson_number,created_by)
      values($1,$2,$3,$4,$5,$6,'Room','https://example.test/lecture','https://example.test/seminar','Лекція','Семінар',$7,$8,$9,$10,$11,$12) returning id`,
      [group,weekday,starts,ends,subject,type,from,until,pattern,anchor,number,owner])).id
  const a=await insert({subject:'Source A',number:6})
  const b=await insert({subject:'Source upper B',starts:'17:20',ends:'18:40',number:8,pattern:'upper',anchor:'2026-10-12'})
  const c=await insert({subject:'Parallel seminar C',starts:'17:20',ends:'18:40',number:8,type:'seminar',pattern:'upper',anchor:'2026-10-12',until:'2030-04-15'})
  await insert({subject:'Source lower B',starts:'17:20',ends:'18:40',number:9,pattern:'lower',anchor:'2026-10-12'})
  await insert({subject:'Tuesday unnumbered A',weekday:2,starts:'16:00',ends:'17:20'})
  await insert({subject:'Tuesday unnumbered B',weekday:2,starts:'17:40',ends:'19:00'})
  await insert({subject:'Mixed numbered',weekday:3,starts:'14:30',ends:'15:50',number:6})
  await insert({subject:'Mixed unknown',weekday:3,starts:'17:20',ends:'18:40'})
  await insert({subject:'Wide gap A',weekday:4,number:1})
  await insert({subject:'Wide gap B',weekday:4,starts:'17:20',ends:'18:40',number:7})
  const homework=first(await asUser(owner,`insert into study_group_homework(group_id,schedule_item_id,lesson_date,body,url,created_by)
    values($1,$2,'2026-10-12','Do not copy homework','https://example.test/homework',$3) returning id`,[group,a,owner])).id
  const sourceSlot=first(await db.query('select id from study_group_seminar_schedule where source_schedule_id=$1 and source_active',[c])).id
  await asUser(owner,`select xelay_save_seminar($1,null,$2,'2030-04-08','Do not copy assignment','Private instructions','questions',
    '[{"body":"Do not copy question","primary_capacity":2}]','[]')`,[group,sourceSlot])
  const immutable=['study_group_homework','study_group_seminars','study_group_seminar_questions','study_group_seminar_reservations','study_group_materials','storage.objects']
  const content=async()=>Object.fromEntries(await Promise.all(immutable.map(async table=>[table,(await db.query(`select to_jsonb(t) as value from ${table} t order by id`)).rows])))
  const sources=() => db.query('select to_jsonb(s) as value from study_group_schedule s where group_id=$1 and weekday between 1 and 5 order by id',[group]).then(result=>result.rows)
  const oldRpcContract=async()=>(await db.query(`select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,p.proowner::text,p.proacl::text
    from pg_proc p where p.oid in('xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)'::regprocedure,
      'xelay_copy_study_group_schedule_sequence(uuid,jsonb,boolean,text)'::regprocedure) order by signature`)).rows
  const beforeContent=await content(),beforeSources=await sources(),beforeOld=await oldRpcContract()
  const state=async()=>(await db.query('select to_jsonb(s) as value from study_group_schedule s where group_id=$1 order by id',[group])).rows
  const rowsOn=date=>db.query('select * from study_group_schedule where group_id=$1 and valid_from=$2::date and valid_until=$2::date order by starts_at,ends_at,subject',[group,date]).then(result=>result.rows)
  const callDay=(source='2026-10-12',target='2026-10-17',preview=true,signature=null,mapping=[],user=owner,mode='first_shift',options={})=>asUser(user,
    'select xelay_copy_study_group_schedule_day_with_time_mode($1,$2,$3,$4,$5,$6,$7::jsonb) as value',
    [group,source,target,preview,signature,mode,JSON.stringify(mapping)],options).then(result=>first(result).value)
  const callSequence=(pairs,preview=true,signature=null,mapping={},user=owner,mode='first_shift',options={})=>asUser(user,
    'select xelay_copy_study_group_schedule_sequence_with_time_mode($1,$2::jsonb,$3,$4,$5,$6::jsonb) as value',
    [group,JSON.stringify(pairs),preview,signature,mode,JSON.stringify(mapping)],options).then(result=>first(result).value)
  const oldDay=(source,target,preview=true,signature=null)=>asUser(owner,'select xelay_copy_study_group_schedule_day($1,$2,$3,$4,$5) as value',[group,source,target,preview,signature]).then(result=>first(result).value)
  const runAudit=async()=>{const results=await db.exec(audit);return results.find(result=>result.rows?.[0]?.audit!==undefined).rows[0].audit}
  const auditBefore=await runAudit()
  await db.exec(migration)

  await t.test('installation has no data changes and keeps original RPC bodies/owners/ACLs with private projection helper',async()=>{
    assert.deepEqual(await sources(),beforeSources);assert.deepEqual(await content(),beforeContent);assert.deepEqual(await oldRpcContract(),beforeOld)
    for(const role of ['anon','authenticated','service_role'])assert.equal(first(await db.query("select has_function_privilege($1,'xelay_private_first_shift_projection(jsonb,jsonb)','execute') as allowed",[role])).allowed,false)
    const funcs=(await db.query("select proname,pronargdefaults,prosecdef,proconfig,proacl::text from pg_proc where proname like 'xelay_copy_study_group_schedule_%_with_time_mode' order by proname")).rows
    assert.equal(funcs.length,2);assert.ok(funcs.every(row=>row.pronargdefaults===0&&row.prosecdef))
    const after=await runAudit()
    assert.deepEqual(after.relations,auditBefore.relations);assert.deepEqual(after.policies,auditBefore.policies);assert.deepEqual(after.table_security,auditBefore.table_security)
    assert.equal(after.functions.length,auditBefore.functions.length+3)
    for(const old of auditBefore.functions)assert.deepEqual(after.functions.find(row=>row.signature===old.signature),old)
  })
  let preview
  await t.test('numbered source day maps min to one, preserves internal gaps and shares a slot across parallel lessons',async()=>{
    const before=await state();preview=await callDay()
    assert.equal(preview.copied,3);assert.equal(preview.skipped,0)
    assert.deepEqual(preview.slot_assignments,[{source_starts_at:'14:30:00',source_ends_at:'15:50:00',target_lesson_number:1},
      {source_starts_at:'17:20:00',source_ends_at:'18:40:00',target_lesson_number:3}])
    assert.deepEqual(preview.lessons.map(row=>row.lesson_number),[1,3,3])
    assert.ok(preview.lessons.every(row=>row.online_url_label==='Лекція'&&row.online_url_secondary_label==='Семінар'))
    assert.ok(preview.lessons.every(row=>row.source_starts_at&&row.source_ends_at&&[6,8].includes(row.source_lesson_number)))
    assert.deepEqual(await state(),before)
  })
  await t.test('projected destination conflicts are checked independently from unrelated evening originals',async()=>{
    await insert({subject:'Unrelated evening Saturday',weekday:6,from:'2026-10-17',until:'2026-10-17',number:5})
    await assert.rejects(oldDay('2026-10-12','2026-10-17'),/COPY_CONFLICT/)
    const fresh=await callDay();assert.equal(fresh.copied,3)
    const result=await callDay('2026-10-12','2026-10-17',false,fresh.source_signature)
    assert.equal(result.copied,3);assert.deepEqual(result.lessons,[]);assert.deepEqual(result.slot_assignments,fresh.slot_assignments)
    assert.equal((await rowsOn('2026-10-17')).length,4)
    const retry=await callDay('2026-10-12','2026-10-17',false,fresh.source_signature)
    assert.equal(retry.copied,0);assert.equal(retry.skipped,3)
    assert.equal((await rowsOn('2026-10-17')).length,4)
    assert.deepEqual(await content(),beforeContent);assert.deepEqual(await sources(),beforeSources)
    const targetSeminar=(await rowsOn('2026-10-17')).find(row=>row.subject==='Parallel seminar C')
    const targetSlot=first(await db.query('select id from study_group_seminar_schedule where source_schedule_id=$1 and source_active',[targetSeminar.id])).id
    assert.equal(first(await db.query('select count(*)::int as n from study_group_seminars where schedule_id=$1',[targetSlot])).n,0)
  })
  await t.test('unnumbered and mixed days use chronological intervals and each source date gets its own mapping',async()=>{
    const tue=await callDay('2026-10-13','2026-10-18');assert.deepEqual(tue.lessons.map(row=>row.lesson_number),[1,2]);assert.ok(tue.lessons.every(row=>row.source_lesson_number===null))
    const wed=await callDay('2026-10-14','2026-10-18');assert.deepEqual(wed.lessons.map(row=>row.lesson_number),[1,2])
    const plan=[{source_date:'2026-10-12',target_date:'2026-10-24'},{source_date:'2026-10-13',target_date:'2026-10-31'},{source_date:'2026-10-16',target_date:'2026-11-07'}]
    const value=await callSequence(plan)
    assert.deepEqual(value.days.map(row=>row.slot_assignments.map(slot=>slot.target_lesson_number)),[[1,3],[1,2],[]])
    assert.equal(value.days[2].empty,true);assert.deepEqual(value.days[2].lessons,[])
    assert.equal((await callSequence(plan,false,value.source_signature)).copied,5)
    assert.deepEqual(await rowsOn('2026-11-07'),[])
    assert.deepEqual(await content(),beforeContent)
  })
  await t.test('full manual assignments can resolve a wide numeric gap; partial assignments preserve valid automatic slots',async()=>{
    await assert.rejects(callDay('2026-10-15','2026-11-14'),/FIRST_SHIFT_UNMAPPABLE/)
    const mapping=[{source_starts_at:'14:30',source_ends_at:'15:50',target_lesson_number:2},{source_starts_at:'17:20',source_ends_at:'18:40',target_lesson_number:4}]
    const result=await callDay('2026-10-15','2026-11-14',true,null,mapping)
    assert.deepEqual(result.lessons.map(row=>row.lesson_number),[2,4]);assert.equal(result.slot_assignments[0].source_starts_at,'14:30:00')
    const partial=[{source_starts_at:'14:30',source_ends_at:'15:50',target_lesson_number:2}]
    const valid=await callDay('2026-10-12','2026-11-14',true,null,partial)
    assert.deepEqual(valid.slot_assignments.map(row=>row.target_lesson_number),[2,3])
    await assert.rejects(callDay('2026-10-12','2026-11-14',false,valid.source_signature,[]),/COPY_SOURCE_CHANGED/)
    assert.deepEqual(await rowsOn('2026-11-14'),[])
  })
  await t.test('invalid/malicious mappings and unknown modes are rejected without changing data',async()=>{
    const before=await state(),entry={source_starts_at:'14:30',source_ends_at:'15:50',target_lesson_number:1}
    for(const mapping of [null,{},[null],[{...entry,target_lesson_number:0}],[{...entry,target_lesson_number:6}],
      [{...entry,target_lesson_number:'1'}],[{...entry,starts_at:'01:00'}],[{...entry,source_starts_at:'03:00'}],
      [entry,{...entry,source_starts_at:'14:30:00',source_ends_at:'15:50:00'}],
      [entry,{source_starts_at:'17:20',source_ends_at:'18:40',target_lesson_number:1}]])await assert.rejects(callDay('2026-10-12','2026-11-14',true,null,mapping),/SLOT_ASSIGNMENTS_INVALID/)
    await assert.rejects(callDay('2026-10-12','2026-11-14',true,null,[],owner,'unknown'),/TIME_MODE_INVALID/)
    await assert.rejects(callSequence([{source_date:'2026-10-12',target_date:'2026-11-14'}],true,null,{'2026-10-13':[]}),/SLOT_ASSIGNMENTS_INVALID/)
    assert.deepEqual(await state(),before)
  })
  await t.test('source edits invalidate approvals even when target ranks/times stay identical',async()=>{
    const old=await callDay('2026-10-12','2026-11-14')
    await asUser(owner,"update study_group_schedule set starts_at='14:40',ends_at='16:00' where id=$1",[a])
    const changed=await callDay('2026-10-12','2026-11-14');assert.notEqual(old.source_signature,changed.source_signature)
    assert.deepEqual(old.lessons.map(row=>row.starts_at),changed.lessons.map(row=>row.starts_at))
    await assert.rejects(callDay('2026-10-12','2026-11-14',false,old.source_signature),/COPY_SOURCE_CHANGED/)
    await asUser(owner,"update study_group_schedule set starts_at='14:30',ends_at='15:50' where id=$1",[a])
    assert.deepEqual(await rowsOn('2026-11-14'),[])
  })
  await t.test('projected morning conflicts cancel the whole sequence, including earlier clean dates',async()=>{
    const plan=[{source_date:'2026-10-12',target_date:'2026-11-14'},{source_date:'2026-10-13',target_date:'2026-11-21'}]
    const approval=await callSequence(plan)
    const conflict=await insert({subject:'Morning conflict',weekday:6,from:'2026-11-21',until:'2026-11-21',starts:'08:30',ends:'09:00'})
    await assert.rejects(callSequence(plan,false,approval.source_signature),/COPY_CONFLICT/)
    assert.deepEqual(await rowsOn('2026-11-14'),[]);assert.deepEqual((await rowsOn('2026-11-21')).map(row=>row.id),[conflict])
  })
  await t.test('late insertion failure rolls back all target lessons, projections and notifications',async()=>{
    const plan=[{source_date:'2026-10-12',target_date:'2026-12-05'},{source_date:'2026-10-13',target_date:'2026-12-12'}]
    const approval=await callSequence(plan)
    const snapshot=async()=>Object.fromEntries(await Promise.all(['study_group_schedule','study_group_seminar_schedule','notifications','notification_email_outbox'].map(async table=>[table,(await db.query(`select to_jsonb(t) as value from ${table} t order by id`)).rows])))
    const before=await snapshot()
    await db.exec(`create function public.fixture_shift_failure() returns trigger language plpgsql as $$ begin
      if new.group_id='${group}'::uuid and new.valid_from=date '2026-12-12' then raise exception 'fixture_shift_failure';end if;return new;end $$;
      create trigger fixture_shift_failure before insert on study_group_schedule for each row execute function public.fixture_shift_failure();`)
    try{await assert.rejects(callSequence(plan,false,approval.source_signature),/fixture_shift_failure/);assert.deepEqual(await snapshot(),before)}
    finally{await db.exec('drop trigger fixture_shift_failure on study_group_schedule;drop function public.fixture_shift_failure()')}
  })
  await t.test('exact exclusions/parity and one-off source occurrences are selected before first-shift projection',async()=>{
    await asUser(owner,"select xelay_cancel_study_group_schedule_occurrence($1,$2,'2026-10-19')",[group,a])
    const lower=await callDay('2026-10-19','2026-12-05')
    assert.deepEqual(lower.lessons.map(row=>row.subject),['Source lower B']);assert.equal(lower.lessons[0].lesson_number,1)
    assert.deepEqual(lower.slot_assignments.map(row=>row.target_lesson_number),[1])
    await insert({subject:'Only once',weekday:5,from:'2026-10-23',until:'2026-10-23',starts:'20:00',ends:'21:20',number:12})
    assert.equal((await callDay('2026-10-23','2026-12-05')).lessons[0].lesson_number,1)
    await assert.rejects(callDay('2026-10-30','2026-12-05'),/COPY_SOURCE_EMPTY/)
    assert.equal(first(await db.query('select body from study_group_homework where id=$1',[homework])).body,'Do not copy homework')
  })
  await t.test('more than five intervals fail clearly and inconsistent duplicate old numbers coalesce projected copies',async()=>{
    for(let i=0;i<6;i++)await insert({subject:'Too many '+i,weekday:5,from:'2026-10-30',until:'2026-10-30',starts:`${String(8+i*2).padStart(2,'0')}:00`,ends:`${String(9+i*2).padStart(2,'0')}:20`})
    await assert.rejects(callDay('2026-10-30','2026-12-05'),/FIRST_SHIFT_UNMAPPABLE/)
    const props={subject:'Same parallel content',weekday:5,from:'2026-11-06',until:'2026-11-06',starts:'18:00',ends:'19:20'}
    await insert({...props,number:6});await insert({...props,number:7})
    const result=await callDay('2026-11-06','2026-12-05');assert.equal(result.copied,1);assert.equal(result.lessons.length,1)
    assert.equal((await callDay('2026-11-06','2026-12-05',false,result.source_signature)).copied,1)
    assert.equal((await rowsOn('2026-12-05')).length,1)
  })
  await t.test('only owner/approved schedule deputy can use either mode; admin role or MFA alone adds no rights',async()=>{
    assert.equal((await callDay('2026-10-12','2026-12-19',true,null,[],deputy)).copied,3)
    for(const user of [member,outsider,admin,hwDeputy])for(const mode of ['original','first_shift'])await assert.rejects(callDay('2026-10-12','2026-12-19',true,null,[],user,mode,{aal:user===admin?'aal2':'aal1'}),error=>error.code==='42501')
    for(const role of ['anon','service_role'])await assert.rejects(callDay('2026-10-12','2026-12-19',true,null,[],null,'first_shift',{role}),error=>error.code==='42501')
    await assert.rejects(asUser(owner,"select xelay_private_first_shift_projection('[]','[]')"),error=>error.code==='42501')
    assert.equal((await asUser(outsider,'select id from study_group_schedule where group_id=$1',[group])).rows.length,0)
  })
  await t.test('actual frontend parser accepts SQL canonical and short override times for both new RPCs',async()=>{
    const module={exports:{}}
    const source=ts.transpileModule(await readFile(new URL('src/lib/studyGroupTimetable.ts',root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
    const rpc=async(name,args)=>{try{assert.equal(name,'xelay_copy_study_group_schedule_day_with_time_mode');return {data:await callDay(args.p_source_date,args.p_target_date,args.p_preview,args.p_expected_signature,args.p_slot_assignments,owner,args.p_time_mode),error:null}}catch(error){return {data:null,error}}}
    vm.runInNewContext(source,{module,exports:module.exports,Date,require(name){assert.equal(name,'./supabase');return {supabase:{rpc}}}})
    const api=module.exports
    const approval=await api.copyStudyGroupScheduleDay(group,'2026-10-13','2026-12-19',true,null,'first_shift',[{source_starts_at:'16:00',source_ends_at:'17:20',target_lesson_number:3}])
    assert.ok(api.validFirstShiftCopyLessons(approval.lessons,approval.slot_assignments,true))
    assert.equal(approval.slot_assignments[0].source_starts_at,'16:00:00')
    assert.equal((await api.copyStudyGroupScheduleDay(group,'2026-10-13','2026-12-19',false,approval.source_signature,'first_shift',[{source_starts_at:'16:00:00',source_ends_at:'17:20:00',target_lesson_number:3}])).copied,2)
    const seqModule={exports:{}},seqSource=ts.transpileModule(await readFile(new URL('src/lib/studyGroupScheduleSequence.ts',root),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
    vm.runInNewContext(seqSource,{module:seqModule,exports:seqModule.exports,Date,require(name){if(name==='./studyGroupTimetable')return api;assert.equal(name,'./supabase');return {supabase:{rpc:async(name,args)=>{assert.equal(name,'xelay_copy_study_group_schedule_sequence_with_time_mode');return {data:await callSequence(args.p_pairs,args.p_preview,args.p_expected_signature,args.p_slot_assignments,owner,args.p_time_mode),error:null}}}}}})
    const result=await seqModule.exports.copyStudyGroupScheduleSequence(group,[{source_date:'2026-10-14',target_date:'2026-12-26'}],true,null,'first_shift',{})
    assert.equal(result.copied,2);assert.ok(result.days[0].slot_assignments.length===2)
  })
  await t.test('original endpoints and mode preserve original times; repeat installation cannot rewrite content or grants',async()=>{
    const original=await oldDay('2026-10-12','2027-01-02')
    const wrapper=await callDay('2026-10-12','2027-01-02',true,null,[],owner,'original')
    assert.equal(wrapper.source_signature,original.source_signature);assert.deepEqual(wrapper.lessons,original.lessons)
    assert.ok(wrapper.lessons.every(row=>['14:30:00','17:20:00'].includes(row.starts_at)))
    const before=await state(),contents=await content()
    await db.exec(migration)
    assert.deepEqual(await oldRpcContract(),beforeOld);assert.deepEqual(await state(),before);assert.deepEqual(await content(),contents)
  })
})
