// Real current seminar RPCs/ACLs in PGlite. Synthetic people and assignments only.
// Existing past lessons are seeded by advancing fixture rows after genuine future
// saves, before applying the new migration. No live database, network or payments.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root=process.env.XELAY_AUDIT_SOURCE_ROOT||fileURLToPath(new URL('../../',import.meta.url))
const {createTeachingScopedFixture}=await import(pathToFileURL(path.join(root,'scripts/security/teaching-scoped-fixture.mjs')))
const migration=()=>readFile(path.join(root,'supabase/migrations/202610300006_seminar_selection_reopen.sql'),'utf8')
const denied=promise=>assert.rejects(promise,error=>error.code==='42501')

test('seminar reopening preserves actual dates, privacy, occupied assignments and current group permissions',{timeout:120000},async t=>{
  const fx=await createTeachingScopedFixture();t.after(()=>fx.close())
  const {db,ids,groups:[groupA,groupB],rpc,asUser}=fx
  const rows=async(sql,args=[])=>(await db.query(sql,args)).rows
  const dates=(await rows("select (clock_timestamp()at time zone'Europe/Kyiv')::date::text today,((clock_timestamp()at time zone'Europe/Kyiv')::date+7)::text future,make_date(public.xelay_current_academic_year(),9,1)::text year_start,(make_date(public.xelay_current_academic_year(),9,1)-1)::text archive,greatest(make_date(public.xelay_current_academic_year(),9,1),(clock_timestamp()at time zone'Europe/Kyiv')::date-7)::text past"))[0]
  await db.query("insert into study_group_members(group_id,user_id,invited_by,status,accepted_at)values($1,$2,$3,'accepted',now())",[groupA,ids.studentB,ids.headA])
  const make=async(format,label,date=dates.future,subjectId=null)=>{
    const subject=subjectId||await rpc(ids.headA,'xelay_save_seminar_subject',[groupA,null,'Synthetic '+label])
    const weekday=Number((await rows('select extract(isodow from $1::date)::integer n',[date]))[0].n)
    const schedule=await rpc(ids.headA,'xelay_save_seminar_schedule',[groupA,null,subject,weekday,'08:00','09:20',date,date])
    const questions=format==='teams'?[]:[{body:'Occupied original question',primary_capacity:2,supplement_capacity:2},{body:'Free original question',primary_capacity:2,supplement_capacity:2}]
    const teams=format==='teams'?[{name:'Head-created team',capacity:2}]:[]
    const seminar=await rpc(ids.headA,'xelay_save_seminar',[groupA,null,schedule,date,'Synthetic '+label,'Original instructions',format,questions,teams])
    const children=(await rows('select * from '+(format==='teams'?'study_group_seminar_teams':'study_group_seminar_questions')+' where seminar_id=$1 order by position',[seminar]))
    return{seminar,subject,schedule,format,children}
  }
  const questions=await make('questions','reopened questions'),booking=await make('booking','reopened booking'),teams=await make('teams','reopened teams'),archive=await make('questions','archive'),unoccupied=await make('questions','empty reopen')
  const fullTeams=await make('teams','thirty teams'),futureParent=await make('booking','future parent occupancy')
  await rpc(ids.headA,'xelay_save_seminar',[groupA,fullTeams.seminar,fullTeams.schedule,dates.future,'Thirty teams fixture','', 'teams',[],Array.from({length:30},(_,i)=>i?{name:'Synthetic full team '+i,capacity:1}:{id:fullTeams.children[0].id,name:fullTeams.children[0].name,capacity:2})])
  await rpc(ids.studentB,'xelay_reserve_seminar',[futureParent.seminar,'booking',futureParent.children[0].id])
  for(const value of [questions,booking,teams])await rpc(ids.studentA,'xelay_reserve_seminar',[value.seminar,value.format==='teams'?'team':value.format==='booking'?'booking':'primary',value.children[0].id])
  const futureBookings=[]
  for(let i=0;i<4;i++){
    const date=(await rows('select ($1::date+$2::integer)::text value',[dates.future,(i+1)*7]))[0].value
    const value=await make('questions','future streak '+i,date,questions.subject)
    futureBookings.push(value)
    await rpc(ids.studentA,'xelay_reserve_seminar',[value.seminar,'primary',value.children[0].id])
  }
  for(const value of [questions,booking,teams,unoccupied,fullTeams])await db.query("update study_group_seminars set lesson_date=$1,starts_at='00:00',ends_at='01:20' where id=$2",[dates.past,value.seminar])
  await db.query("update study_group_seminars set lesson_date=$1,starts_at='00:00',ends_at='01:20' where id=$2",[dates.archive,archive.seminar])
  const preservedSignatures=['xelay_seminar_start(date,time)','xelay_seminar_streak_internal(uuid,uuid,uuid)','xelay_assert_seminar_streaks(uuid,uuid)','xelay_lock_seminar_group(uuid,boolean)','xelay_group_write_access(uuid)','xelay_can_view_seminars(uuid)','xelay_classroom_seminar_mutate(text,jsonb)','xelay_cleanup_seminar_membership()']
  const stableDefinitions=async()=>rows('select oid::regprocedure::text signature,prosrc,proacl::text acl,proowner,prosecdef,provolatile,proconfig from pg_proc where oid=any($1::regprocedure[]) order by oid',[preservedSignatures.map(name=>'public.'+name)])
  const beforeDefinitions=await stableDefinitions()
  const originalRows=await rows('select id,schedule_id,subject_id,lesson_date,starts_at,ends_at from study_group_seminars order by id')
  const originalReservations=await rows('select id,seminar_id,user_id,role,question_id,team_id from study_group_seminar_reservations order by id')
  await db.exec(await migration())
  assert.deepEqual(await stableDefinitions(),beforeDefinitions)
  assert.deepEqual(await rows('select id,schedule_id,subject_id,lesson_date,starts_at,ends_at from study_group_seminars order by id'),originalRows)
  assert.deepEqual(await rows('select id,seminar_id,user_id,role,question_id,team_id from study_group_seminar_reservations order by id'),originalReservations)
  const seminar=async value=>(await rows('select * from study_group_seminars where id=$1',[typeof value==='string'?value:value.seminar]))[0]
  const deadline=async()=> (await rows("select(clock_timestamp()+interval'2 hours')::text value"))[0].value
  const open=async(value,who=ids.headA)=>rpc(who,'xelay_set_seminar_selection_deadline',[groupA,value.seminar,await deadline(),(await seminar(value)).selection_version])
  const close=async(value,who=ids.headA)=>rpc(who,'xelay_set_seminar_selection_deadline',[groupA,value.seminar,null,(await seminar(value)).selection_version])
  const payload=async(value,changes={})=>{
    const row=await seminar(value)
    const qs=await rows('select id,body,primary_capacity,supplement_capacity from study_group_seminar_questions where seminar_id=$1 order by position',[value.seminar])
    const ts=await rows('select id,name,capacity from study_group_seminar_teams where seminar_id=$1 order by position',[value.seminar])
    return{date:row.lesson_date,schedule:row.schedule_id,title:row.title,instructions:row.instructions,format:row.format,questions:qs,teams:ts,...changes}
  }
  const save=async(value,changes={},who=ids.headA)=>{
    const p=await payload(value,changes)
    return rpc(who,'xelay_save_seminar',[groupA,value.seminar,p.schedule,p.date,p.title,p.instructions,p.format,p.questions,p.teams])
  }

  await t.test('default past selections stay closed; only actual seminar managers can reopen and stale changes do not replay',async()=>{
    assert.equal((await seminar(questions)).selection_deadline_at,null)
    await assert.rejects(rpc(ids.studentB,'xelay_reserve_seminar',[questions.seminar,'primary',questions.children[1].id]),/SEMINAR_LOCKED/)
    await assert.rejects(rpc(ids.studentA,'xelay_cancel_seminar_reservation',[questions.seminar]),/SEMINAR_LOCKED/)
    await assert.rejects(save(questions,{title:'Denied before reopening'}),/SEMINAR_LOCKED/)
    for(const who of [ids.studentA,ids.owner,ids.outsider,ids.admin])await denied(open(questions,who))
    await assert.rejects(rpc(ids.headB,'xelay_set_seminar_selection_deadline',[groupB,questions.seminar,await deadline(),0]),/SEMINAR_NOT_FOUND/)
    const changed=await open(questions)
    assert.equal(changed.seminar_id,questions.seminar);assert.equal(changed.selection_version,1)
    await assert.rejects(rpc(ids.headA,'xelay_set_seminar_selection_deadline',[groupA,questions.seminar,await deadline(),0]),error=>error.code==='PT409')
    assert.equal((await seminar(questions)).selection_version,1)
    assert.equal((await rows('select count(*)::integer n from study_group_seminar_reservations where seminar_id=any($1::uuid[])',[futureBookings.map(value=>value.seminar)]))[0].n,4)
  })

  await t.test('reopened groups read narrow current-year metadata with anonymous occupancy counts and unchanged lesson times',async()=>{
    await open(booking);await open(teams)
    const result=await rpc(ids.studentA,'xelay_open_seminar_selections',[groupA])
    assert.deepEqual(result.seminars.map(row=>row.id).sort(),[questions.seminar,booking.seminar,teams.seminar].sort())
    assert.ok(result.schedule.length===3)
    assert.ok(result.occupancy.every(row=>Object.keys(row).sort().join(',')==='count,question_id,role,seminar_id,team_id'))
    assert.ok(!JSON.stringify(result.occupancy).includes(ids.studentA))
    assert.ok(result.occupancy.some(row=>row.seminar_id===questions.seminar&&row.count===1))
    for(const row of result.seminars){assert.equal(row.lesson_date,dates.past);assert.equal(row.starts_at,'00:00:00');assert.equal(row.ends_at,'01:20:00')}
    await denied(rpc(ids.owner,'xelay_open_seminar_selections',[groupA]))
    await denied(rpc(ids.outsider,'xelay_open_seminar_selections',[groupA]))
    await assert.rejects(rpc(ids.headA,'xelay_classroom_seminar_mutate',['save_seminar',{}]),/permission denied/)
  })

  await t.test('questions and booking reservations can join, switch and leave during reopening and stop after explicit close',async()=>{
    for(const value of [questions,booking]){
      const role=value.format==='booking'?'booking':'primary'
      await rpc(ids.studentB,'xelay_reserve_seminar',[value.seminar,role,value.children[1].id])
      await rpc(ids.studentB,'xelay_reserve_seminar',[value.seminar,role,value.children[0].id])
      assert.equal((await rows('select count(*)::integer n from study_group_seminar_reservations where seminar_id=$1 and user_id=$2',[value.seminar,ids.studentB]))[0].n,1)
      await rpc(ids.studentB,'xelay_cancel_seminar_reservation',[value.seminar])
      const closed=await close(value);assert.ok(closed.selection_deadline_at)
      await assert.rejects(rpc(ids.studentB,'xelay_reserve_seminar',[value.seminar,role,value.children[1].id]),/SEMINAR_LOCKED/)
      await assert.rejects(rpc(ids.studentA,'xelay_cancel_seminar_reservation',[value.seminar]),/SEMINAR_LOCKED/)
      await open(value)
    }
  })

  await t.test('reopened edits change overall instructions and free rows but preserve occupied questions, teams and history',async()=>{
    await save(questions,{title:'Updated reopened lesson',instructions:'New general instructions',questions:(await payload(questions)).questions.map((row,i)=>({...row,body:i===1?'Updated free question':row.body}))})
    assert.equal((await seminar(questions)).title,'Updated reopened lesson')
    assert.equal((await rows('select body from study_group_seminar_questions where id=$1',[questions.children[0].id]))[0].body,'Occupied original question')
    for(const patch of [
      {questions:(await payload(questions)).questions.map((row,i)=>({...row,body:i===0?'Illegal occupied edit':row.body}))},
      {questions:(await payload(questions)).questions.map((row,i)=>({...row,primary_capacity:i===0?3:row.primary_capacity}))},
      {questions:(await payload(questions)).questions.slice(1)},
      {format:'teams',questions:[],teams:[{name:'Illegal replacement format',capacity:2}]},
    ])await assert.rejects(save(questions,patch),/OCCUPIED_ITEM_IMMUTABLE|HAS_RESERVATIONS/)
    await assert.rejects(save(teams,{teams:(await payload(teams)).teams.map(row=>({...row,name:'Illegal occupied rename'}))}),/OCCUPIED_ITEM_IMMUTABLE/)
    await assert.rejects(rpc(ids.headA,'xelay_delete_seminar',[questions.seminar]),/HAS_RESERVATIONS/)
    await assert.rejects(rpc(ids.headA,'xelay_delete_seminar_schedule',[futureBookings[0].schedule]),/HAS_RESERVATIONS/)
    await assert.rejects(rpc(ids.headA,'xelay_delete_seminar_subject',[futureParent.subject]),/HAS_RESERVATIONS/)
    const unchanged=await seminar(unoccupied)
    await open(unoccupied)
    // Use an actually valid future target, so the new immutable historical-slot
    // guard is exercised rather than merely an old weekday/date mismatch check.
    await assert.rejects(save(unoccupied,{date:dates.future,schedule:futureParent.schedule}),/SEMINAR_LOCKED/)
    const after=await seminar(unoccupied)
    for(const key of ['lesson_date','starts_at','ends_at','subject_id','schedule_id'])assert.deepEqual(after[key],unchanged[key])
    const retainedIds=[questions.seminar,booking.seminar,teams.seminar,...futureBookings.map(value=>value.seminar)]
    assert.deepEqual(await rows('select id,seminar_id,user_id,role,question_id,team_id from study_group_seminar_reservations where user_id=$1 and seminar_id=any($2::uuid[]) order by id',[ids.studentA,retainedIds]),originalReservations.filter(row=>row.user_id===ids.studentA&&retainedIds.includes(row.seminar_id)))
  })

  await t.test('ordinary approved deputy needs the seminars right and cannot inherit resource management through reopening',async()=>{
    // Self-applications were retired by the real appointments migration. The
    // head's current appointment RPC is the authorized production path.
    const request=await rpc(ids.headA,'xelay_assign_study_group_deputy',[groupA,ids.studentB,['homework']])
    await denied(open(unoccupied,ids.studentB))
    await rpc(ids.headA,'xelay_update_study_group_deputy_permissions',[request,['seminars']])
    await open(unoccupied,ids.studentB)
    await save(unoccupied,{instructions:'Approved seminar deputy edit'},ids.studentB)
    const permissions=await rpc(ids.studentB,'xelay_study_group_permissions',[groupA])
    assert.ok(permissions.includes('seminars'));assert.ok(!permissions.includes('seminar_resources'))
    await rpc(ids.headA,'xelay_revoke_study_group_deputy',[request])
    await denied(open(unoccupied,ids.studentB))
  })

  await t.test('archive rows cannot reopen or be edited, even if a privileged fixture set a future override',async()=>{
    await denied(open(archive))
    await db.query("update study_group_seminars set selection_deadline_at=clock_timestamp()+interval'1 day' where id=$1",[archive.seminar])
    await assert.rejects(save(archive,{instructions:'Forbidden archive edit'}),/SEMINAR_LOCKED/)
    await assert.rejects(rpc(ids.studentA,'xelay_reserve_seminar',[archive.seminar,'primary',archive.children[0].id]),/SEMINAR_LOCKED/)
    assert.ok(!(await rpc(ids.studentA,'xelay_open_seminar_selections',[groupA])).seminars.some(row=>row.id===archive.seminar))
    await assert.rejects(rpc(ids.headA,'xelay_set_seminar_selection_deadline',[groupA,questions.seminar,'infinity',(await seminar(questions)).selection_version]),/DEADLINE_INVALID/)
    await assert.rejects(asUser(ids.studentA,'update study_group_seminars set selection_deadline_at=now() where id=$1',[questions.seminar]),error=>error.code==='42501')
  })

  await t.test('participants create one own team and join atomically; retries cannot create duplicates or move another reservation',async()=>{
    for(const capacity of [0,51])await assert.rejects(rpc(ids.studentB,'xelay_create_seminar_team',[groupA,teams.seminar,randomUUID(),'Invalid capacity',capacity]),/SEMINAR_INVALID_INPUT/)
    await assert.rejects(rpc(ids.studentB,'xelay_create_seminar_team',[groupA,teams.seminar,randomUUID(),'head-CREATED team',2]),/SEMINAR_TEAM_CONFLICT/)
    await open(fullTeams)
    await assert.rejects(rpc(ids.studentB,'xelay_create_seminar_team',[groupA,fullTeams.seminar,randomUUID(),'Thirty-first forbidden',2]),/SEMINAR_TEAM_LIMIT/)
    assert.equal((await rows('select count(*)::integer n from study_group_seminar_teams where seminar_id=$1',[fullTeams.seminar]))[0].n,30)
    const id=randomUUID()
    const first=await rpc(ids.studentB,'xelay_create_seminar_team',[groupA,teams.seminar,id,'Participant-created team',3])
    assert.equal(first.id,id);assert.equal(first.seminar_id,teams.seminar);assert.equal(first.capacity,3)
    assert.equal((await rows('select team_id from study_group_seminar_reservations where seminar_id=$1 and user_id=$2',[teams.seminar,ids.studentB]))[0].team_id,id)
    const again=await rpc(ids.studentB,'xelay_create_seminar_team',[groupA,teams.seminar,id,'Participant-created team',3])
    assert.deepEqual(again,first)
    assert.equal((await rows('select count(*)::integer n from study_group_seminar_teams where id=$1',[id]))[0].n,1)
    await assert.rejects(rpc(ids.studentA,'xelay_create_seminar_team',[groupA,teams.seminar,randomUUID(),'No silent switch',2]),/ALREADY_RESERVED/)
    await assert.rejects(rpc(ids.studentB,'xelay_create_seminar_team',[groupA,teams.seminar,id,'Changed retry',3]),error=>error.code==='PT409')
    await rpc(ids.studentB,'xelay_cancel_seminar_reservation',[teams.seminar])
    await assert.rejects(rpc(ids.studentB,'xelay_create_seminar_team',[groupA,teams.seminar,randomUUID(),'No fill-all-slots spam',2]),/ALREADY_CREATED/)
    assert.equal((await rows('select count(*)::integer n from study_group_seminar_reservations where seminar_id=$1 and user_id=$2',[teams.seminar,ids.studentB]))[0].n,0)
    await denied(rpc(ids.owner,'xelay_create_seminar_team',[groupA,teams.seminar,randomUUID(),'Teacher-only forbidden',2]))
    await denied(asUser(ids.studentA,'select * from public.xelay_seminar_team_creation_receipts'))
    await close(teams)
    await assert.rejects(rpc(ids.studentB,'xelay_reserve_seminar',[teams.seminar,'team',id]),/SEMINAR_LOCKED/)
    await assert.rejects(rpc(ids.headA,'xelay_create_seminar_team',[groupA,teams.seminar,randomUUID(),'Closed selection',2]),/SEMINAR_LOCKED/)
  })

  await t.test('removed historic members remain anonymous but still counted in reopened capacity; expired deadline closes every mutation',async()=>{
    await db.query("update study_group_members set status='removed' where group_id=$1 and user_id=$2",[groupA,ids.studentA])
    assert.equal((await rows('select count(*)::integer n from study_group_seminar_reservations where seminar_id=$1 and user_id=$2',[questions.seminar,ids.studentA]))[0].n,1,'Historical participation is not deleted by a new deadline')
    const view=await rpc(ids.studentB,'xelay_open_seminar_selections',[groupA])
    assert.ok(view.occupancy.some(row=>row.seminar_id===questions.seminar&&row.question_id===questions.children[0].id&&row.count===1))
    assert.ok(!JSON.stringify(view.occupancy).includes(ids.studentA))
    await denied(rpc(ids.studentA,'xelay_reserve_seminar',[questions.seminar,'primary',questions.children[1].id]))
    await db.query("update study_group_seminars set selection_deadline_at=clock_timestamp()-interval'1 second' where id=$1",[questions.seminar])
    await assert.rejects(rpc(ids.studentB,'xelay_reserve_seminar',[questions.seminar,'primary',questions.children[1].id]),/SEMINAR_LOCKED/)
    await assert.rejects(rpc(ids.studentB,'xelay_cancel_seminar_reservation',[questions.seminar]),/SEMINAR_LOCKED/)
    await assert.rejects(save(questions,{title:'No edits after expiry'}),/SEMINAR_LOCKED/)
    assert.ok(!(await rpc(ids.studentB,'xelay_open_seminar_selections',[groupA])).seminars.some(row=>row.id===questions.seminar))
    assert.deepEqual(await stableDefinitions(),beforeDefinitions)
  })
})
