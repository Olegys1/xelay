import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {createTeachingScopedFixture} from '../scripts/security/teaching-scoped-fixture.mjs'
import {deanPublicationRows} from '../src/lib/deanWorkspace.ts'

test('dean room workflow: protected inputs, verified cascade, private main and explicit publication gate',{timeout:120000},async t=>{
 const fx=await createTeachingScopedFixture();t.after(()=>fx.close());const {db,ids,groups}=fx
 await db.exec('create table auth.sessions(id uuid primary key,user_id uuid,not_after timestamptz)')
 const sessions={};for(const id of [ids.admin,ids.owner,ids.outsider,ids.studentA,ids.studentB]){sessions[id]=randomUUID();await db.query('insert into auth.sessions values($1,$2,null)',[sessions[id],id])}
 for(const id of [ids.owner,ids.outsider])await db.query("insert into auth.mfa_factors(user_id,status,factor_type)values($1,'verified','totp')",[id])
 for(const f of ['20261122184146_dean_workspace.sql','20261122200956_dean_online_planning.sql','20261123072500_dean_provision_reservation.sql','202611240100_dean_room_workflow.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+f,import.meta.url),'utf8'))
 async function invoke(name,args,user=ids.admin,aal='aal2',role='authenticated'){
  await db.exec('set role '+role);await db.query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify({sub:user,session_id:sessions[user],aal,role})])
  try{return(await db.query(`select public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result}finally{await db.exec('reset role')}
 }
 const workspace=(a,p={},u=ids.admin,aal='aal2')=>invoke('xelay_dean_workspace',[a,JSON.stringify(p)],u,aal)
 const online=(a,p={},u=ids.admin)=>invoke('xelay_dean_online',[a,JSON.stringify(p)],u)
 const source={students:[{id:'s',name:'Synthetic student',group:'G-1'}],events:Array.from({length:6},(_,i)=>({id:'e'+i,course:'Synthetic',teacher:'Synthetic',teacherIds:['t'],studentIds:['s'],activity:'lab',day:1+Math.floor(i/2),period:1+i%2,weeks:[1,2],room:'R'})),rooms:[{id:'R',capacity:1,computer:true,disabled:false,blockedSlots:[],allowedPrograms:[],note:''}],metadata:{},blockers:[]}
 const document={source,mapping:{},monday:'',rows:[]}
 const base=await workspace('create',{title:'Preserved baseline',document})
 const before=JSON.stringify((await db.query('select * from study_group_schedule order by id')).rows)
 await assert.rejects(workspace('load',{id:base.id},ids.admin,'aal1'),/DEAN_MFA_REQUIRED/)
 await assert.rejects(workspace('main',{id:base.id},ids.outsider),/DEAN_ACCESS_DENIED/)
 assert.equal((await workspace('main',{id:base.id})).main,null)
 await assert.rejects(workspace('publish',{id:base.id,revision:1}),/DEAN_MAIN_REQUIRED/)
 await assert.rejects(workspace('make_main',{id:base.id,revision:1,mainVersion:0,confirmation:'wrong'}),/DEAN_CONFIRMATION_REQUIRED/)
 const main=await workspace('make_main',{id:base.id,revision:1,mainVersion:0,confirmation:'ОСНОВНИЙ 1'})
 assert.equal(main.version,1);assert.deepEqual(main.document,document)
 assert.equal((await db.query('select count(*) n from dean_private.lessons')).rows[0].n,0)
 const changed=structuredClone(document);changed.source.events[0].period=6
 await assert.rejects(workspace('save',{id:base.id,revision:1,document:changed}),/DEAN_MAIN_IMMUTABLE/)
 const fork=await workspace('fork',{id:base.id,revision:1});assert.equal(fork.workspace_id,base.id)
 const input=structuredClone(document);input.planningSource=structuredClone(source);input.planningSource.rooms[0].capacity=2
 const saved=await workspace('save',{id:fork.id,revision:1,document:input})
 assert.deepEqual((await workspace('load',{id:fork.id})).document.planningSource,input.planningSource)
 await assert.rejects(workspace('make_main',{id:fork.id,revision:2,mainVersion:1,confirmation:'ОСНОВНИЙ 2'}),/DEAN_INPUTS_NOT_CALCULATED/)
 const job=await online('begin',{draftId:fork.id,revision:2,settings:{}})
 const moved=source.events.map(e=>({...e,period:e.period+1}))
 await invoke('xelay_dean_finish_job',[job.job,JSON.stringify({ok:true,options:[{events:moved,report:{passed:true}}]})],ids.admin,'aal2','service_role')
 const next=await online('apply',{id:job.job,option:0});assert.equal(next.workspace_id,base.id);assert.equal(next.document.source.rooms[0].capacity,2);assert.equal(next.document.planningSource,undefined)
 assert.deepEqual((await workspace('main',{id:next.id})).main.document,document)
 await assert.rejects(workspace('make_main',{id:next.id,revision:1,mainVersion:0,confirmation:'ОСНОВНИЙ 1'}),/DEAN_STALE_VERSION/)
 const second=await workspace('make_main',{id:next.id,revision:1,mainVersion:1,confirmation:'ОСНОВНИЙ 1'});assert.equal(second.version,2)
 assert.deepEqual((await workspace('load',{id:base.id})).document,document)
 assert.deepEqual((await workspace('main',{id:base.id})).main.document.source.events,moved)
 const bad=structuredClone(document);bad.source.events[0].room='missing'
 const invalid=await workspace('create',{title:'Room not eligible',document:bad})
 await assert.rejects(workspace('make_main',{id:invalid.id,revision:1,mainVersion:0,confirmation:'ОСНОВНИЙ 1'}),/DEAN_ROOM_INELIGIBLE/)
 const collision=structuredClone(document);collision.source.events[1].teacherIds=['another'];collision.source.events[1].studentIds=['other'];collision.source.events[1].period=1;collision.source.students.push({id:'other',name:'Another',group:'G-1'})
 const invalid2=await workspace('create',{title:'Double booked room',document:collision})
 await assert.rejects(workspace('make_main',{id:invalid2.id,revision:1,mainVersion:0,confirmation:'ОСНОВНИЙ 1'}),/DEAN_ROOM_CONFLICT/)
 await db.query("update dean_private.jobs set created_at=now()-interval '5 minutes'")
 const forged=await online('begin',{draftId:next.id,revision:1,settings:{}})
 await invoke('xelay_dean_finish_job',[forged.job,JSON.stringify({ok:true,options:[{events:moved.map((e,i)=>i?e:{...e,room:'missing'}),report:{passed:true}}]})],ids.admin,'aal2','service_role')
 await assert.rejects(online('apply',{id:forged.job,option:0}),/DEAN_ROOM_INELIGIBLE/)
 assert.equal((await db.query('select count(*) n from dean_private.lessons')).rows[0].n,0)
 assert.equal(JSON.stringify((await db.query('select * from study_group_schedule order by id')).rows),before)
 // Only this isolated fixture publishes. The real timetable must remain private.
 const ready=structuredClone(next.document);ready.mapping={s:{userId:ids.studentA,groupId:groups[0]}};ready.teacherMapping={t:ids.owner};ready.monday='2027-02-01';ready.rows=deanPublicationRows(ready.source,ready.mapping,ready.monday)
 const delivery=await workspace('save',{id:next.id,revision:1,document:ready});assert.equal(delivery.revision,2)
 assert.deepEqual((await workspace('main',{id:next.id})).main.document.source,next.document.source)
 await assert.rejects(workspace('publish',{id:next.id,revision:2}),/DEAN_APPROVAL_REQUIRED/)
 assert.equal((await workspace('review',{id:next.id,revision:2})).passed,true)
 const forgedProjection=structuredClone(ready);forgedProjection.rows[0].subject='Injected'
 const tampered=await workspace('save',{id:next.id,revision:2,document:forgedProjection})
 await assert.rejects(workspace('review',{id:next.id,revision:3}),/DEAN_PROJECTION_MISMATCH/)
 const restored=await workspace('save',{id:next.id,revision:3,document:ready})
 await workspace('approve',{id:next.id,revision:4,confirmation:'ПІДТВЕРДЖУЮ 4'})
 await workspace('publish',{id:next.id,revision:4})
 const visible=await invoke('xelay_dean_personal_lessons',[groups[0],null],ids.studentA,'aal1');assert.equal(visible.length,12);assert.equal(visible[0].location,'R')
 assert.deepEqual(await invoke('xelay_dean_personal_lessons',[groups[0],null],ids.studentB,'aal1'),[])
 assert.equal(JSON.stringify((await db.query('select * from study_group_schedule order by id')).rows),before)
 const teacher=(a,p={},u=ids.admin,aal='aal2')=>invoke('xelay_dean_teacher_delivery',[a,JSON.stringify(p)],u,aal)
 assert.equal((await teacher('catalog')).some(p=>p.id===ids.owner),true)
 await assert.rejects(teacher('publish',{id:next.id,revision:4,confirmation:'ВИКЛАДАЧАМ 4'},ids.admin,'aal1'),/DEAN_MFA_REQUIRED/)
 await assert.rejects(teacher('publish',{id:base.id,revision:1,confirmation:'ВИКЛАДАЧАМ 1'}),/DEAN_MAIN_REQUIRED/)
 await assert.rejects(teacher('publish',{id:next.id,revision:4,confirmation:'wrong'}),/DEAN_CONFIRMATION_REQUIRED/)
 assert.equal((await teacher('publish',{id:next.id,revision:4,confirmation:'ВИКЛАДАЧАМ 4'})).lessons,12)
 assert.equal((await teacher('publish',{id:next.id,revision:4,confirmation:'ВИКЛАДАЧАМ 4'})).lessons,0)
 const ownTeacher=await teacher('read',{},ids.owner,'aal1');assert.equal(ownTeacher.length,12);assert.equal(ownTeacher[0].room,'R')
 assert.deepEqual(await teacher('read',{userId:ids.owner},ids.outsider,'aal1'),[])
 assert.equal((await workspace('load',{id:next.id})).teacher_published_revision,4)
 assert.equal((await db.query('select count(*) n from dean_private.lessons')).rows[0].n,12)
 // Teacher-first publication freezes its recipients/date without blocking later student mapping.
 const teacherOnlyDoc=structuredClone(document);teacherOnlyDoc.monday='2027-04-05';teacherOnlyDoc.teacherMapping={t:ids.outsider}
 const teacherOnly=await workspace('create',{title:'Teacher delivery only',document:teacherOnlyDoc})
 await workspace('make_main',{id:teacherOnly.id,revision:1,mainVersion:0,confirmation:'ОСНОВНИЙ 1'})
 await assert.rejects(teacher('publish',{id:teacherOnly.id,revision:1,confirmation:'ВИКЛАДАЧАМ 1'}),/DEAN_TEACHER_MAPPING_REQUIRED/)
 teacherOnlyDoc.teacherMapping={t:ids.owner}
 await workspace('save',{id:teacherOnly.id,revision:1,document:teacherOnlyDoc})
 assert.equal((await teacher('publish',{id:teacherOnly.id,revision:2,confirmation:'ВИКЛАДАЧАМ 2'})).lessons,12)
 const changedTeacher=structuredClone(teacherOnlyDoc);changedTeacher.monday='2027-04-12'
 await assert.rejects(workspace('save',{id:teacherOnly.id,revision:2,document:changedTeacher}),/DEAN_MAIN_IMMUTABLE/)
 changedTeacher.monday=teacherOnlyDoc.monday;changedTeacher.teacherMapping={t:ids.colleague}
 await assert.rejects(workspace('save',{id:teacherOnly.id,revision:2,document:changedTeacher}),/DEAN_MAIN_IMMUTABLE/)
 teacherOnlyDoc.mapping={s:{userId:ids.studentA,groupId:groups[0]}}
 assert.equal((await workspace('save',{id:teacherOnly.id,revision:2,document:teacherOnlyDoc})).revision,3)
 const roomClashDoc=structuredClone(teacherOnlyDoc);roomClashDoc.rows=deanPublicationRows(roomClashDoc.source,roomClashDoc.mapping,roomClashDoc.monday)
 const roomClash=await workspace('create',{title:'Cross-channel room conflict',document:roomClashDoc})
 await workspace('make_main',{id:roomClash.id,revision:1,mainVersion:0,confirmation:'ОСНОВНИЙ 1'})
 await assert.rejects(workspace('review',{id:roomClash.id,revision:1}),/DEAN_ROOM_CONFLICT/)
 await assert.rejects(teacher('publish',{id:roomClash.id,revision:1,confirmation:'ВИКЛАДАЧАМ 1'}),/DEAN_ROOM_CONFLICT/)
})
